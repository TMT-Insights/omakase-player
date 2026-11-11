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

import {OmpError} from './types';
export async function httpGetText(url: string, requestInit?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    method: 'GET',
    ...requestInit,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return await res.text();
}

export async function httpGetArrayBuffer(url: string, requestInit?: RequestInit): Promise<ArrayBuffer> {
  let res = await fetch(url, {
    method: 'GET',
    ...requestInit,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return res.arrayBuffer();
}

/** Byte sub-range of a resource. */
export interface HttpByteRange {
  offset: number;
  length: number;
}

export interface HttpGetBytesOptions {
  /** Bytes to request; without one the whole body is read (up to {@link maxBytes}). */
  range?: HttpByteRange | undefined;
  /** Upper bound on the bytes retained; a larger declared range is rejected before any request. */
  maxBytes: number;
  /** Accept fewer bytes than {@link range} asks for when the resource ends first. */
  allowShort?: boolean | undefined;
  /** Merged into the request; a `Range` header is added for {@link range}. */
  requestInit?: RequestInit | undefined;
  signal?: AbortSignal | undefined;
  /** Names the resource in error messages, e.g. `SIDX`. */
  label: string;
  /** Prepended to error messages, e.g. `DASH: `. */
  errorPrefix?: string | undefined;
}

export interface HttpBytesResult {
  data: Uint8Array<ArrayBuffer>;
  status: number;
  /** Size of the whole resource, when the response reveals it. */
  total?: number | undefined;
}

/**
 * Reads a byte range, or a whole bounded body, without trusting the server to honour `Range`.
 *
 * A `206` is validated against the request. A full-file `200` is streamed: the prefix is discarded,
 * only the requested bytes are kept, and the response is cancelled once they have arrived, so a range
 * of a multi-gigabyte file never buffers the file.
 */
export async function httpGetBytes(url: string, options: HttpGetBytesOptions): Promise<HttpBytesResult> {
  const {range, maxBytes, allowShort, requestInit, signal, label, errorPrefix = ''} = options;
  const fail = (message: string): never => {
    throw new OmpError(`${errorPrefix}${message}`);
  };
  signal?.throwIfAborted();
  const headers = new Headers(requestInit?.headers);
  if (range) {
    const last = range.offset + range.length - 1;
    if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(last) || range.offset < 0 || range.length < 1) {
      fail(`invalid ${label} byte range`);
    }
    if (range.length > maxBytes) {
      fail(`${label} byte range exceeds ${formatBytes(maxBytes)}`);
    }
    headers.set('Range', `bytes=${range.offset}-${last}`);
  }

  const response = await fetch(url, {...requestInit, headers, ...(signal ? {signal} : {})});
  if (!response.ok) {
    return fail(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} for ${label} ${url}`);
  }
  if (response.status !== 200 && response.status !== 206) {
    return fail(`unexpected HTTP ${response.status} for ${label}`);
  }
  const contentRange = response.headers.get('Content-Range');
  if (range && response.status === 206 && contentRange) {
    // Content-Range is often not CORS-exposed, so it is checked when present and the size checked always
    const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange);
    const last = range.offset + range.length - 1;
    if (!match || Number(match[1]) !== range.offset || (allowShort ? Number(match[2]) > last : Number(match[2]) !== last)) {
      fail(`unexpected ${label} Content-Range`);
    }
  }
  const total = (response.status === 200 ? Number(response.headers.get('Content-Length')) : Number(contentRange?.split('/')[1])) || undefined;
  if (!response.body) {
    return fail(`empty ${label} response`);
  }

  const skip = range && response.status === 200 ? range.offset : 0;
  const wanted = range ? range.length : maxBytes;
  const buffer = range ? new Uint8Array(range.length) : undefined;
  const chunks: Uint8Array[] = [];
  let received = 0;
  let retained = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (range && response.status === 206 && received + value.byteLength > range.length) {
        fail(`oversized ${label} range response`);
      }
      const from = Math.max(0, skip - received);
      const to = Math.min(value.byteLength, skip + wanted - received);
      received += value.byteLength;
      if (to > from) {
        if (buffer) {
          buffer.set(value.subarray(from, to), retained);
        } else {
          if (retained + to - from > maxBytes) fail(`${label} response exceeds ${formatBytes(maxBytes)}`);
          chunks.push(value.subarray(from, to));
        }
        retained += to - from;
      }
      // the rest of a full-file response is not needed
      if (range && response.status === 200 && retained === range.length) break;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (range && retained < range.length) {
    const known = total === undefined ? retained : Math.min(range.length, total - range.offset);
    if (!allowShort || retained < known) {
      fail(response.status === 200 ? `truncated ${label} full-file response` : `truncated ${label} range response`);
    }
  }
  signal?.throwIfAborted();
  let data: Uint8Array<ArrayBuffer>;
  if (buffer) {
    data = retained === buffer.byteLength ? buffer : buffer.slice(0, retained);
  } else {
    data = new Uint8Array(retained);
    let position = 0;
    for (const chunk of chunks) {
      data.set(chunk, position);
      position += chunk.byteLength;
    }
  }
  return {data, status: response.status, total};
}

function formatBytes(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;
}
