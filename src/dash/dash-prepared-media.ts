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

import {defer, from, map, type Observable} from 'rxjs';
import {fromFetch} from 'rxjs/fetch';
import {AuthConfig} from '../common/authentication';
import {SyntheticManifestRegistry} from '../hls/synthetic-manifest-registry';
import {OmpError} from '../types';
import {type DashManifest, type DashSegment, dashSegmentsAligned, parseDashManifest, planDashTracks, resolveDashTailShortfall, writeDashMasterPlaylist, writeDashMediaPlaylist} from './dash-manifest';
import {createDashIndexBudget, resolveDashTrack} from './dash-segment-index';
import type {DashAuxiliaryManifest, DashMainMediaSessionState} from './dash-main-media-session';

/** Origin of the synthetic playlist URLs served by `SyntheticManifestLoader`. */
export const DASH_SYNTHETIC_ORIGIN = 'https://dash.omakase.local';

/**
 * An MPD bridged to HLS: the master playlist and one lazily built media playlist per track, held in
 * this window's {@link SyntheticManifestRegistry} until {@link release}.
 *
 * A track's indexes are only fetched when its playlist is first resolved, so an ABR ladder costs one
 * index request per rendition actually played.
 */
export class DashPreparedMedia {
  private readonly _urls: Set<string>;

  private constructor(
    readonly masterUrl: string,
    readonly duration: number,
    readonly playlistUrls: string[],
    readonly initialPlaylists: {url: string; type: 'video' | 'audio'}[],
    readonly auxiliary: DashAuxiliaryManifest | undefined,
    private readonly _indexAbort: AbortController
  ) {
    this._urls = new Set([masterUrl, ...playlistUrls]);
  }

  /** Fetches (with {@link AuthConfig}) and parses the MPD, and registers its playlists. */
  static load(url: string): Observable<DashPreparedMedia> {
    return defer(() => {
      const sourceUrl = new URL(url, document.baseURI).href;
      return fromFetch(sourceUrl, {
        ...AuthConfig.createRequestInit(sourceUrl, AuthConfig.authentication),
        selector: (response) => {
          if (!response.ok) {
            throw new OmpError(`DASH: HTTP ${response.status} ${response.statusText} for ${sourceUrl}`);
          }
          return from(response.text()).pipe(map((xml) => parseDashManifest(xml, response.url || sourceUrl)));
        },
      }).pipe(map((manifest) => DashPreparedMedia.fromManifest(manifest)));
    });
  }

  static fromManifest(manifest: DashManifest): DashPreparedMedia {
    const indexAbort = new AbortController();
    const budget = createDashIndexBudget();
    const plans = planDashTracks(manifest);
    let alignment: DashSegment[] | undefined;
    const register = (content: string | (() => Promise<string>)) => {
      const url = SyntheticManifestRegistry.createUrl(DASH_SYNTHETIC_ORIGIN);
      if (typeof content === 'string') {
        SyntheticManifestRegistry.register(url, content);
      } else {
        SyntheticManifestRegistry.registerLazy(url, content);
      }
      return url;
    };
    const isInitial = new Set<number>();
    const playlistUrls = plans.map((plan, index) =>
      register(async () => {
        const track = await resolveDashTrack(plan, indexAbort.signal, budget);
        // initial tracks are reported when the media loads; alternate audio only when first used
        if (!isInitial.has(index) && track.type === 'audio') {
          const end = track.segments.reduce((total, segment) => total + segment.duration, 0);
          const shortfall = resolveDashTailShortfall(manifest.duration, [{type: 'audio', end}]);
          if (shortfall) console.warn(`${shortfall.message} (audio track "${track.label}")`);
        }
        if (track.type === 'video') {
          // checked per resolved level, as levels are not resolved together
          if (alignment && !dashSegmentsAligned(track.segments, alignment)) {
            throw new OmpError('DASH: video representations must have aligned segment boundaries');
          }
          alignment ??= track.segments;
        }
        return writeDashMediaPlaylist(track);
      })
    );
    const heads = plans.map((plan) => plan.head);
    const masterUrl = register(writeDashMasterPlaylist(heads, playlistUrls));
    const initialPlaylists = [heads.findIndex((track) => track.type === 'video'), heads.findIndex((track) => track.type === 'audio')]
      .filter((index) => index >= 0)
      .map((index) => {
        isInitial.add(index);
        return {url: playlistUrls[index]!, type: heads[index]!.type as 'video' | 'audio'};
      });
    const auxiliary = manifest.auxiliaryPeriods ? {duration: manifest.duration, auxiliaryPeriods: manifest.auxiliaryPeriods} : undefined;
    return new DashPreparedMedia(masterUrl, manifest.duration, playlistUrls, initialPlaylists, auxiliary, indexAbort);
  }

  /** A snapshot another window can play from; playlists not built yet are requested from this one. */
  get state(): DashMainMediaSessionState {
    const manifests: Record<string, string> = {};
    this._urls.forEach((url) => {
      const content = SyntheticManifestRegistry.get(url);
      if (content !== undefined) {
        manifests[url] = content;
      }
    });
    return {
      masterUrl: this.masterUrl,
      duration: this.duration,
      playlistUrls: this.playlistUrls,
      initialPlaylists: this.initialPlaylists,
      manifests,
      ...(this.auxiliary ? {auxiliary: this.auxiliary} : {}),
    };
  }

  /** The text of one of this media's playlists, building it if needed. */
  resolve(url: string): Promise<string> {
    const content = this._urls.has(url) ? SyntheticManifestRegistry.resolve(url) : undefined;
    return content ?? Promise.reject(new OmpError(`DASH: ${url} is not a playlist of this media`));
  }

  /** Aborts pending index requests and removes the playlists from the registry. */
  release(): void {
    this._indexAbort.abort();
    this._urls.forEach((url) => SyntheticManifestRegistry.clear(url));
  }
}
