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

import {Observable} from 'rxjs';
import {AuthConfig} from '../common/authentication';
import {OmpError} from '../types';
import {
  concatDashTrack,
  type DashByteRange,
  type DashIndexSource,
  type DashManifest,
  type DashRendition,
  type DashSegment,
  type DashTrackPlan,
  stitchDashPeriods,
  validateDashSegmentAlignment,
} from './dash-manifest';

const MAX_INDEX_BYTES = 16 * 1024 * 1024;
/** First read when locating `moov`/`sidx`; covers both in typical files, so discovery is one request. */
const DISCOVERY_PROBE_BYTES = 16 * 1024;
/** Parallel index requests per track (per-segment indexes) and per Period (renditions). */
const INDEX_CONCURRENCY = 6;

/** Like `Promise.all(items.map(fn))` with at most `limit` calls in flight; stops starting calls after a failure. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

async function readFullResponseIndex(response: Response, range: DashByteRange, allowShort = false): Promise<ArrayBuffer> {
  if (!response.body) {
    return fail('empty SIDX full-file response');
  }
  const reader = response.body.getReader();
  const index = new Uint8Array(range.length);
  const end = range.offset + range.length;
  let position = 0;
  try {
    while (position < end) {
      const {done, value} = await reader.read();
      if (done) {
        if (allowShort) {
          return index.slice(0, Math.max(position - range.offset, 0)).buffer;
        }
        return fail('truncated SIDX full-file response');
      }
      const start = Math.max(range.offset - position, 0);
      const stop = Math.min(value.byteLength, end - position);
      if (stop > start) {
        index.set(value.subarray(start, stop), Math.max(position - range.offset, 0));
      }
      position += value.byteLength;
    }
    return index.buffer;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function fail(message: string): never {
  throw new OmpError(`DASH: ${message}`);
}

function safeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`invalid SIDX ${name}`);
  }
  return value;
}

interface SidxReference {
  byteRange: DashByteRange;
  duration: number;
  hierarchical: boolean;
}

function readSidx(data: ArrayBuffer, absoluteOffset: number): {earliestTime: number; references: SidxReference[]} {
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
    const referenceCount = view.getUint16(countOffset);
    const referencesStart = countOffset + 2;
    if (!referenceCount || referencesStart + referenceCount * 12 > boxEnd) {
      return fail('empty or truncated SIDX references');
    }

    let byteOffset = safeInteger(absoluteOffset + boxEnd + firstOffset, 'first byte offset');
    let elapsedTicks = 0;
    const references: SidxReference[] = [];
    for (let i = 0; i < referenceCount; i++) {
      const position = referencesStart + i * 12;
      const reference = view.getUint32(position);
      const length = reference & 0x7fffffff;
      const ticks = view.getUint32(position + 4);
      if (!length || !ticks) {
        return fail('invalid SIDX reference size or duration');
      }
      const segmentDuration = ticks / timescale;
      const nextByteOffset = safeInteger(byteOffset + length, 'segment end');
      references.push({duration: segmentDuration, byteRange: {offset: byteOffset, length}, hierarchical: !!(reference >>> 31)});
      elapsedTicks += ticks;
      safeInteger(elapsedTicks, 'duration');
      byteOffset = nextByteOffset;
    }
    return {earliestTime: earliestTime / timescale, references};
  }
  return fail('SegmentBase indexRange contains no SIDX box');
}

function clipSegments(segments: DashSegment[], rendition: DashRendition, periodDuration: number): DashSegment[] {
  const tolerance = rendition.type === 'audio' && rendition.codecs === 'mp4a.40.2' && rendition.audioSamplingRate ? Math.max(0.001, 1024 / rendition.audioSamplingRate) : 0.001;
  let elapsed = 0;
  const clipped = segments.flatMap((segment) => {
    const start = rendition.auxiliary ? (segment.presentationTime ?? elapsed) : elapsed;
    const duration = Math.min(segment.duration, periodDuration - start);
    elapsed += segment.duration;
    return duration > 0 ? [{...segment, duration}] : [];
  });
  if (!rendition.auxiliary && elapsed < periodDuration - tolerance) {
    return fail('SIDX does not cover the Period duration');
  }
  return clipped;
}

/** Resolves direct SIDX references; the asynchronous resolver also follows nested indexes. */
export function parseDashSegmentIndex(data: ArrayBuffer, rendition: DashRendition, periodDuration: number): DashSegment[] {
  if (!rendition.segmentBase) {
    return fail('SegmentBase addressing is required for SIDX');
  }
  const index = readSidx(data, rendition.segmentBase.indexRange?.offset ?? 0);
  if (!rendition.auxiliary && index.earliestTime < rendition.presentationTimeOffset - 0.001) {
    return fail('SIDX begins before presentationTimeOffset; leading trims are not supported');
  }
  let time = index.earliestTime;
  return clipSegments(
    index.references.map((reference) => {
      if (reference.hierarchical) {
        return fail('hierarchical SIDX requires asynchronous index resolution');
      }
      const segment = {
        url: rendition.segmentBase!.mediaUrl,
        duration: reference.duration,
        byteRange: reference.byteRange,
        ...(rendition.auxiliary ? {presentationTime: time - rendition.presentationTimeOffset} : {}),
      };
      time += reference.duration;
      return segment;
    }),
    rendition,
    periodDuration
  );
}

/** Request, byte and segment limits shared by every index request of one MPD load. */
export interface IndexBudget {
  bytes: number;
  requests: number;
  segments: number;
}

export function createDashIndexBudget(): IndexBudget {
  return {bytes: 0, requests: 0, segments: 0};
}

/**
 * @param allowShort accept fewer bytes than requested when the resource ends first (discovery probes)
 */
async function fetchIndex(source: DashIndexSource, signal: AbortSignal, budget: IndexBudget, allowShort = false): Promise<{data: ArrayBuffer; total?: number}> {
  signal.throwIfAborted();
  if (++budget.requests > 2048) {
    return fail('too many index requests');
  }
  const range = source.range;
  if (range && range.length > MAX_INDEX_BYTES) {
    return fail(`SIDX indexRange exceeds ${MAX_INDEX_BYTES} bytes`);
  }
  const request = AuthConfig.createRequestInit(source.url, AuthConfig.authentication);
  const headers = new Headers(request.headers);
  if (range) {
    headers.set('Range', `bytes=${range.offset}-${safeInteger(range.offset + range.length - 1, 'index range end')}`);
  }
  const response = await fetch(source.url, {...request, headers, signal});
  if (!response.ok) {
    return fail(`HTTP ${response.status} ${response.statusText} for SIDX ${source.url}`);
  }
  if (response.status !== 200 && response.status !== 206) {
    return fail(`unexpected HTTP ${response.status} for SIDX`);
  }
  const contentRange = response.headers.get('Content-Range');
  if (range && response.status === 206 && contentRange) {
    const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange);
    const end = range.offset + range.length - 1;
    if (!match || Number(match[1]) !== range.offset || (allowShort ? Number(match[2]) > end : Number(match[2]) !== end)) {
      return fail('unexpected SIDX Content-Range');
    }
  }
  const total = response.status === 200 ? Number(response.headers.get('Content-Length')) || undefined : Number(contentRange?.split('/')[1]) || undefined;
  let data: ArrayBuffer;
  if (range && response.status === 200) {
    data = await readFullResponseIndex(response, range, allowShort);
  } else {
    if (!response.body) {
      return fail('empty SIDX response');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > (range?.length ?? MAX_INDEX_BYTES)) {
          return fail('truncated or oversized SIDX range response');
        }
        chunks.push(value);
      }
      const buffer = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      data = buffer.buffer;
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  if (range && (allowShort ? total !== undefined && data.byteLength < Math.min(range.length, total - range.offset) : data.byteLength !== range.length)) {
    return fail('truncated or oversized SIDX range response');
  }
  budget.bytes += data.byteLength;
  if (budget.bytes > 64 * 1024 * 1024) {
    return fail('combined SIDX data exceeds 64 MiB');
  }
  return {data, ...(total === undefined ? {} : {total})};
}

async function resolveIndex(
  source: DashIndexSource,
  rendition: DashRendition,
  mediaUrl: string,
  duration: number,
  signal: AbortSignal,
  budget: IndexBudget,
  depth = 0,
  expectedTime?: number,
  prefetched?: ArrayBuffer
): Promise<DashSegment[]> {
  if (depth > 8) {
    return fail('SIDX nesting exceeds 8 levels');
  }
  const data = prefetched ?? (await fetchIndex(source, signal, budget)).data;
  const index = readSidx(data, source.range?.offset ?? 0);
  if (expectedTime !== undefined && Math.abs(index.earliestTime - expectedTime) > 0.001) {
    return fail('nested SIDX timestamps do not match the parent index');
  }
  if (depth && Math.abs(index.references.reduce((total, reference) => total + reference.duration, 0) - duration) > 0.001) {
    return fail('nested SIDX duration does not match the parent index');
  }
  if (depth === 0 && !rendition.auxiliary && index.earliestTime < rendition.presentationTimeOffset - 0.001) {
    return fail('SIDX begins before presentationTimeOffset; leading trims are not supported');
  }
  const segments: DashSegment[] = [];
  let time = index.earliestTime;
  for (const reference of index.references) {
    if (reference.hierarchical) {
      const nested = await resolveIndex({url: source.url, range: reference.byteRange}, rendition, mediaUrl, reference.duration, signal, budget, depth + 1, time);
      for (const segment of nested) segments.push(segment);
    } else {
      if (++budget.segments > 100000) {
        return fail('more than 100000 indexed segments are not supported');
      }
      segments.push({
        url: mediaUrl,
        byteRange: reference.byteRange,
        duration: reference.duration,
        ...(rendition.auxiliary ? {presentationTime: time - rendition.presentationTimeOffset} : {}),
      });
    }
    time += reference.duration;
  }
  return depth ? segments : clipSegments(segments, rendition, duration);
}

/** Contiguous window over the start of a resource, grown or moved by Range requests as boxes are walked. */
class RangeReader {
  private _data = new Uint8Array(0);
  private _start = 0;
  /** Resource size, once a response has revealed it. */
  total: number | undefined;

  constructor(
    private readonly _url: string,
    private readonly _signal: AbortSignal,
    private readonly _budget: IndexBudget
  ) {}

  private get end(): number {
    return this._start + this._data.byteLength;
  }

  /** Bytes `[offset, offset + length)`, fewer if the resource ends first. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    const want = offset + length;
    if (offset < this._start || offset > this.end) {
      // skipping an unneeded box (or moving backwards): start a new window rather than download the gap
      this._data = new Uint8Array(0);
      this._start = offset;
    }
    while (this.end < want && (this.total === undefined || this.end < this.total)) {
      const requested = Math.max(want - this.end, DISCOVERY_PROBE_BYTES);
      const {data, total} = await fetchIndex({url: this._url, range: {offset: this.end, length: requested}}, this._signal, this._budget, true);
      if (total !== undefined) {
        this.total = total;
      }
      if (data.byteLength < requested) {
        this.total = this.end + data.byteLength;
      }
      const grown = new Uint8Array(this._data.byteLength + data.byteLength);
      grown.set(this._data);
      grown.set(new Uint8Array(data), this._data.byteLength);
      this._data = grown;
    }
    return this._data.subarray(offset - this._start, Math.min(want, this.end) - this._start);
  }

  /** A copy of `range` if it is already buffered. */
  peek(range: DashByteRange): ArrayBuffer | undefined {
    if (range.offset < this._start || range.offset + range.length > this.end) {
      return undefined;
    }
    return this._data.slice(range.offset - this._start, range.offset - this._start + range.length).buffer;
  }
}

interface DiscoveredBoxes {
  initialization?: DashByteRange;
  index?: DashByteRange;
  /** The bytes of {@link index}, already downloaded during discovery. */
  indexData?: ArrayBuffer;
  media?: DashByteRange;
  reader: RangeReader;
}

async function discoverBoxes(url: string, signal: AbortSignal, budget: IndexBudget, needIndex: boolean, needInitialization = true): Promise<DiscoveredBoxes> {
  const reader = new RangeReader(url, signal, budget);
  let offset = 0;
  let initialization: DashByteRange | undefined;
  let index: DashByteRange | undefined;
  let indexData: ArrayBuffer | undefined;
  const found = () => ({...(initialization ? {initialization} : {}), ...(index ? {index} : {}), ...(indexData ? {indexData} : {}), reader});
  for (let count = 0; count < 1024; count++) {
    const header = await reader.read(offset, 16);
    if (header.byteLength < 8) return fail('MP4 initialization/index not found before the end of the file');
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const type = String.fromCharCode(...header.subarray(4, 8));
    let size = view.getUint32(0);
    const headerSize = size === 1 ? 16 : 8;
    if (size === 1) {
      if (header.byteLength < 16) return fail('truncated MP4 box');
      size = safeInteger(view.getUint32(8) * 2 ** 32 + view.getUint32(12), 'box size');
    }
    const total = reader.total;
    if (size === 0 && total !== undefined) size = total - offset;
    if (size < headerSize) return fail('invalid MP4 box during initialization/index discovery');
    const end = safeInteger(offset + size, 'box end');
    if (total !== undefined && end > total) return fail('truncated MP4 box');
    if (type === 'moov') {
      if (end > MAX_INDEX_BYTES) return fail('discovered MP4 initialization exceeds 16 MiB');
      initialization = {offset: 0, length: end};
    }
    if (type === 'sidx' && needIndex && !index) {
      if (size > MAX_INDEX_BYTES) return fail(`SIDX exceeds ${MAX_INDEX_BYTES} bytes`);
      const bytes = await reader.read(offset, size);
      if (bytes.byteLength < size) return fail('truncated MP4 box');
      index = {offset, length: size};
      indexData = bytes.slice().buffer;
    }
    if ((!needInitialization || initialization) && (!needIndex || index)) return found();
    if (type === 'moof') {
      if (needInitialization && !initialization) return fail('fragmented MP4 requires moov before moof');
      if (total === undefined) return fail('implicit unindexed MP4 requires a known file size');
      if (total - offset > 64 * 1024 * 1024) return fail('implicit unindexed MP4 exceeds the 64 MiB single-segment limit; provide SIDX or explicit segments');
      return {...found(), media: {offset, length: total - offset}};
    }
    if (type === 'mdat') return fail('implicit addressing requires fragmented MP4, not progressive MP4');
    offset = end;
  }
  return fail('MP4 initialization/index discovery exceeds 1024 boxes');
}

/** Resolves one rendition's indexes and implicit initialization within a Period of `duration` seconds. */
export async function resolveDashRendition(rendition: DashRendition, duration: number, signal: AbortSignal, budget: IndexBudget): Promise<DashRendition> {
  let resolved = {...rendition};
  const addressing = rendition.segmentBase;
  if (addressing) {
    let source: DashIndexSource = {url: addressing.indexUrl ?? addressing.mediaUrl, range: addressing.indexRange};
    let prefetched: ArrayBuffer | undefined;
    const needIndex = !source.range && !addressing.indexUrl;
    if (needIndex || rendition.discoverInitialization) {
      const boxes = await discoverBoxes(addressing.mediaUrl, signal, budget, needIndex, !!rendition.discoverInitialization);
      if (rendition.discoverInitialization) {
        if (!boxes.initialization) return fail('MP4 initialization could not be discovered');
        resolved.initializationByteRange = boxes.initialization;
        delete resolved.discoverInitialization;
      }
      if (needIndex) {
        if (boxes.media) {
          resolved.segments = [{url: addressing.mediaUrl, duration, byteRange: boxes.media}];
          return resolved;
        }
        source = {url: addressing.mediaUrl, range: boxes.index};
        prefetched = boxes.indexData;
      } else if (source.url === addressing.mediaUrl && source.range) {
        // an explicit indexRange usually sits right after moov, inside the discovery probe
        prefetched = boxes.reader.peek(source.range);
      }
    }
    resolved.segments = await resolveIndex(source, rendition, addressing.mediaUrl, duration, signal, budget, 0, undefined, prefetched);
  } else {
    if (rendition.discoverInitialization) {
      const boxes = await discoverBoxes(rendition.initializationUrl, signal, budget, false);
      if (!boxes.initialization) return fail('MP4 initialization could not be discovered');
      resolved.initializationByteRange = boxes.initialization;
      delete resolved.discoverInitialization;
    }
    const resolvedSegments = await mapLimit(rendition.segments, INDEX_CONCURRENCY, async (segment): Promise<DashSegment[]> => {
      if (!segment.index) {
        return [segment];
      }
      const segmentStart = segment.presentationTime ?? 0;
      const indexed = await resolveIndex(
        segment.index,
        {...rendition, presentationTimeOffset: rendition.auxiliary ? rendition.presentationTimeOffset + segmentStart : 0},
        segment.url,
        segment.duration,
        signal,
        budget
      );
      const range = segment.byteRange;
      if (
        range &&
        indexed.some((subsegment) => !subsegment.byteRange || subsegment.byteRange.offset < range.offset || subsegment.byteRange.offset + subsegment.byteRange.length > range.offset + range.length)
      ) {
        return fail('indexed subsegments exceed SegmentURL@mediaRange');
      }
      return rendition.auxiliary ? indexed.map((subsegment) => ({...subsegment, presentationTime: segmentStart + (subsegment.presentationTime ?? 0)})) : indexed;
    });
    resolved.segments = resolvedSegments.flat();
  }
  return resolved;
}

/**
 * Resolves one HLS track: each of its per-Period renditions (indexes, discovered initialization),
 * joined across Periods. Used to build a media playlist only when hls.js asks for it.
 */
export async function resolveDashTrack(plan: DashTrackPlan, signal: AbortSignal, budget: IndexBudget): Promise<DashRendition> {
  const resolved = await mapLimit(plan.parts, INDEX_CONCURRENCY, ({period, rendition}) => resolveDashRendition(rendition, period.duration, signal, budget));
  return concatDashTrack(plan, resolved);
}

/** Resolves every rendition of every Period up front (auxiliary tracks, and callers that need the whole manifest). */
export function resolveDashSegmentIndexes(manifest: DashManifest): Observable<DashManifest> {
  return new Observable((subscriber) => {
    const controller = new AbortController();
    const budget = createDashIndexBudget();
    const resolvePeriod = async (period: {duration: number; renditions: DashRendition[]}) => {
      const renditions = await mapLimit(period.renditions, INDEX_CONCURRENCY, (rendition) => resolveDashRendition(rendition, period.duration, controller.signal, budget));
      validateDashSegmentAlignment({duration: period.duration, renditions});
      return renditions;
    };
    const run = async () => {
      const auxiliaryPeriods = [];
      for (const period of manifest.auxiliaryPeriods ?? []) {
        auxiliaryPeriods.push({...period, renditions: await resolvePeriod(period)});
      }
      const withAuxiliary = auxiliaryPeriods.length ? {...manifest, auxiliaryPeriods} : manifest;
      if (manifest.periods) {
        const periods = [];
        for (const period of manifest.periods) {
          periods.push({...period, renditions: await resolvePeriod(period)});
        }
        return stitchDashPeriods(withAuxiliary, periods);
      }
      return {...withAuxiliary, renditions: await resolvePeriod(manifest)};
    };
    run().then(
      (resolved) => {
        subscriber.next(resolved);
        subscriber.complete();
      },
      (error: unknown) => subscriber.error(error)
    );
    return () => controller.abort();
  });
}
