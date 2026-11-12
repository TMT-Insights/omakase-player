export function createSidx({
  version = 0,
  timescale = 1000,
  earliestTime = 0,
  firstOffset = 0,
  references = [
    {size: 100, duration: 2000},
    {size: 200, duration: 2000},
    {size: 300, duration: 2000},
  ],
}: {
  version?: number;
  timescale?: number;
  earliestTime?: number;
  firstOffset?: number;
  references?: {size: number; duration: number; hierarchical?: boolean}[];
} = {}): ArrayBuffer {
  const buffer = new ArrayBuffer((version === 1 ? 40 : 32) + references.length * 12);
  const view = new DataView(buffer);
  view.setUint32(0, buffer.byteLength);
  new Uint8Array(buffer, 4, 4).set([0x73, 0x69, 0x64, 0x78]);
  view.setUint8(8, version);
  view.setUint32(12, 1);
  view.setUint32(16, timescale);
  let position = 20;
  for (const value of [earliestTime, firstOffset]) {
    if (version === 1) {
      view.setUint32(position, Math.floor(value / 2 ** 32));
      position += 4;
    }
    view.setUint32(position, value % 2 ** 32);
    position += 4;
  }
  view.setUint16(position + 2, references.length);
  position += 4;
  for (const reference of references) {
    view.setUint32(position, reference.size + (reference.hierarchical ? 2 ** 31 : 0));
    view.setUint32(position + 4, reference.duration);
    view.setUint32(position + 8, 0x90000000);
    position += 12;
  }
  return buffer;
}
