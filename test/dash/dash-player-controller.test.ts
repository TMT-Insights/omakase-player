// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, type MockInstance, vi} from 'vitest';
import {firstValueFrom, map, of, Subject, throwError} from 'rxjs';
import type {Track} from '../../src/media';
import {TextTrackFile, ThumbnailTrack} from '../../src/media';
import {UrlSource} from '../../src/source';
import {DashMainMedia} from '../../src/dash/dash-main-media';
import type {LoadMainMediaArgsType, PlayerDomController} from '../../src/player/player-controller-api';

const {loadHls, destroyHls, configureHls} = vi.hoisted(() => ({loadHls: vi.fn(), destroyHls: vi.fn(), configureHls: vi.fn()}));
vi.mock('../../src/hls/hls-player-controller', async () => {
  const {ObserverBreaker} = await import('../../src/common/observer-breaker');
  return {
    HlsPlayerController: class {
      constructor(...args: unknown[]) {
        configureHls(...args);
      }
      protected _loadBreaker = new ObserverBreaker();
      protected _destroyBreaker = new ObserverBreaker();
      loadMainMedia(args: LoadMainMediaArgsType) {
        return loadHls(args);
      }
      destroyHls() {
        destroyHls();
      }
      unwireEvents() {}
      destroy() {
        this._destroyBreaker.destroy();
      }
    },
  };
});

import {DashPlayerController} from '../../src/dash/dash-player-controller';
import {AuthConfig} from '../../src/common/authentication';
import {SyntheticManifestLoader} from '../../src/hls/synthetic-manifest-loader';
import {SyntheticManifestRegistry} from '../../src/hls/synthetic-manifest-registry';
import {createSidx} from './sidx-fixture';

const xml = `<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e" frameRate="25">
  <SegmentTemplate duration="2" initialization="init.mp4" media="$Number$.m4s"/><Representation id="v" bandwidth="1000000"/>
  </AdaptationSet></Period></MPD>`;
const args: LoadMainMediaArgsType = {
  url: 'https://example.com/manifest.mpd',
  loadOptions: {frameRate: 25},
  mainMediaEssentialArgsHook: () => of(void 0),
  tracksCreatedHook: () => of(void 0),
};
let controller: DashPlayerController;
let blobs: Blob[];
let revoke: ReturnType<typeof vi.fn<(url: string) => void>>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

const segmentBaseXml = (base = '<BaseURL>video.mp4</BaseURL>') =>
  xml.replace('<SegmentTemplate duration="2" initialization="init.mp4" media="$Number$.m4s"/>', `${base}<SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase>`);
/** Synthetic master handed to hls.js by the most recent load. */
const masterUrl = (): string => loadHls.mock.calls.at(-1)![0].url;
const master = (): string => SyntheticManifestRegistry.get(masterUrl())!;
/** Media playlist URLs in master order: alternate audio (EXT-X-MEDIA) first, then variants. */
const mediaUrls = (): string[] => [
  ...[...master().matchAll(/URI="([^"]+)"/g)].map((match) => match[1]!),
  ...master()
    .split('\n')
    .filter((line) => line && !line.startsWith('#')),
];
let registerSpy: MockInstance<typeof SyntheticManifestRegistry.register>;
let registerLazySpy: MockInstance<typeof SyntheticManifestRegistry.registerLazy>;
/** Every synthetic URL registered so far, so that tests can assert they are released. */
const registered = (): string[] => [...new Set([...registerSpy.mock.calls, ...registerLazySpy.mock.calls].map(([url]) => url))];
const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
const sidxResponse = (data = createSidx()) => new Response(data, {status: 206});

describe('DashPlayerController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blobs = [];
    revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL(blob: Blob) {
          blobs.push(blob);
          return `blob:dash-${blobs.length}`;
        }
        static override revokeObjectURL = revoke;
      }
    );
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(xml));
    vi.stubGlobal('fetch', fetchMock);
    loadHls.mockImplementation(() => of(true));
    registerSpy = vi.spyOn(SyntheticManifestRegistry, 'register');
    registerLazySpy = vi.spyOn(SyntheticManifestRegistry, 'registerLazy');
    controller = new DashPlayerController({} as PlayerDomController);
  });

  afterEach(() => {
    controller.destroy();
    AuthConfig.authentication = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches the MPD with authentication and passes a synthetic HLS master to the existing controller', async () => {
    AuthConfig.authentication = {type: 'custom', headers: () => ({headers: {'X-Test': 'test'}})};
    await expect(firstValueFrom(controller.loadMainMedia(args))).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(args.url, expect.objectContaining({headers: {'X-Test': 'test'}, signal: expect.any(AbortSignal)}));
    expect(loadHls).toHaveBeenCalledWith({...args, url: expect.stringMatching(/^https:\/\/dash\.omakase\.local\//), loadOptions: {...args.loadOptions, duration: 4}});
    expect(master()).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1000000');
    expect(SyntheticManifestRegistry.get(mediaUrls()[0]!)).toContain('#EXT-X-ENDLIST');
    expect(blobs).toHaveLength(0);
    expect(args.url).toBe('https://example.com/manifest.mpd');
  });

  it('resolves media paths against the final URL after redirects', async () => {
    const response = new Response(xml);
    Object.defineProperty(response, 'url', {value: 'https://cdn.example.com/redirected/manifest.mpd'});
    fetchMock.mockResolvedValue(response);
    await firstValueFrom(controller.loadMainMedia(args));
    const text = await SyntheticManifestRegistry.resolve(mediaUrls()[0]!)!;
    expect(text).toContain('https://cdn.example.com/redirected/init.mp4');
    expect(text).toContain('https://cdn.example.com/redirected/1.m4s');
  });

  it('resolves the initial SegmentBase index alongside the HLS load', async () => {
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml())).mockResolvedValueOnce(sidxResponse());
    await expect(firstValueFrom(controller.loadMainMedia(args))).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://example.com/video.mp4');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Range')).toBe('bytes=100-167');
    expect(loadHls).toHaveBeenCalledOnce();
    expect(SyntheticManifestRegistry.get(mediaUrls()[0]!)).toContain('#EXT-X-BYTERANGE:100@168');
  });

  it('accepts a full-file HTTP 200 response when loading SegmentBase indexes', async () => {
    const file = new Uint8Array(1000);
    file.set(new Uint8Array(createSidx()), 100);
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml())).mockResolvedValueOnce(new Response(file));
    await expect(firstValueFrom(controller.loadMainMedia(args))).resolves.toBe(true);
    expect(loadHls).toHaveBeenCalledOnce();
    expect(SyntheticManifestRegistry.get(mediaUrls()[0]!)).toContain('#EXT-X-BYTERANGE:100@168');
  });

  it('only fetches indexes for the initial renditions, and the others when hls.js requests their playlists', async () => {
    const ladder = (id: string, bandwidth: number) =>
      `<Representation id="${id}" bandwidth="${bandwidth}"><BaseURL>${id}.mp4</BaseURL><SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase></Representation>`;
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('.mpd')
        ? new Response(
            `<MPD mediaPresentationDuration="PT5S"><Period>
              <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e">${ladder('v1', 1000000)}${ladder('v2', 2000000)}${ladder('v3', 3000000)}</AdaptationSet>
              <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">${ladder('a', 128000)}</AdaptationSet></Period></MPD>`
          )
        : sidxResponse()
    );
    await firstValueFrom(controller.loadMainMedia(args));
    const indexes = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith('.mp4'));
    expect(indexes()).toEqual(['https://example.com/v1.mp4', 'https://example.com/a.mp4']);
    const [audio, , v2] = mediaUrls();
    expect(SyntheticManifestRegistry.get(audio!)).toContain('a.mp4');
    expect(SyntheticManifestRegistry.get(v2!)).toBeUndefined();
    await expect(SyntheticManifestRegistry.resolve(v2!)!).resolves.toContain('https://example.com/v2.mp4');
    expect(indexes()).toEqual(['https://example.com/v1.mp4', 'https://example.com/a.mp4', 'https://example.com/v2.mp4']);
  });

  it('rejects a lazily resolved level whose segments do not align with the first', async () => {
    const ladder = (id: string) =>
      `<Representation id="${id}" bandwidth="1000"><BaseURL>${id}.mp4</BaseURL><SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase></Representation>`;
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('.mpd')
        ? new Response(`<MPD mediaPresentationDuration="PT6S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e">${ladder('v1')}${ladder('v2')}</AdaptationSet></Period></MPD>`)
        : sidxResponse(
            String(url).includes('v2')
              ? createSidx({
                  references: [
                    {size: 100, duration: 1000},
                    {size: 200, duration: 3000},
                    {size: 300, duration: 2000},
                  ],
                })
              : createSidx()
          )
    );
    await firstValueFrom(controller.loadMainMedia(args));
    await expect(SyntheticManifestRegistry.resolve(mediaUrls()[1]!)!).rejects.toThrow(/aligned segment boundaries/);
  });

  it('installs the synthetic playlist loader without replacing other HLS configuration', () => {
    // byte-range fragments are handled by HlsPlayerController for every HLS source
    expect(configureHls).toHaveBeenCalledWith(expect.anything(), {hlsConfig: {pLoader: SyntheticManifestLoader}});
  });

  it('loads one MPD containing content/ad/content Periods into one HLS session', async () => {
    const period = xml.slice(xml.indexOf('<Period>'), xml.indexOf('</Period>') + '</Period>'.length).replace('<Period>', '<Period duration="PT4S">');
    fetchMock.mockResolvedValue(new Response(`<MPD mediaPresentationDuration="PT12S">${period}${period}${period}</MPD>`));
    await expect(firstValueFrom(controller.loadMainMedia(args))).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(loadHls).toHaveBeenCalledOnce();
    expect(loadHls).toHaveBeenCalledWith(expect.objectContaining({loadOptions: {...args.loadOptions, duration: 12}}));
    const playlist = SyntheticManifestRegistry.get(mediaUrls()[0]!)!;
    expect(playlist.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
    expect(playlist.match(/#EXT-X-MAP/g)).toHaveLength(3);
  });

  it('fails the load with the DASH error when an initial index cannot be resolved, and releases playlists', async () => {
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml(''))).mockResolvedValueOnce(new Response('', {status: 403}));
    await expect(firstValueFrom(controller.loadMainMedia(args))).rejects.toThrow(/DASH: HTTP 403/);
    expect(destroyHls).toHaveBeenCalledTimes(2);
    registered().forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
  });

  it('aborts pending SIDX requests when a new load supersedes them', async () => {
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml(''))).mockImplementationOnce(() => new Promise<Response>(() => {}));
    const complete = vi.fn();
    controller.loadMainMedia(args).subscribe({complete});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const signal = fetchMock.mock.calls[1]![1]!.signal!;
    const stale = registered();
    await firstValueFrom(controller.loadMainMedia(args));
    expect(signal.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    stale.forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
  });

  it.each(['unsubscribe', 'destroy'])('aborts pending SIDX requests on %s', async (action) => {
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml(''))).mockImplementationOnce(() => new Promise<Response>(() => {}));
    const subscription = controller.loadMainMedia(args).subscribe();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const signal = fetchMock.mock.calls[1]![1]!.signal!;
    const urls = registered();
    if (action === 'destroy') {
      controller.destroy();
    } else {
      subscription.unsubscribe();
    }
    expect(signal.aborted).toBe(true);
    urls.forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
  });

  it('preserves explicit load options without mutating them', async () => {
    const loadOptions = {frameRate: 30, duration: 3};
    await firstValueFrom(controller.loadMainMedia({...args, loadOptions}));
    expect(loadHls).toHaveBeenCalledWith(expect.objectContaining({loadOptions: {frameRate: 30, duration: 3}}));
    expect(loadOptions).toEqual({frameRate: 30, duration: 3});
  });

  it('releases old playlists on reload and the current playlists on destroy', async () => {
    await firstValueFrom(controller.loadMainMedia(args));
    const first = registered();
    fetchMock.mockResolvedValue(new Response(xml));
    await firstValueFrom(controller.loadMainMedia(args));
    const second = registered().filter((url) => !first.includes(url));
    expect(second).toHaveLength(2);
    first.forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
    second.forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(true));
    controller.destroy();
    second.forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
  });

  it('surfaces HTTP failures without invoking HLS', async () => {
    fetchMock.mockResolvedValue(new Response('', {status: 403, statusText: 'Forbidden'}));
    await expect(firstValueFrom(controller.loadMainMedia(args))).rejects.toThrow('DASH: HTTP 403 Forbidden');
    expect(loadHls).not.toHaveBeenCalled();
  });

  it('surfaces unsupported MPDs before creating playlists', async () => {
    fetchMock.mockResolvedValue(new Response(xml.replace('<MPD ', '<MPD type="dynamic" ')));
    await expect(firstValueFrom(controller.loadMainMedia(args))).rejects.toThrow('live/dynamic');
    expect(loadHls).not.toHaveBeenCalled();
  });

  it('releases playlists and destroys HLS when HLS loading fails', async () => {
    loadHls.mockImplementation(() => throwError(() => new Error('segment failed')));
    await expect(firstValueFrom(controller.loadMainMedia(args))).rejects.toThrow('segment failed');
    expect(registered()).toHaveLength(2);
    registered().forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
    expect(destroyHls).toHaveBeenCalledTimes(2);
  });

  it('aborts pending MPD fetches on unsubscribe and destroy', () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const first = controller.loadMainMedia(args).subscribe();
    const firstSignal = fetchMock.mock.calls[0]![1]!.signal!;
    first.unsubscribe();
    expect(firstSignal.aborted).toBe(true);
    controller.loadMainMedia(args).subscribe();
    const secondSignal = fetchMock.mock.calls[1]![1]!.signal!;
    controller.destroy();
    expect(secondSignal.aborted).toBe(true);
    expect(loadHls).not.toHaveBeenCalled();
  });

  it('supersedes a pending MPD fetch without starting stale HLS playback', async () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const complete = vi.fn();
    controller.loadMainMedia(args).subscribe({complete});
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    await firstValueFrom(controller.loadMainMedia(args));
    expect(signal.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(loadHls).toHaveBeenCalledOnce();
  });

  it('releases playlists when an in-flight HLS load is cancelled', async () => {
    loadHls.mockImplementation(() => new Subject<boolean>());
    const subscription = controller.loadMainMedia(args).subscribe();
    await vi.waitFor(() => expect(loadHls).toHaveBeenCalledOnce());
    const urls = registered();
    subscription.unsubscribe();
    urls.forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
  });

  it('adds auxiliary tracks before the load completes and keeps their resources alive until the tracks are removed', async () => {
    const auxiliaryXml = xml.replace(
      '</Period>',
      `<AdaptationSet mimeType="text/vtt" lang="en"><BaseURL>en.vtt</BaseURL><Representation id="en"/></AdaptationSet>
      <AdaptationSet mimeType="image/jpeg"><BaseURL>thumbnail.jpg</BaseURL><Representation id="images"/></AdaptationSet></Period>`
    );
    fetchMock.mockResolvedValueOnce(new Response(auxiliaryXml));
    const tracksCreatedHook = vi.fn((_tracks: Track[]) => of(void 0));
    loadHls.mockImplementation((hlsArgs: LoadMainMediaArgsType) => hlsArgs.tracksCreatedHook([]).pipe(map(() => true)));
    await firstValueFrom(controller.loadMainMedia({...args, tracksCreatedHook}));
    // the sidecar and the image are referenced by URL, not downloaded
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tracksCreatedHook).toHaveBeenCalledTimes(2);
    const auxiliaryTracks = tracksCreatedHook.mock.calls[1]![0];
    expect(auxiliaryTracks).toMatchObject([{trackType: 'TEXT_TRACK', srclang: 'en'}, {trackType: 'THUMBNAIL_TRACK'}]);
    expect(blobs).toHaveLength(1);
    expect(await readBlob(blobs[0]!)).toContain('https://example.com/thumbnail.jpg');
    controller.destroy();
    expect(revoke).not.toHaveBeenCalled();
    auxiliaryTracks.forEach((track) => {
      if (track instanceof TextTrackFile || track instanceof ThumbnailTrack) track.destroy();
    });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('reuses track-owned resources when restoring a detached main-media session', async () => {
    const auxiliaryXml = xml.replace('</Period>', '<AdaptationSet mimeType="text/vtt"><SegmentTemplate duration="2" media="$Number$.vtt"/><Representation/></AdaptationSet></Period>');
    fetchMock.mockResolvedValue(new Response(auxiliaryXml));
    const providedMainMedia = new DashMainMedia({
      source: new UrlSource(args.url!),
      tracks: [new TextTrackFile({source: new UrlSource('blob:persistent-text'), customAttrs: {dashAuxiliary: true}})],
    }).state;
    await firstValueFrom(controller.loadMainMedia({...args, providedMainMedia}));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(blobs).toHaveLength(0);
    expect(loadHls.mock.calls[0]![0].tracksCreatedHook).toBe(args.tracksCreatedHook);
  });

  it('surfaces auxiliary load errors and releases generated playlists', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(xml.replace('</Period>', '<AdaptationSet mimeType="text/vtt"><SegmentTemplate duration="2" media="$Number$.vtt"/><Representation/></AdaptationSet></Period>'))
      )
      .mockResolvedValue(new Response('', {status: 404}));
    await expect(firstValueFrom(controller.loadMainMedia(args))).rejects.toThrow('HTTP 404');
    registered().forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
    expect(destroyHls).toHaveBeenCalledTimes(2);
  });

  it('aborts auxiliary loading and releases its playlists when cancelled', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(xml.replace('</Period>', '<AdaptationSet mimeType="text/vtt"><SegmentTemplate duration="2" media="$Number$.vtt"/><Representation/></AdaptationSet></Period>'))
      )
      .mockImplementation(() => new Promise<Response>(() => {}));
    const subscription = controller.loadMainMedia(args).subscribe();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const urls = registered();
    subscription.unsubscribe();
    expect(fetchMock.mock.calls[1]![1]!.signal!.aborted).toBe(true);
    urls.forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
  });
});
