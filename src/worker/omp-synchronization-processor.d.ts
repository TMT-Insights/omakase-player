declare class OmpSynchronizationProcessor extends AudioWorkletProcessor {
    private processCount;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
