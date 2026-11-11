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
  byteRange?: DashByteRange;
}

export interface DashRendition {
  type: 'video' | 'audio';
  id: string;
  bandwidth: number;
  codecs: string;
  width?: number | undefined;
  height?: number | undefined;
  frameRate?: number | undefined;
  language?: string | undefined;
  label: string;
  channels?: string | undefined;
  initializationUrl: string;
  initializationByteRange?: DashByteRange;
  segmentBase?: {indexRange: DashByteRange; mediaUrl: string};
  presentationTimeOffset: number;
  segments: DashSegment[];
}

export interface DashManifest {
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

function parseRendition(path: Element[], manifestUrl: string, periodDuration: number, type: 'video' | 'audio', index: number): DashRendition {
  const representation = path[path.length - 1]!;
  const id = representation.getAttribute('id') ?? '';
  const bandwidth = integer(attr(path, 'bandwidth'), 'bandwidth', undefined, 1);
  const codecs = attr(path, 'codecs');
  if (!codecs || codecs.includes(',')) {
    return fail('each representation must declare one codec (multiplexed representations are not supported)');
  }
  quote(codecs);
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

  const segmentBases = path.map((element) => single(element, 'SegmentBase')).filter((element) => element !== undefined);
  const templates = path.map((element) => single(element, 'SegmentTemplate')).filter((element) => element !== undefined);
  if (segmentBases.length && templates.length) {
    fail('mixed SegmentBase and SegmentTemplate addressing is not supported');
  }
  const addressing = segmentBases.length ? parseSegmentBase(segmentBases, base) : parseSegmentTemplate(templates, base, id, bandwidth, periodDuration);
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
    codecs,
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
    ...addressing,
  };
}

type DashAddressing = Pick<DashRendition, 'initializationUrl' | 'initializationByteRange' | 'presentationTimeOffset' | 'segmentBase' | 'segments'>;

function parseSegmentBase(segmentBases: Element[], base: string): DashAddressing {
  const initialization = segmentBases.map((element) => single(element, 'Initialization')).findLast((element) => element !== undefined);
  if (!initialization) {
    return fail('SegmentBase requires Initialization');
  }
  if (segmentBases.some((element) => children(element, 'RepresentationIndex').length)) {
    fail('SegmentBase RepresentationIndex is not supported; use indexRange');
  }
  const indexRange = byteRange(attr(segmentBases, 'indexRange'), 'SegmentBase@indexRange');
  const timescale = integer(attr(segmentBases, 'timescale'), 'SegmentBase@timescale', 1, 1);
  const offset = integer(attr(segmentBases, 'presentationTimeOffset'), 'SegmentBase@presentationTimeOffset', 0);
  const initializationRange = initialization.getAttribute('range');
  if (initializationRange === null && !initialization.getAttribute('sourceURL')) {
    fail('SegmentBase Initialization requires a range or sourceURL');
  }
  return {
    initializationUrl: url(initialization.getAttribute('sourceURL') ?? '', base),
    ...(initializationRange !== null ? {initializationByteRange: byteRange(initializationRange, 'Initialization@range')} : {}),
    presentationTimeOffset: offset / timescale,
    segmentBase: {indexRange, mediaUrl: base},
    segments: [],
  };
}

function parseSegmentTemplate(templates: Element[], base: string, id: string, bandwidth: number, periodDuration: number): DashAddressing {
  if (!templates.length) {
    return fail('SegmentTemplate or SegmentBase is required; SegmentList is not supported');
  }
  const media = attr(templates, 'media');
  const initialization = attr(templates, 'initialization');
  if (!media || !initialization) {
    return fail('SegmentTemplate must declare media and initialization URLs');
  }
  if (templates.some((element) => element.hasAttribute('index') || element.hasAttribute('indexRange') || element.hasAttribute('endNumber'))) {
    fail('indexed or endNumber-bounded SegmentTemplates are not supported');
  }
  if (!id && [media, initialization].some((template) => template.includes('$RepresentationID$'))) {
    fail('RepresentationID template requires a representation id');
  }
  const timescale = integer(attr(templates, 'timescale'), 'timescale', 1, 1);
  const offset = integer(attr(templates, 'presentationTimeOffset'), 'presentationTimeOffset', 0);
  const startNumber = integer(attr(templates, 'startNumber'), 'startNumber', 1);
  const end = offset + periodDuration * timescale;
  if (!Number.isSafeInteger(Math.ceil(end))) {
    fail('segment timeline exceeds safe integer precision');
  }
  const timeline = templates.map((element) => single(element, 'SegmentTimeline')).findLast((element) => element !== undefined);
  const segments: DashSegment[] = [];
  let cursor = 0;
  const append = (time: number, length: number) => {
    // HLS cannot express a presentation-time trim at the start of a fragment.
    if (segments.length === 0 && time !== offset) {
      fail('the first segment must start at presentationTimeOffset; leading trims or gaps are not supported');
    }
    if (time >= end) {
      return;
    }
    if (segments.length >= MAX_SEGMENTS) {
      fail(`more than ${MAX_SEGMENTS} segments per representation are not supported`);
    }
    segments.push({
      url: url(expandTemplate(media, id, bandwidth, startNumber + segments.length, time), base),
      duration: Math.min(length, end - time) / timescale,
    });
  };
  if (timeline) {
    const entries = children(timeline, 'S');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const time = integer(entry.getAttribute('t') ?? undefined, 'S@t', cursor);
      const length = integer(entry.getAttribute('d') ?? undefined, 'S@d', undefined, 1);
      const repeat = integer(entry.getAttribute('r') ?? undefined, 'S@r', 0, -1);
      if (segments.length && time !== cursor) {
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
    if (cursor < end - 0.001 * timescale) {
      fail('SegmentTimeline does not cover the Period duration');
    }
  } else {
    const length = integer(attr(templates, 'duration'), 'SegmentTemplate@duration', undefined, 1);
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
  return {
    initializationUrl: url(expandTemplate(initialization, id, bandwidth), base),
    presentationTimeOffset: offset / timescale,
    segments,
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
  for (const name of ['ContentProtection', 'SegmentList', 'ContentComponent', 'SubRepresentation', 'EssentialProperty']) {
    if (document.getElementsByTagNameNS('*', name).length) {
      fail(`${name} is not supported`);
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
  const period = single(mpd, 'Period');
  if (!period || (duration(period.getAttribute('start')) ?? 0) !== 0) {
    return fail('one Period starting at zero is required');
  }
  const periodDuration = duration(period.getAttribute('duration')) ?? duration(mpd.getAttribute('mediaPresentationDuration'));
  if (periodDuration === undefined || periodDuration <= 0) {
    return fail('a finite positive Period or MPD duration is required');
  }
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
      const type = mimeType === 'video/mp4' ? 'video' : mimeType === 'audio/mp4' ? 'audio' : undefined;
      if (!type) {
        return fail(`unsupported mimeType ${mimeType ?? '(missing)'}; only video/mp4 and audio/mp4 are supported`);
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
  if (!renditions.length) {
    fail('MPD has no audio or video representations');
  }
  if (renditions.some((rendition) => Math.abs(rendition.presentationTimeOffset - renditions[0]!.presentationTimeOffset) > 0.001)) {
    fail('audio and video must share the same presentation time origin');
  }
  const audio = renditions.filter((rendition) => rendition.type === 'audio');
  if (audio.some((rendition) => rendition.codecs !== audio[0]!.codecs)) {
    fail('alternate audio tracks must use the same codec');
  }
  const manifest = {duration: periodDuration, renditions};
  if (!renditions.some((rendition) => rendition.segmentBase)) {
    validateDashSegmentAlignment(manifest);
  }
  return manifest;
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
