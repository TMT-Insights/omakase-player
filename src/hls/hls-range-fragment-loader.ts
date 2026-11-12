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

type FragmentLoaderClass = NonNullable<HlsConfig['fLoader']>;

/** Marks loader classes produced by {@link createRangeFragmentLoader}, so that they are not wrapped twice. */
const RANGE_FRAGMENT_LOADER = Symbol('rangeFragmentLoader');

export function isRangeFragmentLoader(loader: unknown): boolean {
  return !!loader && (loader as {[RANGE_FRAGMENT_LOADER]?: boolean})[RANGE_FRAGMENT_LOADER] === true;
}

/**
 * Fragment loader that keeps a server's full-file HTTP 200 reply to a byte-range request out of the
 * demuxer. Ignoring `Range` is legal, and with byte-range playlists (HLS `EXT-X-BYTERANGE`, DASH
 * indexes) it would otherwise hand hls.js a whole file - possibly gigabytes - as one fragment.
 *
 * With the default loaders, ranged fragments are streamed with a {@link FetchLoader}: the prefix is
 * discarded and the response cancelled as soon as the range has arrived. Requests go through
 * `hlsConfig.fetchSetup`, which is where authentication and credentials are applied. Fragments
 * without a range use `baseLoader` untouched.
 *
 * @param options.stream `false` keeps ranged fragments on `baseLoader` too (eg. when the application
 * customises XHR requests); a full-file response is then buffered before it is sliced.
 */
export function createRangeFragmentLoader(baseLoader: HlsConfig['loader'] = Hls.DefaultConfig.loader, options: {stream?: boolean} = {}): FragmentLoaderClass {
  const stream = options.stream ?? true;
  if (isRangeFragmentLoader(baseLoader)) {
    return baseLoader as FragmentLoaderClass;
  }
  return class RangeFragmentLoader implements Loader<FragmentLoaderContext> {
    static readonly [RANGE_FRAGMENT_LOADER] = true;

    context: FragmentLoaderContext | null = null;
    private readonly _loader: Loader<LoaderContext>;
    private readonly _rangeLoader?: Loader<LoaderContext>;
    private _streaming = false;

    constructor(config: HlsConfig) {
      this._loader = new baseLoader(config);
      if (stream && (baseLoader === Hls.DefaultConfig.loader || baseLoader === FetchLoader)) {
        this._rangeLoader = new FetchLoader(config);
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
                callbacks.onError({code: 200, text: 'truncated full-file fragment response'}, context, networkDetails, stats);
                return;
              }
              data = data.slice(start, end);
            }
            if (!(data instanceof ArrayBuffer) || data.byteLength !== end - start) {
              callbacks.onError({code: response.code ?? 0, text: 'invalid fragment byte-range response'}, context, networkDetails, stats);
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
        callbacks.onError({code: details instanceof Response ? details.status : 0, text}, context, details, this.stats);
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
        // emit every chunk as it arrives: hls.js would otherwise join small ones into 64 KiB blocks,
        // a copy made only to be copied again into the fragment buffer
        {...config, highWaterMark: 1},
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
            if (!data && from === 0 && to === bytes.byteLength && to === end - start) {
              // the whole range in one chunk: use it as is
              data = bytes;
              retained = to;
            } else if (to > from) {
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
