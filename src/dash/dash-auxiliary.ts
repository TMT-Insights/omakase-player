/*
 * Copyright 2026 ByOmakase, LLC (https://byomakase.org)
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {Observable} from 'rxjs';
import * as imsc from 'smp-imsc';
import {AuthConfig, FileFormatType} from '../common';
import {DefaultTextCue, TextTrackFile, ThumbnailTrack, TimedItemTemporalType, type TimedImscDocument} from '../media';
import {UrlSource} from '../source';
import {httpGetBytes} from '../http';
import {OmpError} from '../types';
import type {DashByteRange, DashManifest, DashPeriod, DashRendition, DashSegment} from './dash-manifest';
import {createDashIndexBudget, mapLimit, resolveDashRendition} from './dash-segment-index';

/** Parallel auxiliary tracks, and parallel segment downloads within one. */
const AUXILIARY_CONCURRENCY = 6;
import {parseDashTextInitialization, parseDashTextSamples, parseDashWvttSample} from './dash-text-mp4';

interface Cue {
  start: number;
  end: number;
  text: string;
  settings?: string | undefined;
}

interface Group {
  rendition: DashRendition;
  cues: Cue[];
  headers: Set<string>;
  documents: TimedImscDocument[];
  resourceUrls: string[];
}

interface IsdNode {
  kind?: string;
  text?: string;
  contents?: IsdNode[];
}

function isdText(node: IsdNode): string {
  if (node.kind === 'br') return '\n';
  return node.text ?? (node.contents ?? []).map(isdText).join(!node.kind || node.kind === 'div' || node.kind === 'body' || node.kind === 'region' ? '\n' : '');
}

function fail(message: string): never {
  throw new OmpError(`DASH auxiliary: ${message}`);
}

function timestamp(value: string): number {
  if (!/^(?:\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3}$/.test(value)) return fail(`invalid WebVTT timestamp ${value}`);
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function formatTime(time: number): string {
  const ms = Math.round(time * 1000);
  return `${Math.floor(ms / 3600000)
    .toString()
    .padStart(2, '0')}:${Math.floor((ms / 60000) % 60)
    .toString()
    .padStart(2, '0')}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, '0')}.${(ms % 1000).toString().padStart(3, '0')}`;
}

function parseVtt(text: string, group: Group): {cues: Cue[]; offset: number} {
  const blocks = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/);
  const header = blocks.shift() ?? '';
  if (!/^WEBVTT(?:[ \t]|\n|$)/.test(header)) return fail('invalid WebVTT header');
  let offset = 0;
  const map = header.split('\n').find((line) => line.startsWith('X-TIMESTAMP-MAP='));
  if (map) {
    const local = /(?:=|,)LOCAL:([^,\s]+)/.exec(map)?.[1];
    const ticks = /(?:=|,)MPEGTS:(\d+)(?:,|$)/.exec(map)?.[1];
    if (!local || !ticks || !Number.isSafeInteger(Number(ticks))) fail('invalid WebVTT timestamp map');
    offset = Number(ticks) / 90000 - timestamp(local);
  }
  const cues: Cue[] = [];
  for (const block of blocks) {
    if (/^NOTE(?:[ \t]|\n|$)/.test(block)) continue;
    if (/^(?:STYLE|REGION)\n/.test(block)) {
      group.headers.add(block);
      continue;
    }
    const lines = block.split('\n');
    const index = lines[0]?.includes('-->') ? 0 : 1;
    const match = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(lines[index] ?? '');
    if (!match) return fail('invalid WebVTT cue timing');
    const start = timestamp(match[1]!);
    const end = timestamp(match[2]!);
    if (end <= start) return fail('invalid WebVTT cue interval');
    cues.push({start, end, settings: match[3], text: lines.slice(index + 1).join('\n')});
  }
  return {cues, offset};
}

/** Downloads finite static auxiliary tracks; the caller owns every generated URL. */
export function loadDashAuxiliaryTracks(manifest: DashManifest, createResource: (data: BlobPart[], mime: string) => string): Observable<(TextTrackFile | ThumbnailTrack)[]> {
  return new Observable((observer) => {
    const controller = new AbortController();
    const signal = controller.signal;
    let bytes = 0;
    let requests = 0;
    let cueCount = 0;
    const fetchResource = async (url: string, range?: DashByteRange): Promise<Uint8Array<ArrayBuffer>> => {
      signal.throwIfAborted();
      if (++requests > 4096) fail('more than 4096 auxiliary requests');
      const {data} = await httpGetBytes(url, {
        range,
        maxBytes: 32 * 1024 * 1024,
        requestInit: AuthConfig.createRequestInit(url, AuthConfig.authentication),
        signal,
        label: 'auxiliary',
        errorPrefix: 'DASH auxiliary: ',
      });
      bytes += data.byteLength;
      if (bytes > 128 * 1024 * 1024) fail('auxiliary resources exceed 128 MiB combined');
      return data;
    };
    const resource = (group: Group, data: BlobPart[], mime: string) => {
      const url = createResource(data, mime);
      group.resourceUrls.push(url);
      return url;
    };
    const addCue = (group: Group, cue: Cue, offset: number, start: number, end: number) => {
      const clipped = {...cue, start: Math.max(start, cue.start + offset), end: Math.min(end, cue.end + offset)};
      if (!Number.isFinite(clipped.start) || !Number.isFinite(clipped.end)) fail('invalid subtitle timestamps');
      if (clipped.end <= clipped.start) return;
      if (++cueCount > 100000) fail('more than 100000 auxiliary cues');
      clipped.text = clipped.text.replace(/<((?:\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3})>/g, (_, time: string) => `<${formatTime(Math.max(0, timestamp(time) + offset))}>`);
      group.cues.push(clipped);
    };
    const budget = createDashIndexBudget();
    const run = async () => {
      // Group each track's renditions across Periods before deciding how to load it.
      const entries = new Map<string, {rendition: DashRendition; parts: {period: DashPeriod; rendition: DashRendition}[]}>();
      for (const period of manifest.auxiliaryPeriods ?? []) {
        const counts = new Map<string, number>();
        for (const rendition of period.renditions) {
          const basicKey = JSON.stringify([rendition.type, rendition.trackKey, rendition.auxiliary?.kind, rendition.auxiliary?.forced]);
          counts.set(basicKey, (counts.get(basicKey) ?? 0) + 1);
        }
        const seen = new Set<string>();
        for (const rendition of period.renditions) {
          const auxiliary = rendition.auxiliary;
          if (!auxiliary) continue;
          const basicKey = JSON.stringify([rendition.type, rendition.trackKey, auxiliary.kind, auxiliary.forced]);
          const key = counts.get(basicKey)! > 1 ? `${basicKey}:${rendition.id}` : basicKey;
          if (seen.has(key)) fail('ambiguous auxiliary rendition identities');
          seen.add(key);
          const entry = entries.get(key);
          if (!entry) entries.set(key, {rendition, parts: [{period, rendition}]});
          else if (entry.rendition.auxiliary!.format !== auxiliary.format) fail('auxiliary codec changes between Periods are not supported');
          else entry.parts.push({period, rendition});
        }
      }

      const tracks = await mapLimit([...entries.values()], AUXILIARY_CONCURRENCY, async ({rendition: head, parts}) => {
        const sidecar = directSidecar(head, parts);
        if (sidecar) return sidecar;
        const group: Group = {rendition: head, cues: [], headers: new Set(), documents: [], resourceUrls: []};
        for (const part of parts) await loadPart(group, part.period, part.rendition);
        return createTrack(group);
      });
      signal.throwIfAborted();
      return tracks;
    };

    /**
     * A single unshifted sidecar file is handed to the text track as-is: it is fetched and parsed by
     * the regular text controllers when used, instead of being downloaded and re-encoded here.
     */
    const directSidecar = (head: DashRendition, parts: {period: DashPeriod; rendition: DashRendition}[]): TextTrackFile | undefined => {
      const auxiliary = head.auxiliary!;
      if ((auxiliary.format !== 'vtt' && auxiliary.format !== 'ttml') || parts.length !== 1) return undefined;
      const {period, rendition} = parts[0]!;
      const segment = rendition.segments.length === 1 ? rendition.segments[0]! : undefined;
      const coversPresentation = period.start === 0 && Math.abs(period.duration - manifest.duration) <= 0.001;
      if (!segment || segment.byteRange || !coversPresentation || rendition.presentationTimeOffset !== 0 || (segment.presentationTime ?? 0) !== 0) return undefined;
      return new TextTrackFile({
        source: new UrlSource(segment.url),
        sourceFileFormatType: auxiliary.format === 'vtt' ? FileFormatType.VTT : FileFormatType.TTML,
        label: head.label,
        kind: auxiliary.kind,
        srclang: head.language,
        default: auxiliary.default,
        customAttrs: {dashAuxiliary: true, dashForced: auxiliary.forced},
      });
    };

    const loadPart = async (group: Group, period: DashPeriod, unresolved: DashRendition) => {
      const auxiliary = unresolved.auxiliary!;
      // only fragmented MP4 text can carry indexes or implicit initialization
      const rendition =
        unresolved.segmentBase || unresolved.discoverInitialization || unresolved.segments.some((segment) => segment.index)
          ? await resolveDashRendition(unresolved, period.duration, signal, budget)
          : unresolved;
      const offset = period.start - rendition.presentationTimeOffset;
      const mp4 =
        auxiliary.format === 'wvtt' || auxiliary.format === 'stpp'
          ? parseDashTextInitialization(await fetchResource(rendition.initializationUrl, rendition.initializationByteRange), auxiliary.format)
          : undefined;
      const textDocument = (xml: string, start: number, end: number) => {
        const document = imsc.fromXML(xml);
        group.documents.push({url: resource(group, [xml], 'application/ttml+xml'), start, end, timeOffset: offset});
        const events = document.getMediaTimeEvents();
        if (events.length > 100000) fail('more than 100000 TTML timing events');
        const boundaries = [...new Set([start - offset, ...events.filter((time) => time > start - offset && time < end - offset), end - offset])].sort((a, b) => a - b);
        for (let i = 0; i + 1 < boundaries.length; i++) {
          const isd: IsdNode = imsc.generateISD(document, boundaries[i]!);
          const content = isdText(isd).trim();
          if (!content) continue;
          addCue(group, {start: boundaries[i]!, end: boundaries[i + 1]!, text: content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}, offset, start, end);
        }
      };
      let elapsed = 0;
      const timed = rendition.segments.flatMap((segment) => {
        const start = period.start + (segment.presentationTime ?? elapsed);
        const end = Math.min(period.start + period.duration, start + segment.duration);
        const clipStart = Math.max(period.start, start);
        elapsed += segment.duration;
        return end > clipStart ? [{segment, start, end, clipStart}] : [];
      });
      // Images are referenced by URL; only byte-range sprites, which no URL can address, are downloaded.
      const download = (segment: DashSegment) => auxiliary.format !== 'image' || !!segment.byteRange;
      const data = await mapLimit(timed, AUXILIARY_CONCURRENCY, ({segment}) => (download(segment) ? fetchResource(segment.url, segment.byteRange) : Promise.resolve(undefined)));
      signal.throwIfAborted();
      timed.forEach(({segment, start, end, clipStart}, index) => {
        const bytes = data[index];
        if (auxiliary.format === 'image') {
          const {columns, rows} = auxiliary.tiles;
          if ((columns > 1 || rows > 1) && (!rendition.width || !rendition.height || rendition.width % columns || rendition.height % rows))
            fail('tiled images require dimensions divisible by the tile grid');
          const imageUrl = bytes ? resource(group, [bytes], auxiliary.mimeType) : segment.url;
          const tileDuration = (segment.mediaDuration ?? segment.duration) / (columns * rows);
          for (let tile = 0; tile < columns * rows; tile++) {
            const xywh =
              columns * rows > 1
                ? `#xywh=${(tile % columns) * (rendition.width! / columns)},${Math.floor(tile / columns) * (rendition.height! / rows)},${rendition.width! / columns},${rendition.height! / rows}`
                : '';
            addCue(group, {start: start + tile * tileDuration, end: start + (tile + 1) * tileDuration, text: `${imageUrl}${xywh}`}, 0, clipStart, end);
          }
        } else if (mp4) {
          for (const sample of parseDashTextSamples(bytes!, mp4, segment.byteRange?.offset)) {
            const sampleStart = Math.max(period.start, sample.time + offset);
            const sampleEnd = Math.min(period.start + period.duration, sample.time + offset + sample.duration);
            if (sampleEnd <= sampleStart) continue;
            if (mp4.codec === 'wvtt') {
              for (const cue of parseDashWvttSample(sample)) addCue(group, {...cue, start: sample.time, end: sample.time + sample.duration}, offset, sampleStart, sampleEnd);
            } else textDocument(new TextDecoder('utf-8', {fatal: true}).decode(sample.data), sampleStart, sampleEnd);
          }
        } else {
          const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes!);
          if (auxiliary.format === 'ttml') textDocument(text, clipStart, end);
          else {
            const vtt = parseVtt(text, group);
            for (const cue of vtt.cues) addCue(group, cue, offset + vtt.offset, clipStart, end);
          }
        }
      });
    };

    const createTrack = (group: Group): TextTrackFile | ThumbnailTrack => {
      group.cues.sort((a, b) => a.start - b.start || a.end - b.end);
      const unique = new Set<string>();
      const cues = group.cues.filter((cue) => {
        const key = JSON.stringify(cue);
        if (unique.has(key)) return false;
        unique.add(key);
        return true;
      });
      const vtt = `WEBVTT\n\n${[...group.headers].map((header) => `${header}\n\n`).join('')}${cues.map((cue) => `${formatTime(cue.start)} --> ${formatTime(cue.end)}${cue.settings ? ` ${cue.settings}` : ''}\n${cue.text}\n\n`).join('')}`;
      const args = {
        source: new UrlSource(resource(group, [vtt], 'text/vtt')),
        sourceFileFormatType: FileFormatType.VTT,
        label: group.rendition.label,
        ownedResourceUrls: group.resourceUrls,
        customAttrs: {dashAuxiliary: true, dashForced: group.rendition.auxiliary!.forced},
      };
      if (group.rendition.type === 'image') return new ThumbnailTrack(args);
      const track = new TextTrackFile({
        ...args,
        kind: group.rendition.auxiliary!.kind,
        srclang: group.rendition.language,
        default: group.rendition.auxiliary!.default,
        imscDocuments: group.documents.length ? group.documents : undefined,
      });
      track.addTimedItems(cues.map((cue) => new DefaultTextCue({text: cue.text, temporal: {type: TimedItemTemporalType.SPAN, start: cue.start.toString(), end: cue.end.toString()}})));
      track.areTimedItemsFetched = true;
      return track;
    };
    run().then(
      (tracks) => {
        observer.next(tracks);
        observer.complete();
      },
      (error: unknown) => observer.error(error)
    );
    return () => controller.abort();
  });
}
