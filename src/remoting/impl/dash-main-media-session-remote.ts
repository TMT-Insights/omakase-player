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

import {type Observable, of, throwError} from 'rxjs';
import type {MainMedia} from '../../media';
import type {MainMediaSessionRemote} from '../main-media-session-remote';
import type {RemoteNode} from '../remote-node';
import type {DashMainMediaSession, DashMainMediaSessionState} from '../../dash/dash-main-media-session';
import {OmpError} from '../../types';

/**
 * The session of DASH media this window plays but does not own.
 *
 * The owning window fetched the MPD and holds the playlists; this window reads them, and asks it to
 * build the media playlists it has not built yet, rather than fetching the MPD and indexes again.
 */
export class DashMainMediaSessionRemote implements MainMediaSessionRemote, DashMainMediaSession {
  protected _session: DashMainMediaSession | undefined;

  connect(remoteNode: RemoteNode): void {
    this._session = remoteNode.getProxyByName('DashMainMediaSession');
  }

  /** Preparing happened in the window owning the media; there is nothing to do here. */
  prepare(): Observable<void> {
    return of(void 0);
  }

  getSessionState(mainMediaId: MainMedia['id']): Observable<DashMainMediaSessionState | undefined> {
    return this._session ? this._session.getSessionState(mainMediaId) : of(void 0);
  }

  resolvePlaylist(mainMediaId: MainMedia['id'], url: string): Observable<string> {
    return this._session ? this._session.resolvePlaylist(mainMediaId, url) : throwError(() => new OmpError(`DASH session is not connected`));
  }

  destroy(): void {
    this._session = void 0;
  }
}
