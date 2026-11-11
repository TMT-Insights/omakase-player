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

import {combineLatest, defer, finalize, from, map, type Observable, of, switchMap, take, takeUntil, tap} from 'rxjs';
import {fromFetch} from 'rxjs/fetch';
import type {HlsConfig} from 'hls.js';
import {HlsPlayerController, type HlsPlayerControllerConfig} from '../hls/hls-player-controller';
import {SyntheticManifestLoader} from '../hls/synthetic-manifest-loader';
import {SyntheticManifestRegistry, type SyntheticManifestResolver} from '../hls/synthetic-manifest-registry';
import type {LoadMainMediaArgsType, PlayerDomController} from '../player/player-controller-api';
import {AuthConfig} from '../common/authentication';
import {ObserverBreaker} from '../common/observer-breaker';
import {BlobUtil} from '../util/blob-util';
import {OmpError} from '../types';
import {type DashSegment, dashSegmentsAligned, parseDashManifest, planDashTracks, writeDashMasterPlaylist, writeDashMediaPlaylist} from './dash-manifest';
import {createDashIndexBudget, resolveDashTrack} from './dash-segment-index';
import {createDashFragmentLoader} from './dash-fragment-loader';
import {loadDashAuxiliaryTracks} from './dash-auxiliary';

/** Origin of the synthetic playlist URLs served by {@link SyntheticManifestLoader}. */
export const DASH_SYNTHETIC_ORIGIN = 'https://dash.omakase.local';

/**
 * Bridges a static MPD to HLS; the original MPD remains the source in serialized media state.
 *
 * Media playlists are built lazily: a track's indexes are only fetched when hls.js asks for its
 * playlist, so an ABR ladder costs one index request per rendition actually played. The initial
 * video and audio playlists are resolved alongside the hls.js load, so their errors still fail it.
 */
export class DashPlayerController extends HlsPlayerController {
  private readonly _dashLoadBreaker = new ObserverBreaker();
  private _playlistUrls: string[] = [];
  private _pendingAuxiliaryUrls: string[] = [];
  private _indexAbort: AbortController | undefined;

  constructor(playerDomController: PlayerDomController, config?: Partial<HlsPlayerControllerConfig>) {
    super(playerDomController, {
      ...config,
      hlsConfig: {
        ...config?.hlsConfig,
        pLoader: SyntheticManifestLoader as NonNullable<HlsConfig['pLoader']>,
        fLoader: createDashFragmentLoader(config?.hlsConfig?.fLoader ?? config?.hlsConfig?.loader),
      },
    });
  }

  override loadMainMedia(args: LoadMainMediaArgsType): Observable<boolean> {
    return defer(() => {
      this._dashLoadBreaker.break();
      this._loadBreaker.break();
      this.destroyHls();
      this.unwireEvents();
      this.releasePlaylists();
      if (!args.url) {
        throw new OmpError('DASH: MPD URL not provided');
      }
      const sourceUrl = new URL(args.url, document.baseURI).href;
      let loaded = false;
      return fromFetch(sourceUrl, {
        ...AuthConfig.createRequestInit(sourceUrl, AuthConfig.authentication),
        selector: (response) => {
          if (!response.ok) {
            throw new OmpError(`DASH: HTTP ${response.status} ${response.statusText} for ${sourceUrl}`);
          }
          return from(response.text()).pipe(map((xml) => parseDashManifest(xml, response.url || sourceUrl)));
        },
      }).pipe(
        switchMap((manifest) => {
          const indexAbort = (this._indexAbort = new AbortController());
          const budget = createDashIndexBudget();
          const plans = planDashTracks(manifest);
          let alignment: DashSegment[] | undefined;
          const playlistUrls = plans.map((plan) =>
            this.registerPlaylist(async () => {
              const track = await resolveDashTrack(plan, indexAbort.signal, budget);
              if (track.type === 'video') {
                // checked per resolved level, as levels are no longer resolved together
                if (alignment && !dashSegmentsAligned(track.segments, alignment)) {
                  throw new OmpError('DASH: video representations must have aligned segment boundaries');
                }
                alignment ??= track.segments;
              }
              return writeDashMediaPlaylist(track);
            })
          );
          const heads = plans.map((plan) => plan.head);
          const masterUrl = this.registerPlaylist(writeDashMasterPlaylist(heads, playlistUrls));
          const initialUrls = [heads.findIndex((track) => track.type === 'video'), heads.findIndex((track) => track.type === 'audio')]
            .filter((index) => index >= 0)
            .map((index) => playlistUrls[index]!);
          // hls.js requests the same playlists and joins these resolutions rather than repeating them
          const initial$ = defer(() => Promise.all(initialUrls.map((url) => SyntheticManifestRegistry.resolve(url)!)));
          const restoringAuxiliary = args.providedMainMedia?.tracks.some((track) => track.customAttrs?.['dashAuxiliary'] === true);
          const auxiliary$ = restoringAuxiliary
            ? of([])
            : loadDashAuxiliaryTracks(manifest, (data, mime) => {
                const url = BlobUtil.createBlobURL(data, {type: mime});
                this._pendingAuxiliaryUrls.push(url);
                return url;
              });
          const hls$ = super.loadMainMedia({
            ...args,
            url: masterUrl,
            loadOptions: {...args.loadOptions, duration: args.loadOptions?.duration ?? manifest.duration},
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
            this.releasePlaylists();
          }
        })
      );
    });
  }

  private registerPlaylist(content: string | SyntheticManifestResolver): string {
    const url = SyntheticManifestRegistry.createUrl(DASH_SYNTHETIC_ORIGIN);
    if (typeof content === 'string') {
      SyntheticManifestRegistry.register(url, content);
    } else {
      SyntheticManifestRegistry.registerLazy(url, content);
    }
    this._playlistUrls.push(url);
    return url;
  }

  private releasePlaylists(): void {
    this._indexAbort?.abort();
    this._indexAbort = undefined;
    this._playlistUrls.forEach((url) => SyntheticManifestRegistry.clear(url));
    this._pendingAuxiliaryUrls.forEach((url) => BlobUtil.revokeObjectURL(url));
    this._playlistUrls = [];
    this._pendingAuxiliaryUrls = [];
  }

  override destroy(): void {
    this._dashLoadBreaker.destroy();
    super.destroy();
    this.releasePlaylists();
  }
}
