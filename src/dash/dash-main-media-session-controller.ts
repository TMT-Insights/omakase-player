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

import {defer, finalize, from, map, type Observable, of, share, tap, throwError} from 'rxjs';
import type {MainMedia} from '../media';
import {HlsMainMediaSessionController} from '../hls/hls-main-media-session-controller';
import {SourceUtil} from '../source';
import {OmpError} from '../types';
import type {DashMainMediaSession, DashMainMediaSessionState} from './dash-main-media-session';
import {DashPreparedMedia} from './dash-prepared-media';

/**
 * Owns a DASH media's bridged playlists in the window that loaded it, for as long as the media
 * exists - across player reloads, detaching and re-attaching - and serves them to whichever window
 * plays it. A detached window builds nothing itself; it reads this session through a remote.
 */
export class DashMainMediaSessionController extends HlsMainMediaSessionController implements DashMainMediaSession {
  protected _media: DashPreparedMedia | undefined;
  protected _preparing$: Observable<void> | undefined;
  protected _readersPrepared = false;
  protected _destroyed = false;

  /** Fetches and bridges the MPD once; later calls (player reloads, re-attaching) reuse the result. */
  override prepare(): Observable<void> {
    if (!this._readersPrepared) {
      this._readersPrepared = true;
      super.prepare().subscribe();
    }
    if (this._media) {
      return of(void 0);
    }
    this._preparing$ ??= defer(() => DashPreparedMedia.load(SourceUtil.resolveUrlFromSourceOrFail(this.mainMedia.source))).pipe(
      tap((media) => {
        if (this._destroyed) {
          media.release();
        } else {
          this._media = media;
        }
      }),
      map(() => void 0),
      finalize(() => (this._preparing$ = undefined)),
      share()
    );
    return this._preparing$;
  }

  getSessionState(mainMediaId: MainMedia['id']): Observable<DashMainMediaSessionState | undefined> {
    return of(mainMediaId === this.mainMedia.id ? this._media?.state : undefined);
  }

  resolvePlaylist(mainMediaId: MainMedia['id'], url: string): Observable<string> {
    if (mainMediaId !== this.mainMedia.id || !this._media) {
      return throwError(() => new OmpError(`DASH media ${mainMediaId} is not prepared in this window`));
    }
    const media = this._media;
    return defer(() => from(media.resolve(url)));
  }

  override destroy(): void {
    this._destroyed = true;
    this._media?.release();
    this._media = undefined;
    super.destroy();
  }
}
