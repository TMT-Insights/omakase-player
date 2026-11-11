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

import Hls, {FetchLoader, type FragmentLoaderContext, type HlsConfig, type Loader, type LoaderCallbacks, type LoaderConfiguration, type LoaderContext} from 'hls.js';
import {AuthConfig} from '../common/authentication';

/** Keeps full-file HTTP 200 responses out of the byte-range fragment demuxer. */
export function createDashFragmentLoader(baseLoader: HlsConfig['loader'] = Hls.DefaultConfig.loader): NonNullable<HlsConfig['fLoader']> {
  return class DashFragmentLoader implements Loader<FragmentLoaderContext> {
    context: FragmentLoaderContext | null = null;
    private readonly _loader: Loader<LoaderContext>;
    private readonly _rangeLoader?: Loader<LoaderContext>;
    private _streaming = false;

    constructor(config: HlsConfig) {
      this._loader = new baseLoader(config);
      if (baseLoader === Hls.DefaultConfig.loader || baseLoader === FetchLoader) {
        this._rangeLoader = new FetchLoader({
          ...config,
          fetchSetup: (context, init) => {
            const headers = new Headers(init.headers);
            new Headers(AuthConfig.createRequestInit(context.url, AuthConfig.authentication).headers).forEach((value, name) => headers.set(name, value));
            const options = {...init, headers};
            return config.fetchSetup ? config.fetchSetup(context, options) : new Request(context.url, options);
          },
        });
        this._rangeLoader.stats = this._loader.stats;
      }
    }

    get stats() {
      return this._loader.stats;
    }

    abort(): void {
      (this._streaming ? this._rangeLoader! : this._loader).abort();
    }

    destroy(): void {
      this._rangeLoader?.destroy();
      this._loader.destroy();
      this.context = null;
    }

    getCacheAge(): number | null {
      return (this._streaming ? this._rangeLoader! : this._loader).getCacheAge?.() ?? null;
    }

    getResponseHeader(name: string): string | null {
      return (this._streaming ? this._rangeLoader! : this._loader).getResponseHeader?.(name) ?? null;
    }

    load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>): void {
      this.context = context;
      const start = context.rangeStart ?? 0;
      const end = context.rangeEnd;
      if (end && this._rangeLoader) {
        this._streaming = true;
        this.loadStreamedRange(context, config, callbacks, this._rangeLoader, start, end);
        return;
      }
      const {onAbort, onProgress} = callbacks;
      const forwardedCallbacks: LoaderCallbacks<LoaderContext> = {
        onSuccess: (response, stats, _context, details) => callbacks.onSuccess(response, stats, context, details),
        onError: (error, _context, details, stats) => callbacks.onError(error, context, details, stats),
        onTimeout: (stats, _context, details) => callbacks.onTimeout(stats, context, details),
        ...(onAbort ? {onAbort: (stats, _context, details) => onAbort(stats, context, details)} : {}),
        ...(onProgress ? {onProgress: (stats, _context, data, details) => onProgress(stats, context, data, details)} : {}),
      };
      if (!end) {
        this._loader.load(context, config, forwardedCallbacks);
        return;
      }

      // Progressive data must not reach hls.js before we know whether the server honored Range.
      const {onProgress: forwardProgress, ...completedCallbacks} = forwardedCallbacks;
      this._loader.load(
        {...context, progressData: false},
        {...config, highWaterMark: Infinity},
        {
          ...completedCallbacks,
          onSuccess: (response, stats, loaderContext, networkDetails) => {
            let data = response.data;
            if (response.code === 200) {
              if (!(data instanceof ArrayBuffer) || data.byteLength < end) {
                callbacks.onError({code: 200, text: 'DASH: truncated full-file fragment response'}, context, networkDetails, stats);
                return;
              }
              data = data.slice(start, end);
            }
            if (!(data instanceof ArrayBuffer) || data.byteLength !== end - start) {
              callbacks.onError({code: response.code ?? 0, text: 'DASH: invalid fragment byte-range response'}, context, networkDetails, stats);
              return;
            }
            forwardProgress?.(stats, loaderContext, data, networkDetails);
            callbacks.onSuccess({...response, data}, stats, context, networkDetails);
          },
        }
      );
    }

    private loadStreamedRange(
      context: FragmentLoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<FragmentLoaderContext>,
      loader: Loader<LoaderContext>,
      start: number,
      end: number
    ): void {
      let position = 0;
      let retained = 0;
      let data: Uint8Array<ArrayBuffer> | undefined;
      let settled = false;
      const fail = (text: string, details: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        loader.abort();
        callbacks.onError({code: details instanceof Response ? details.status : 0, text: `DASH: ${text}`}, context, details, this.stats);
      };
      const succeed = (response: Response) => {
        if (settled) {
          return;
        }
        if (!data || retained !== end - start) {
          fail('truncated fragment byte-range response', response);
          return;
        }
        settled = true;
        // A 200 response may contain gigabytes after this range. Stop before buffering them.
        loader.abort();
        const stats = this.stats;
        stats.aborted = false;
        stats.total = stats.loaded;
        stats.loading.end = Math.max(performance.now(), stats.loading.first);
        callbacks.onProgress?.(stats, context, data.buffer, response);
        callbacks.onSuccess({url: response.url || context.url, code: response.status, data: data.buffer}, stats, context, response);
      };
      loader.load(
        context,
        {...config, highWaterMark: 64 * 1024},
        {
          onProgress: (stats, _context, chunk, details: unknown) => {
            if (settled) {
              return;
            }
            if (!(details instanceof Response) || typeof chunk === 'string' || ![200, 206].includes(details.status)) {
              fail('invalid streaming fragment response', details);
              return;
            }
            // Full-file Content-Length is not the size of the fragment hls.js is loading.
            stats.total = 0;
            const bytes = new Uint8Array(chunk);
            const rangeStart = details.status === 200 ? start : 0;
            const rangeEnd = details.status === 200 ? end : end - start;
            if (details.status === 206 && position + bytes.byteLength > rangeEnd) {
              fail('oversized fragment byte-range response', details);
              return;
            }
            const from = Math.max(rangeStart - position, 0);
            const to = Math.min(bytes.byteLength, rangeEnd - position);
            if (to > from) {
              data ??= new Uint8Array(end - start);
              data.set(bytes.subarray(from, to), retained);
              retained += to - from;
            }
            position += bytes.byteLength;
            if (details.status === 200 && position >= end) {
              succeed(details);
            }
          },
          onSuccess: (_response, _stats, _context, details: unknown) => {
            if (details instanceof Response) {
              succeed(details);
            } else {
              fail('missing streaming fragment response', details);
            }
          },
          onError: (error, _context, details, stats) => {
            if (!settled) {
              settled = true;
              callbacks.onError(error, context, details, stats);
            }
          },
          onTimeout: (stats, _context, details) => {
            if (!settled) {
              settled = true;
              callbacks.onTimeout(stats, context, details);
            }
          },
          onAbort: (stats, _context, details) => {
            if (!settled) {
              settled = true;
              callbacks.onAbort?.(stats, context, details);
            }
          },
        }
      );
    }
  };
}
