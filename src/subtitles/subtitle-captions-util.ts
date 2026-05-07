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

import {parseResponse, VTTCue} from 'media-captions';
import {SubtitlesTrack} from '../types';

export interface SubtitleCaptionsTrack {
  regions: any[];
  cues: any[];
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
}

export async function loadSubtitleCaptionsTrack(track: SubtitlesTrack): Promise<SubtitleCaptionsTrack> {
  const format = track.format ?? 'vtt';

  if (format === 'vtt') {
    return parseResponse(fetch(track.src));
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
  const cues: VTTCue[] = [];

  getTtmlElements(doc, 'p').forEach((p, index) => {
    const begin = parseTimedTextClockValue(p.getAttribute('begin') ?? p.getAttribute('start') ?? '');
    const endAttr = p.getAttribute('end');
    const durAttr = p.getAttribute('dur');
    const end = endAttr ? parseTimedTextClockValue(endAttr) : durAttr ? begin + parseTimedTextClockValue(durAttr) : Number.NaN;

    if (Number.isNaN(begin) || Number.isNaN(end)) {
      return;
    }

    const textContent = normalizeCueText(extractDfxpText(p, styles));
    if (!textContent) {
      return;
    }

    const cue = new VTTCue(begin, end, textContent);
    cue.id = `${index}`;
    cues.push(cue);
  });

  return {
    regions: [],
    cues,
  };
}

function parseSccToCues(text: string): VTTCue[] {
  const entries = new Map<number, string[]>();

  text.split(/\r?\n|\r/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Scenarist_SCC')) {
      return;
    }

    const match = trimmed.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})\s+(.+)$/);
    if (!match) {
      return;
    }

    const startTime = parseSccTimecode(match[1], match[2], match[3], match[4]);
    const decoded = decodeSccPayload(match[5]);
    if (!decoded) {
      return;
    }

    const existing = entries.get(startTime) ?? [];
    existing.push(decoded);
    entries.set(startTime, existing);
  });

  const ordered = Array.from(entries.entries()).sort((a, b) => a[0] - b[0]);
  return ordered
    .map(([startTime, chunks], index) => {
      const endTime = ordered[index + 1]?.[0] ?? startTime + 2;
      const textContent = normalizeCueText(chunks.join('\n'));
      if (!textContent) {
        return undefined;
      }

      const cue = new VTTCue(startTime, endTime, textContent);
      cue.id = `${index}`;
      return cue;
    })
    .filter((cue): cue is VTTCue => !!cue);
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
    });
  });

  return styles;
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

function decodeSccPayload(payload: string): string {
  const chunks = payload.match(/[0-9a-fA-F]{4}/g) ?? [];
  let text = '';

  chunks.forEach((chunk) => {
    const value = Number.parseInt(chunk, 16);
    const high = (value >> 8) & 0xff;
    const low = value & 0xff;

    [high, low].forEach((byte) => {
      if (byte === 0x0d) {
        text += '\n';
      } else if (byte >= 0x20 && byte <= 0x7e) {
        text += String.fromCharCode(byte);
      }
    });
  });

  return text;
}

function normalizeCueText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}
