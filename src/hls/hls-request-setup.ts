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

import type {HlsConfig} from 'hls.js';
import {AuthConfig} from '../common/authentication';

type FetchSetup = NonNullable<HlsConfig['fetchSetup']>;

/** Marks setups produced by {@link createAuthFetchSetup}, so that they are not wrapped twice. */
const AUTH_FETCH_SETUP = Symbol('authFetchSetup');

/**
 * hls.js `fetchSetup` adding the current {@link AuthConfig} headers to every fetch-based request,
 * the Fetch counterpart of the `xhrSetup` {@link HlsPlayerController} installs. `configured` (the
 * application's own `fetchSetup`) still runs last, eg. to set cross-origin credentials.
 */
export function createAuthFetchSetup(configured?: FetchSetup | undefined): FetchSetup {
  if (configured && (configured as {[AUTH_FETCH_SETUP]?: boolean})[AUTH_FETCH_SETUP]) {
    return configured;
  }
  const setup: FetchSetup = (context, initParams) => {
    const auth = AuthConfig.createRequestInit(context.url, AuthConfig.authentication).headers;
    let init: RequestInit = initParams;
    if (auth) {
      const headers = new Headers(initParams.headers);
      new Headers(auth).forEach((value, name) => headers.set(name, value));
      init = {...initParams, headers};
    }
    return configured ? configured(context, init) : new Request(context.url, init);
  };
  return Object.assign(setup, {[AUTH_FETCH_SETUP]: true});
}
