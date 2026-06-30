/**
 * yin.worklet.js - monophonic pitch detector for live vocal capture.
 *
 * Runs the YIN algorithm (de Cheveigne & Kawahara, 2002) on a rolling analysis
 * window and streams one frame per hop back to the main thread over the port:
 *   { type: 'f0', tSec, hz, clarity, rms }
 * hz is 0 when unvoiced/unclear; clarity is 1 - d'(tau) (0..1); rms is the window
 * level. Per-frame pitch cannot ride AudioParams (k-rate), so it goes over the
 * port like the granular-morph worklet's position messages.
 *
 * Input is the mic stream; output is silence (the node is connected through a
 * zero gain only so the graph keeps pulling it). Capture-relative time is derived
 * on the main thread by subtracting the AudioContext time captured at start.
 */

const MIN_HZ = 70; // lowest pitch tracked (covers most sung registers)
const MAX_HZ = 1000; // highest pitch tracked
const WINDOW = 2048; // analysis window in samples
const HOP = 1024; // run YIN every HOP samples (~21ms @ 48k)
const THRESHOLD = 0.15; // YIN absolute threshold

class YinDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(WINDOW);
    this.filled = 0; // samples written into buf since last analysis
    this.minTau = Math.max(2, Math.floor(sampleRate / MAX_HZ));
    this.maxTau = Math.min(Math.floor(sampleRate / MIN_HZ), Math.floor(WINDOW / 2));
    this.d = new Float32Array(this.maxTau + 1);
    this.dp = new Float32Array(this.maxTau + 1);
  }

  // Shift the window left by `n` and append the newest `n` samples.
  push(chunk) {
    const n = chunk.length;
    if (n >= WINDOW) {
      this.buf.set(chunk.subarray(n - WINDOW));
    } else {
      this.buf.copyWithin(0, n);
      this.buf.set(chunk, WINDOW - n);
    }
  }

  analyze() {
    const buf = this.buf;
    const maxTau = this.maxTau;
    const integ = WINDOW - maxTau; // integration length keeps indices valid
    let rms = 0;
    for (let j = 0; j < WINDOW; j++) rms += buf[j] * buf[j];
    rms = Math.sqrt(rms / WINDOW);

    const d = this.d;
    d[0] = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      for (let j = 0; j < integ; j++) {
        const diff = buf[j] - buf[j + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }

    const dp = this.dp;
    dp[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      running += d[tau];
      dp[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }

    // First dip below threshold, then descend to its local minimum.
    let tau = -1;
    for (let t = this.minTau; t <= maxTau; t++) {
      if (dp[t] < THRESHOLD) {
        while (t + 1 <= maxTau && dp[t + 1] < dp[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau === -1) return { hz: 0, clarity: 0, rms }; // unvoiced/no clear pitch

    // Parabolic interpolation around the chosen tau for sub-sample precision.
    const x0 = tau > this.minTau ? dp[tau - 1] : dp[tau];
    const x2 = tau + 1 <= maxTau ? dp[tau + 1] : dp[tau];
    const denom = x0 + x2 - 2 * dp[tau];
    const betterTau = denom !== 0 ? tau + (x0 - x2) / (2 * denom) : tau;

    const hz = betterTau > 0 ? sampleRate / betterTau : 0;
    const clarity = Math.max(0, Math.min(1, 1 - dp[tau]));
    if (hz < MIN_HZ || hz > MAX_HZ) return { hz: 0, clarity, rms };
    return { hz, clarity, rms };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const ch = input && input[0] ? input[0] : null;
    const output = outputs[0];
    if (output) for (let c = 0; c < output.length; c++) output[c].fill(0);
    if (!ch) return true;

    this.push(ch);
    this.filled += ch.length;
    if (this.filled >= HOP) {
      this.filled = 0;
      const { hz, clarity, rms } = this.analyze();
      this.port.postMessage({ type: 'f0', tSec: currentTime, hz, clarity, rms });
    }
    return true;
  }
}

registerProcessor('yin-detector', YinDetector);
