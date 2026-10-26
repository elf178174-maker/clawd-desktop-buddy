// AudioWorklet that batches microphone samples (already at the context's 16 kHz rate) into 100 ms
// frames and hands them to the main thread.

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: unknown): void

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(1600)
  private n = 0

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(1600)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('clawd-capture', CaptureProcessor)
export const SAMPLE_RATE_CHECK = typeof sampleRate
