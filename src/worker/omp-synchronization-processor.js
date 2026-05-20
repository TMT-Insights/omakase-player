class r extends AudioWorkletProcessor {
  constructor() {
    super(...arguments), this.processCount = 0;
  }
  process(o, e, t) {
    return this.processCount % 32 === 0 && this.port.postMessage(""), this.processCount += 1, !0;
  }
}
try {
  registerProcessor("omp-synchronization-processor", r);
} catch {
  console.info("Failed to register omp-synchronization-processor. This probably means it was already registered.");
}
