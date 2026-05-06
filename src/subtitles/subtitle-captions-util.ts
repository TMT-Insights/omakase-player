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

import {parseResponse} from 'media-captions';
import {SubtitlesTrack} from '../types';

export interface SubtitleCaptionsTrack {
  regions: any[];
  cues: any[];
}

export async function loadSubtitleCaptionsTrack(track: SubtitlesTrack): Promise<SubtitleCaptionsTrack> {
  const format = track.format ?? 'vtt';

  if (format === 'vtt') {
    return parseResponse(fetch(track.src));
  }

  const text = await (await fetch(track.src)).text();

  if (format === 'dfxp') {
    return {
      regions: [],
      cues: parseDfxpToCues(text),
    };
  }

  return {
    regions: [],
    cues: parseSccToCues(text),
  };
}

function parseDfxpToCues(text: string): VTTCue[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0 || doc.documentElement?.nodeName === 'parsererror') {
    throw new Error('Failed to parse DFXP captions');
  }

  const cues: VTTCue[] = [];
  Array.from(doc.getElementsByTagName('p')).forEach((p, index) => {
    const begin = parseTimedTextClockValue(p.getAttribute('begin') ?? p.getAttribute('start') ?? '');
    const endAttr = p.getAttribute('end');
    const durAttr = p.getAttribute('dur');
    const end = endAttr ? parseTimedTextClockValue(endAttr) : durAttr ? begin + parseTimedTextClockValue(durAttr) : Number.NaN;

    if (Number.isNaN(begin) || Number.isNaN(end)) {
      return;
    }

    const textContent = normalizeCueText(extractDfxpText(p));
    if (!textContent) {
      return;
    }

    const cue = new VTTCue(begin, end, textContent);
    cue.id = `${index}`;
    cues.push(cue);
  });

  return cues;
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

function extractDfxpText(node: Element): string {
  let text = '';

  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as Element;
      if (element.tagName.toLowerCase() === 'br') {
        text += '\n';
      } else {
        text += extractDfxpText(element);
      }
    }
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
