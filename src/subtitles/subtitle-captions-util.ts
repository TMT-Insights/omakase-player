/*
 * Copyright 2024 ByOmakase, LLC (https://byomakase.org)
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

import {parseResponse, VTTCue, VTTRegion} from 'media-captions';
import {SubtitlesTrack} from '../types';
import {TtmlCaptionTrack, TtmlContentNode} from './ttml/ttml-types';

export interface SubtitleCaptionsTrack {
  regions: any[];
  cues: any[];
  ttml?: TtmlCaptionTrack;
}

interface TtmlStyle {
  fontStyle?: string;
  fontWeight?: string;
  fontFamily?: string;
  fontSize?: string;
  color?: string;
  backgroundColor?: string;
  textAlign?: string;
  textDecoration?: string;
  textOutline?: string;
  lineHeight?: string;
  displayAlign?: string;
  writingMode?: string;
  xmlSpace?: 'default' | 'preserve';
  padding?: string;
  origin?: string;
  extent?: string;
}

interface TtmlRegionData {
  id: string;
  vttRegion: VTTRegion;
  origin?: string;
  extent?: string;
  displayAlign?: string;
  textAlign?: string;
  writingMode?: string;
  xmlSpace?: 'default' | 'preserve';
  padding?: string;
  style?: Record<string, string>;
}

export async function loadSubtitleCaptionsTrack(track: SubtitlesTrack): Promise<SubtitleCaptionsTrack> {
  const format = track.format ?? 'vtt';

  if (format === 'vtt') {
    return parseResponse(fetch(track.src));
  }

  if (format === 'ass') {
    return parseResponse(fetch(track.src), {type: 'ass'});
  }

  const text = await (await fetch(track.src)).text();

  if (format === 'dfxp') {
    return parseDfxpToTrack(text);
  }

  return {
    regions: [],
    cues: parseSccToCues(text),
  };
}

function parseDfxpToTrack(text: string): SubtitleCaptionsTrack {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0 || doc.documentElement?.nodeName === 'parsererror') {
    throw new Error('Failed to parse DFXP captions');
  }

  const styles = parseTtmlStyles(doc);
  const regions = parseTtmlRegions(doc, styles);
  const cues: VTTCue[] = [];
  const ttmlCues: TtmlCaptionTrack['cues'] = [];

  getTtmlElements(doc, 'p').forEach((p, index) => {
    const begin = parseTimedTextClockValue(p.getAttribute('begin') ?? p.getAttribute('start') ?? '');
    const endAttr = p.getAttribute('end');
    const durAttr = p.getAttribute('dur');
    const end = endAttr ? parseTimedTextClockValue(endAttr) : durAttr ? begin + parseTimedTextClockValue(durAttr) : Number.NaN;

    if (Number.isNaN(begin) || Number.isNaN(end)) {
      return;
    }

    const mergedStyle = resolveInheritedTtmlStyle(p, styles);
    const region = getDfxpRegion(p, regions, mergedStyle);
    if (region && !regions.has(region.id)) {
      regions.set(region.id, region);
    }
    const content = parseTtmlContentNodes(p, styles, mergedStyle);
    const textContent = normalizeCueText(extractDfxpText(p, styles));
    if (!textContent) {
      return;
    }

    const cue = new VTTCue(begin, end, textContent);
    cue.id = `${index}`;
    if (region) {
      cue.region = region.vttRegion;
    }
    cue.align = normalizeTextAlign(getAttrAny(p, ['tts:textAlign', 'textAlign']) ?? region?.textAlign ?? mergedStyle.textAlign);
    cue.style = buildTtmlCueStyle(mergedStyle);
    cues.push(cue);

    ttmlCues.push({
      id: cue.id,
      startTime: begin,
      endTime: end,
      regionId: region?.id,
      textAlign: normalizeTextAlign(getAttrAny(p, ['tts:textAlign', 'textAlign']) ?? region?.textAlign ?? mergedStyle.textAlign),
      displayAlign: (region?.displayAlign ?? mergedStyle.displayAlign) as 'before' | 'center' | 'after' | string | undefined,
      writingMode: mergedStyle.writingMode,
      xmlSpace: getXmlSpace(p, mergedStyle.xmlSpace ?? region?.xmlSpace),
      style: buildTtmlCueStyle(mergedStyle),
      content,
    });
  });

  return {
    regions: Array.from(regions.values()).map((region) => region.vttRegion),
    cues,
    ttml: {
      regions: Array.from(regions.values()).map((region) => ({
        id: region.id,
        origin: parseTtmlPair(region.origin),
        extent: parseTtmlPair(region.extent),
        displayAlign: region.displayAlign,
        textAlign: region.textAlign,
        writingMode: region.writingMode,
        xmlSpace: region.xmlSpace,
      })),
      cues: ttmlCues,
    },
  };
}

function parseSccToCues(text: string): VTTCue[] {
  const cues: VTTCue[] = [];
  const entries = text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => !!line && !line.startsWith('Scenarist_SCC'))
    .map((line) => {
      const match = line.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})\s+(.+)$/);
      if (!match) {
        return null;
      }

      return {
        time: parseSccTimecode(match[1], match[2], match[3], match[4]),
        bytes: parseSccPayload(match[5]),
      };
    })
    .filter((entry): entry is {time: number; bytes: number[]} => !!entry);

  let currentText = '';
  let currentStart: number | null = null;

  entries.forEach((entry, index) => {
    const nextTime = entries[index + 1]?.time ?? entry.time + 2;
    const flush = () => {
      const textContent = normalizeCueText(currentText);
      if (currentStart !== null && textContent) {
        const cue = new VTTCue(currentStart, nextTime, textContent);
        cue.id = `${cues.length}`;
        cues.push(cue);
      }
      currentText = '';
      currentStart = null;
    };

    for (let i = 0; i < entry.bytes.length; i += 2) {
      const a = entry.bytes[i] & 0x7f;
      const b = entry.bytes[i + 1] & 0x7f;

      if (a === 0 && b === 0) {
        continue;
      }

      if (isSccControlCode(a, b)) {
        if (b === 0x2c || b === 0x2d || b === 0x2f) {
          if (currentStart !== null && currentText.trim()) {
            flush();
          } else if (b === 0x2f) {
            currentText = '';
            currentStart = null;
          }
        } else if (b === 0x21) {
          currentText = currentText.slice(0, -1);
        } else if (b === 0x2e) {
          currentText = '';
          currentStart = null;
        }
        continue;
      }

      const chars = decodeSccChars(a, b);
      if (chars.length > 0) {
        if (currentStart === null) {
          currentStart = entry.time;
        }
        currentText += chars;
      }
    }
  });

  if (currentStart !== null && normalizeCueText(currentText)) {
    const endTime = entries.length > 0 ? entries[entries.length - 1].time : currentStart + 2;
    const cue = new VTTCue(currentStart, endTime, normalizeCueText(currentText));
    cue.id = `${cues.length}`;
    cues.push(cue);
  }

  return cues;
}

function parseTtmlStyles(doc: Document): Map<string, TtmlStyle> {
  const styles = new Map<string, TtmlStyle>();

  getTtmlElements(doc, 'style').forEach((styleElement) => {
    const id = getAttrAny(styleElement, ['xml:id', 'id']);
    if (!id) {
      return;
    }

    styles.set(id, {
      fontStyle: getAttrAny(styleElement, ['tts:fontStyle', 'fontStyle']) ?? undefined,
      fontWeight: getAttrAny(styleElement, ['tts:fontWeight', 'fontWeight']) ?? undefined,
      fontFamily: getAttrAny(styleElement, ['tts:fontFamily', 'fontFamily']) ?? undefined,
      fontSize: getAttrAny(styleElement, ['tts:fontSize', 'fontSize']) ?? undefined,
      color: getAttrAny(styleElement, ['tts:color', 'color']) ?? undefined,
      backgroundColor: getAttrAny(styleElement, ['tts:backgroundColor', 'backgroundColor']) ?? undefined,
      textAlign: getAttrAny(styleElement, ['tts:textAlign', 'textAlign']) ?? undefined,
      textDecoration: getAttrAny(styleElement, ['tts:textDecoration', 'textDecoration']) ?? undefined,
      textOutline: getAttrAny(styleElement, ['tts:textOutline', 'textOutline']) ?? undefined,
      lineHeight: getAttrAny(styleElement, ['tts:lineHeight', 'lineHeight']) ?? undefined,
      displayAlign: getAttrAny(styleElement, ['tts:displayAlign', 'displayAlign']) ?? undefined,
      writingMode: getAttrAny(styleElement, ['tts:writingMode', 'writingMode']) ?? undefined,
      xmlSpace: getXmlSpace(styleElement),
      origin: getAttrAny(styleElement, ['tts:origin', 'origin']) ?? undefined,
      extent: getAttrAny(styleElement, ['tts:extent', 'extent']) ?? undefined,
    });
  });

  return styles;
}

function resolveInheritedTtmlStyle(element: Element, styles: Map<string, TtmlStyle>): TtmlStyle {
  const chain: Element[] = [];
  let current: Element | null = element;

  while (current) {
    chain.push(current);
    current = current.parentElement;
  }

  return chain
    .reverse()
    .reduce<TtmlStyle>((acc, node) => Object.assign(acc, mergeTtmlStyles(getAttrAny(node, ['style']) ?? '', node, styles)), {});
}

function parseTtmlRegions(doc: Document, styles: Map<string, TtmlStyle>): Map<string, TtmlRegionData> {
  const regions = new Map<string, TtmlRegionData>();

  getTtmlElements(doc, 'region').forEach((regionElement) => {
    const id = getAttrAny(regionElement, ['xml:id', 'id']);
    if (!id) {
      return;
    }

    const geometry = parseTtmlRegionGeometry(
      getAttrAny(regionElement, ['tts:origin', 'origin']) ?? undefined,
      getAttrAny(regionElement, ['tts:extent', 'extent']) ?? undefined,
      getAttrAny(regionElement, ['tts:displayAlign', 'displayAlign']) ?? undefined,
    );

    regions.set(id, {
      id,
      vttRegion: toVttRegion(id, geometry),
      origin: getAttrAny(regionElement, ['tts:origin', 'origin']) ?? undefined,
      extent: getAttrAny(regionElement, ['tts:extent', 'extent']) ?? undefined,
      displayAlign: getAttrAny(regionElement, ['tts:displayAlign', 'displayAlign']) ?? undefined,
      textAlign: getAttrAny(regionElement, ['tts:textAlign', 'textAlign']) ?? undefined,
      writingMode: getAttrAny(regionElement, ['tts:writingMode', 'writingMode']) ?? undefined,
      xmlSpace: getXmlSpace(regionElement),
      padding: getAttrAny(regionElement, ['tts:padding', 'padding']) ?? undefined,
      style: buildTtmlCueStyle(mergeTtmlStyles(getAttrAny(regionElement, ['style']) ?? '', regionElement, styles)),
    });
  });

  return regions;
}

function parseTtmlRegionGeometry(originValue?: string, extentValue?: string, displayAlignValue?: string) {
  const origin = parseTtmlPair(originValue);
  const extent = parseTtmlPair(extentValue);

  return {
    origin,
    extent,
    displayAlign: displayAlignValue,
  };
}

function getDfxpRegion(p: Element, regions: Map<string, TtmlRegionData>, style: TtmlStyle): TtmlRegionData | undefined {
  const regionId = getAttrAny(p, ['region']) ?? undefined;
  const region = regionId ? regions.get(regionId) : undefined;
  if (region) {
    return region;
  }

  const origin = parseTtmlPair(style.origin);
  const extent = parseTtmlPair(style.extent);
  if (!origin || !extent) {
    return void 0;
  }

  const id = `cue-${p.getAttribute('xml:id') ?? p.getAttribute('id') ?? ''}`;
  return {
    id,
    vttRegion: toVttRegion(id, {origin, extent, displayAlign: style.displayAlign}),
    origin: style.origin,
    extent: style.extent,
    displayAlign: style.displayAlign,
    textAlign: style.textAlign,
    writingMode: style.writingMode,
  };
}

function buildTtmlCueStyle(style: TtmlStyle): Record<string, string> {
  return {
    ...(style.fontFamily ? {'font-family': style.fontFamily} : {}),
    ...(style.fontSize ? {'font-size': style.fontSize} : {}),
    ...(style.fontStyle ? {'font-style': style.fontStyle} : {}),
    ...(style.fontWeight ? {'font-weight': style.fontWeight} : {}),
    ...(style.color ? {color: style.color} : {}),
    ...(style.backgroundColor ? {'background-color': style.backgroundColor} : {}),
    ...(style.lineHeight ? {'line-height': style.lineHeight} : {}),
    ...(style.textDecoration ? {'text-decoration': style.textDecoration} : {}),
    ...(style.textOutline ? {'text-shadow': textOutlineToTextShadow(style.textOutline)} : {}),
  };
}

function parseTtmlContentNodes(node: Element, styles: Map<string, TtmlStyle>, inheritedStyle: TtmlStyle = {}): TtmlContentNode[] {
  return parseTtmlContentNodesWithSpace(node, styles, inheritedStyle, getXmlSpace(node, inheritedStyle.xmlSpace));
}

function parseTtmlContentNodesWithSpace(node: Element, styles: Map<string, TtmlStyle>, inheritedStyle: TtmlStyle = {}, inheritedSpace: 'default' | 'preserve' = 'default'): TtmlContentNode[] {
  const currentStyle = mergeTtmlStyles(getAttrAny(node, ['style']) ?? '', node, styles);
  const mergedStyle = {...inheritedStyle, ...currentStyle};
  const currentSpace = getXmlSpace(node, mergedStyle.xmlSpace ?? inheritedSpace);
  const content: TtmlContentNode[] = [];

  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = normalizeTtmlWhitespace(child.textContent ?? '', currentSpace);
      if (text) {
        content.push({kind: 'text', text});
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as Element;
      const tagName = element.tagName.toLowerCase();
      if (tagName === 'br') {
        content.push({kind: 'br'});
      } else {
        const directStyle = mergeTtmlStyles(getAttrAny(element, ['style']) ?? '', element, styles);
        const children = parseTtmlContentNodesWithSpace(element, styles, {...mergedStyle, ...directStyle}, getXmlSpace(element, currentSpace));
        if (children.length > 0) {
          content.push({kind: 'span', children, style: buildTtmlCueStyle(directStyle)});
        }
      }
    }
  });

  return content;
}

function normalizeTtmlWhitespace(value: string, xmlSpace: 'default' | 'preserve'): string {
  if (xmlSpace === 'preserve') {
    return value;
  }

  return value.replace(/\s+/g, ' ');
}

function getXmlSpace(element: Element, fallback: 'default' | 'preserve' = 'default'): 'default' | 'preserve' {
  const value = getAttrAny(element, ['xml:space'])?.toLowerCase();
  if (value === 'preserve') {
    return 'preserve';
  }

  if (value === 'default') {
    return 'default';
  }

  return fallback;
}

function toVttRegion(id: string, geometry: {origin?: {x: number; y: number}; extent?: {x: number; y: number}; displayAlign?: string}): VTTRegion {
  const region = new VTTRegion();
  region.id = id;
  region.width = geometry.extent?.x ?? 100;
  (region as any).height = geometry.extent?.y ?? 0;
  region.lines = 3;
  region.regionAnchorX = 0;
  region.regionAnchorY = 0;
  region.viewportAnchorX = geometry.origin?.x ?? 0;
  region.viewportAnchorY = geometry.origin?.y ?? 0;
  region.scroll = '';
  return region;
}

function normalizeTextAlign(value?: string): 'start' | 'center' | 'end' | 'left' | 'right' {
  switch ((value ?? '').toLowerCase()) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'end':
      return 'end';
    case 'start':
      return 'start';
    case 'center':
    default:
      return 'center';
  }
}

function parseTtmlPair(value?: string): {x: number; y: number} | undefined {
  if (!value) {
    return void 0;
  }

  const parts = value.trim().split(/\s+/);
  if (parts.length < 2) {
    return void 0;
  }

  return {
    x: parseTtmlPercent(parts[0]),
    y: parseTtmlPercent(parts[1]),
  };
}

function parseTtmlPercent(value: string): number {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)%$/);
  if (!match) {
    return Number(value) || 0;
  }

  return Number(match[1]);
}

function mergeTtmlStyles(styleRefs: string, element: Element, styles: Map<string, TtmlStyle>): TtmlStyle {
  const merged: TtmlStyle = {};

  styleRefs
    .split(/\s+/)
    .map((id) => id.trim())
    .filter((id) => !!id)
    .forEach((id) => {
      Object.assign(merged, styles.get(id) ?? {});
    });

  const directStyle = ttmlStyleFromElement(element);
  Object.assign(merged, directStyle);

  return merged;
}

function ttmlStyleFromElement(element: Element): TtmlStyle {
    return {
      fontStyle: getAttrAny(element, ['tts:fontStyle', 'fontStyle']) ?? undefined,
      fontWeight: getAttrAny(element, ['tts:fontWeight', 'fontWeight']) ?? undefined,
      fontFamily: getAttrAny(element, ['tts:fontFamily', 'fontFamily']) ?? undefined,
    fontSize: getAttrAny(element, ['tts:fontSize', 'fontSize']) ?? undefined,
    color: getAttrAny(element, ['tts:color', 'color']) ?? undefined,
    backgroundColor: getAttrAny(element, ['tts:backgroundColor', 'backgroundColor']) ?? undefined,
    textAlign: getAttrAny(element, ['tts:textAlign', 'textAlign']) ?? undefined,
    textDecoration: getAttrAny(element, ['tts:textDecoration', 'textDecoration']) ?? undefined,
      textOutline: getAttrAny(element, ['tts:textOutline', 'textOutline']) ?? undefined,
      lineHeight: getAttrAny(element, ['tts:lineHeight', 'lineHeight']) ?? undefined,
      xmlSpace: getXmlSpace(element),
      padding: getAttrAny(element, ['tts:padding', 'padding']) ?? undefined,
    };
}

function getTtmlElements(doc: Document, tagName: string): Element[] {
  return Array.from(doc.getElementsByTagNameNS('*', tagName)).filter((node): node is Element => node instanceof Element);
}

function textOutlineToTextShadow(value: string): string {
  const parts = value.trim().split(/\s+/);
  const color = parts[0] ?? 'black';
  const radius = parts[1] ?? '2px';
  return `0 0 ${radius} ${color}`;
}

function getAttrAny(element: Element, names: string[]): string | null {
  for (const name of names) {
    const value = element.getAttribute(name);
    if (value !== null) {
      return value;
    }

    const namespacedValue = getNamespacedAttr(element, name);
    if (namespacedValue !== null) {
      return namespacedValue;
    }
  }

  return null;
}

function getNamespacedAttr(element: Element, name: string): string | null {
  const parts = name.split(':');
  if (parts.length !== 2) {
    return null;
  }

  const [prefix, localName] = parts;
  const namespace = getNamespaceUri(prefix);
  return namespace ? element.getAttributeNS(namespace, localName) : null;
}

function getNamespaceUri(prefix: string): string | null {
  switch (prefix) {
    case 'xml':
      return 'http://www.w3.org/XML/1998/namespace';
    case 'tts':
      return 'http://www.w3.org/ns/ttml#styling';
    case 'ttm':
      return 'http://www.w3.org/ns/ttml#metadata';
    case 'ttp':
      return 'http://www.w3.org/ns/ttml#parameter';
    default:
      return null;
  }
}

function escapeVttText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractDfxpText(node: Element, styles: Map<string, TtmlStyle>, inheritedStyle: TtmlStyle = {}): string {
  const currentStyle = mergeTtmlStyles(getAttrAny(node, ['style']) ?? '', node, styles);
  const mergedStyle = {...inheritedStyle, ...currentStyle};
  let text = '';

  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      text += escapeVttText(child.textContent ?? '');
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as Element;
      const tagName = element.tagName.toLowerCase();
      if (tagName === 'br') {
        text += '\n';
      } else {
        const childStyle = mergeTtmlStyles(getAttrAny(element, ['style']) ?? '', element, styles);
        const combinedStyle = {...mergedStyle, ...childStyle};
        const childText = extractDfxpText(element, styles, combinedStyle);
        text += wrapDfxpText(childText, combinedStyle);
      }
    }
  });

  return text;
}

function wrapDfxpText(text: string, style: TtmlStyle): string {
  let wrapped = text;

  if ((style.fontStyle ?? '').toLowerCase() === 'italic') {
    wrapped = `<i>${wrapped}</i>`;
  }
  if ((style.fontWeight ?? '').toLowerCase() === 'bold') {
    wrapped = `<b>${wrapped}</b>`;
  }
  if ((style.textDecoration ?? '').toLowerCase().includes('underline')) {
    wrapped = `<u>${wrapped}</u>`;
  }

  return wrapped;
}

function parseTimedTextClockValue(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return Number.NaN;
  }

  const parts = trimmed.split(':');
  if (parts.length === 4) {
    const [hours, minutes, seconds, frames] = parts;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(frames) / 30;
  }

  const normalized = trimmed.replace(',', '.');
  const match = normalized.match(/^(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) {
    return Number.NaN;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function parseSccTimecode(hours: string, minutes: string, seconds: string, frames: string): number {
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(frames) / 30;
}

function parseSccPayload(payload: string): number[] {
  return (payload.match(/[0-9a-fA-F]{4}/g) ?? []).flatMap((chunk) => {
    const value = Number.parseInt(chunk, 16);
    return [(value >> 8) & 0xff, value & 0xff];
  });
}

function isSccControlCode(a: number, b: number): boolean {
  return (
    (((a === 0x14 || a === 0x1c || a === 0x15 || a === 0x1d) && b >= 0x20 && b <= 0x2f) ||
      ((a === 0x17 || a === 0x1f) && b >= 0x21 && b <= 0x23) ||
      ((a === 0x11 || a === 0x19) && b >= 0x20 && b <= 0x2f) ||
      ((a === 0x10 || a === 0x18) && b >= 0x20 && b <= 0x2f))
  );
}

function decodeSccChars(a: number, b: number): string {
  const chars: number[] = [];
  let charCode1 = a;

  if (a >= 0x19) {
    charCode1 = a - 8;
  }

  if (charCode1 >= 0x11 && charCode1 <= 0x13) {
    const oneCode = charCode1 === 0x11 ? b + 0x50 : charCode1 === 0x12 ? b + 0x70 : b + 0x90;
    chars.push(oneCode);
  } else if (a >= 0x20 && a <= 0x7f) {
    chars.push(a);
    if (b !== 0) {
      chars.push(b);
    }
  }

  return chars.map(decodeCea608Byte).join('');
}

function decodeCea608Byte(byte: number): string {
  return String.fromCharCode(CEA608_SPECIAL_CHARS[byte] ?? byte);
}

const CEA608_SPECIAL_CHARS: Record<number, number> = {
  0x2a: 0xe1,
  0x5c: 0xe9,
  0x5e: 0xed,
  0x5f: 0xf3,
  0x60: 0xfa,
  0x7b: 0xe7,
  0x7c: 0xf7,
  0x7d: 0xd1,
  0x7e: 0xf1,
  0x7f: 0x2588,
  0x80: 0xae,
  0x81: 0xb0,
  0x82: 0xbd,
  0x83: 0xbf,
  0x84: 0x2122,
  0x85: 0xa2,
  0x86: 0xa3,
  0x87: 0x266a,
  0x88: 0xe0,
  0x89: 0x20,
  0x8a: 0xe8,
  0x8b: 0xe2,
  0x8c: 0xea,
  0x8d: 0xee,
  0x8e: 0xf4,
  0x8f: 0xfb,
  0x90: 0xc1,
  0x91: 0xc9,
  0x92: 0xd3,
  0x93: 0xda,
  0x94: 0xdc,
  0x95: 0xfc,
  0x96: 0x2018,
  0x97: 0xa1,
  0x98: 0x2a,
  0x99: 0x2019,
  0x9a: 0x2501,
  0x9b: 0xa9,
  0x9c: 0x2120,
  0x9d: 0x2022,
  0x9e: 0x201c,
  0x9f: 0x201d,
  0xa0: 0xc0,
  0xa1: 0xc2,
  0xa2: 0xc7,
  0xa3: 0xc8,
  0xa4: 0xca,
  0xa5: 0xcb,
  0xa6: 0xeb,
  0xa7: 0xce,
  0xa8: 0xcf,
  0xa9: 0xef,
  0xaa: 0xd4,
  0xab: 0xd9,
  0xac: 0xf9,
  0xad: 0xdb,
  0xae: 0xab,
  0xaf: 0xbb,
  0xb0: 0xc3,
  0xb1: 0xe3,
  0xb2: 0xcd,
  0xb3: 0xcc,
  0xb4: 0xec,
  0xb5: 0xd2,
  0xb6: 0xf2,
  0xb7: 0xd5,
  0xb8: 0xf5,
  0xb9: 0x7b,
  0xba: 0x7d,
  0xbb: 0x5c,
  0xbc: 0x5e,
  0xbd: 0x5f,
  0xbe: 0x7c,
  0xbf: 0x223c,
  0xc0: 0xc4,
  0xc1: 0xe4,
  0xc2: 0xd6,
  0xc3: 0xf6,
  0xc4: 0xdf,
  0xc5: 0xa5,
  0xc6: 0xa4,
  0xc7: 0x2503,
  0xc8: 0xc5,
  0xc9: 0xe5,
  0xca: 0xd8,
  0xcb: 0xf8,
  0xcc: 0x250f,
  0xcd: 0x2513,
  0xce: 0x2517,
  0xcf: 0x251b,
}

function normalizeCueText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}
