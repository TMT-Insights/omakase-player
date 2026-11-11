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
import type {MainMedia} from '../../media';
import {BaseMessageChannelProxy} from '../message-channel-proxy';
import type {RemoteNode} from '../remote-node';
import type {DashMainMediaSessionMessageChannel} from './dash-main-media-session-message-channel';
import type {DashMainMediaSessionState} from '../../dash/dash-main-media-session';

/** Building a playlist fetches its indexes in the owning window, which can outlast a plain request. */
const RESOLVE_PLAYLIST_TIMEOUT_MS = 60000;

export class DashMainMediaSessionProxy extends BaseMessageChannelProxy<DashMainMediaSessionMessageChannel> implements DashMainMediaSessionMessageChannel {
  constructor(remoteNode: RemoteNode) {
    super(remoteNode.getRemoteChannelOrFail('DashMainMediaSession'));
    this._onInitialized$.next(true);
  }

  getSessionState(mainMediaId: MainMedia['id']): Observable<DashMainMediaSessionState | undefined> {
    return this.messageChannel.sendAndWaitForResponse('getSessionState', [mainMediaId]);
  }

  resolvePlaylist(mainMediaId: MainMedia['id'], url: string): Observable<string> {
    return this.messageChannel.sendAndWaitForResponse('resolvePlaylist', [mainMediaId, url], {timeout: RESOLVE_PLAYLIST_TIMEOUT_MS});
  }
}
