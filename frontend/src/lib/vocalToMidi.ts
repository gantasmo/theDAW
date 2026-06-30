/**
 * vocalToMidi.ts - monophonic vocal pitch capture spine.
 *
 * Drives the /yin.worklet.js detector on a live mic stream, accumulates its
 * per-frame f0 estimates, and segments them into ms-timed notes that match the
 * backend VocalArtifact Note shape (start_ms / end_ms / pitch / velocity). The
 * offline complement lives server-side (backend basic-pitch in
 * backend/modules/vocal/preprocess/notes.py); this is the live path.
 *
 * Reuse boundaries: RenderNote and PianoNote are imported, never redeclared, so
 * a capture flows straight into the soundfont render path (renderNotesToBlob) and
 * the Piano Roll (importNotes) without an adapter elsewhere.
 */

import { getEngineCtx } from '../state/playerStore';
import type { PianoNote } from '../state/pianoRollStore';
import type { RenderNote } from './midiSynth';

export interface F0Frame {
  tSec: number; // capture-relative seconds
  hz: number; // 0 when unvoiced
  clarity: number; // 0..1 (YIN clarity)
  rms: number; // window level
}

export interface CaptureNote {
  startMs: number;
  endMs: number;
  pitch: number; // MIDI 0..127
  velocity: number; // 1..127
}

export interface VocalCapture {
  notes: CaptureNote[];
  frames: F0Frame[];
  durationMs: number;
}

export interface CaptureOptions {
  clarityMin?: number; // reject frames below this YIN clarity (default 0.5)
  rmsGateRel?: number; // reject frames below peakRms * this (default 0.08)
  minNoteMs?: number; // drop notes shorter than this (default 80)
  maxGapMs?: number; // bridge same-pitch frames separated by <= this (default 60)
  smoothWindow?: number; // median window in frames for pitch (default 5, odd)
  pitchHysteresis?: number; // semitones a sustained change must exceed (default 0.6)
}

export const frequencyToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

// ── worklet registration (per-context, mirrors ensureChopModule) ──────────────
const yinModuleByCtx = new WeakMap<BaseAudioContext, Promise<void>>();
export const ensureYinModule = (ctx: BaseAudioContext): Promise<void> => {
  let p = yinModuleByCtx.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule('/yin.worklet.js').catch((e) => {
      yinModuleByCtx.delete(ctx);
      throw e;
    });
    yinModuleByCtx.set(ctx, p);
  }
  return p;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Segment a frame stream into notes. Voiced frames (clear + above the RMS gate)
 * are mapped to MIDI, median-smoothed to kill jitter/octave flickers, then run-
 * length grouped by rounded pitch with gap bridging, a hysteresis guard on pitch
 * changes, and a minimum-duration floor.
 */
export const framesToNotes = (
  frames: F0Frame[],
  opts: CaptureOptions = {},
): CaptureNote[] => {
  const clarityMin = opts.clarityMin ?? 0.5;
  const rmsGateRel = opts.rmsGateRel ?? 0.08;
  const minNoteMs = opts.minNoteMs ?? 80;
  const maxGapMs = opts.maxGapMs ?? 60;
  const win = Math.max(1, (opts.smoothWindow ?? 5) | 1); // force odd
  const hyst = opts.pitchHysteresis ?? 0.6;

  const peakRms = frames.reduce((m, f) => Math.max(m, f.rms), 0);
  const gate = peakRms * rmsGateRel;

  // Voiced frames carry a continuous MIDI pitch; unvoiced become null markers so
  // gaps remain visible to the run-length pass.
  type V = { tMs: number; midi: number | null; rms: number };
  const voiced: V[] = frames.map((f) => {
    const ok = f.hz > 0 && f.clarity >= clarityMin && f.rms >= gate;
    return { tMs: f.tSec * 1000, midi: ok ? frequencyToMidi(f.hz) : null, rms: f.rms };
  });

  // Median-smooth pitch over a sliding window (ignoring unvoiced neighbours).
  const half = win >> 1;
  const smooth: V[] = voiced.map((v, i) => {
    if (v.midi === null) return v;
    const around: number[] = [];
    for (let k = i - half; k <= i + half; k++) {
      const m = voiced[k]?.midi;
      if (m !== null && m !== undefined) around.push(m);
    }
    return { ...v, midi: median(around) };
  });

  const notes: CaptureNote[] = [];
  let cur: { startMs: number; endMs: number; pitches: number[]; rmss: number[] } | null = null;
  const flush = () => {
    if (!cur) return;
    if (cur.endMs - cur.startMs >= minNoteMs && cur.pitches.length) {
      const pitch = Math.round(median(cur.pitches));
      const meanRms = cur.rmss.reduce((a, b) => a + b, 0) / cur.rmss.length;
      const velocity = Math.max(1, Math.min(127, Math.round(40 + meanRms * 600)));
      notes.push({
        startMs: Math.round(cur.startMs),
        endMs: Math.round(cur.endMs),
        pitch: Math.max(0, Math.min(127, pitch)),
        velocity,
      });
    }
    cur = null;
  };

  for (const v of smooth) {
    if (v.midi === null) {
      // Unvoiced: only break the note if the silence outlasts maxGapMs.
      if (cur && v.tMs - cur.endMs > maxGapMs) flush();
      continue;
    }
    if (!cur) {
      cur = { startMs: v.tMs, endMs: v.tMs, pitches: [v.midi], rmss: [v.rms] };
      continue;
    }
    const refPitch = median(cur.pitches);
    if (Math.abs(v.midi - refPitch) > hyst && Math.round(v.midi) !== Math.round(refPitch)) {
      flush();
      cur = { startMs: v.tMs, endMs: v.tMs, pitches: [v.midi], rmss: [v.rms] };
    } else {
      cur.endMs = v.tMs;
      cur.pitches.push(v.midi);
      cur.rmss.push(v.rms);
    }
  }
  flush();
  return notes;
};

export interface VocalCaptureController {
  stream: MediaStream;
  /** Current mic RMS level, 0..1, for a live meter (independent of YIN). */
  getLevel: () => number;
  /** Number of f0 frames received so far (proof the worklet is running). */
  frameCount: () => number;
  /** Finalize: stop the graph + mic, return the segmented capture. */
  stop: (opts?: CaptureOptions) => VocalCapture;
}

/** Available microphone inputs. Labels are blank until mic permission is granted
 * once, so call this after a successful capture (or permission prompt). */
export const listAudioInputs = async (): Promise<MediaDeviceInfo[]> => {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
};

export interface InputMonitor {
  stream: MediaStream;
  /** Current mic RMS level, 0..1. */
  getLevel: () => number;
  stop: () => void;
}

/**
 * Open a lightweight always-on input monitor: just the mic + an analyser for the
 * level meter, no pitch detection. Used so the level is observable before/without
 * recording. AGC / noise-suppression / echo-cancellation stay OFF to match the
 * capture path. Call stop() to release the mic.
 */
export const startInputMonitor = async (deviceId?: string): Promise<InputMonitor> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = getEngineCtx();
  // Best-effort resume; on mount there may be no user gesture yet, so don't block.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const getLevel = (): number => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(sum / buf.length) * 3);
  };
  const stop = (): void => {
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      /* already torn down */
    }
    for (const t of stream.getTracks()) t.stop();
  };
  return { stream, getLevel, stop };
};

/** Current microphone permission state, or 'unknown' where the API is absent. */
export const queryMicPermission = async (): Promise<PermissionState | 'unknown'> => {
  try {
    const p = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return p.state;
  } catch {
    return 'unknown';
  }
};

/**
 * Begin live capture. Requests the mic with AGC / noise-suppression / echo-
 * cancellation OFF (all three distort f0), taps it into the shared engine
 * context, and runs the YIN worklet. Pass a deviceId to pick a specific input.
 * Call stop() to finalize.
 */
export const startVocalCapture = async (
  deviceId?: string,
): Promise<VocalCaptureController> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  await ensureYinModule(ctx);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'yin-detector', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
  });
  // Pull the node through a muted sink so process() keeps running without
  // routing the mic to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;

  // A second tap drives the live level meter, independent of YIN so it responds
  // even on unvoiced/breath input. An analyser needs no onward connection to run.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const levelBuf = new Float32Array(analyser.fftSize);
  const getLevel = (): number => {
    analyser.getFloatTimeDomainData(levelBuf);
    let sum = 0;
    for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
    return Math.min(1, Math.sqrt(sum / levelBuf.length) * 3);
  };

  const frames: F0Frame[] = [];
  const startTime = ctx.currentTime;
  node.port.onmessage = (e: MessageEvent) => {
    const d = e.data;
    if (d?.type === 'f0') {
      frames.push({
        tSec: Math.max(0, d.tSec - startTime),
        hz: d.hz,
        clarity: d.clarity,
        rms: d.rms,
      });
    }
  };

  source.connect(node);
  source.connect(analyser);
  node.connect(sink);
  sink.connect(ctx.destination);

  const stop = (opts?: CaptureOptions): VocalCapture => {
    try {
      node.port.onmessage = null;
      source.disconnect();
      analyser.disconnect();
      node.disconnect();
      sink.disconnect();
    } catch {
      /* already torn down */
    }
    for (const t of stream.getTracks()) t.stop();
    const durationMs = frames.length ? frames[frames.length - 1].tSec * 1000 : 0;
    return { notes: framesToNotes(frames, opts), frames, durationMs };
  };

  return { stream, getLevel, frameCount: () => frames.length, stop };
};

// ── converters to the shared note models ──────────────────────────────────────

export const captureNotesToRenderNotes = (notes: CaptureNote[]): RenderNote[] =>
  notes.map((n) => ({
    midi: n.pitch,
    startSec: n.startMs / 1000,
    durationSec: Math.max(0.02, (n.endMs - n.startMs) / 1000),
    velocity: n.velocity,
  }));

const stepSec = (bpm: number): number => 60 / bpm / 4; // one 16th note

export const captureNotesToPianoNotes = (
  notes: CaptureNote[],
  bpm: number,
): PianoNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n, i) => ({
    id: `vox-${i}-${n.startMs}`,
    note: n.pitch,
    step: Math.max(0, Math.round(n.startMs / 1000 / ss)),
    length: Math.max(1, Math.round((n.endMs - n.startMs) / 1000 / ss)),
    velocity: n.velocity,
  }));
};
