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

import {VTTCue} from 'media-captions';

interface SccEntry {
  time: number;
  bytes: number[];
}

export function parseSccCaptions(text: string): VTTCue[] {
  const entries = parseSccEntries(text);
  const cues: VTTCue[] = [];
  let currentText = '';
  let currentStart: number | undefined;

  const flush = (endTime: number) => {
    const cueText = normalizeCueText(currentText);
    if (currentStart !== undefined && cueText) {
      const cue = new VTTCue(currentStart, Math.max(currentStart + 0.001, endTime), escapeCueText(cueText));
      cue.id = `${cues.length}`;
      cues.push(cue);
    }
    currentText = '';
    currentStart = undefined;
  };

  entries.forEach((entry) => {
    for (let i = 0; i + 1 < entry.bytes.length; i += 2) {
      const a = entry.bytes[i]! & 0x7f;
      const b = entry.bytes[i + 1]! & 0x7f;

      if (a === 0 && b === 0) {
        continue;
      }

      if (isSccControlCode(a, b)) {
        if (b === 0x2c || b === 0x2d || b === 0x2f) {
          flush(entry.time);
        } else if (b === 0x21) {
          currentText = currentText.slice(0, -1);
        } else if (b === 0x2e) {
          currentText = '';
          currentStart = undefined;
        }
        continue;
      }

      const chars = decodeSccChars(a, b);
      if (chars) {
        currentStart ??= entry.time;
        currentText += chars;
      }
    }
  });

  const lastEntry = entries.at(-1);
  if (lastEntry) {
    flush(lastEntry.time + 2);
  }

  return cues;
}

function parseSccEntries(text: string): SccEntry[] {
  const entries: SccEntry[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Scenarist_SCC')) {
      continue;
    }

    const match = trimmed.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})\s+(.+)$/);
    if (!match) {
      continue;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const frames = Number(match[4]);
    if (minutes > 59 || seconds > 59 || frames > 29) {
      continue;
    }

    const bytes = (match[5]!.match(/[0-9a-fA-F]{4}/g) ?? []).flatMap((word) => {
      const value = Number.parseInt(word, 16);
      return [(value >> 8) & 0xff, value & 0xff];
    });

    if (bytes.length > 0) {
      entries.push({
        time: hours * 3600 + minutes * 60 + seconds + frames / 30,
        bytes,
      });
    }
  }

  return entries;
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
  const charCodes: number[] = [];
  const firstCode = a >= 0x19 ? a - 8 : a;

  if (firstCode >= 0x11 && firstCode <= 0x13) {
    const extendedCode = firstCode === 0x11 ? b + 0x50 : firstCode === 0x12 ? b + 0x70 : b + 0x90;
    charCodes.push(extendedCode);
  } else if (a >= 0x20 && a <= 0x7f) {
    charCodes.push(a);
    if (b >= 0x20 && b <= 0x7f) {
      charCodes.push(b);
    }
  }

  return charCodes.map((code) => String.fromCharCode(CEA608_SPECIAL_CHARS[code] ?? code)).join('');
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
};

function normalizeCueText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
}

function escapeCueText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
