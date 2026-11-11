/*
 * Copyright 2026 ByOmakase, LLC (https://byomakase.org)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {combineLatest, defer, finalize, firstValueFrom, map, type Observable, of, switchMap, take, takeUntil, tap} from 'rxjs';
import type {HlsConfig} from 'hls.js';
import {HlsPlayerController, type HlsPlayerControllerConfig} from '../hls/hls-player-controller';
import {SyntheticManifestLoader} from '../hls/synthetic-manifest-loader';
import {SyntheticManifestRegistry} from '../hls/synthetic-manifest-registry';
import type {LoadMainMediaArgsType, PlayerDomController} from '../player/player-controller-api';
import {ObserverBreaker} from '../common/observer-breaker';
import {BlobUtil} from '../util/blob-util';
import {OmpError} from '../types';
import {loadDashAuxiliaryTracks} from './dash-auxiliary';
import {dashPlaylistDuration, resolveDashTailShortfall} from './dash-manifest';
import {type DashMainMediaSession, type DashMainMediaSessionState, isDashMainMediaSession} from './dash-main-media-session';
import {DashPreparedMedia} from './dash-prepared-media';

export {DASH_SYNTHETIC_ORIGIN} from './dash-prepared-media';

/**
 * Bridges a static MPD to HLS; the original MPD remains the source in serialized media state.
 *
 * The bridged playlists come from the media's {@link DashMainMediaSession}: the session controller
 * in the window that owns the media, or a remote to it from a detached window, which then neither
 * fetches the MPD nor builds playlists itself. Without a session the controller prepares the media
 * on its own. Media playlists are built lazily; the initial video and audio ones are resolved
 * alongside the hls.js load, so that their errors still fail it.
 */
export class DashPlayerController extends HlsPlayerController {
  private readonly _dashLoadBreaker = new ObserverBreaker();
  /** Media prepared by this controller, when there is no session to own it. */
  private _ownMedia: DashPreparedMedia | undefined;
  /** Playlists copied from a session in another window. */
  private _adoptedUrls: string[] = [];
  private _pendingAuxiliaryUrls: string[] = [];

  constructor(playerDomController: PlayerDomController, config?: Partial<HlsPlayerControllerConfig>) {
    super(playerDomController, {
      ...config,
      hlsConfig: {
        ...config?.hlsConfig,
        pLoader: SyntheticManifestLoader as NonNullable<HlsConfig['pLoader']>,
      },
    });
  }

  override loadMainMedia(args: LoadMainMediaArgsType): Observable<boolean> {
    return defer(() => {
      this._dashLoadBreaker.break();
      this._loadBreaker.break();
      this.destroyHls();
      this.unwireEvents();
      this.release();
      const session = isDashMainMediaSession(args.mainMediaSessionController) ? args.mainMediaSessionController : undefined;
      const mainMediaId = args.providedMainMedia?.id;
      let loaded = false;
      return this.resolveSessionState(args, session, mainMediaId).pipe(
        switchMap((state) => {
          this.adoptPlaylists(state, session, mainMediaId);
          // the duration hls.js reads once the initial playlists are in (see applyTailShortfall)
          const loadOptions = {...args.loadOptions, duration: args.loadOptions?.duration ?? state.duration};
          // hls.js requests the same playlists and joins these resolutions rather than repeating them
          const initial$ = defer(() =>
            Promise.all(state.initialPlaylists.map(({url}) => SyntheticManifestRegistry.resolve(url) ?? Promise.reject(new OmpError(`DASH: playlist ${url} is not registered`))))
          ).pipe(tap((playlists) => this.applyTailShortfall(args, state, playlists, loadOptions)));
          // tracks restored with the media (a reload, or another window) already own their resources
          const hasAuxiliaryTracks = args.providedMainMedia?.tracks.some((track) => track.customAttrs?.['dashAuxiliary'] === true);
          const auxiliary$ =
            hasAuxiliaryTracks || !state.auxiliary
              ? of([])
              : loadDashAuxiliaryTracks(state.auxiliary, (data, mime) => {
                  const url = BlobUtil.createBlobURL(data, {type: mime});
                  this._pendingAuxiliaryUrls.push(url);
                  return url;
                });
          const hls$ = super.loadMainMedia({
            ...args,
            url: state.masterUrl,
            loadOptions,
          });
          // playback starts buffering while auxiliary tracks load; they are added before the load
          // completes so that the player preloads them like any other main-media text track
          return combineLatest([hls$, initial$, auxiliary$]).pipe(
            take(1),
            switchMap(([hlsLoaded, , auxiliaryTracks]) =>
              auxiliaryTracks.length
                ? args.tracksCreatedHook(auxiliaryTracks).pipe(
                    tap(() => {
                      this._pendingAuxiliaryUrls = [];
                    }),
                    map(() => hlsLoaded)
                  )
                : of(hlsLoaded)
            )
          );
        }),
        tap(() => (loaded = true)),
        takeUntil(this._dashLoadBreaker.observer),
        takeUntil(this._destroyBreaker.observer),
        finalize(() => {
          if (!loaded) {
            this.destroyHls();
            this.release();
          }
        })
      );
    });
  }

  /**
   * Warns when tracks end before the duration the MPD declares, and when they all do, makes the
   * player's duration where the media really ends, so that playback, seeking to the end and the end
   * of the timeline agree with the media instead of waiting for time that does not exist.
   *
   * `loadOptions` is the object handed to hls.js; it reads the duration only after the initial
   * playlists have been loaded, which is after these resolutions (it joins them).
   */
  private applyTailShortfall(args: LoadMainMediaArgsType, state: DashMainMediaSessionState, playlists: string[], loadOptions: {duration?: number | string | undefined}): void {
    // a restored media already carries the corrected duration, and was warned about when first loaded
    if (args.providedMainMedia?.duration !== undefined || args.loadOptions?.duration !== undefined) {
      return;
    }
    const shortfall = resolveDashTailShortfall(
      state.duration,
      state.initialPlaylists.map(({type}, index) => ({type, end: dashPlaylistDuration(playlists[index]!)}))
    );
    if (!shortfall) {
      return;
    }
    loadOptions.duration = shortfall.duration;
    console.warn(shortfall.message);
    args.warningHook?.(shortfall.message);
  }

  private resolveSessionState(args: LoadMainMediaArgsType, session: DashMainMediaSession | undefined, mainMediaId: string | undefined): Observable<DashMainMediaSessionState> {
    if (session && mainMediaId) {
      return session.getSessionState(mainMediaId).pipe(
        map((state) => {
          if (!state) {
            throw new OmpError(`DASH media has no prepared session in the window that owns it`);
          }
          return state;
        })
      );
    }
    if (!args.url) {
      throw new OmpError('DASH: MPD URL not provided');
    }
    return DashPreparedMedia.load(args.url).pipe(
      map((media) => {
        this._ownMedia = media;
        return media.state;
      })
    );
  }

  /**
   * Makes a session's playlists playable in this window. The owning window has them registered
   * already; another window registers the built ones and asks the owner for the rest when used.
   */
  private adoptPlaylists(state: DashMainMediaSessionState, session: DashMainMediaSession | undefined, mainMediaId: string | undefined): void {
    if (SyntheticManifestRegistry.has(state.masterUrl) || !session || !mainMediaId) {
      return;
    }
    for (const url of [state.masterUrl, ...state.playlistUrls]) {
      const content = state.manifests[url];
      if (content !== undefined) {
        SyntheticManifestRegistry.register(url, content);
      } else {
        SyntheticManifestRegistry.registerLazy(url, () => firstValueFrom(session.resolvePlaylist(mainMediaId, url)));
      }
      this._adoptedUrls.push(url);
    }
  }

  /** Releases what this controller registered or created; a session's own playlists stay with it. */
  private release(): void {
    this._ownMedia?.release();
    this._ownMedia = undefined;
    this._adoptedUrls.forEach((url) => SyntheticManifestRegistry.clear(url));
    this._adoptedUrls = [];
    this._pendingAuxiliaryUrls.forEach((url) => BlobUtil.revokeObjectURL(url));
    this._pendingAuxiliaryUrls = [];
  }

  override destroy(): void {
    this._dashLoadBreaker.destroy();
    super.destroy();
    this.release();
  }
}
