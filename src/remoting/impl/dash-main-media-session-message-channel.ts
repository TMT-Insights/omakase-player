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

import {of, takeUntil, type Observable} from 'rxjs';
import type {MainMedia} from '../../media';
import {BaseMessageChannelBinding, MessageChannel} from '../message-channel';
import type {OmpProvider} from '../../omp-provider';
import {type DashMainMediaSessionState, isDashMainMediaSession} from '../../dash/dash-main-media-session';
import {OmpError} from '../../types';

export interface DashMainMediaSessionMessageChannel {
  getSessionState(mainMediaId: MainMedia['id']): Observable<DashMainMediaSessionState | undefined>;
  resolvePlaylist(mainMediaId: MainMedia['id'], url: string): Observable<string>;
}

/** Serves the DASH sessions of the media this window owns to the windows that play them. */
export class DashMainMediaSessionMessageChannelBinding extends BaseMessageChannelBinding {
  private _messageChannel: MessageChannel<DashMainMediaSessionMessageChannel>;

  constructor(messageChannel: MessageChannel<DashMainMediaSessionMessageChannel>, ompProvider: OmpProvider) {
    super(ompProvider);
    this._messageChannel = messageChannel;
  }

  override bind() {
    this._messageChannel
      .receiveAndSendResponse('getSessionState')
      .pipe(takeUntil(this._destroyBreaker.observer))
      .subscribe({
        next: ([[mainMediaId], sendResponseHook]) => {
          const session = this._ompProvider.mainMediaSessionManager.get(mainMediaId);
          sendResponseHook(isDashMainMediaSession(session) ? session.getSessionState(mainMediaId) : of(void 0));
        },
      });

    this._messageChannel
      .receiveAndSendResponse('resolvePlaylist')
      .pipe(takeUntil(this._destroyBreaker.observer))
      .subscribe({
        next: ([[mainMediaId, url], sendResponseHook, sendErrorHook]) => {
          const session = this._ompProvider.mainMediaSessionManager.get(mainMediaId);
          if (isDashMainMediaSession(session)) {
            sendResponseHook(session.resolvePlaylist(mainMediaId, url));
          } else {
            sendErrorHook(new OmpError(`DASH media ${mainMediaId} has no session in the window that owns it`));
          }
        },
      });
  }
}
