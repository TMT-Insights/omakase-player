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

import {defer, finalize, from, map, type Observable, switchMap, takeUntil, tap} from 'rxjs';
import {fromFetch} from 'rxjs/fetch';
import {HlsPlayerController} from '../hls/hls-player-controller';
import type {LoadMainMediaArgsType} from '../player/player-controller-api';
import {AuthConfig} from '../common/authentication';
import {ObserverBreaker} from '../common/observer-breaker';
import {BlobUtil} from '../util/blob-util';
import {OmpError} from '../types';
import {parseDashManifest, writeDashMasterPlaylist, writeDashMediaPlaylist} from './dash-manifest';
import {resolveDashSegmentIndexes} from './dash-segment-index';

/** Bridges a static MPD to HLS; the original MPD remains the source in serialized media state. */
export class DashPlayerController extends HlsPlayerController {
  private readonly _dashLoadBreaker = new ObserverBreaker();
  private _playlistUrls: string[] = [];

  override loadMainMedia(args: LoadMainMediaArgsType): Observable<boolean> {
    return defer(() => {
      this._dashLoadBreaker.break();
      this._loadBreaker.break();
      this.destroyHls();
      this.unwireEvents();
      this.revokePlaylists();
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
        switchMap((manifest) => resolveDashSegmentIndexes(manifest)),
        switchMap((manifest) => {
          const playlists = manifest.renditions.map((rendition) => this.createPlaylist(writeDashMediaPlaylist(rendition)));
          const masterUrl = this.createPlaylist(writeDashMasterPlaylist(manifest.renditions, playlists));
          return super.loadMainMedia({...args, url: masterUrl, loadOptions: {...args.loadOptions, duration: args.loadOptions?.duration ?? manifest.duration}});
        }),
        tap(() => (loaded = true)),
        takeUntil(this._dashLoadBreaker.observer),
        takeUntil(this._destroyBreaker.observer),
        finalize(() => {
          if (!loaded) {
            this.destroyHls();
            this.revokePlaylists();
          }
        })
      );
    });
  }

  private createPlaylist(content: string): string {
    const url = BlobUtil.createBlobURL([content], {type: 'application/vnd.apple.mpegurl'});
    this._playlistUrls.push(url);
    return url;
  }

  private revokePlaylists(): void {
    this._playlistUrls.forEach((url) => BlobUtil.revokeObjectURL(url));
    this._playlistUrls = [];
  }

  override destroy(): void {
    this._dashLoadBreaker.destroy();
    super.destroy();
    this.revokePlaylists();
  }
}
