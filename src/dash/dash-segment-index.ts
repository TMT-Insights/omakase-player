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

import {forkJoin, from, map, of, type Observable} from 'rxjs';
import {fromFetch} from 'rxjs/fetch';
import {AuthConfig} from '../common/authentication';
import {OmpError} from '../types';
import {type DashManifest, type DashRendition, type DashSegment, validateDashSegmentAlignment} from './dash-manifest';

const MAX_INDEX_BYTES = 16 * 1024 * 1024;

function fail(message: string): never {
  throw new OmpError(`DASH: ${message}`);
}

function safeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`invalid SIDX ${name}`);
  }
  return value;
}

/** Resolves direct SIDX references into absolute media-file byte ranges. */
export function parseDashSegmentIndex(data: ArrayBuffer, rendition: DashRendition, periodDuration: number): DashSegment[] {
  const addressing = rendition.segmentBase;
  if (!addressing) {
    return fail('SegmentBase addressing is required for SIDX');
  }
  const view = new DataView(data);
  const uint64 = (offset: number) => safeInteger(view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4), '64-bit value');
  let boxStart = 0;
  while (boxStart + 8 <= view.byteLength) {
    let size = view.getUint32(boxStart);
    const type = String.fromCharCode(...new Uint8Array(data, boxStart + 4, 4));
    let headerSize = 8;
    if (size === 1) {
      if (boxStart + 16 > view.byteLength) {
        return fail('truncated SIDX box header');
      }
      size = uint64(boxStart + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = view.byteLength - boxStart;
    }
    const boxEnd = safeInteger(boxStart + size, 'box end');
    if (size < headerSize || boxEnd > view.byteLength) {
      return fail('truncated or invalid SIDX box');
    }
    if (type !== 'sidx') {
      boxStart = boxEnd;
      continue;
    }

    const payload = boxStart + headerSize;
    if (payload + 12 > boxEnd) {
      return fail('truncated SIDX header');
    }
    const version = view.getUint8(payload);
    if (version !== 0 && version !== 1) {
      return fail(`unsupported SIDX version ${version}`);
    }
    const timescale = view.getUint32(payload + 8);
    if (!timescale) {
      return fail('invalid SIDX timescale');
    }
    const timingSize = version === 0 ? 8 : 16;
    const countOffset = payload + 12 + timingSize + 2;
    if (countOffset + 2 > boxEnd) {
      return fail('truncated SIDX timing fields');
    }
    const earliestTime = version === 0 ? view.getUint32(payload + 12) : uint64(payload + 12);
    const firstOffset = version === 0 ? view.getUint32(payload + 16) : uint64(payload + 20);
    if (Math.abs(earliestTime / timescale - rendition.presentationTimeOffset) > 0.001) {
      return fail('the first SIDX segment must start at presentationTimeOffset; leading trims or gaps are not supported');
    }
    const referenceCount = view.getUint16(countOffset);
    const referencesStart = countOffset + 2;
    if (!referenceCount || referencesStart + referenceCount * 12 > boxEnd) {
      return fail('empty or truncated SIDX references');
    }

    let byteOffset = safeInteger(addressing.indexRange.offset + boxEnd + firstOffset, 'first byte offset');
    let elapsedTicks = 0;
    const segments: DashSegment[] = [];
    for (let i = 0; i < referenceCount; i++) {
      const position = referencesStart + i * 12;
      const reference = view.getUint32(position);
      if (reference >>> 31) {
        return fail('hierarchical SIDX references are not supported');
      }
      const length = reference & 0x7fffffff;
      const ticks = view.getUint32(position + 4);
      if (!length || !ticks) {
        return fail('invalid SIDX reference size or duration');
      }
      const segmentDuration = ticks / timescale;
      const elapsed = elapsedTicks / timescale;
      const nextByteOffset = safeInteger(byteOffset + length, 'segment end');
      if (elapsed < periodDuration) {
        segments.push({
          url: addressing.mediaUrl,
          duration: Math.min(segmentDuration, periodDuration - elapsed),
          byteRange: {offset: byteOffset, length},
        });
      }
      elapsedTicks += ticks;
      byteOffset = nextByteOffset;
    }
    if (elapsedTicks / timescale < periodDuration - 0.001) {
      return fail('SIDX does not cover the Period duration');
    }
    return segments;
  }
  return fail('SegmentBase indexRange contains no SIDX box');
}

export function resolveDashSegmentIndexes(manifest: DashManifest): Observable<DashManifest> {
  return forkJoin(
    manifest.renditions.map((rendition) => {
      if (!rendition.segmentBase) {
        return of(rendition);
      }
      const {mediaUrl, indexRange} = rendition.segmentBase;
      if (indexRange.length > MAX_INDEX_BYTES) {
        return fail(`SIDX indexRange exceeds ${MAX_INDEX_BYTES} bytes`);
      }
      const end = safeInteger(indexRange.offset + indexRange.length - 1, 'index range end');
      const request = AuthConfig.createRequestInit(mediaUrl, AuthConfig.authentication);
      const headers = new Headers(request.headers);
      headers.set('Range', `bytes=${indexRange.offset}-${end}`);
      return fromFetch(mediaUrl, {
        ...request,
        headers,
        selector: (response) => {
          if (!response.ok) {
            return fail(`HTTP ${response.status} ${response.statusText} for SIDX ${mediaUrl}`);
          }
          if (response.status !== 206) {
            return fail('SegmentBase requires HTTP byte-range support (206 Partial Content)');
          }
          const contentRange = response.headers.get('Content-Range');
          if (contentRange && !new RegExp(`^bytes ${indexRange.offset}-${end}/(?:\\d+|\\*)$`, 'i').test(contentRange)) {
            return fail('unexpected SIDX Content-Range');
          }
          return from(response.arrayBuffer()).pipe(
            map((data) => {
              if (data.byteLength !== indexRange.length) {
                return fail('truncated or oversized SIDX range response');
              }
              return {...rendition, segments: parseDashSegmentIndex(data, rendition, manifest.duration)};
            })
          );
        },
      });
    })
  ).pipe(
    map((renditions) => {
      const resolved = {...manifest, renditions};
      validateDashSegmentAlignment(resolved);
      return resolved;
    })
  );
}
