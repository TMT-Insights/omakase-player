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

import type {Observable} from 'rxjs';
import type {MainMedia} from '../media';
import type {DashManifest} from './dash-manifest';

/** What auxiliary (text/image) track loading needs from a manifest. */
export type DashAuxiliaryManifest = Pick<DashManifest, 'duration' | 'auxiliaryPeriods'>;

/**
 * A prepared DASH media as any window can use it: synthetic playlist URLs (portable between windows,
 * served by `SyntheticManifestLoader`), the playlists built so far, and what auxiliary tracks need.
 */
export interface DashMainMediaSessionState {
  masterUrl: string;
  duration: number;
  /** Every media playlist, in master order; those not in {@link manifests} are built on request. */
  playlistUrls: string[];
  /** The playlists hls.js starts with, resolved while a load starts so that their errors fail it. */
  initialPlaylists: {url: string; type: 'video' | 'audio'}[];
  /** Playlist text already built, by URL; includes the master. */
  manifests: Record<string, string>;
  auxiliary?: DashAuxiliaryManifest | undefined;
}

/**
 * The DASH session as the player controller reads it: the session controller when this window owns
 * the media, a remote to the owning window when it does not.
 */
export interface DashMainMediaSession {
  getSessionState(mainMediaId: MainMedia['id']): Observable<DashMainMediaSessionState | undefined>;

  /** Builds a media playlist (fetching its indexes) in the window that owns the media. */
  resolvePlaylist(mainMediaId: MainMedia['id'], url: string): Observable<string>;
}

export function isDashMainMediaSession(sessionController: unknown): sessionController is DashMainMediaSession {
  return !!sessionController && typeof (sessionController as Partial<DashMainMediaSession>).resolvePlaylist === 'function';
}
