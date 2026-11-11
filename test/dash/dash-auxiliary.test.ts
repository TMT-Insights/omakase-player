// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {firstValueFrom} from 'rxjs';
import {parseDashManifest} from '../../src/dash/dash-manifest';
import {loadDashAuxiliaryTracks} from '../../src/dash/dash-auxiliary';
import {AuthConfig} from '../../src/common';
import {parseDashTextInitialization, parseDashTextSamples, parseDashWvttSample} from '../../src/dash/dash-text-mp4';
import {SegmentedImscTextTrackController} from '../../src/text/segmented-imsc-text-track-controller';
import {TextTrackControllerFactory} from '../../src/text/text-track-controller-factory';
import type {PlayerController} from '../../src/player/player-controller-api';
import {TextTrackFile} from '../../src/media';
import {MediaDeserializer} from '../../src/media/media-deserializer';
import {TrackRepository} from '../../src/repository';
import {TrackUtils} from '../../src/track/track-utils';
import {UrlUtil} from '../../src/util/url-util';
import {resolveDashSegmentIndexes} from '../../src/dash/dash-segment-index';
import {createSidx} from './sidx-fixture';

vi.hoisted(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
});

vi.mock('media-captions', () => ({
  CaptionsRenderer: class {},
  parseResponse: vi.fn(),
}));

const source = 'https://example.com/main.mpd';
const video = '<AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e"><SegmentTemplate duration="2" initialization="init" media="$Number$"/><Representation id="v" bandwidth="1"/></AdaptationSet>';
const text = (body: string, mime = 'text/vtt', attrs = '') => `<AdaptationSet mimeType="${mime}" lang="en" ${attrs}>${body}<Representation id="en"/></AdaptationSet>`;
const mpd = (auxiliary: string, duration = 4) => `<MPD mediaPresentationDuration="PT${duration}S"><Period>${video}${auxiliary}</Period></MPD>`;
const vtt = 'WEBVTT\n\n00:00:00.500 --> 00:00:03.500 line:80% align:start\n<b>Hello</b>\n';
const ttml =
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><head><styling><style xml:id="red" tts:color="red"/></styling></head><body><div><p begin="0.5s" end="3.5s" style="red">Hello</p></div></body></tt>';
let resources: {data: BlobPart[]; mime: string}[];
const createResource = (data: BlobPart[], mime: string) => {
  resources.push({data, mime});
  return `blob:aux-${resources.length}`;
};
const load = (xml: string) => firstValueFrom(loadDashAuxiliaryTracks(parseDashManifest(xml, source), createResource));
/** Two segments: never a direct sidecar, so the cues are downloaded and normalized. */
const segmented = (extension = 'vtt') => `<SegmentTemplate duration="2" media="$Number$.${extension}"/>`;
/** One byte-ranged file: no URL addresses it, so it is downloaded and normalized. */
const ranged = (content: string, extension = 'vtt') => `<SegmentList><SegmentURL media="en.${extension}" mediaRange="0-${new TextEncoder().encode(content).length - 1}"/></SegmentList>`;

beforeEach(() => {
  resources = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async () => new Response(vtt))
  );
});
afterEach(() => {
  AuthConfig.authentication = undefined;
  vi.unstubAllGlobals();
});

describe('DASH auxiliary tracks', () => {
  it('keeps generated blob thumbnail URLs absolute when consumed by thumbnail fetchers', () => {
    const blob = 'blob:https://example.com/image#xywh=0,0,100,50';
    expect(UrlUtil.absolutizeUrl('blob:https://example.com', blob)).toBe(blob);
    expect(UrlUtil.absolutizeUrl('https://example.com/images', 'sheet.jpg')).toBe('https://example.com/images/sheet.jpg');
    expect(UrlUtil.absolutizeUrl('https://example.com/images', 'https://cdn.example.com/sheet.jpg')).toBe('https://cdn.example.com/sheet.jpg');
  });
  it('hands a single unshifted WebVTT file to the text track by URL, with language and roles', async () => {
    const [track] = await load(mpd(text('<BaseURL>en.vtt</BaseURL><Role value="caption"/><Role value="main"/>')));
    expect(track!.state).toMatchObject({kind: 'captions', srclang: 'en', default: true, sourceFileFormatType: 'VTT', customAttrs: {dashAuxiliary: true}});
    expect(track!.source).toMatchObject({url: 'https://example.com/en.vtt'});
    expect(track!.areTimedItemsFetched).toBeFalsy();
    expect(fetch).not.toHaveBeenCalled();
    expect(resources).toHaveLength(0);
  });

  it('hands a single unshifted TTML file to the text track by URL', async () => {
    const [track] = await load(mpd(text('<BaseURL>en.ttml</BaseURL>', 'application/ttml+xml')));
    expect(track!.state).toMatchObject({sourceFileFormatType: 'TTML', srclang: 'en'});
    expect(track!.source).toMatchObject({url: 'https://example.com/en.ttml'});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes a sidecar that needs a time shift instead of passing it through', async () => {
    const xml = mpd(text('<BaseURL>en.vtt</BaseURL><SegmentBase timescale="1" presentationTimeOffset="1"/>'));
    await load(xml);
    expect(fetch).toHaveBeenCalledOnce();
    expect(resources[0]!.data.join('')).toContain('00:00:00.000 --> 00:00:02.500');
  });

  it('downloads and normalizes WebVTT markup and settings', async () => {
    await load(mpd(text(ranged(vtt))));
    expect(resources[0]!.data.join('')).toContain('00:00:00.500 --> 00:00:03.500 line:80% align:start\n<b>Hello</b>');
    expect(fetch).toHaveBeenCalledWith('https://example.com/en.vtt', expect.objectContaining({signal: expect.any(AbortSignal)}));
  });

  it('maps segmented cues using PTO, clips boundaries, preserves settings and permits sparse timelines', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(vtt.replaceAll('00:00:00.500', '00:00:10.500').replaceAll('00:00:03.500', '00:00:13.500')));
    const [track] = await load(
      mpd(text('<SegmentTemplate timescale="1" presentationTimeOffset="10" media="$Time$.vtt"><SegmentTimeline><S t="10" d="1"/><S t="12" d="1"/></SegmentTimeline></SegmentTemplate>'))
    );
    expect(track!.areTimedItemsFetched).toBe(true);
    expect(resources[0]!.data.join('')).toContain('00:00:00.500 --> 00:00:01.000');
    expect(resources[0]!.data.join('')).toContain('00:00:02.000 --> 00:00:03.000');
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['https://example.com/10.vtt', 'https://example.com/12.vtt']);
  });

  it('applies WebVTT timestamp maps and inline timestamps', async () => {
    const mapped = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:10.000,MPEGTS:0\n\n00:00:10.500 --> 00:00:11.500\n<00:00:10.750>Hello';
    vi.mocked(fetch).mockImplementation(async () => new Response(mapped));
    await load(mpd(text(ranged(mapped))));
    expect(resources[0]!.data.join('')).toContain('00:00:00.500 --> 00:00:01.500\n<00:00:00.750>Hello');
  });

  it('stitches auxiliary tracks across Periods and normalizes a nonzero first start', async () => {
    const period = `<Period duration="PT4S">${video}${text('<BaseURL>en.vtt</BaseURL>')}</Period>`;
    const xml = `<MPD mediaPresentationDuration="PT13S">${period.replace('<Period ', '<Period start="PT5S" ')}${period}</MPD>`;
    const tracks = await load(xml);
    expect(tracks).toHaveLength(1);
    expect(resources[0]!.data.join('')).toContain('00:00:04.500 --> 00:00:07.500');
    expect(resources[0]!.data.join('')).toContain('00:00:00.500 --> 00:00:03.500');
  });

  it('preserves styled TTML documents as well as normalized cue data', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(ttml));
    const [track] = await load(mpd(text(ranged(ttml, 'ttml'), 'application/ttml+xml')));
    expect(track!.state).toMatchObject({imscDocuments: [{url: 'blob:aux-1', start: 0, end: 4, timeOffset: 0}]});
    expect(resources[0]!.data[0]).toBe(ttml);
    expect(resources[1]!.data.join('')).toContain('Hello');
  });

  it('retains TTML cues that begin at zero', async () => {
    const zero = ttml.replace('begin="0.5s"', 'begin="0s"');
    vi.mocked(fetch).mockResolvedValue(new Response(zero));
    await load(mpd(text(ranged(zero, 'ttml'), 'application/ttml+xml')));
    expect(resources.at(-1)!.data.join('')).toContain('00:00:00.000 --> 00:00:03.500\nHello');
  });

  it('creates tiled thumbnail VTT referencing the images by URL, without squeezing the final partial sprite sheet', async () => {
    await load(
      mpd(
        '<AdaptationSet mimeType="image/jpeg"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/thumbnail_tile" value="2x2"/><SegmentTemplate duration="8" media="$Number$.jpg"/><Representation id="images" width="200" height="100"/></AdaptationSet>',
        10
      )
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(resources).toHaveLength(1);
    const output = resources[0]!.data.join('');
    expect(output).toContain('00:00:00.000 --> 00:00:02.000\nhttps://example.com/1.jpg#xywh=0,0,100,50');
    expect(output).toContain('00:00:06.000 --> 00:00:08.000\nhttps://example.com/1.jpg#xywh=100,50,100,50');
    expect(output).toContain('00:00:08.000 --> 00:00:10.000\nhttps://example.com/2.jpg#xywh=0,0,100,50');
    expect(output).not.toContain('2.jpg#xywh=100');
  });

  it('downloads only byte-range thumbnail sprites, which no URL can address', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), {status: 206}));
    await load(mpd('<AdaptationSet mimeType="image/jpeg"><SegmentList duration="4"><SegmentURL media="sprites.bin" mediaRange="0-2"/></SegmentList><Representation id="images"/></AdaptationSet>'));
    expect(fetch).toHaveBeenCalledOnce();
    expect(resources[0]!.mime).toBe('image/jpeg');
    expect(resources.at(-1)!.data.join('')).toContain('00:00:00.000 --> 00:00:04.000\nblob:aux-1');
  });

  it('supports byte-range raw resources when the server ignores Range and authenticates them', async () => {
    AuthConfig.authentication = {type: 'custom', headers: () => ({headers: {'X-Test': 'secret'}})};
    const encoded = new TextEncoder().encode(vtt);
    const bytes = new Uint8Array(encoded.length + 20);
    bytes.set(encoded, 10);
    vi.mocked(fetch).mockResolvedValue(new Response(bytes));
    await load(mpd(text(`<SegmentList><SegmentURL media="subtitles.bin" mediaRange="10-${encoded.length + 9}"/></SegmentList>`)));
    const headers = new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers);
    expect(headers.get('X-Test')).toBe('secret');
    expect(headers.get('Range')).toBe(`bytes=10-${encoded.length + 9}`);
    expect(resources[0]!.data.join('')).toContain('Hello');
  });

  it.each(['truncated', 'oversized'])('rejects a %s HTTP 206 auxiliary response', async (kind) => {
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array(kind === 'truncated' ? 5 : 11), {status: 206}));
    await expect(load(mpd(text('<SegmentList><SegmentURL media="en.vtt" mediaRange="10-19"/></SegmentList>')))).rejects.toThrow(new RegExp(kind));
  });

  it('rejects auxiliary requests exceeding the declared byte limit before downloading', async () => {
    await expect(load(mpd(text('<SegmentList><SegmentURL media="en.vtt" mediaRange="0-33554432"/></SegmentList>')))).rejects.toThrow(/32 MiB/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts pending auxiliary requests on unsubscription', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_url, init) => {
      requestSignal = init!.signal!;
      return new Promise((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    });
    const subscription = loadDashAuxiliaryTracks(parseDashManifest(mpd(text(segmented())), source), createResource).subscribe();
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    subscription.unsubscribe();
    expect(requestSignal!.aborted).toBe(true);
    expect(resources).toHaveLength(0);
  });

  it.each([403, 404, 500])('surfaces HTTP %s instead of silently dropping subtitles', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response('', {status}));
    await expect(load(mpd(text(segmented())))).rejects.toThrow(`HTTP ${status}`);
  });

  it('rejects invalid VTT, malformed tiles and encrypted/out-of-scope tracks', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('invalid'));
    await expect(load(mpd(text(segmented())))).rejects.toThrow(/WebVTT/);
    expect(() =>
      parseDashManifest(mpd('<AdaptationSet mimeType="image/jpeg"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/thumbnail_tile" value="0x2"/><Representation/></AdaptationSet>'), source)
    ).toThrow(/thumbnail/);
    expect(() => parseDashManifest(mpd(text('<EssentialProperty schemeIdUri="http://dashif.org/guidelines/thumbnail_tile" value="2x2"/>')), source)).toThrow(/EssentialProperty/);
  });
});

function concat(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(arrays.reduce((length, data) => length + data.length, 0));
  let offset = 0;
  for (const data of arrays) {
    result.set(data, offset);
    offset += data.length;
  }
  return result;
}
function uints(...values: number[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(values.length * 4);
  const view = new DataView(result.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return result;
}
function box(type: string, ...data: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const payload = concat(...data);
  return concat(uints(payload.length + 8), new TextEncoder().encode(type), payload);
}
function initialization(codec: 'wvtt' | 'stpp'): Uint8Array<ArrayBuffer> {
  return box('moov', box('trak', box('tkhd', uints(0, 0, 0, 1)), box('mdia', box('mdhd', uints(0, 0, 0, 1000)), box('minf', box('stbl', box('stsd', uints(0, 1), box(codec)))))));
}
function fragment(payload: Uint8Array, time = 500): Uint8Array<ArrayBuffer> {
  const moof = (offset: number) => box('moof', box('traf', box('tfhd', uints(0x020000, 1)), box('tfdt', uints(0, time)), box('trun', uints(0x301, 1, offset, 2000, payload.length))));
  return concat(moof(moof(0).length + 8), box('mdat', payload));
}

describe('fragmented MP4 subtitles', () => {
  it('retains sparse SIDX subtitle timestamps independently of A/V coverage', async () => {
    const manifest = parseDashManifest(
      mpd(text('<BaseURL>text.mp4</BaseURL><SegmentBase indexRange="100-143"><Initialization range="0-99"/></SegmentBase>', 'application/mp4', 'codecs="wvtt"')),
      source
    );
    vi.mocked(fetch).mockResolvedValue(new Response(createSidx({earliestTime: 500, references: [{size: 100, duration: 2000}]}), {status: 206}));
    const resolved = await firstValueFrom(resolveDashSegmentIndexes(manifest));
    expect(resolved.auxiliaryPeriods![0]!.renditions[0]!.segments).toEqual([{url: 'https://example.com/text.mp4', duration: 2, presentationTime: 0.5, byteRange: {offset: 144, length: 100}}]);
  });

  it('demuxes wvtt and retains cue positioning', () => {
    const track = parseDashTextInitialization(initialization('wvtt'), 'wvtt');
    const sample = parseDashTextSamples(fragment(box('vttc', box('payl', new TextEncoder().encode('Hello')), box('sttg', new TextEncoder().encode('line:80%')))), track)[0]!;
    expect(sample).toMatchObject({time: 0.5, duration: 2});
    expect(parseDashWvttSample(sample)).toEqual([{text: 'Hello', settings: 'line:80%', id: ''}]);
  });

  describe('DASH styled text integration', () => {
    it('retains IMSC metadata when serialized and preloaded into distinct sidecar tracks', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(ttml));
      const [track] = await load(mpd(text(ranged(ttml, 'ttml'), 'application/ttml+xml')));
      const restored = MediaDeserializer.createTrack(track!.state);
      expect(restored.state).toMatchObject({imscDocuments: [{start: 0, end: 4}]});
      const repository = new TrackRepository();
      repository.add(restored);
      const utils = new TrackUtils(repository);
      const first = await firstValueFrom(utils.preloadTrack(restored.id));
      const second = await firstValueFrom(utils.preloadTrack(restored.id));
      expect(first.id).not.toBe(second.id);
      expect(first.state).toMatchObject({imscDocuments: [{start: 0, end: 4}], relations: [{entityId: restored.id}]});
      expect(TextTrackControllerFactory.create(first.state, {} as PlayerController)).toBeInstanceOf(SegmentedImscTextTrackController);
      utils.destroy();
      repository.destroy();
    });

    it('selects styled documents on normalized Period times and clears gaps', async () => {
      class TestController extends SegmentedImscTextTrackController {
        at(time: number) {
          return this.generateISD(time);
        }
      }
      const state = new TextTrackFile({
        imscDocuments: [
          {url: 'blob:one', start: 5, end: 9, timeOffset: 5},
          {url: 'blob:two', start: 10, end: 14, timeOffset: 10},
        ],
      }).state;
      vi.mocked(fetch).mockImplementation(async () => new Response(ttml));
      const controller = new TestController(state, {} as PlayerController);
      await firstValueFrom(controller.loadSource());
      expect(controller.at(4).contents).toEqual([]);
      expect(controller.at(6).contents.length).toBeGreaterThan(0);
      expect(JSON.stringify(controller.at(6))).toContain('Hello');
      expect(controller.at(9.5).contents).toEqual([]);
      expect(JSON.stringify(controller.at(11))).toContain('Hello');
      expect(controller.at(14).contents).toEqual([]);
      controller.destroy();
    });
  });

  it.each(['wvtt', 'stpp'] as const)('loads %s through MPD addressing into text tracks', async (codec) => {
    const payload = codec === 'wvtt' ? box('vttc', box('payl', new TextEncoder().encode('Hello'))) : new TextEncoder().encode(ttml);
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(initialization(codec)))
      .mockResolvedValueOnce(new Response(fragment(payload)));
    const tracks = await load(mpd(text('<SegmentTemplate duration="4" initialization="text-init" media="text-$Number$"/>', 'application/mp4', `codecs="${codec}"`)));
    expect(tracks).toHaveLength(1);
    expect(resources.at(-1)!.data.join('')).toContain('00:00:00.500 --> 00:00:02.500');
    if (codec === 'stpp') expect(tracks[0]!.state).toMatchObject({imscDocuments: [{start: 0.5, end: 2.5}]});
  });

  it('handles empty wvtt samples and rejects malformed sample offsets and boxes', () => {
    expect(parseDashWvttSample({time: 0, duration: 1, data: box('vtte')})).toEqual([]);
    const track = parseDashTextInitialization(initialization('wvtt'), 'wvtt');
    expect(() => parseDashTextSamples(fragment(box('vtte')).subarray(0, 30), track)).toThrow(/box/);
    expect(() => parseDashTextInitialization(initialization('wvtt'), 'stpp')).toThrow(/matching/);
    expect(() => parseDashWvttSample({time: 0, duration: 1, data: box('vttc')})).toThrow(/payl/);
  });
});
