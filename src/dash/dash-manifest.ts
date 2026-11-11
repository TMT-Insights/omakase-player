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

import {OmpError} from '../types';

export interface DashByteRange {
  offset: number;
  length: number;
}

export interface DashSegment {
  url: string;
  duration: number;
  mediaDuration?: number;
  presentationTime?: number;
  byteRange?: DashByteRange;
  index?: DashIndexSource;
  discontinuity?: boolean;
  initialization?: {url: string; byteRange?: DashByteRange | undefined};
}

export interface DashIndexSource {
  url: string;
  range?: DashByteRange | undefined;
}

export interface DashRendition {
  type: 'video' | 'audio' | 'text' | 'image';
  id: string;
  bandwidth: number;
  codecs: string;
  width?: number | undefined;
  height?: number | undefined;
  frameRate?: number | undefined;
  language?: string | undefined;
  label: string;
  channels?: string | undefined;
  audioSamplingRate?: number | undefined;
  initializationUrl: string;
  initializationByteRange?: DashByteRange;
  segmentBase?: {indexRange?: DashByteRange | undefined; mediaUrl: string; indexUrl?: string | undefined};
  discoverInitialization?: boolean;
  trackKey?: string;
  presentationTimeOffset: number;
  segments: DashSegment[];
  auxiliary?: {
    format: 'vtt' | 'ttml' | 'wvtt' | 'stpp' | 'image';
    kind: 'subtitles' | 'captions';
    forced: boolean;
    default: boolean;
    mimeType: string;
    tiles: {columns: number; rows: number};
  };
}

export interface DashManifest {
  duration: number;
  renditions: DashRendition[];
  periods?: DashPeriod[];
  presentationStart?: number;
  auxiliaryPeriods?: DashPeriod[];
}

export interface DashPeriod {
  start: number;
  duration: number;
  renditions: DashRendition[];
}

const MAX_SEGMENTS = 100000;

function fail(message: string): never {
  throw new OmpError(`DASH: ${message}`);
}

function children(element: Element, name: string): Element[] {
  return Array.from(element.children).filter((child) => child.localName === name);
}

function single(element: Element, name: string): Element | undefined {
  const found = children(element, name);
  if (found.length > 1) {
    fail(`multiple ${name} elements are not supported`);
  }
  return found[0];
}

function attr(elements: Element[], name: string): string | undefined {
  return elements.map((element) => element.getAttribute(name)).findLast((value) => value !== null) ?? undefined;
}

function integer(value: string | undefined, name: string, fallback?: number, minimum = 0): number {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (value === undefined || !/^-?\d+$/.test(value)) {
    return fail(`invalid ${name}`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) {
    fail(`invalid ${name}`);
  }
  return result;
}

function byteRange(value: string | undefined, name: string): DashByteRange {
  const match = /^(\d+)-(\d+)$/.exec(value ?? '');
  if (!match) {
    return fail(`invalid ${name} byte range`);
  }
  const offset = integer(match[1], name);
  const end = integer(match[2], name, undefined, offset);
  const length = end - offset + 1;
  if (!Number.isSafeInteger(length)) {
    fail(`invalid ${name} byte range`);
  }
  return {offset, length};
}

function duration(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some((part) => part !== undefined)) {
    return fail(`unsupported duration ${value}`);
  }
  const seconds = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  if (!Number.isFinite(seconds)) {
    fail(`invalid duration ${value}`);
  }
  return seconds;
}

function url(value: string, base: string): string {
  const resolved = new URL(value, base);
  if (!['http:', 'https:'].includes(resolved.protocol) || /[\r\n"]/.test(resolved.href)) {
    fail('only HTTP(S) media URLs are supported');
  }
  return resolved.href;
}

function quote(value: string): string {
  if (/["\r\n]/.test(value)) {
    fail('invalid HLS attribute value');
  }
  return `"${value}"`;
}

function expandTemplate(template: string, id: string, bandwidth: number, number?: number, time?: number): string {
  return template.replace(/\$\$|\$([^$]*)\$|\$/g, (token, expression: string | undefined) => {
    if (token === '$$') {
      return '$';
    }
    const match = /^(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)([diuoxX]))?$/.exec(expression ?? '');
    if (!match) {
      return fail(`unsupported URL template token ${token}`);
    }
    const name = match[1];
    if (name === 'RepresentationID') {
      if (match[2]) {
        fail('RepresentationID cannot have a numeric format');
      }
      return id;
    }
    const value = name === 'Bandwidth' ? bandwidth : name === 'Number' ? number : time;
    if (value === undefined || !Number.isSafeInteger(value)) {
      return fail(`invalid ${name} URL template value`);
    }
    const width = Number(match[2] ?? 0);
    if (width > 32) {
      fail('URL template padding is too large');
    }
    const radix = match[3] === 'o' ? 8 : /[xX]/.test(match[3] ?? '') ? 16 : 10;
    const formatted = value.toString(radix).padStart(width, '0');
    return match[3] === 'X' ? formatted.toUpperCase() : formatted;
  });
}

function parseRendition(path: Element[], manifestUrl: string, periodDuration: number, type: DashRendition['type'], index: number): DashRendition {
  const representation = path[path.length - 1]!;
  const id = representation.getAttribute('id') ?? '';
  const isAuxiliary = type === 'text' || type === 'image';
  const bandwidth = integer(attr(path, 'bandwidth'), 'bandwidth', isAuxiliary ? 1 : undefined, 1);
  const codecs = attr(path, 'codecs') ?? (isAuxiliary ? '' : undefined);
  if ((!codecs && !isAuxiliary) || codecs?.includes(',')) {
    return fail('each representation must declare one codec (multiplexed representations are not supported)');
  }
  quote(codecs!);
  let base = manifestUrl;
  for (const element of path) {
    const baseElement = single(element, 'BaseURL');
    if (baseElement) {
      if (baseElement.hasAttribute('byteRange')) {
        fail('BaseURL byte ranges are not supported');
      }
      base = url(baseElement.textContent?.trim() ?? '', base);
    }
  }

  let addressingName: string | undefined;
  let addressingElements: Element[] = [];
  for (const element of path) {
    const found = ['SegmentBase', 'SegmentTemplate', 'SegmentList'].flatMap((name) => children(element, name));
    if (found.length > 1) {
      fail('mixed segment addressing on the same element is not supported');
    }
    if (found[0]) {
      if (addressingName !== found[0].localName) {
        addressingElements = [];
      }
      addressingName = found[0].localName;
      addressingElements.push(found[0]);
    }
  }
  const mimeType = attr(path, 'mimeType');
  const format =
    type === 'image'
      ? 'image'
      : mimeType === 'text/vtt'
        ? 'vtt'
        : mimeType === 'application/ttml+xml'
          ? 'ttml'
          : codecs?.split('.')[0] === 'wvtt'
            ? 'wvtt'
            : codecs?.split('.')[0] === 'stpp'
              ? 'stpp'
              : undefined;
  if (isAuxiliary && !format) fail('unsupported DASH text/image format');
  const raw = format === 'image' || format === 'vtt' || format === 'ttml';
  if (
    raw &&
    addressingName === 'SegmentBase' &&
    (attr(addressingElements, 'indexRange') || addressingElements.some((element) => children(element, 'RepresentationIndex').length || children(element, 'Initialization').length))
  ) {
    fail('raw text/image SegmentBase indexes and initialization are not supported; use SegmentList or SegmentTemplate');
  }
  const addressing =
    addressingName === 'SegmentTemplate'
      ? parseSegmentTemplate(addressingElements, base, id, bandwidth, periodDuration, raw, isAuxiliary)
      : addressingName === 'SegmentList'
        ? parseSegmentList(addressingElements, base, periodDuration, raw, isAuxiliary)
        : raw
          ? {
              initializationUrl: '',
              presentationTimeOffset: integer(attr(addressingElements, 'presentationTimeOffset'), 'presentationTimeOffset', 0) / integer(attr(addressingElements, 'timescale'), 'timescale', 1, 1),
              segments: [{url: base, duration: periodDuration}],
            }
          : parseSegmentBase(addressingElements, base);
  const frameRateValue = attr(path, 'frameRate');
  let frameRate: number | undefined;
  if (frameRateValue) {
    const match = /^(\d+(?:\.\d+)?)(?:\/(\d+))?$/.exec(frameRateValue);
    frameRate = match ? Number(match[1]) / Number(match[2] ?? 1) : NaN;
    if (!Number.isFinite(frameRate) || frameRate <= 0) {
      fail('invalid frameRate');
    }
  }
  const channelElement = path.flatMap((element) => children(element, 'AudioChannelConfiguration')).at(-1);
  const channels = channelElement?.getAttribute('schemeIdUri') === 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011' ? (channelElement.getAttribute('value') ?? undefined) : undefined;
  const language = attr(path, 'lang');
  return {
    type,
    id,
    bandwidth,
    codecs: codecs!,
    width: attr(path, 'width') === undefined ? undefined : integer(attr(path, 'width'), 'width', undefined, 1),
    height: attr(path, 'height') === undefined ? undefined : integer(attr(path, 'height'), 'height', undefined, 1),
    frameRate,
    language,
    label:
      path
        .flatMap((element) => children(element, 'Label'))
        .at(-1)
        ?.textContent?.trim() ||
      language ||
      id ||
      `${type} ${index + 1}`,
    channels,
    trackKey:
      type !== 'video'
        ? JSON.stringify([
            language ?? '',
            path
              .flatMap((element) => children(element, 'Role'))
              .map((role) => role.getAttribute('value'))
              .sort(),
            path
              .flatMap((element) => children(element, 'Label'))
              .at(-1)
              ?.textContent?.trim() ?? '',
          ])
        : 'video',
    audioSamplingRate: attr(path, 'audioSamplingRate') === undefined ? undefined : integer(attr(path, 'audioSamplingRate'), 'audioSamplingRate', undefined, 1),
    ...addressing,
    ...(isAuxiliary
      ? {
          auxiliary: {
            format: format!,
            kind: path.flatMap((element) => children(element, 'Role')).some((element) => element.getAttribute('value') === 'caption') ? ('captions' as const) : ('subtitles' as const),
            forced: path.flatMap((element) => children(element, 'Role')).some((element) => ['forced-subtitle', 'forced_subtitle'].includes(element.getAttribute('value') ?? '')),
            default: path.flatMap((element) => children(element, 'Role')).some((element) => element.getAttribute('value') === 'main'),
            mimeType: mimeType!,
            tiles: parseImageTiles(path),
          },
        }
      : {}),
  };
}

function parseImageTiles(path: Element[]): {columns: number; rows: number} {
  const property = path
    .flatMap((element) => [...children(element, 'EssentialProperty'), ...children(element, 'SupplementalProperty')])
    .findLast((element) => element.getAttribute('schemeIdUri') === 'http://dashif.org/guidelines/thumbnail_tile');
  if (!property) return {columns: 1, rows: 1};
  const match = /^(\d+)x(\d+)$/.exec(property.getAttribute('value') ?? '');
  if (!match) return fail('invalid thumbnail tile layout');
  const columns = integer(match[1], 'thumbnail columns', undefined, 1);
  const rows = integer(match[2], 'thumbnail rows', undefined, 1);
  if (columns * rows > 10000) return fail('thumbnail tile layout exceeds 10000 tiles');
  return {columns, rows};
}

type DashAddressing = Pick<DashRendition, 'initializationUrl' | 'initializationByteRange' | 'presentationTimeOffset' | 'segmentBase' | 'segments' | 'discoverInitialization'>;

function parseInitialization(elements: Element[], base: string): Pick<DashAddressing, 'initializationUrl' | 'initializationByteRange' | 'discoverInitialization'> {
  const initialization = elements.map((element) => single(element, 'Initialization')).findLast((element) => element !== undefined);
  if (!initialization) {
    return {initializationUrl: base, discoverInitialization: true};
  }
  const range = initialization.getAttribute('range');
  if (range === null && !initialization.getAttribute('sourceURL')) {
    return fail('Initialization requires a range or sourceURL');
  }
  return {
    initializationUrl: url(initialization.getAttribute('sourceURL') ?? '', base),
    ...(range === null ? {} : {initializationByteRange: byteRange(range, 'Initialization@range')}),
  };
}

function parseSegmentBase(segmentBases: Element[], base: string): DashAddressing {
  const representationIndex = segmentBases.map((element) => single(element, 'RepresentationIndex')).findLast((element) => element !== undefined);
  const indexRangeValue = representationIndex ? (representationIndex.getAttribute('range') ?? undefined) : attr(segmentBases, 'indexRange');
  const indexRange = indexRangeValue === undefined ? undefined : byteRange(indexRangeValue, 'SegmentBase@indexRange');
  const timescale = integer(attr(segmentBases, 'timescale'), 'SegmentBase@timescale', 1, 1);
  const offset = integer(attr(segmentBases, 'presentationTimeOffset'), 'SegmentBase@presentationTimeOffset', 0);
  return {
    ...parseInitialization(segmentBases, base),
    presentationTimeOffset: offset / timescale,
    segmentBase: {
      ...(indexRange ? {indexRange} : {}),
      mediaUrl: base,
      ...(representationIndex?.hasAttribute('sourceURL') ? {indexUrl: url(representationIndex.getAttribute('sourceURL')!, base)} : {}),
    },
    segments: [],
  };
}

function segmentTiming(elements: Element[], periodDuration: number, listLength?: number, auxiliary = false): {time: number; duration: number; mediaDuration: number; number: number}[] {
  const timescale = integer(attr(elements, 'timescale'), 'timescale', 1, 1);
  const offset = integer(attr(elements, 'presentationTimeOffset'), 'presentationTimeOffset', 0);
  const startNumber = integer(attr(elements, 'startNumber'), 'startNumber', 1);
  const endNumber = attr(elements, 'endNumber') === undefined ? undefined : integer(attr(elements, 'endNumber'), 'endNumber', undefined, startNumber);
  const end = offset + periodDuration * timescale;
  if (!Number.isSafeInteger(Math.ceil(end))) {
    fail('segment timeline exceeds safe integer precision');
  }
  const timeline = elements.map((element) => single(element, 'SegmentTimeline')).findLast((element) => element !== undefined);
  const segments: {time: number; duration: number; mediaDuration: number; number: number}[] = [];
  let cursor = 0;
  const append = (time: number, length: number) => {
    // HLS cannot express a presentation-time trim at the start of a fragment.
    if (!auxiliary && segments.length === 0 && time !== offset) {
      fail('the first segment must start at presentationTimeOffset; leading trims or gaps are not supported');
    }
    if (time >= end) {
      return;
    }
    if (endNumber !== undefined && startNumber + segments.length > endNumber) {
      return;
    }
    if (segments.length >= MAX_SEGMENTS) {
      fail(`more than ${MAX_SEGMENTS} segments per representation are not supported`);
    }
    segments.push({
      time,
      number: integer(String(startNumber + segments.length), 'segment number'),
      duration: Math.min(length, end - time) / timescale,
      mediaDuration: length / timescale,
    });
  };
  if (timeline) {
    const entries = children(timeline, 'S');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const time = integer(entry.getAttribute('t') ?? undefined, 'S@t', cursor);
      const length = integer(entry.getAttribute('d') ?? undefined, 'S@d', undefined, 1);
      const repeat = integer(entry.getAttribute('r') ?? undefined, 'S@r', 0, -1);
      if (entry.hasAttribute('k')) {
        fail('chunked SegmentTimeline S@k and SubNumber addressing are not supported');
      }
      if (segments.length && (auxiliary ? time < cursor : time !== cursor)) {
        fail('gaps and overlaps in SegmentTimeline are not supported');
      }
      const nextTime = entries[i + 1]?.getAttribute('t');
      const bound = repeat === -1 && nextTime != null ? integer(nextTime, 'S@t') : end;
      const count = repeat === -1 ? Math.ceil((bound - time) / length) : repeat + 1;
      if (count < 1 || count > MAX_SEGMENTS || segments.length + count > MAX_SEGMENTS) {
        fail('invalid or excessively large SegmentTimeline repeat');
      }
      for (let j = 0; j < count; j++) {
        append(time + j * length, length);
      }
      cursor = time + count * length;
    }
    if (!auxiliary && cursor < end - 0.001 * timescale) {
      fail('SegmentTimeline does not cover the Period duration');
    }
  } else {
    if (attr(elements, 'duration') === undefined && listLength === 1) {
      return [{time: offset, number: startNumber, duration: periodDuration, mediaDuration: periodDuration}];
    }
    const length = integer(attr(elements, 'duration'), 'segment duration', undefined, 1);
    const count = Math.ceil((periodDuration * timescale) / length);
    if (count > MAX_SEGMENTS) {
      fail(`more than ${MAX_SEGMENTS} segments per representation are not supported`);
    }
    for (let i = 0; i < count; i++) {
      // With duration addressing, media time is relative to startNumber, not PTO.
      append(i * length, length);
    }
  }
  if (!segments.length) {
    fail('representation contains no playable segments');
  }
  const coverage = segments.reduce((total, segment) => total + segment.duration, 0);
  if (!auxiliary && coverage < periodDuration - 0.001) {
    fail('segment addressing does not cover the Period duration');
  }
  return segments;
}

function parseSegmentTemplate(templates: Element[], base: string, id: string, bandwidth: number, periodDuration: number, raw = false, auxiliary = false): DashAddressing {
  const media = attr(templates, 'media');
  const initialization = attr(templates, 'initialization');
  const initializationElement = templates.map((element) => single(element, 'Initialization')).findLast((element) => element !== undefined);
  if (!media || (!raw && !initialization && !initializationElement)) {
    return fail('SegmentTemplate must declare media and initialization URLs');
  }
  if (!id && [media, initialization ?? initializationElement?.getAttribute('sourceURL') ?? ''].some((template) => template.includes('$RepresentationID$'))) {
    fail('RepresentationID template requires a representation id');
  }
  const index = attr(templates, 'index');
  const indexRange = attr(templates, 'indexRange');
  const timescale = integer(attr(templates, 'timescale'), 'timescale', 1, 1);
  const offset = integer(attr(templates, 'presentationTimeOffset'), 'presentationTimeOffset', 0);
  const segments = segmentTiming(templates, periodDuration, undefined, auxiliary).map(({time, duration, mediaDuration, number}) => ({
    url: url(expandTemplate(media, id, bandwidth, number, time), base),
    duration,
    ...(raw ? {mediaDuration} : {}),
    ...(auxiliary ? {presentationTime: (time - offset) / timescale} : {}),
    ...(index || indexRange
      ? {
          index: {
            url: url(expandTemplate(index ?? media, id, bandwidth, number, time), base),
            ...(indexRange ? {range: byteRange(indexRange, 'SegmentTemplate@indexRange')} : {}),
          },
        }
      : {}),
  }));
  return {
    ...(raw
      ? {initializationUrl: ''}
      : initialization
        ? {initializationUrl: url(expandTemplate(initialization, id, bandwidth), base)}
        : {
            ...parseInitialization(templates, base),
            initializationUrl: url(expandTemplate(initializationElement!.getAttribute('sourceURL') ?? '', id, bandwidth), base),
          }),
    presentationTimeOffset: offset / timescale,
    segments,
  };
}

function parseSegmentList(lists: Element[], base: string, periodDuration: number, raw = false, auxiliary = false): DashAddressing {
  const urls = lists.map((element) => children(element, 'SegmentURL')).findLast((elements) => elements.length) ?? [];
  if (!urls.length) {
    return fail('SegmentList requires SegmentURL entries');
  }
  const timing = segmentTiming(lists, periodDuration, urls.length, auxiliary);
  const timescale = integer(attr(lists, 'timescale'), 'timescale', 1, 1);
  const offset = integer(attr(lists, 'presentationTimeOffset'), 'presentationTimeOffset', 0);
  if (timing.length !== urls.length) {
    return fail('SegmentList SegmentURL count does not match its timing');
  }
  const initialization = raw ? {initializationUrl: ''} : parseInitialization(lists, base);
  if (initialization.discoverInitialization) {
    initialization.initializationUrl = url(urls[0]!.getAttribute('media') ?? '', base);
  }
  return {
    ...initialization,
    presentationTimeOffset: offset / timescale,
    segments: urls.map((element, index) => {
      const mediaUrl = url(element.getAttribute('media') ?? '', base);
      const mediaRange = element.getAttribute('mediaRange');
      const indexUrl = element.getAttribute('index');
      const indexRange = element.getAttribute('indexRange');
      return {
        url: mediaUrl,
        duration: timing[index]!.duration,
        ...(raw ? {mediaDuration: timing[index]!.mediaDuration} : {}),
        ...(auxiliary ? {presentationTime: (timing[index]!.time - offset) / timescale} : {}),
        ...(mediaRange === null ? {} : {byteRange: byteRange(mediaRange, 'SegmentURL@mediaRange')}),
        ...(indexUrl !== null || indexRange !== null
          ? {
              index: {
                url: url(indexUrl ?? element.getAttribute('media') ?? '', base),
                ...(indexRange === null ? {} : {range: byteRange(indexRange, 'SegmentURL@indexRange')}),
              },
            }
          : {}),
      };
    }),
  };
}

/** Parses static DASH addressing; SegmentBase indexes are resolved before writing playlists. */
export function parseDashManifest(xml: string, manifestUrl: string): DashManifest {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const mpd = document.documentElement;
  if (mpd.localName !== 'MPD' || document.getElementsByTagNameNS('*', 'parsererror').length) {
    return fail('invalid MPD XML');
  }
  if ((mpd.getAttribute('type') ?? 'static') !== 'static') {
    fail('live/dynamic MPDs are not supported');
  }
  for (const name of ['ContentProtection', 'ContentComponent', 'SubRepresentation']) {
    if (document.getElementsByTagNameNS('*', name).length) {
      fail(`${name} is not supported`);
    }
  }
  for (const property of Array.from(document.getElementsByTagNameNS('*', 'EssentialProperty'))) {
    const path = [];
    for (let parent = property.parentElement; parent; parent = parent.parentElement) path.unshift(parent);
    if (property.getAttribute('schemeIdUri') !== 'http://dashif.org/guidelines/thumbnail_tile' || !attr(path, 'mimeType')?.startsWith('image/')) {
      fail('EssentialProperty is not supported');
    }
  }
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    if (element.hasAttributeNS('http://www.w3.org/1999/xlink', 'href')) {
      fail('XLink manifests are not supported');
    }
    if (element.hasAttributeNS('http://www.w3.org/XML/1998/namespace', 'base')) {
      fail('xml:base is not supported; use BaseURL');
    }
  }
  const periodElements = children(mpd, 'Period');
  if (!periodElements.length) {
    return fail('at least one Period is required');
  }
  const mpdDuration = duration(mpd.getAttribute('mediaPresentationDuration'));
  const starts = periodElements.map((element) => duration(element.getAttribute('start')));
  const durations = periodElements.map((element) => duration(element.getAttribute('duration')));
  starts[0] ??= 0;
  for (let i = 0; i < periodElements.length; i++) {
    const start = starts[i];
    if (start === undefined) {
      return fail('Period start cannot be inferred');
    }
    const nextStart = starts[i + 1];
    durations[i] ??= nextStart !== undefined ? nextStart - start : i === periodElements.length - 1 && mpdDuration !== undefined ? mpdDuration - start : undefined;
    const length = durations[i];
    if (length === undefined || length <= 0 || !Number.isFinite(start + length)) {
      return fail('a finite positive Period or MPD duration is required');
    }
    if (i + 1 < starts.length) {
      starts[i + 1] ??= start + length;
      if (Math.abs(starts[i + 1]! - (start + length)) > 0.001) {
        return fail('gaps and overlaps between Periods are not supported');
      }
    }
  }
  const presentationStart = starts[0]!;
  const end = starts.at(-1)! + durations.at(-1)!;
  if (mpdDuration !== undefined && Math.abs(end - mpdDuration) > 0.001) {
    return fail('Period durations do not match mediaPresentationDuration');
  }
  const allPeriods = periodElements.map((period, index) => ({
    start: starts[index]!,
    duration: durations[index]!,
    renditions: parsePeriodRenditions(mpd, period, manifestUrl, durations[index]!),
  }));
  const periods = allPeriods.map((period) => ({...period, renditions: period.renditions.filter((rendition) => rendition.type === 'video' || rendition.type === 'audio')}));
  const auxiliaryPeriods = allPeriods.map((period) => ({...period, start: period.start - presentationStart, renditions: period.renditions.filter((rendition) => rendition.auxiliary)}));
  return {
    duration: end - presentationStart,
    renditions: periods[0]!.renditions,
    ...(periods.length > 1 ? {periods} : {}),
    ...(presentationStart ? {presentationStart} : {}),
    ...(auxiliaryPeriods.some((period) => period.renditions.length) ? {auxiliaryPeriods} : {}),
  };
}

function parsePeriodRenditions(mpd: Element, period: Element, manifestUrl: string, periodDuration: number): DashRendition[] {
  const renditions: DashRendition[] = [];
  let videoAdaptations = 0;
  for (const adaptation of children(period, 'AdaptationSet')) {
    const representations = children(adaptation, 'Representation');
    if (!representations.length) {
      fail('AdaptationSet has no representations');
    }
    const parsed = representations.map((representation, index) => {
      const path = [mpd, period, adaptation, representation];
      const mimeType = attr(path, 'mimeType');
      const codecs = attr(path, 'codecs') ?? '';
      const type =
        mimeType === 'video/mp4'
          ? 'video'
          : mimeType === 'audio/mp4'
            ? 'audio'
            : ['text/vtt', 'application/ttml+xml'].includes(mimeType ?? '') || (mimeType === 'application/mp4' && /^(wvtt|stpp)(\.|$)/.test(codecs))
              ? 'text'
              : ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(mimeType ?? '')
                ? 'image'
                : undefined;
      if (!type) {
        return fail(`unsupported mimeType ${mimeType ?? '(missing)'}; expected separate MP4 audio/video, WebVTT, TTML, MP4 wvtt/stpp or images`);
      }
      return parseRendition(path, manifestUrl, periodDuration, type, index);
    });
    if (parsed.some((rendition) => rendition.type !== parsed[0]!.type)) {
      fail('mixed media types in an AdaptationSet are not supported');
    }
    if (parsed[0]!.type === 'video') {
      if (++videoAdaptations > 1) {
        fail('multiple video AdaptationSets are not supported');
      }
      renditions.push(...parsed);
    } else {
      // HLS exposes alternate audio tracks, not DASH's per-track representation ladder.
      renditions.push(parsed.reduce((best, rendition) => (rendition.bandwidth > best.bandwidth ? rendition : best)));
    }
  }
  const av = renditions.filter((rendition) => rendition.type === 'audio' || rendition.type === 'video');
  if (!av.length) {
    fail('MPD has no audio or video representations');
  }
  if (av.some((rendition) => Math.abs(rendition.presentationTimeOffset - av[0]!.presentationTimeOffset) > 0.001)) {
    fail('audio and video must share the same presentation time origin');
  }
  const audio = renditions.filter((rendition) => rendition.type === 'audio');
  if (audio.some((rendition) => rendition.codecs !== audio[0]!.codecs)) {
    fail('alternate audio tracks must use the same codec');
  }
  const manifest = {duration: periodDuration, renditions};
  if (!renditions.some((rendition) => rendition.segmentBase || rendition.segments.some((segment) => segment.index))) {
    validateDashSegmentAlignment(manifest);
  }
  return renditions;
}

/** Stitch pre-authored Periods without introducing another manifest or ad source. */
export function stitchDashPeriods(manifest: DashManifest, periods: DashPeriod[]): DashManifest {
  const first = periods[0]!;
  const tracks = first.renditions.map((rendition) => ({...rendition, segments: rendition.segments.map((segment) => ({...segment}))}));
  for (let i = 1; i < periods.length; i++) {
    const period = periods[i]!;
    const video = period.renditions.filter((rendition) => rendition.type === 'video');
    const audio = period.renditions.filter((rendition) => rendition.type === 'audio');
    const firstAudio = first.renditions.filter((rendition) => rendition.type === 'audio');
    const usedAudio = new Set<DashRendition>();
    if (!!video.length !== first.renditions.some((rendition) => rendition.type === 'video') || audio.length !== firstAudio.length) {
      return fail('Period transitions that add or remove audio/video tracks are not supported');
    }
    for (const [trackIndex, track] of tracks.entries()) {
      let next: DashRendition | undefined;
      if (track.type === 'video') {
        const compatible = video.filter((rendition) => rendition.codecs.toLowerCase() === track.codecs.toLowerCase());
        next =
          compatible.find((rendition) => rendition.id === track.id) ??
          compatible.reduce<DashRendition | undefined>(
            (best, rendition) =>
              !best || Math.abs(rendition.bandwidth - first.renditions[trackIndex]!.bandwidth) < Math.abs(best.bandwidth - first.renditions[trackIndex]!.bandwidth) ? rendition : best,
            undefined
          );
      } else {
        const matches = audio.filter((rendition) => rendition.trackKey === track.trackKey);
        next = matches.length === 1 ? matches[0] : matches.find((rendition) => rendition.id === track.id);
        if (!next && audio.length === 1 && firstAudio.length === 1 && audio[0]!.language === track.language) {
          next = audio[0];
        }
      }
      if (
        !next ||
        next.codecs.toLowerCase() !== track.codecs.toLowerCase() ||
        (track.type === 'video' && next.frameRate !== track.frameRate) ||
        (track.type === 'audio' && (usedAudio.has(next) || next.channels !== track.channels || next.audioSamplingRate !== track.audioSamplingRate))
      ) {
        return fail('Period tracks must have compatible codecs, frame rates, audio layouts and unambiguous track identities');
      }
      if (track.type === 'audio') usedAudio.add(next);
      // Playlist time must reach the Period boundary even if an AAC tail ends a fraction of a frame early.
      const previousBoundary = periods.slice(0, i).reduce((total, value) => total + value.duration, 0);
      const elapsed = track.segments.reduce((total, segment) => total + segment.duration, 0);
      track.segments.at(-1)!.duration += previousBoundary - elapsed;
      next.segments.forEach((segment, index) =>
        track.segments.push(
          index
            ? {...segment}
            : {
                ...segment,
                discontinuity: true,
                initialization: {url: next.initializationUrl, byteRange: next.initializationByteRange},
              }
        )
      );
      track.bandwidth = Math.max(track.bandwidth, next.bandwidth);
    }
  }
  const resolved = {...manifest, periods, renditions: tracks};
  validateDashSegmentAlignment(resolved);
  return resolved;
}

export function validateDashSegmentAlignment(manifest: DashManifest): void {
  const video = manifest.renditions.filter((rendition) => rendition.type === 'video');
  const reference = video[0]?.segments;
  if (reference && video.some(({segments}) => segments.length !== reference.length || segments.some((segment, i) => Math.abs(segment.duration - reference[i]!.duration) > 0.001))) {
    fail('video representations must have aligned segment boundaries');
  }
}

export function writeDashMediaPlaylist(rendition: DashRendition): string {
  if (!rendition.segments.length) {
    fail('representation contains no resolved playable segments');
  }
  const targetDuration = rendition.segments.reduce((max, segment) => Math.max(max, segment.duration), 1);
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(targetDuration)}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI=${quote(rendition.initializationUrl)}${rendition.initializationByteRange ? `,BYTERANGE="${rendition.initializationByteRange.length}@${rendition.initializationByteRange.offset}"` : ''}`,
    ...rendition.segments.flatMap((segment) => [
      ...(segment.discontinuity ? ['#EXT-X-DISCONTINUITY'] : []),
      ...(segment.initialization
        ? [
            `#EXT-X-MAP:URI=${quote(segment.initialization.url)}${segment.initialization.byteRange ? `,BYTERANGE="${segment.initialization.byteRange.length}@${segment.initialization.byteRange.offset}"` : ''}`,
          ]
        : []),
      `#EXTINF:${segment.duration.toFixed(9)},`,
      ...(segment.byteRange ? [`#EXT-X-BYTERANGE:${segment.byteRange.length}@${segment.byteRange.offset}`] : []),
      segment.url,
    ]),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

export function writeDashMasterPlaylist(renditions: DashRendition[], playlistUrls: string[]): string {
  const audio = renditions.filter((rendition) => rendition.type === 'audio');
  const video = renditions.filter((rendition) => rendition.type === 'video');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
  renditions.forEach((rendition, index) => {
    if (rendition.type === 'audio') {
      const attributes = [
        'TYPE=AUDIO',
        'GROUP-ID="audio"',
        `NAME=${quote(`${rendition.label} (${index + 1})`)}`,
        `DEFAULT=${rendition === audio[0] ? 'YES' : 'NO'}`,
        'AUTOSELECT=YES',
        `URI=${quote(playlistUrls[index]!)}`,
      ];
      if (rendition.language) attributes.push(`LANGUAGE=${quote(rendition.language)}`);
      if (rendition.channels) attributes.push(`CHANNELS=${quote(rendition.channels)}`);
      lines.push(`#EXT-X-MEDIA:${attributes.join(',')}`);
    }
  });
  renditions.forEach((rendition, index) => {
    if (video.length ? rendition.type !== 'video' : rendition !== audio[0]) return;
    const attributes = [`BANDWIDTH=${rendition.bandwidth + (rendition.type === 'video' ? audio.reduce((max, track) => Math.max(max, track.bandwidth), 0) : 0)}`];
    attributes.push(`CODECS=${quote([rendition.codecs, ...(rendition.type === 'video' && audio.length ? [audio[0]!.codecs] : [])].join(','))}`);
    if (rendition.width && rendition.height) attributes.push(`RESOLUTION=${rendition.width}x${rendition.height}`);
    if (rendition.frameRate) attributes.push(`FRAME-RATE=${rendition.frameRate.toFixed(6)}`);
    if (audio.length) attributes.push('AUDIO="audio"');
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`, playlistUrls[index]!);
  });
  return [...lines, ''].join('\n');
}
