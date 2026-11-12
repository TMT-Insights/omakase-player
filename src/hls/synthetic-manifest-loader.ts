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

import Hls, {type HlsConfig, type Loader, type LoaderCallbacks, type LoaderConfiguration, type LoaderContext} from 'hls.js';
import {SyntheticManifestRegistry} from './synthetic-manifest-registry';

const BaseLoader = Hls.DefaultConfig.loader as new (config: HlsConfig) => Loader<LoaderContext>;

/**
 * hls.js playlist loader (`pLoader`) that serves playlists from {@link SyntheticManifestRegistry},
 * building lazy ones on demand. Anything not in the registry falls through to the default loader.
 */
export class SyntheticManifestLoader extends BaseLoader {
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _request = 0;

  override load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
    const content = SyntheticManifestRegistry.resolve(context.url);

    if (content === undefined) {
      if (SyntheticManifestRegistry.isSyntheticUrl(context.url)) {
        console.warn(`Unregistered synthetic playlist requested: ${context.url}`);
      }
      super.load(context, config, callbacks);
      return;
    }

    const stats = this.stats;
    stats.loading.start = performance.now();
    const request = ++this._request;

    // hls.js finishes wiring the loader synchronously around load(); deliver on a macrotask so its
    // internal state is ready before a callback fires (default loaders are always async).
    content.then(
      (text) =>
        this.deliver(request, () => {
          const now = performance.now();
          stats.loading.first = now;
          stats.loading.end = now;
          stats.loaded = text.length;
          stats.total = text.length;
          callbacks.onSuccess({url: context.url, data: text}, stats, context, null);
        }),
      (error: unknown) =>
        this.deliver(request, () => {
          const text = error instanceof Error ? error.message : String(error);
          console.error(`Synthetic playlist ${context.url} could not be built: ${text}`);
          callbacks.onError({code: 0, text}, context, null, stats);
        })
    );
  }

  override abort(): void {
    this.cancel();
    super.abort();
  }

  override destroy(): void {
    this.cancel();
    super.destroy();
  }

  private deliver(request: number, callback: () => void): void {
    if (request !== this._request) {
      return;
    }
    this._timer = setTimeout(() => {
      this._timer = undefined;
      if (request === this._request) {
        callback();
      }
    }, 0);
  }

  private cancel(): void {
    this._request++;
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}
