// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {firstValueFrom} from 'rxjs';
import {AuthConfig} from '../../src/common/authentication';
import {parseDashManifest, writeDashMediaPlaylist, type DashRendition} from '../../src/dash/dash-manifest';
import {parseDashSegmentIndex, resolveDashSegmentIndexes} from '../../src/dash/dash-segment-index';
import {createSidx} from './sidx-fixture';

const sourceUrl = 'https://example.com/media/manifest.mpd';
const xml = `<MPD mediaPresentationDuration="PT5S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e">
  <Representation id="v" bandwidth="1000000"><BaseURL>video.mp4</BaseURL>
  <SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase>
  </Representation></AdaptationSet></Period></MPD>`;
const rendition = () => parseDashManifest(xml, sourceUrl).renditions[0]!;
const rangeResponse = (data = createSidx()) => new Response(data, {status: 206, headers: {'Content-Range': 'bytes 100-167/1000'}});

afterEach(() => {
  AuthConfig.authentication = undefined;
  vi.unstubAllGlobals();
});

describe('DASH SIDX parsing', () => {
  it('resolves version 0 references, first_offset and the final clipped duration', () => {
    expect(parseDashSegmentIndex(createSidx({firstOffset: 12}), rendition(), 5)).toEqual([
      {url: 'https://example.com/media/video.mp4', duration: 2, byteRange: {offset: 180, length: 100}},
      {url: 'https://example.com/media/video.mp4', duration: 2, byteRange: {offset: 280, length: 200}},
      {url: 'https://example.com/media/video.mp4', duration: 1, byteRange: {offset: 480, length: 300}},
    ]);
  });

  it('supports version 1 timing and offsets beyond 32 bits with a different MPD timescale', () => {
    const track = rendition();
    track.presentationTimeOffset = 2 ** 32 / 1000;
    const data = createSidx({version: 1, earliestTime: 2 ** 32, firstOffset: 2 ** 32});
    expect(parseDashSegmentIndex(data, track, 5)[0]?.byteRange).toEqual({offset: 100 + data.byteLength + 2 ** 32, length: 100});
  });

  it('accepts a video composition offset without changing byte ranges or fragment durations', () => {
    const data = createSidx({
      timescale: 90000,
      earliestTime: 7200,
      references: [
        {size: 100, duration: 187200},
        {size: 200, duration: 187200},
        {size: 300, duration: 57600},
      ],
    });
    const segments = parseDashSegmentIndex(data, rendition(), 4.8);
    expect(segments).toHaveLength(3);
    [2.08, 2.08, 0.64].forEach((duration, index) => expect(segments[index]?.duration).toBeCloseTo(duration, 9));
    expect(segments[0]?.byteRange).toEqual({offset: 100 + data.byteLength, length: 100});
    expect(segments.reduce((total, segment) => total + segment.duration, 0)).toBeCloseTo(4.8);
  });

  it('still rejects indexes that require a leading presentation trim', () => {
    const track = {...rendition(), presentationTimeOffset: 1};
    expect(() => parseDashSegmentIndex(createSidx({earliestTime: 500}), track, 5)).toThrow(/leading trims/);
  });

  it('allows an AAC-LC tail shorter than one codec frame without padding or stretching audio', () => {
    const track: DashRendition = {...rendition(), type: 'audio', codecs: 'mp4a.40.2', audioSamplingRate: 24000};
    const data = createSidx({timescale: 24000, references: [{size: 100, duration: 119488}]});
    const segments = parseDashSegmentIndex(data, track, 5);
    expect(segments[0]?.duration).toBe(119488 / 24000);
    expect(() => parseDashSegmentIndex(data, track, 119488 / 24000 + 1024 / 24000)).not.toThrow();
    expect(() => parseDashSegmentIndex(data, track, 119488 / 24000 + 1025 / 24000)).toThrow(/cover/);
    expect(() => parseDashSegmentIndex(data, track, 5.1)).toThrow(/cover/);
    expect(() => parseDashSegmentIndex(data, {...track, audioSamplingRate: undefined}, 5)).toThrow(/cover/);
    expect(() => parseDashSegmentIndex(data, {...track, codecs: 'other'}, 5)).toThrow(/cover/);
    expect(() => parseDashSegmentIndex(data, {...track, type: 'video'}, 5)).toThrow(/cover/);
  });

  it('computes offsets from the end of the SIDX box, not the end of indexRange', () => {
    const index = createSidx();
    const data = new ArrayBuffer(index.byteLength + 16);
    const view = new DataView(data);
    view.setUint32(0, 8);
    new Uint8Array(data, 4, 4).set([0x66, 0x72, 0x65, 0x65]);
    new Uint8Array(data, 8, index.byteLength).set(new Uint8Array(index));
    view.setUint32(index.byteLength + 8, 8);
    expect(parseDashSegmentIndex(data, rendition(), 5)[0]?.byteRange?.offset).toBe(100 + 8 + index.byteLength);
  });

  it('supports extended-size box headers', () => {
    const index = createSidx();
    const data = new ArrayBuffer(index.byteLength + 8);
    const view = new DataView(data);
    view.setUint32(0, 1);
    view.setUint32(12, data.byteLength);
    new Uint8Array(data, 4, 4).set(new Uint8Array(index, 4, 4));
    new Uint8Array(data, 16).set(new Uint8Array(index, 8));
    expect(parseDashSegmentIndex(data, rendition(), 5)[0]?.byteRange?.offset).toBe(100 + data.byteLength);
  });

  it.each([
    ['unsupported version', () => createSidx({version: 2}), /version/],
    ['zero timescale', () => createSidx({timescale: 0}), /timescale/],
    ['zero duration', () => createSidx({references: [{size: 100, duration: 0}]}), /size or duration/],
    ['zero size', () => createSidx({references: [{size: 0, duration: 5000}]}), /size or duration/],
    ['empty references', () => createSidx({references: []}), /empty/],
    ['hierarchical references', () => createSidx({references: [{size: 100, duration: 5000, hierarchical: true}]}), /hierarchical/],
    ['incomplete coverage', () => createSidx({references: [{size: 100, duration: 1000}]}), /cover/],
    ['truncated box', () => createSidx().slice(0, 20), /truncated/],
    ['unsafe 64-bit offset', () => createSidx({version: 1, firstOffset: 2 ** 53}), /64-bit/],
    ['missing SIDX', () => new ArrayBuffer(0), /no SIDX/],
  ])('explicitly rejects %s', (_name, data, error) => {
    expect(() => parseDashSegmentIndex(data(), rendition(), 5)).toThrow(error);
  });
});

describe('DASH index loading', () => {
  it('requests authenticated byte ranges and writes exact HLS initialization and segment byte ranges', async () => {
    AuthConfig.authentication = {type: 'custom', headers: () => ({headers: {'X-Test': 'test'}})};
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(rangeResponse());
    vi.stubGlobal('fetch', fetchMock);
    const manifest = await firstValueFrom(resolveDashSegmentIndexes(parseDashManifest(xml, sourceUrl)));
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.com/media/video.mp4');
    expect(new Headers(options?.headers).get('Range')).toBe('bytes=100-167');
    expect(new Headers(options?.headers).get('X-Test')).toBe('test');
    expect(writeDashMediaPlaylist(manifest.renditions[0]!)).toBe(
      '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n' +
        '#EXT-X-MAP:URI="https://example.com/media/video.mp4",BYTERANGE="100@0"\n' +
        '#EXTINF:2.000000000,\n#EXT-X-BYTERANGE:100@168\nhttps://example.com/media/video.mp4\n' +
        '#EXTINF:2.000000000,\n#EXT-X-BYTERANGE:200@268\nhttps://example.com/media/video.mp4\n' +
        '#EXTINF:1.000000000,\n#EXT-X-BYTERANGE:300@468\nhttps://example.com/media/video.mp4\n#EXT-X-ENDLIST\n'
    );
  });

  it('does not require Content-Range to be CORS-exposed when the response size is correct', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(createSidx(), {status: 206})));
    await expect(firstValueFrom(resolveDashSegmentIndexes(parseDashManifest(xml, sourceUrl)))).resolves.toMatchObject({duration: 5});
  });

  it('extracts SIDX at its absolute offset when the server ignores Range and returns HTTP 200', async () => {
    const file = new Uint8Array(1000);
    file.set(new Uint8Array(createSidx()), 100);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(file)));
    const manifest = await firstValueFrom(resolveDashSegmentIndexes(parseDashManifest(xml, sourceUrl)));
    expect(manifest.renditions[0]?.segments).toEqual(parseDashSegmentIndex(createSidx(), rendition(), 5));
  });

  it('streams past the prefix, retains only the index, and cancels the rest of the full-file body', async () => {
    const file = new Uint8Array(1000);
    file.set(new Uint8Array(createSidx()), 100);
    const cancel = vi.fn();
    const chunks = [file.slice(0, 60), file.slice(60, 110), file.slice(110, 150), file.slice(150, 200)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
    const manifest = await firstValueFrom(resolveDashSegmentIndexes(parseDashManifest(xml, sourceUrl)));
    expect(manifest.renditions[0]?.segments).toHaveLength(3);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([
    [() => new Response('', {status: 403}), /HTTP 403/],
    [() => new Response(createSidx()), /truncated SIDX full-file response/],
    [() => new Response(null), /empty SIDX full-file response/],
    [() => new Response(null, {status: 204}), /unexpected HTTP 204/],
    [() => new Response(createSidx(), {status: 206, headers: {'Content-Range': 'bytes 0-67/1000'}}), /Content-Range/],
    [() => rangeResponse(createSidx().slice(0, 20)), /range response/],
  ])('surfaces invalid index responses', async (response, error) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response()));
    await expect(firstValueFrom(resolveDashSegmentIndexes(parseDashManifest(xml, sourceUrl)))).rejects.toThrow(error);
  });

  it('checks video segment alignment after resolving all indexes', async () => {
    const manifest = parseDashManifest(xml, sourceUrl);
    const other: DashRendition = {...manifest.renditions[0]!, id: 'other'};
    manifest.renditions.push(other);
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(rangeResponse())
        .mockResolvedValueOnce(
          rangeResponse(
            createSidx({
              references: [
                {size: 100, duration: 1000},
                {size: 200, duration: 3000},
                {size: 300, duration: 2000},
              ],
            })
          )
        )
    );
    await expect(firstValueFrom(resolveDashSegmentIndexes(manifest))).rejects.toThrow(/aligned segment boundaries/);
  });

  it('limits index request sizes before fetching', async () => {
    const manifest = parseDashManifest(xml.replace('100-167', '100-99999999'), sourceUrl);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => resolveDashSegmentIndexes(manifest)).toThrow(/exceeds/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
