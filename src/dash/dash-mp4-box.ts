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

/** An ISO BMFF box located within a buffer; offsets are relative to the buffer start. */
export interface Mp4Box {
  type: string;
  start: number;
  /** Offset of the first byte after the header. */
  payload: number;
  end: number;
}

export interface Mp4BoxHeader {
  type: string;
  /** Declared size including the header; `0` means the box extends to the end of its container. */
  size: number;
  headerSize: number;
}

function fail(message: string): never {
  throw new OmpError(`DASH: ${message}`);
}

/** Reads the box header at `offset`, including 64-bit sizes; does not check the box fits in `view`. */
export function parseMp4BoxHeader(view: DataView, offset: number): Mp4BoxHeader {
  if (offset + 8 > view.byteLength) fail('truncated MP4 box header');
  const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
  const size = view.getUint32(offset);
  if (size !== 1) {
    return {type, size, headerSize: 8};
  }
  if (offset + 16 > view.byteLength) fail('truncated MP4 box header');
  const largeSize = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
  if (!Number.isSafeInteger(largeSize)) fail('unsafe 64-bit MP4 box size');
  return {type, size: largeSize, headerSize: 16};
}

/** The consecutive boxes filling `data[start, end)`, which must contain only whole boxes. */
export function readMp4Boxes(data: Uint8Array, start = 0, end = data.byteLength): Mp4Box[] {
  const view = new DataView(data.buffer, data.byteOffset, end);
  const boxes: Mp4Box[] = [];
  while (start < end) {
    const header = parseMp4BoxHeader(view, start);
    const size = header.size || end - start;
    if (size < header.headerSize || start + size > end) fail('truncated or invalid MP4 box');
    boxes.push({type: header.type, start, payload: start + header.headerSize, end: start + size});
    start += size;
  }
  return boxes;
}
