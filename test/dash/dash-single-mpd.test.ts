// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {firstValueFrom} from 'rxjs';
import {parseDashManifest, writeDashMediaPlaylist} from '../../src/dash/dash-manifest';
import {resolveDashSegmentIndexes} from '../../src/dash/dash-segment-index';
import {createSidx} from './sidx-fixture';

const source = 'https://example.com/manifest.mpd';
const template = '<SegmentTemplate duration="2" initialization="init.mp4" media="$Number$.m4s"/>';
const video = (addressing = template, id = 'v', codec = 'avc1.4d401e') =>
  `<AdaptationSet mimeType="video/mp4" codecs="${codec}">${addressing}<Representation id="${id}" bandwidth="1000000"/></AdaptationSet>`;
const audio = (language: string, id = language) =>
  `<AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="${language}" audioSamplingRate="48000">${template}<Representation id="${id}" bandwidth="64000"/></AdaptationSet>`;
const mpd = (content: string, duration = 4) => `<MPD mediaPresentationDuration="PT${duration}S">${content}</MPD>`;
const period = (content = video(), attributes = '') => `<Period ${attributes}>${content}</Period>`;
const resolve = async (xml: string) => firstValueFrom(resolveDashSegmentIndexes(parseDashManifest(xml, source)));

afterEach(() => vi.unstubAllGlobals());

describe('single-MPD segment addressing', () => {
  it('inherits SegmentList timing and initialization while overriding SegmentURLs', () => {
    const xml = mpd(`<Period><SegmentList timescale="1000" duration="2000"><Initialization sourceURL="init.mp4"/></SegmentList>
      <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e"><SegmentList><SegmentURL media="old.m4s"/></SegmentList>
      <Representation id="v" bandwidth="1"><SegmentList><SegmentURL media="file.mp4" mediaRange="100-199"/>
      <SegmentURL media="file.mp4" mediaRange="200-349"/></SegmentList></Representation></AdaptationSet></Period>`);
    const track = parseDashManifest(xml, source).renditions[0]!;
    expect(track.initializationUrl).toBe('https://example.com/init.mp4');
    expect(track.segments).toEqual([
      {url: 'https://example.com/file.mp4', duration: 2, byteRange: {offset: 100, length: 100}},
      {url: 'https://example.com/file.mp4', duration: 2, byteRange: {offset: 200, length: 150}},
    ]);
  });

  it('maps SegmentList timelines and validates URL counts and ranges', () => {
    const list = `<SegmentList timescale="10" presentationTimeOffset="100"><Initialization sourceURL="init.mp4"/>
      <SegmentTimeline><S t="100" d="10"/><S d="30"/></SegmentTimeline><SegmentURL media="a.m4s"/><SegmentURL media="b.m4s"/></SegmentList>`;
    expect(parseDashManifest(mpd(period(video(list))), source).renditions[0]!.segments.map((segment) => segment.duration)).toEqual([1, 3]);
    expect(() => parseDashManifest(mpd(period(video(list.replace('<SegmentURL media="b.m4s"/>', '')))), source)).toThrow(/count/);
    expect(() => parseDashManifest(mpd(period(video(list.replace('media="a.m4s"', 'media="a.m4s" mediaRange="2-1"')))), source)).toThrow(/mediaRange/);
  });

  it('accepts a single SegmentURL with the Period duration', () => {
    const track = parseDashManifest(mpd(period(video('<SegmentList><Initialization sourceURL="init.mp4"/><SegmentURL media="whole.m4s"/></SegmentList>'))), source).renditions[0]!;
    expect(track.segments).toEqual([{url: 'https://example.com/whole.m4s', duration: 4}]);
  });

  it('overrides inherited addressing types without leaking unrelated parent attributes', () => {
    const xml = mpd(`<Period>${template}<AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e">
      <SegmentList duration="2"><Initialization sourceURL="list-init.mp4"/><SegmentURL media="a.m4s"/><SegmentURL media="b.m4s"/></SegmentList>
      <Representation id="v" bandwidth="1"/></AdaptationSet></Period>`);
    expect(parseDashManifest(xml, source).renditions[0]!.segments[0]!.url).toBe('https://example.com/a.m4s');
  });

  it('supports inclusive endNumber, plays a template ending before the presentation end, and rejects one ending before an inner boundary', () => {
    const addressing = template.replace('duration="2"', 'duration="2" startNumber="7" endNumber="8"');
    expect(parseDashManifest(mpd(period(video(addressing))), source).renditions[0]!.segments.map((segment) => segment.url)).toEqual(['https://example.com/7.m4s', 'https://example.com/8.m4s']);
    const short = addressing.replace('endNumber="8"', 'endNumber="7"');
    expect(parseDashManifest(mpd(period(video(short))), source).renditions[0]!.segments.map((segment) => segment.url)).toEqual(['https://example.com/7.m4s']);
    expect(() => parseDashManifest(mpd(period(video(short), 'duration="PT4S"') + period(video(), 'duration="PT4S"'), 8), source)).toThrow(/cover/);
  });

  it('supports Initialization elements and ranges in SegmentTemplate', () => {
    const addressing = '<SegmentTemplate duration="2" media="$Number$.m4s"><Initialization sourceURL="$RepresentationID$-init.mp4" range="10-29"/></SegmentTemplate>';
    expect(parseDashManifest(mpd(period(video(addressing))), source).renditions[0]).toMatchObject({
      initializationUrl: 'https://example.com/v-init.mp4',
      initializationByteRange: {offset: 10, length: 20},
    });
  });

  it.each(['template', 'list'])('resolves %s per-segment indexes into media subranges', async (kind) => {
    const addressing =
      kind === 'template'
        ? template.replace('duration="2"', 'duration="4" index="index-$Number$.sidx"')
        : '<SegmentList><Initialization sourceURL="init.mp4"/><SegmentURL media="1.m4s" index="index-1.sidx" indexRange="0-55"/></SegmentList>';
    const data = createSidx({
      references: [
        {size: 100, duration: 2000},
        {size: 200, duration: 2000},
      ],
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(data));
    vi.stubGlobal('fetch', fetchMock);
    const track = (await resolve(mpd(period(video(addressing))))).renditions[0]!;
    expect(fetchMock.mock.calls[0]![0]).toBe('https://example.com/index-1.sidx');
    expect(track.segments).toEqual([
      {url: 'https://example.com/1.m4s', duration: 2, byteRange: {offset: 56, length: 100}},
      {url: 'https://example.com/1.m4s', duration: 2, byteRange: {offset: 156, length: 200}},
    ]);
  });

  it('uses a RepresentationIndex resource and its own byte range', async () => {
    const data = createSidx({references: [{size: 100, duration: 4000}]});
    const file = new Uint8Array(64);
    file.set(new Uint8Array(data), 20);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(file));
    vi.stubGlobal('fetch', fetchMock);
    const addressing = '<BaseURL>video.mp4</BaseURL><SegmentBase><Initialization range="0-19"/><RepresentationIndex sourceURL="index.bin" range="20-63"/></SegmentBase>';
    const track = (await resolve(mpd(period(video(addressing))))).renditions[0]!;
    expect(fetchMock.mock.calls[0]![0]).toBe('https://example.com/index.bin');
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('Range')).toBe('bytes=20-63');
    expect(track.segments[0]!.byteRange).toEqual({offset: 64, length: 100});
    expect(track.segments[0]!.url).toBe('https://example.com/video.mp4');
  });

  it('resolves hierarchical SIDX references with absolute child offsets', async () => {
    const child = createSidx({
      firstOffset: 12,
      references: [
        {size: 100, duration: 2000},
        {size: 200, duration: 2000},
      ],
    });
    const root = createSidx({references: [{size: child.byteLength, duration: 4000, hierarchical: true}]});
    const file = new Uint8Array(500);
    file.set(new Uint8Array(root), 100);
    file.set(new Uint8Array(child), 100 + root.byteLength);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(file));
    vi.stubGlobal('fetch', fetchMock);
    const addressing = `<BaseURL>video.mp4</BaseURL><SegmentBase indexRange="100-${99 + root.byteLength}"><Initialization range="0-99"/></SegmentBase>`;
    const track = (await resolve(mpd(period(video(addressing))))).renditions[0]!;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(track.segments.map((segment) => segment.byteRange)).toEqual([
      {offset: 212, length: 100},
      {offset: 312, length: 200},
    ]);
  });

  it.each(['time', 'duration'])('rejects a nested SIDX with inconsistent %s', async (kind) => {
    const child = createSidx({earliestTime: kind === 'time' ? 1000 : 0, references: [{size: 100, duration: kind === 'duration' ? 5000 : 4000}]});
    const root = createSidx({references: [{size: child.byteLength, duration: 4000, hierarchical: true}]});
    const file = new Uint8Array(300);
    file.set(new Uint8Array(root), 100);
    file.set(new Uint8Array(child), 100 + root.byteLength);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async () => new Response(file))
    );
    const addressing = '<BaseURL>video.mp4</BaseURL><SegmentBase indexRange="100-143"><Initialization range="0-99"/></SegmentBase>';
    await expect(resolve(mpd(period(video(addressing))))).rejects.toThrow(/nested SIDX/);
  });

  it('rejects subsegments outside a declared SegmentURL media range', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(createSidx({references: [{size: 100, duration: 4000}]}))));
    const list = '<SegmentList><Initialization sourceURL="init.mp4"/><SegmentURL media="a.m4s" index="a.sidx" mediaRange="200-299"/></SegmentList>';
    await expect(resolve(mpd(period(video(list))))).rejects.toThrow(/exceed SegmentURL/);
  });

  it('does not inherit a media indexRange onto an external RepresentationIndex without a range', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(createSidx({references: [{size: 100, duration: 4000}]})));
    vi.stubGlobal('fetch', fetchMock);
    const addressing = '<BaseURL>video.mp4</BaseURL><SegmentBase indexRange="100-143"><Initialization range="0-99"/><RepresentationIndex sourceURL="external.sidx"/></SegmentBase>';
    await resolve(mpd(period(video(addressing))));
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('Range')).toBeNull();
  });

  it('bounds recursive SIDX requests', async () => {
    const root = createSidx({references: [{size: 44, duration: 4000, hierarchical: true}]});
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async () => new Response(root, {status: 206}))
    );
    const addressing = '<BaseURL>video.mp4</BaseURL><SegmentBase indexRange="100-143"><Initialization range="0-99"/></SegmentBase>';
    await expect(resolve(mpd(period(video(addressing))))).rejects.toThrow(/nesting/);
  });

  it('cancels a pending nested index request on unsubscribe', async () => {
    const root = createSidx({references: [{size: 44, duration: 4000, hierarchical: true}]});
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(root, {status: 206}))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const addressing = '<BaseURL>video.mp4</BaseURL><SegmentBase indexRange="100-143"><Initialization range="0-99"/></SegmentBase>';
    const subscription = resolveDashSegmentIndexes(parseDashManifest(mpd(period(video(addressing))), source)).subscribe();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const signal = fetchMock.mock.calls[1]![1]!.signal!;
    subscription.unsubscribe();
    expect(signal.aborted).toBe(true);
  });

  it('discovers implicit initialization and an embedded SIDX without downloading media', async () => {
    const sidx = createSidx({references: [{size: 100, duration: 4000}]});
    const file = new Uint8Array(200);
    const view = new DataView(file.buffer);
    for (const [offset, type] of [
      [0, 'ftyp'],
      [16, 'moov'],
    ] as const) {
      view.setUint32(offset, 16);
      file.set(
        [...type].map((char) => char.charCodeAt(0)),
        offset + 4
      );
    }
    file.set(new Uint8Array(sidx), 32);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(file, {headers: {'Content-Length': '200'}}));
    vi.stubGlobal('fetch', fetchMock);
    const track = (await resolve(mpd(period(video('<BaseURL>video.mp4</BaseURL>'))))).renditions[0]!;
    expect(track.initializationByteRange).toEqual({offset: 0, length: 32});
    expect(track.segments[0]!.byteRange).toEqual({offset: 76, length: 100});
    // one probe covers ftyp, moov and sidx; the probed SIDX bytes are parsed without another request
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('Range')).toBe('bytes=0-16383');
  });

  it('extends the probe when the SIDX runs past it and skips large boxes without downloading them', async () => {
    const sidx = createSidx({references: [{size: 100, duration: 4000}]});
    const moov = 40000; // after a 40 KB box the probe moves rather than downloading the gap
    const sidxOffset = moov + 16384 - 10; // straddles the end of the second probe
    const file = new Uint8Array(sidxOffset + sidx.byteLength);
    const view = new DataView(file.buffer);
    const header = (offset: number, size: number, type: string) => {
      view.setUint32(offset, size);
      file.set(
        [...type].map((char) => char.charCodeAt(0)),
        offset + 4
      );
    };
    header(0, moov, 'free');
    header(moov, 16, 'moov');
    header(moov + 16, sidxOffset - moov - 16, 'free');
    file.set(new Uint8Array(sidx), sidxOffset);
    const ranges: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const range = new Headers(init?.headers).get('Range')!;
        ranges.push(range);
        const [start, end] = range.slice(6).split('-').map(Number) as [number, number];
        const body = file.slice(start, Math.min(end + 1, file.length));
        return new Response(body, {status: 206, headers: {'Content-Range': `bytes ${start}-${start + body.length - 1}/${file.length}`}});
      })
    );
    const track = (await resolve(mpd(period(video('<BaseURL>video.mp4</BaseURL>'))))).renditions[0]!;
    expect(track.initializationByteRange).toEqual({offset: 0, length: moov + 16});
    expect(track.segments[0]!.byteRange).toEqual({offset: file.length, length: 100});
    expect(ranges).toEqual(['bytes=0-16383', `bytes=${moov}-${moov + 16383}`, `bytes=${moov + 16384}-${moov + 2 * 16384 - 1}`]);
  });

  it('supports small unindexed fragmented files as a single segment and rejects huge ones', async () => {
    const file = new Uint8Array(100);
    const view = new DataView(file.buffer);
    for (const [offset, type, size] of [
      [0, 'ftyp', 16],
      [16, 'moov', 16],
      [32, 'moof', 16],
      [48, 'mdat', 52],
    ] as const) {
      view.setUint32(offset, size);
      file.set(
        [...type].map((char) => char.charCodeAt(0)),
        offset + 4
      );
    }
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(file, {headers: {'Content-Length': '100'}}));
    vi.stubGlobal('fetch', fetchMock);
    const xml = mpd(period(video('<BaseURL>video.mp4</BaseURL>')));
    const track = (await resolve(xml)).renditions[0]!;
    expect(track.segments).toEqual([{url: 'https://example.com/video.mp4', duration: 4, byteRange: {offset: 32, length: 68}}]);
    // the probe reads past the first boxes of a large file, so serve more than its 16 KiB
    const large = new Uint8Array(32 * 1024);
    large.set(file);
    fetchMock.mockImplementation(async () => new Response(large, {headers: {'Content-Length': String(128 * 1024 * 1024)}}));
    await expect(resolve(xml)).rejects.toThrow(/64 MiB/);
  });
});

describe('single-MPD Periods and pre-authored splices', () => {
  it('infers Period durations from starts, stitches timestamp resets and replaces initialization maps', async () => {
    const xml = mpd(period(video(), 'id="content"') + period(video(template.replaceAll('init.mp4', 'ad-init.mp4'), 'ad'), 'id="ad" start="PT4S"'), 8);
    const manifest = await resolve(xml);
    expect(manifest.duration).toBe(8);
    expect(manifest.periods!.map(({start, duration}) => ({start, duration}))).toEqual([
      {start: 0, duration: 4},
      {start: 4, duration: 4},
    ]);
    const track = manifest.renditions[0]!;
    expect(track.segments.map((segment) => segment.duration)).toEqual([2, 2, 2, 2]);
    const playlist = writeDashMediaPlaylist(track);
    expect(playlist).toContain('#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="https://example.com/ad-init.mp4"\n#EXTINF:2,');
    expect(playlist.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    expect(manifest.periods![0]!.renditions[0]!.segments).toHaveLength(2);
  });

  it('infers starts from durations and supports content/ad/content without an MPD duration', async () => {
    const xml = `<MPD>${period(video(), 'duration="PT4S"')}${period(video(), 'duration="PT2S"')}${period(video(), 'duration="PT4S"')}</MPD>`;
    const manifest = await resolve(xml);
    expect(manifest.duration).toBe(10);
    expect(manifest.periods!.map((value) => value.start)).toEqual([0, 4, 6]);
    expect(manifest.renditions[0]!.segments.filter((segment) => segment.discontinuity)).toHaveLength(2);
  });

  it('normalizes a nonzero first Period start to the playable duration', async () => {
    const manifest = await resolve(mpd(period(video(), 'start="PT10S"'), 14));
    expect(manifest.presentationStart).toBe(10);
    expect(manifest.duration).toBe(4);
    expect(manifest.renditions[0]!.segments).toHaveLength(2);
  });

  it('matches reordered audio by language and preserves audio/video discontinuity alignment', async () => {
    const manifest = await resolve(mpd(period(video() + audio('en') + audio('fr'), 'duration="PT4S"') + period(video() + audio('fr', 'ad-fr') + audio('en', 'ad-en'), 'duration="PT4S"'), 8));
    expect(manifest.renditions.map((track) => track.language)).toEqual([undefined, 'en', 'fr']);
    expect(manifest.renditions.every((track) => track.segments[2]!.discontinuity)).toBe(true);
    expect(manifest.renditions.every((track) => track.segments.reduce((sum, segment) => sum + segment.duration, 0) === 8)).toBe(true);
  });

  it('clips each Period index to its own duration, not the whole MPD', async () => {
    const addressing = '<BaseURL>video.mp4</BaseURL><SegmentBase indexRange="0-67"><Initialization range="68-99"/></SegmentBase>';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async () => new Response(createSidx(), {status: 206}))
    );
    const manifest = await resolve(mpd(period(video(addressing), 'duration="PT4S"') + period(video(addressing), 'duration="PT2S"'), 6));
    expect(manifest.renditions[0]!.segments.map((segment) => segment.duration)).toEqual([2, 2, 2]);
    expect(manifest.renditions[0]!.segments[2]!.discontinuity).toBe(true);
  });

  it('keeps an AAC tail tolerance from moving subsequent Period audio boundaries', async () => {
    const audioBase = `<AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" audioSamplingRate="24000"><Representation id="a" bandwidth="1">
      <BaseURL>audio.mp4</BaseURL><SegmentBase indexRange="0-43"><Initialization range="44-99"/></SegmentBase></Representation></AdaptationSet>`;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async () => new Response(createSidx({timescale: 24000, references: [{size: 100, duration: 95488}]}), {status: 206}))
    );
    const manifest = await resolve(mpd(period(video() + audioBase, 'duration="PT4S"') + period(video() + audioBase, 'duration="PT4S"'), 8));
    const audioTrack = manifest.renditions.find((track) => track.type === 'audio')!;
    expect(audioTrack.segments[0]!.duration).toBe(4);
    expect(audioTrack.segments[1]!.discontinuity).toBe(true);
    expect(audioTrack.segments[1]!.duration).toBe(95488 / 24000);
    expect(manifest.periods![0]!.renditions.find((track) => track.type === 'audio')!.segments[0]!.duration).toBe(95488 / 24000);
  });

  it('supports an ad with fewer video variants using compatible bandwidth matching', async () => {
    const ladder = video().replace('</AdaptationSet>', '<Representation id="high" bandwidth="2000000"/></AdaptationSet>');
    const manifest = await resolve(mpd(period(ladder, 'duration="PT4S"') + period(video(template, 'ad'), 'duration="PT4S"'), 8));
    expect(manifest.renditions).toHaveLength(2);
    expect(manifest.renditions.every((track) => track.segments.length === 4)).toBe(true);
  });

  it.each([
    ['gap', mpd(period(video(), 'duration="PT2S"') + period(video(), 'start="PT3S"'), 7), /gaps and overlaps/],
    ['overlap', mpd(period(video(), 'duration="PT4S"') + period(video(), 'start="PT3S"'), 7), /gaps and overlaps/],
    ['inconsistent duration', mpd(period(video(), 'duration="PT4S"'), 5), /do not match/],
    ['missing duration', '<MPD>' + period() + '</MPD>', /duration is required/],
    ['codec change', mpd(period(video(), 'duration="PT4S"') + period(video(template, 'v', 'hvc1.1.6.L93.B0'), 'duration="PT4S"'), 8), /compatible codecs/],
    [
      'frame-rate change',
      mpd(period(video().replace('mimeType=', 'frameRate="25" mimeType='), 'duration="PT4S"') + period(video().replace('mimeType=', 'frameRate="24" mimeType='), 'duration="PT4S"'), 8),
      /frame rates/,
    ],
    ['track removal', mpd(period(video() + audio('en'), 'duration="PT4S"') + period(video(), 'duration="PT4S"'), 8), /add or remove/],
    ['language substitution', mpd(period(video() + audio('en'), 'duration="PT4S"') + period(video() + audio('fr'), 'duration="PT4S"'), 8), /identities/],
  ])('explicitly rejects unsafe Period timing/transitions: %s', async (_name, xml, error) => {
    await expect(resolve(xml)).rejects.toThrow(error);
  });
});
