/*
 * Copyright 2026 ByOmakase, LLC (https://byomakase.org)
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {OmpError} from '../types';
import {type Mp4Box as Box, readMp4Boxes as boxes} from './dash-mp4-box';

export interface DashTextMp4Track {
  id: number;
  timescale: number;
  codec: 'wvtt' | 'stpp';
  duration: number;
  size: number;
}

export interface DashTextSample {
  time: number;
  duration: number;
  data: Uint8Array;
}

function fail(message: string): never {
  throw new OmpError(`DASH text MP4: ${message}`);
}

function uint64(view: DataView, offset: number): number {
  const value = view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4);
  if (!Number.isSafeInteger(value)) fail('unsafe 64-bit value');
  return value;
}

function child(data: Uint8Array, parent: Box, type: string): Box {
  const found = boxes(data, parent.payload, parent.end).filter((box) => box.type === type);
  if (found.length !== 1) return fail(`expected one ${type} box`);
  return found[0]!;
}

function need(box: Box, offset: number, length: number): void {
  if (offset < box.payload || offset + length > box.end) fail(`truncated ${box.type}`);
}

export function parseDashTextInitialization(data: Uint8Array, codec: 'wvtt' | 'stpp'): DashTextMp4Track {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const moov = boxes(data).find((box) => box.type === 'moov');
  if (!moov) return fail('missing moov');
  const tracks: DashTextMp4Track[] = [];
  for (const trak of boxes(data, moov.payload, moov.end).filter((box) => box.type === 'trak')) {
    const mdia = child(data, trak, 'mdia');
    const stsd = child(data, child(data, child(data, mdia, 'minf'), 'stbl'), 'stsd');
    need(stsd, stsd.payload, 8);
    const entries = boxes(data, stsd.payload + 8, stsd.end);
    if (!entries.some((entry) => entry.type === codec)) continue;
    if (entries.length !== 1) fail('multiple sample descriptions are not supported');
    if (boxes(data, trak.payload, trak.end).some((box) => box.type === 'edts')) fail('subtitle edit lists are not supported');
    const tkhd = child(data, trak, 'tkhd');
    const mdhd = child(data, mdia, 'mdhd');
    const tkVersion = view.getUint8(tkhd.payload);
    const mdVersion = view.getUint8(mdhd.payload);
    if (tkVersion > 1 || mdVersion > 1) fail('unsupported track timing version');
    const idOffset = tkhd.payload + (tkVersion === 1 ? 20 : 12);
    const scaleOffset = mdhd.payload + (mdVersion === 1 ? 20 : 12);
    need(tkhd, idOffset, 4);
    need(mdhd, scaleOffset, 4);
    const id = view.getUint32(idOffset);
    const timescale = view.getUint32(scaleOffset);
    if (!id || !timescale) fail('invalid track id or timescale');
    tracks.push({id, timescale, codec, duration: 0, size: 0});
  }
  if (tracks.length !== 1) return fail('expected one matching subtitle track');
  const track = tracks[0]!;
  const mvex = boxes(data, moov.payload, moov.end).find((box) => box.type === 'mvex');
  if (mvex) {
    for (const trex of boxes(data, mvex.payload, mvex.end).filter((box) => box.type === 'trex')) {
      need(trex, trex.payload, 24);
      if (view.getUint32(trex.payload + 4) === track.id) {
        track.duration = view.getUint32(trex.payload + 12);
        track.size = view.getUint32(trex.payload + 16);
      }
    }
  }
  return track;
}

export function parseDashTextSamples(data: Uint8Array, track: DashTextMp4Track, absoluteOffset = 0): DashTextSample[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const top = boxes(data);
  const mdats = top.filter((box) => box.type === 'mdat');
  const samples: DashTextSample[] = [];
  for (const moof of top.filter((box) => box.type === 'moof')) {
    for (const traf of boxes(data, moof.payload, moof.end).filter((box) => box.type === 'traf')) {
      const tfhd = child(data, traf, 'tfhd');
      need(tfhd, tfhd.payload, 8);
      if (view.getUint32(tfhd.payload + 4) !== track.id) continue;
      if (boxes(data, traf.payload, traf.end).some((box) => box.type === 'senc' || box.type === 'saiz')) fail('encrypted text is not supported');
      const flags = view.getUint32(tfhd.payload) & 0xffffff;
      let cursor = tfhd.payload + 8;
      let base = moof.start;
      if (flags & 1) {
        need(tfhd, cursor, 8);
        base = uint64(view, cursor) - absoluteOffset;
        cursor += 8;
      } else if (!(flags & 0x020000) && boxes(data, moof.payload, moof.end).filter((box) => box.type === 'traf').length > 1) {
        fail('ambiguous implicit data offset');
      }
      if (flags & 2) {
        need(tfhd, cursor, 4);
        if (view.getUint32(cursor) !== 1) fail('unsupported sample description index');
        cursor += 4;
      }
      let defaultDuration = track.duration;
      let defaultSize = track.size;
      if (flags & 8) {
        need(tfhd, cursor, 4);
        defaultDuration = view.getUint32(cursor);
        cursor += 4;
      }
      if (flags & 16) {
        need(tfhd, cursor, 4);
        defaultSize = view.getUint32(cursor);
        cursor += 4;
      }
      if (flags & 32) {
        need(tfhd, cursor, 4);
        cursor += 4;
      }
      const tfdt = child(data, traf, 'tfdt');
      need(tfdt, tfdt.payload, 8);
      const version = view.getUint8(tfdt.payload);
      if (version > 1) fail('unsupported tfdt version');
      need(tfdt, tfdt.payload + 4, version === 1 ? 8 : 4);
      let decode = version === 1 ? uint64(view, tfdt.payload + 4) : view.getUint32(tfdt.payload + 4);
      let dataOffset: number | undefined;
      for (const trun of boxes(data, traf.payload, traf.end).filter((box) => box.type === 'trun')) {
        need(trun, trun.payload, 8);
        const trunFlags = view.getUint32(trun.payload) & 0xffffff;
        const trunVersion = view.getUint8(trun.payload);
        if (trunVersion > 1) fail('unsupported trun version');
        const count = view.getUint32(trun.payload + 4);
        if (count > 100000 || samples.length + count > 100000) fail('too many text samples');
        cursor = trun.payload + 8;
        if (trunFlags & 1) {
          need(trun, cursor, 4);
          dataOffset = base + view.getInt32(cursor);
          cursor += 4;
        }
        if (trunFlags & 4) {
          need(trun, cursor, 4);
          cursor += 4;
        }
        if (dataOffset === undefined) return fail('text trun requires a data offset');
        for (let i = 0; i < count; i++) {
          let duration = defaultDuration;
          let size = defaultSize;
          let composition = 0;
          if (trunFlags & 256) {
            need(trun, cursor, 4);
            duration = view.getUint32(cursor);
            cursor += 4;
          }
          if (trunFlags & 512) {
            need(trun, cursor, 4);
            size = view.getUint32(cursor);
            cursor += 4;
          }
          if (trunFlags & 1024) {
            need(trun, cursor, 4);
            cursor += 4;
          }
          if (trunFlags & 2048) {
            need(trun, cursor, 4);
            composition = trunVersion === 1 ? view.getInt32(cursor) : view.getUint32(cursor);
            cursor += 4;
          }
          if (!duration || !size || !mdats.some((mdat) => dataOffset! >= mdat.payload && dataOffset! + size <= mdat.end)) fail('invalid text sample size, duration or offset');
          samples.push({time: (decode + composition) / track.timescale, duration: duration / track.timescale, data: data.subarray(dataOffset, dataOffset + size)});
          dataOffset += size;
          decode += duration;
          if (!Number.isSafeInteger(decode)) fail('unsafe decode timestamp');
        }
      }
    }
  }
  if (!samples.length) return fail('no subtitle samples');
  return samples;
}

export function parseDashWvttSample(sample: DashTextSample): {text: string; settings: string; id: string}[] {
  return boxes(sample.data).flatMap((box) => {
    if (box.type === 'vtte') return [];
    if (box.type !== 'vttc') return fail(`unsupported WebVTT sample box ${box.type}`);
    const fields = boxes(sample.data, box.payload, box.end);
    const value = (type: string) => {
      const field = fields.find((item) => item.type === type);
      return field ? new TextDecoder('utf-8', {fatal: true}).decode(sample.data.subarray(field.payload, field.end)) : '';
    };
    if (!fields.some((field) => field.type === 'payl')) return fail('WebVTT cue is missing payl');
    return [{text: value('payl'), settings: value('sttg'), id: value('iden')}];
  });
}
