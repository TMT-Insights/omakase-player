// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {firstValueFrom, type Observable, of, Subject, throwError} from 'rxjs';
import {UrlSource} from '../../src/source';
import {DashMainMedia} from '../../src/dash/dash-main-media';
import type {LoadMainMediaArgsType, PlayerDomController} from '../../src/player/player-controller-api';
import type {DashMainMediaSession, DashMainMediaSessionState} from '../../src/dash/dash-main-media-session';
import {createSidx} from './sidx-fixture';

const {loadHls} = vi.hoisted(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  return {loadHls: vi.fn()};
});
vi.mock('media-captions', () => ({CaptionsRenderer: class {}, parseResponse: vi.fn()}));
vi.mock('../../src/hls/hls-player-controller', async () => {
  const {ObserverBreaker} = await import('../../src/common/observer-breaker');
  return {
    HlsPlayerController: class {
      protected _loadBreaker = new ObserverBreaker();
      protected _destroyBreaker = new ObserverBreaker();
      loadMainMedia(args: LoadMainMediaArgsType) {
        return loadHls(args);
      }
      destroyHls() {}
      unwireEvents() {}
      destroy() {
        this._destroyBreaker.destroy();
      }
    },
  };
});

import {DashPlayerController} from '../../src/dash/dash-player-controller';
import {DashMainMediaSessionController} from '../../src/dash/dash-main-media-session-controller';
import {DashPreparedMedia} from '../../src/dash/dash-prepared-media';
import {SyntheticManifestRegistry} from '../../src/hls/synthetic-manifest-registry';
import {TrackRepository} from '../../src/repository';
import {DashMainMediaSessionRemote} from '../../src/remoting/impl/dash-main-media-session-remote';
import {DashMainMediaSessionMessageChannelBinding} from '../../src/remoting/impl/dash-main-media-session-message-channel';
import {MediaFactory} from '../../src/media/media-factory';
import type {RemoteNode} from '../../src/remoting/remote-node';
import type {OmpProvider} from '../../src/omp-provider';

const mpdUrl = 'https://example.com/manifest.mpd';
const ladder = (id: string, bandwidth: number) =>
  `<Representation id="${id}" bandwidth="${bandwidth}"><BaseURL>${id}.mp4</BaseURL><SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase></Representation>`;
const mpd = `<MPD mediaPresentationDuration="PT5S"><Period>
  <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e">${ladder('v1', 1000000)}${ladder('v2', 2000000)}</AdaptationSet>
  <AdaptationSet mimeType="text/vtt" lang="en"><BaseURL>en.vtt</BaseURL><Representation id="en"/></AdaptationSet></Period></MPD>`;

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let repository: TrackRepository;
const media = () => new DashMainMedia({source: new UrlSource(mpdUrl)});
const args = (overrides: Partial<LoadMainMediaArgsType> = {}): LoadMainMediaArgsType => ({
  url: mpdUrl,
  mainMediaEssentialArgsHook: () => of(void 0),
  tracksCreatedHook: () => of(void 0),
  ...overrides,
});
const mpdRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('.mpd')).length;
const indexRequests = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith('.mp4'));

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).endsWith('.mpd') ? new Response(mpd) : new Response(createSidx(), {status: 206})));
  vi.stubGlobal('fetch', fetchMock);
  loadHls.mockImplementation(() => of(true));
  repository = new TrackRepository();
});

afterEach(() => {
  repository.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DashMainMediaSessionController', () => {
  it('prepares the media once, however often it is asked, and shares a pending preparation', async () => {
    const mainMedia = media();
    const session = new DashMainMediaSessionController(mainMedia, repository);
    await Promise.all([firstValueFrom(session.prepare(), {defaultValue: void 0}), firstValueFrom(session.prepare(), {defaultValue: void 0})]);
    await firstValueFrom(session.prepare(), {defaultValue: void 0});
    expect(mpdRequests()).toBe(1);
    const state = (await firstValueFrom(session.getSessionState(mainMedia.id)))!;
    expect(state.duration).toBe(5);
    expect(state.playlistUrls).toHaveLength(2);
    expect(state.manifests[state.masterUrl]).toContain('#EXT-X-STREAM-INF');
    expect(state.auxiliary?.auxiliaryPeriods).toHaveLength(1);
    expect(await firstValueFrom(session.getSessionState('other'))).toBeUndefined();
    session.destroy();
  });

  it('builds playlists on request and includes them in later state', async () => {
    const mainMedia = media();
    const session = new DashMainMediaSessionController(mainMedia, repository);
    await firstValueFrom(session.prepare(), {defaultValue: void 0});
    const state = (await firstValueFrom(session.getSessionState(mainMedia.id)))!;
    expect(state.manifests[state.playlistUrls[1]!]).toBeUndefined();
    await expect(firstValueFrom(session.resolvePlaylist(mainMedia.id, state.playlistUrls[1]!))).resolves.toContain('v2.mp4');
    expect((await firstValueFrom(session.getSessionState(mainMedia.id)))!.manifests[state.playlistUrls[1]!]).toContain('v2.mp4');
    await expect(firstValueFrom(session.resolvePlaylist(mainMedia.id, 'https://dash.omakase.local/unknown.m3u8'))).rejects.toThrow(/not a playlist/);
    await expect(firstValueFrom(session.resolvePlaylist('other', state.playlistUrls[0]!))).rejects.toThrow(/not prepared/);
    session.destroy();
  });

  it('releases its playlists and aborts pending index requests when destroyed', async () => {
    const mainMedia = media();
    const session = new DashMainMediaSessionController(mainMedia, repository);
    await firstValueFrom(session.prepare(), {defaultValue: void 0});
    const state = (await firstValueFrom(session.getSessionState(mainMedia.id)))!;
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    void session.resolvePlaylist(mainMedia.id, state.playlistUrls[0]!).subscribe({error: () => {}});
    await vi.waitFor(() => expect(indexRequests()).toHaveLength(1));
    session.destroy();
    expect(fetchMock.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true);
    [state.masterUrl, ...state.playlistUrls].forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
  });

  it('surfaces MPD errors from prepare and allows a retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', {status: 404, statusText: 'Not Found'}));
    const session = new DashMainMediaSessionController(media(), repository);
    await expect(firstValueFrom(session.prepare(), {defaultValue: void 0})).rejects.toThrow('DASH: HTTP 404');
    await firstValueFrom(session.prepare(), {defaultValue: void 0});
    expect(mpdRequests()).toBe(2);
    session.destroy();
  });

  it('is created for DASH media, with a remote for detached windows', () => {
    const mainMedia = media();
    const session = MediaFactory.createMainMediaSessionController(mainMedia, repository);
    expect(session).toBeInstanceOf(DashMainMediaSessionController);
    session?.destroy();
    expect(MediaFactory.createMainMediaSessionRemote(mainMedia.mainMediaType)).toBeInstanceOf(DashMainMediaSessionRemote);
  });
});

describe('DashPlayerController with a session', () => {
  it('plays from the session in the owning window and leaves its playlists to it', async () => {
    const mainMedia = media();
    const session = new DashMainMediaSessionController(mainMedia, repository);
    await firstValueFrom(session.prepare(), {defaultValue: void 0});
    const state = (await firstValueFrom(session.getSessionState(mainMedia.id)))!;
    const controller = new DashPlayerController({} as PlayerDomController);
    const tracksCreatedHook = vi.fn(() => of(void 0));
    await firstValueFrom(controller.loadMainMedia(args({providedMainMedia: mainMedia.state, mainMediaSessionController: session, tracksCreatedHook})));
    expect(mpdRequests()).toBe(1);
    expect(loadHls).toHaveBeenCalledWith(expect.objectContaining({url: state.masterUrl, loadOptions: {duration: 5}}));
    expect(tracksCreatedHook).toHaveBeenCalledWith([expect.objectContaining({srclang: 'en'})]);
    // a detach destroys the player controller; the media's playlists must outlive it
    controller.destroy();
    expect(SyntheticManifestRegistry.has(state.masterUrl)).toBe(true);
    session.destroy();
  });

  describe('in a window that does not own the media', () => {
    let owner: DashPreparedMedia;
    let ownerState: DashMainMediaSessionState;
    let ownerManifests: Record<string, string>;
    let resolvePlaylist: ReturnType<typeof vi.fn<DashMainMediaSession['resolvePlaylist']>>;
    let remote: DashMainMediaSession & {prepare(): Observable<void>; destroy(): void};

    beforeEach(async () => {
      owner = DashPreparedMedia.fromManifest((await import('../../src/dash/dash-manifest')).parseDashManifest(mpd, mpdUrl));
      await owner.resolve(owner.initialPlaylists[0]!.url);
      ownerState = owner.state;
      ownerManifests = {...ownerState.manifests, [ownerState.playlistUrls[1]!]: await owner.resolve(ownerState.playlistUrls[1]!)};
      // the owner's registry is another window's: nothing of it is visible here
      owner.release();
      fetchMock.mockClear();
      resolvePlaylist = vi.fn((_id, url) => (ownerManifests[url] ? of(ownerManifests[url]!) : throwError(() => new Error('DASH: HTTP 403 for SIDX'))));
      remote = {getSessionState: () => of(ownerState), resolvePlaylist, prepare: () => of(void 0), destroy: () => {}};
    });

    it('registers the built playlists, asks the owner for the rest, and fetches nothing itself', async () => {
      const mainMedia = media();
      const controller = new DashPlayerController({} as PlayerDomController);
      await firstValueFrom(controller.loadMainMedia(args({providedMainMedia: mainMedia.state, mainMediaSessionController: remote})));
      expect(SyntheticManifestRegistry.get(ownerState.masterUrl)).toBe(ownerState.manifests[ownerState.masterUrl]);
      expect(resolvePlaylist).not.toHaveBeenCalled();
      await expect(SyntheticManifestRegistry.resolve(ownerState.playlistUrls[1]!)!).resolves.toContain('v2.mp4');
      expect(resolvePlaylist).toHaveBeenCalledWith(mainMedia.id, ownerState.playlistUrls[1]);
      // auxiliary tracks are created from the shared state; the sidecar is referenced by URL
      expect(fetchMock).not.toHaveBeenCalled();
      controller.destroy();
      [ownerState.masterUrl, ...ownerState.playlistUrls].forEach((url) => expect(SyntheticManifestRegistry.has(url)).toBe(false));
    });

    it('fails the load with the owner error when an initial playlist cannot be built there', async () => {
      ownerState = {...ownerState, manifests: {[ownerState.masterUrl]: ownerState.manifests[ownerState.masterUrl]!}};
      ownerManifests = {};
      const controller = new DashPlayerController({} as PlayerDomController);
      await expect(firstValueFrom(controller.loadMainMedia(args({providedMainMedia: media().state, mainMediaSessionController: remote})))).rejects.toThrow('DASH: HTTP 403 for SIDX');
      expect(SyntheticManifestRegistry.has(ownerState.masterUrl)).toBe(false);
      controller.destroy();
    });

    it('fails clearly when the owning window has no prepared session', async () => {
      const controller = new DashPlayerController({} as PlayerDomController);
      const empty = {getSessionState: () => of(undefined), resolvePlaylist, prepare: () => of(void 0), destroy: () => {}};
      await expect(firstValueFrom(controller.loadMainMedia(args({providedMainMedia: media().state, mainMediaSessionController: empty})))).rejects.toThrow(/no prepared session/);
      expect(mpdRequests()).toBe(0);
      controller.destroy();
    });
  });
});

describe('DASH session remoting', () => {
  it('forwards a remote window to the owning session and serves it from the binding', async () => {
    const getSessionState = new Subject<[[string], (response: unknown) => void, (error: Error) => void]>();
    const resolve = new Subject<[[string, string], (response: unknown) => void, (error: Error) => void]>();
    const channel = {receiveAndSendResponse: (action: string) => (action === 'getSessionState' ? getSessionState : resolve)};
    const owning: DashMainMediaSession & {prepare(): unknown; destroy(): void} = {
      getSessionState: (id) => of(id === 'media' ? ({masterUrl: 'master'} as DashMainMediaSessionState) : undefined),
      resolvePlaylist: (_id, url) => of(`playlist ${url}`),
      prepare: () => of(void 0),
      destroy: () => {},
    };
    const sessions: Record<string, unknown> = {media: owning};
    const binding = new DashMainMediaSessionMessageChannelBinding(channel as never, {mainMediaSessionManager: {get: (id: string) => sessions[id]}} as unknown as OmpProvider);
    binding.bind();

    const respond = vi.fn();
    const fail = vi.fn();
    getSessionState.next([['media'], respond, fail]);
    expect(await firstValueFrom(respond.mock.calls[0]![0])).toEqual({masterUrl: 'master'});
    resolve.next([['media', 'a.m3u8'], respond, fail]);
    expect(await firstValueFrom(respond.mock.calls[1]![0])).toBe('playlist a.m3u8');
    resolve.next([['gone', 'a.m3u8'], respond, fail]);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringMatching(/no session/)}));
    binding.destroy();

    const remote = new DashMainMediaSessionRemote();
    await expect(firstValueFrom(remote.resolvePlaylist('media', 'a.m3u8'))).rejects.toThrow(/not connected/);
    remote.connect({getProxyByName: () => owning} as unknown as RemoteNode);
    expect(await firstValueFrom(remote.getSessionState('media'))).toEqual({masterUrl: 'master'});
    expect(await firstValueFrom(remote.resolvePlaylist('media', 'a.m3u8'))).toBe('playlist a.m3u8');
    remote.destroy();
  });
});
