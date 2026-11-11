// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {firstValueFrom, of, Subject, throwError} from 'rxjs';
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
    controller = new DashPlayerController({} as PlayerDomController);
  });

  afterEach(() => {
    controller.destroy();
    AuthConfig.authentication = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches the MPD with authentication and passes synthetic HLS to the existing controller', async () => {
    AuthConfig.authentication = {type: 'custom', headers: () => ({headers: {'X-Test': 'test'}})};
    await expect(firstValueFrom(controller.loadMainMedia(args))).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(args.url, expect.objectContaining({headers: {'X-Test': 'test'}, signal: expect.any(AbortSignal)}));
    expect(loadHls).toHaveBeenCalledWith({...args, url: 'blob:dash-2', loadOptions: {...args.loadOptions, duration: 4}});
    expect(blobs).toHaveLength(2);
    expect(revoke).not.toHaveBeenCalled();
    expect(args.url).toBe('https://example.com/manifest.mpd');
  });

  it('resolves media paths against the final URL after redirects', async () => {
    const response = new Response(xml);
    Object.defineProperty(response, 'url', {value: 'https://cdn.example.com/redirected/manifest.mpd'});
    fetchMock.mockResolvedValue(response);
    await firstValueFrom(controller.loadMainMedia(args));
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blobs[0]!);
    });

    expect(text).toContain('https://cdn.example.com/redirected/init.mp4');
    expect(text).toContain('https://cdn.example.com/redirected/1.m4s');
  });

  it('resolves SegmentBase indexes before starting HLS playback', async () => {
    const segmentBaseXml = xml.replace(
      '<SegmentTemplate duration="2" initialization="init.mp4" media="$Number$.m4s"/>',
      '<BaseURL>video.mp4</BaseURL><SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase>'
    );
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml)).mockResolvedValueOnce(new Response(createSidx(), {status: 206}));
    await expect(firstValueFrom(controller.loadMainMedia(args))).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://example.com/video.mp4');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Range')).toBe('bytes=100-167');
    expect(loadHls).toHaveBeenCalledOnce();
    expect(blobs).toHaveLength(2);
  });

  it('accepts a full-file HTTP 200 response when loading SegmentBase indexes', async () => {
    const segmentBaseXml = xml.replace(
      '<SegmentTemplate duration="2" initialization="init.mp4" media="$Number$.m4s"/>',
      '<BaseURL>video.mp4</BaseURL><SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase>'
    );
    const file = new Uint8Array(1000);
    file.set(new Uint8Array(createSidx()), 100);
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml)).mockResolvedValueOnce(new Response(file));
    await expect(firstValueFrom(controller.loadMainMedia(args))).resolves.toBe(true);
    expect(loadHls).toHaveBeenCalledOnce();
    expect(blobs).toHaveLength(2);
  });

  it('installs the DASH fragment adapter without replacing other HLS configuration', () => {
    expect(configureHls).toHaveBeenCalledWith(expect.anything(), {hlsConfig: {fLoader: expect.any(Function)}});
  });

  it('surfaces index errors without invoking HLS or creating playlists', async () => {
    const segmentBaseXml = xml.replace(
      '<SegmentTemplate duration="2" initialization="init.mp4" media="$Number$.m4s"/>',
      '<SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase>'
    );
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml)).mockResolvedValueOnce(new Response('', {status: 403}));
    await expect(firstValueFrom(controller.loadMainMedia(args))).rejects.toThrow(/DASH: HTTP 403/);
    expect(loadHls).not.toHaveBeenCalled();
    expect(blobs).toHaveLength(0);
  });

  it('aborts pending SIDX requests when a new load supersedes them', async () => {
    const segmentBaseXml = xml.replace(
      '<SegmentTemplate duration="2" initialization="init.mp4" media="$Number$.m4s"/>',
      '<SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase>'
    );
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml)).mockImplementationOnce(() => new Promise<Response>(() => {}));
    const complete = vi.fn();
    controller.loadMainMedia(args).subscribe({complete});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const signal = fetchMock.mock.calls[1]![1]!.signal!;
    await firstValueFrom(controller.loadMainMedia(args));
    expect(signal.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(loadHls).toHaveBeenCalledOnce();
  });

  it.each(['unsubscribe', 'destroy'])('aborts pending SIDX requests on %s', async (action) => {
    const segmentBaseXml = xml.replace(
      '<SegmentTemplate duration="2" initialization="init.mp4" media="$Number$.m4s"/>',
      '<SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase>'
    );
    fetchMock.mockResolvedValueOnce(new Response(segmentBaseXml)).mockImplementationOnce(() => new Promise<Response>(() => {}));
    const subscription = controller.loadMainMedia(args).subscribe();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const signal = fetchMock.mock.calls[1]![1]!.signal!;
    if (action === 'destroy') {
      controller.destroy();
    } else {
      subscription.unsubscribe();
    }
    expect(signal.aborted).toBe(true);
    expect(loadHls).not.toHaveBeenCalled();
    expect(blobs).toHaveLength(0);
  });

  it('preserves explicit load options without mutating them', async () => {
    const loadOptions = {frameRate: 30, duration: 3};
    await firstValueFrom(controller.loadMainMedia({...args, loadOptions}));
    expect(loadHls).toHaveBeenCalledWith(expect.objectContaining({loadOptions: {frameRate: 30, duration: 3}}));
    expect(loadOptions).toEqual({frameRate: 30, duration: 3});
  });

  it('revokes old playlists on reload and the current playlists on destroy', async () => {
    await firstValueFrom(controller.loadMainMedia(args));
    fetchMock.mockResolvedValue(new Response(xml));
    await firstValueFrom(controller.loadMainMedia(args));
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(['blob:dash-1', 'blob:dash-2']);
    controller.destroy();
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(['blob:dash-1', 'blob:dash-2', 'blob:dash-3', 'blob:dash-4']);
  });

  it('surfaces HTTP failures without invoking HLS', async () => {
    fetchMock.mockResolvedValue(new Response('', {status: 403, statusText: 'Forbidden'}));
    await expect(firstValueFrom(controller.loadMainMedia(args))).rejects.toThrow('DASH: HTTP 403 Forbidden');
    expect(loadHls).not.toHaveBeenCalled();
    expect(blobs).toHaveLength(0);
  });

  it('surfaces unsupported MPDs before creating playlists', async () => {
    fetchMock.mockResolvedValue(new Response(xml.replace('<MPD ', '<MPD type="dynamic" ')));
    await expect(firstValueFrom(controller.loadMainMedia(args))).rejects.toThrow('live/dynamic');
    expect(loadHls).not.toHaveBeenCalled();
    expect(blobs).toHaveLength(0);
  });

  it('revokes playlists and destroys HLS when HLS loading fails', async () => {
    loadHls.mockImplementation(() => throwError(() => new Error('segment failed')));
    await expect(firstValueFrom(controller.loadMainMedia(args))).rejects.toThrow('segment failed');
    expect(revoke).toHaveBeenCalledTimes(2);
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
    subscription.unsubscribe();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
