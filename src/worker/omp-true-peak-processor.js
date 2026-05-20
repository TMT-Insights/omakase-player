function m(o, r) {
  const s = [], i = 1 / (4 * r), t = 1 - Math.ceil(o / 2), l = Math.floor(o / 2);
  for (let e = t; e <= l; e++) {
    const n = 0.54 + 0.46 * Math.cos(2 * Math.PI * e / o);
    let a = 0;
    e == 0 ? a = 2 * i : a = Math.sin(2 * Math.PI * i * e) / (Math.PI * e), a = n * a * r, s.push(a);
  }
  return s;
}
function g(o, r, s) {
  const i = [];
  for (let t = 0; t < s; t += 1) {
    let l = 0, e = 0;
    for (let n = t; n < r.length; n += s)
      e += r[n] * o[o.length - 1 - l], l += 1;
    i.push(e);
  }
  return i;
}
function M(o, r, s, i) {
  return o.map((t, l) => {
    const e = r[l];
    let n = 0;
    for (let a = 0; a < t.length; a++) {
      const u = t[a];
      e.push(u), e.shift();
      const h = g(e, s, i);
      for (let f = 0; f < h.length; f++) {
        const p = Math.abs(h[f]);
        p > n && (n = p);
      }
    }
    return n;
  });
}
class P extends AudioWorkletProcessor {
  constructor() {
    super(), this.numCoefficients = 33, this.sampleRate = sampleRate, this.upsampleFactor = this.sampleRate > 8e4 ? 2 : 4, this.lpfCoefficients = m(this.numCoefficients, this.upsampleFactor), this.lpfBuffers = [], this.port.postMessage({ type: "message", message: `true peak inited? ${this.sampleRate}` }), this.processCount = 0;
  }
  process(r) {
    const s = r[0];
    if (s.length > this.lpfBuffers.length)
      for (let t = 1; t <= s.length; t += 1)
        t > this.lpfBuffers.length && this.lpfBuffers.push(new Array(this.numCoefficients).fill(0));
    const i = M(s, this.lpfBuffers, this.lpfCoefficients, this.upsampleFactor);
    return this.port.postMessage({ type: "peaks", peaks: i }), this.processCount += 1, !0;
  }
}
const c = "omp-true-peak-processor";
try {
  registerProcessor(c, P);
} catch {
  console.info(`Failed to register ${c}. This probably means it was already registered.`);
}
