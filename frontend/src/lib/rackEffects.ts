/**
 * rackEffects — a real-time Web Audio insert-effect engine for the EDIT timeline.
 *
 * Each effect is a context-agnostic factory: given a BaseAudioContext (the live
 * engine ctx OR an OfflineAudioContext at export time) and a params object, it
 * builds a single-input / single-output node subgraph plus a live `setParams`.
 * Because the factory takes any BaseAudioContext, the SAME graph powers live
 * preview (liveMixer) and the offline bounce (commitEdit) with no duplication.
 *
 * `buildEffectChain` wires a list of ChainEntry's in series between a caller-owned
 * `input` and `output` node, rebuilds on add/remove/reorder/toggle, and pushes
 * live param moves into the running nodes without a rebuild.
 *
 * The processors are genuinely psychoacoustic (crossfeed, missing-fundamental
 * bass, true M/S widening, aural excitation, HRTF spatialization, equal-loudness
 * contour) rather than thin wrappers over a single filter.
 */

import { distCurve } from './synthVoiceKit';
import type { ChainEntry } from '../state/effectChainStore';

/** One scheduled spatial jump: position (x,y,z) to hold from absolute ctx time `when`. */
export interface TeleportEvent {
  when: number;
  x: number;
  y: number;
  z: number;
}

export interface RackEffectInstance {
  /** Feed signal in here. */
  input: AudioNode;
  /** Processed signal leaves here. */
  output: AudioNode;
  /** Push new parameter values onto the live nodes (click-free where possible). */
  setParams: (p: Record<string, number>) => void;
  /** Spatializer only: drive panner position from a transport-synced schedule
   *  (Teleport motion). `when` values are absolute AudioContext times. */
  scheduleTeleport?: (events: TeleportEvent[]) => void;
  /** Stop oscillators / release nodes. */
  dispose: () => void;
}

export type RackEffectFactory = (
  ctx: BaseAudioContext,
  params: Record<string, number>,
) => RackEffectInstance;

export interface RackParamDescriptor {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export interface RackEffectDef {
  id: string;
  label: string;
  group: string;
  description: string;
  params: RackParamDescriptor[];
  make: RackEffectFactory;
}

/* ── small helpers ─────────────────────────────────────────────────────────── */

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Smoothly set an AudioParam toward a target (click-free for live moves). */
const ramp = (p: AudioParam, v: number, ctx: BaseAudioContext) => {
  // OfflineAudioContext also exposes currentTime (0 at build); setTargetAtTime is fine.
  p.setTargetAtTime(v, ctx.currentTime, 0.02);
};

/** dB to linear gain. */
const dbToGain = (db: number) => Math.pow(10, db / 20);

/* ── 1. Headphone Crossfeed (Bauer / BS2B) ─────────────────────────────────────
   Each channel sends a short-delayed, low-passed copy to the opposite channel.
   On headphones this relieves the unnatural hard-panned "in-head" image by
   approximating the inter-aural crosstalk you'd get from speakers. */
const makeCrossfeed: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  input.connect(splitter);

  // Direct (same-channel) path stays full level.
  const directL = ctx.createGain();
  const directR = ctx.createGain();
  splitter.connect(directL, 0);
  splitter.connect(directR, 1);
  directL.connect(merger, 0, 0);
  directR.connect(merger, 0, 1);

  // Cross path: delayed + low-passed copy into the opposite channel.
  // Initial values mirror setParams exactly so the make-time state (used as-is
  // in the offline bounce) matches the live state after any param move.
  const amt0 = clamp(params.amount ?? 0.5, 0, 1) * 0.6;
  const cut0 = clamp(params.cutFreq ?? 700, 200, 2000);
  const mkCross = (fromCh: number, toCh: number) => {
    const delay = ctx.createDelay(0.01);
    delay.delayTime.value = 0.0003; // ~300 us inter-aural delay
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cut0;
    const g = ctx.createGain();
    g.gain.value = amt0;
    splitter.connect(delay, fromCh);
    delay.connect(lp);
    lp.connect(g);
    g.connect(merger, 0, toCh);
    return { lp, g };
  };
  const lr = mkCross(0, 1);
  const rl = mkCross(1, 0);
  merger.connect(output);

  return {
    input,
    output,
    setParams: (p) => {
      const amt = clamp(p.amount ?? 0.5, 0, 1) * 0.6; // cap so it never overwhelms the direct path
      const cut = clamp(p.cutFreq ?? 700, 200, 2000);
      ramp(lr.g.gain, amt, ctx);
      ramp(rl.g.gain, amt, ctx);
      lr.lp.frequency.setValueAtTime(cut, ctx.currentTime);
      rl.lp.frequency.setValueAtTime(cut, ctx.currentTime);
    },
    dispose: () => {
      try { input.disconnect(); output.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── 2. Phantom Bass (missing-fundamental / residue pitch) ──────────────────────
   Isolate the sub band, synthesize its integer harmonics with a waveshaper, then
   high-pass those harmonics back above the crossover. The ear's residue-pitch
   mechanism reconstructs the (possibly unreproducible) fundamental, so the low
   end reads as deeper on small drivers without adding real sub energy. */
const makePhantomBass: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const dry = ctx.createGain();
  dry.gain.value = 1;
  input.connect(dry).connect(output);

  const subLP = ctx.createBiquadFilter();
  subLP.type = 'lowpass';
  subLP.frequency.value = params.crossover ?? 90;
  subLP.Q.value = 0.7;
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(Math.round(params.drive ?? 6));
  shaper.oversample = '2x';
  const postHP = ctx.createBiquadFilter();
  postHP.type = 'highpass';
  postHP.frequency.value = params.crossover ?? 90;
  const wet = ctx.createGain();
  wet.gain.value = params.blend ?? 0.6;

  input.connect(subLP);
  subLP.connect(shaper);
  shaper.connect(postHP);
  postHP.connect(wet);
  wet.connect(output);

  return {
    input,
    output,
    setParams: (p) => {
      const xover = clamp(p.crossover ?? 90, 50, 160);
      shaper.curve = distCurve(clamp(Math.round(p.drive ?? 6), 1, 40));
      subLP.frequency.setValueAtTime(xover, ctx.currentTime);
      postHP.frequency.setValueAtTime(xover, ctx.currentTime);
      ramp(wet.gain, clamp(p.blend ?? 0.6, 0, 1.5), ctx);
    },
    dispose: () => {
      try { input.disconnect(); output.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── 3. Stereo Widener (true mid/side) ─────────────────────────────────────────
   Decode M = (L+R)/2 and S = (L-R)/2, scale the side, recombine. Unlike a Haas
   delay this stays mono-compatible. An optional high-pass on the side keeps the
   low end mono (bass stays centered and powerful while the top widens). */
const makeStereoWidener: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const splitter = ctx.createChannelSplitter(2);
  input.connect(splitter);

  // Mid = 0.5L + 0.5R
  const mid = ctx.createGain();
  const lMid = ctx.createGain(); lMid.gain.value = 0.5;
  const rMid = ctx.createGain(); rMid.gain.value = 0.5;
  splitter.connect(lMid, 0); lMid.connect(mid);
  splitter.connect(rMid, 1); rMid.connect(mid);

  // Side = 0.5L - 0.5R
  const side = ctx.createGain();
  const lSide = ctx.createGain(); lSide.gain.value = 0.5;
  const rSide = ctx.createGain(); rSide.gain.value = -0.5;
  splitter.connect(lSide, 0); lSide.connect(side);
  splitter.connect(rSide, 1); rSide.connect(side);

  // Bass-mono: high-pass the side so lows fold to center.
  const sideHP = ctx.createBiquadFilter();
  sideHP.type = 'highpass';
  sideHP.frequency.value = params.bassMonoFreq ?? 120;
  side.connect(sideHP);

  // Width scaling.
  const sideW = ctx.createGain();
  sideW.gain.value = params.width ?? 1.4;
  sideHP.connect(sideW);
  const sideWneg = ctx.createGain();
  sideWneg.gain.value = -1;
  sideW.connect(sideWneg);

  // outL = mid + sideW ; outR = mid - sideW
  const outL = ctx.createGain();
  const outR = ctx.createGain();
  mid.connect(outL); sideW.connect(outL);
  mid.connect(outR); sideWneg.connect(outR);
  const merger = ctx.createChannelMerger(2);
  outL.connect(merger, 0, 0);
  outR.connect(merger, 0, 1);
  merger.connect(output);

  return {
    input,
    output,
    setParams: (p) => {
      ramp(sideW.gain, clamp(p.width ?? 1.4, 0, 2.5), ctx);
      sideHP.frequency.setValueAtTime(clamp(p.bassMonoFreq ?? 120, 20, 400), ctx.currentTime);
    },
    dispose: () => {
      try { input.disconnect(); output.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── 4. Aural Exciter ──────────────────────────────────────────────────────────
   High-pass a branch, generate harmonics with a waveshaper, blend that "air"
   back in. Restores perceived brightness/presence the ear reads as detail. */
const makeExciter: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output); // dry through

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = params.frequency ?? 3500;
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(Math.round(params.amount ?? 8));
  shaper.oversample = '4x';
  const wet = ctx.createGain();
  wet.gain.value = params.mix ?? 0.4;

  input.connect(hp);
  hp.connect(shaper);
  shaper.connect(wet);
  wet.connect(output);

  return {
    input,
    output,
    setParams: (p) => {
      hp.frequency.setValueAtTime(clamp(p.frequency ?? 3500, 1000, 9000), ctx.currentTime);
      shaper.curve = distCurve(clamp(Math.round(p.amount ?? 8), 1, 40));
      ramp(wet.gain, clamp(p.mix ?? 0.4, 0, 1), ctx);
    },
    dispose: () => {
      try { input.disconnect(); output.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── 5. HRTF Spatializer ───────────────────────────────────────────────────────
   A PannerNode in HRTF mode positions the track in 3D around the listener
   (azimuth / elevation / distance). A motion mode adds an audio-rate orbit /
   ping-pong / up-down / figure-8 on top of the base position; because the motion
   comes from oscillators it renders identically in the live preview and the
   offline bounce. The visual guide + presets live in SpatializerPad.tsx. */

/** Motion-mode labels, indexed by the numeric `motion` param. */
export const SPATIAL_MOTIONS = [
  'Static',
  'Orbit H CW',
  'Orbit H CCW',
  'Orbit Frontal',
  'Orbit Sagittal',
  'Spherical',
  'Ping-Pong',
  'Up / Down',
  'Figure-8',
  'Expand / Collapse',
  'Teleport',
  'Autopilot',
] as const;

/** Index of the data-driven Teleport mode: position is driven by a transport-
 *  synced schedule from onset analysis (see liveMixer), not by the LFOs. */
export const SPATIAL_TELEPORT = 10;

/** Index of Autopilot: an analyser taps the signal and a live rAF loop drives the
 *  motion, auto-cycling through the behaviours so the source is "played" by the
 *  music. Live only — the offline bounce falls back to a bake-correct Spherical. */
export const SPATIAL_AUTOPILOT = 11;

/** One-click spatial-motion presets (merged onto the effect's current params). */
export const SPATIAL_PRESETS: ReadonlyArray<{ label: string; values: Record<string, number> }> = [
  { label: 'Static Front', values: { motion: 0, azimuth: 0, elevation: 0, distance: 1.5 } },
  { label: 'Orbit CW', values: { motion: 1, motionRate: 0.3, motionDepth: 2 } },
  { label: 'Orbit CCW', values: { motion: 2, motionRate: 0.3, motionDepth: 2 } },
  { label: 'Frontal', values: { motion: 3, motionRate: 0.35, motionDepth: 2 } },
  { label: 'Sagittal', values: { motion: 4, motionRate: 0.35, motionDepth: 2 } },
  { label: 'Spherical', values: { motion: 5, motionRate: 0.3, motionDepth: 2.5 } },
  { label: 'Ping-Pong', values: { motion: 6, motionRate: 1, motionDepth: 2.5 } },
  { label: 'Up / Down', values: { motion: 7, motionRate: 0.5, motionDepth: 2 } },
  { label: 'Figure-8', values: { motion: 8, motionRate: 0.4, motionDepth: 2 } },
  { label: 'Expand/Collapse', values: { motion: 9, motionRate: 0.25, motionDepth: 3, distance: 2.5 } },
  { label: 'Teleport', values: { motion: 10, motionDepth: 5 } },
  { label: 'Autopilot', values: { motion: 11 } },
];

export const azElToXYZ = (azDeg: number, elDeg: number, dist: number) => {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return {
    x: dist * Math.cos(el) * Math.sin(az),
    y: dist * Math.sin(el),
    z: -dist * Math.cos(el) * Math.cos(az), // front of the listener is -z
  };
};

/** Map a sliced chunk to a teleport position. Azimuth is a golden-angle scatter
 *  (low-discrepancy, so successive chunks spread evenly around the head), scaled
 *  by `spread`; brightness lifts elevation (brighter = higher); loudness pulls the
 *  source in (louder = closer). Deterministic, so live + bounce land identically. */
export function teleportXYZ(
  index: number,
  loudness: number,
  brightness: number,
  spread: number,
): { x: number; y: number; z: number } {
  const reach = clamp(spread, 0, 8) / 8; // 0..1
  const az = (((index * 137.508) % 360) - 180) * reach; // golden-angle, scaled toward center at low spread
  const el = (-25 + clamp(brightness, 0, 1) * 70) * reach; // -25..+45 deg
  const dist = clamp(3.0 - clamp(loudness, 0, 1) * 1.6, 1.2, 6); // loud ~1.4 (present), quiet ~3.0 (back)
  return azElToXYZ(az, el, dist);
}

/** Per-axis LFO frequency + depth + cosine flag, for a motion mode. Pairing a
 *  sine axis with a cosine axis at the same rate traces a circle, so any plane
 *  (horizontal XZ, frontal XY, sagittal YZ) can be orbited; the radial
 *  Expand/Collapse mode drives all three axes in phase along the source direction
 *  so the image breathes toward and away from the listener (binaural in/out). */
const motionConfig = (p: Record<string, number>) => {
  const motion = Math.round(p.motion ?? 0);
  const rate = clamp(p.motionRate ?? 0.3, 0, 4);
  const depth = clamp(p.motionDepth ?? 1.5, 0, 8);
  let fx = rate, fy = rate, fz = rate;
  let dx = 0, dy = 0, dz = 0;
  let xCos = false, yCos = false, zCos = false;
  switch (motion) {
    case 1: dx = depth; dz = depth; zCos = true; break;              // orbit horizontal CW (XZ)
    case 2: dx = depth; dz = -depth; zCos = true; break;            // orbit horizontal CCW
    case 3: dx = depth; dy = depth; yCos = true; break;              // orbit frontal (XY wheel)
    case 4: dz = depth; dy = depth; yCos = true; break;              // orbit sagittal (YZ, over the top)
    case 5:                                                          // spherical (orbit + slow vertical precession)
      dx = depth; dz = depth; zCos = true;
      dy = depth * 0.7; fy = rate * 0.6; break;
    case 6: dx = depth; break;                                       // ping-pong (X only)
    case 7: dy = depth; break;                                       // up / down (Y only)
    case 8: dx = depth; dz = depth; fz = rate * 2; break;            // figure-8 (Z sine at 2x)
    case 9: {                                                        // expand / collapse (radial breathing)
      const u = azElToXYZ(p.azimuth ?? 0, p.elevation ?? 0, 1);    // unit vector toward the source
      dx = depth * u.x; dy = depth * u.y; dz = depth * u.z; break;
    }
    default: break;                                                  // static
  }
  return { fx, fy, fz, dx, dy, dz, xCos, yCos, zCos };
};

const makeSpatializer: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1.2;    // hold full level a touch farther out before the rolloff bites
  panner.rolloffFactor = 0.5;  // gentler than the default 1 so distance/depth don't dive in level so fast
  input.connect(panner).connect(output);

  // Offline contexts expose startRendering and can't run the live Autopilot rAF
  // loop, so Autopilot falls back to a bake-correct Spherical motion there.
  const isOffline = 'startRendering' in ctx;

  const pos = azElToXYZ(params.azimuth ?? 0, params.elevation ?? 0, params.distance ?? 1.5);
  panner.positionX.value = pos.x;
  panner.positionY.value = pos.y;
  panner.positionZ.value = pos.z;

  // One LFO per axis adds motion on top of the static position. Each axis can run
  // as a sine or a 90-degrees-shifted cosine: pairing a sine axis with a cosine
  // axis at the same rate traces a circle, so any plane (horizontal, frontal,
  // sagittal) can be orbited, while an in-phase radial triple breathes in and out.
  const cosWave = ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]));
  const lfoX = ctx.createOscillator(); lfoX.type = 'sine';
  const lfoY = ctx.createOscillator(); lfoY.type = 'sine';
  const lfoZ = ctx.createOscillator(); lfoZ.type = 'sine';
  const setWave = (osc: OscillatorNode, cos: boolean) => {
    if (cos) osc.setPeriodicWave(cosWave); else osc.type = 'sine';
  };
  const depthX = ctx.createGain();
  const depthY = ctx.createGain();
  const depthZ = ctx.createGain();
  lfoX.connect(depthX).connect(panner.positionX);
  lfoY.connect(depthY).connect(panner.positionY);
  lfoZ.connect(depthZ).connect(panner.positionZ);

  // Push a motion config onto the LFOs (waveform + frequency + depth).
  const applyMotion = (cfg: ReturnType<typeof motionConfig>) => {
    setWave(lfoX, cfg.xCos);
    setWave(lfoY, cfg.yCos);
    setWave(lfoZ, cfg.zCos);
    lfoX.frequency.setValueAtTime(cfg.fx, ctx.currentTime);
    lfoY.frequency.setValueAtTime(cfg.fy, ctx.currentTime);
    lfoZ.frequency.setValueAtTime(cfg.fz, ctx.currentTime);
    ramp(depthX.gain, cfg.dx, ctx);
    ramp(depthY.gain, cfg.dy, ctx);
    ramp(depthZ.gain, cfg.dz, ctx);
  };
  const applyPosition = (azimuth: number, elevation: number, distance: number) => {
    const np = azElToXYZ(azimuth, elevation, distance);
    ramp(panner.positionX, np.x, ctx);
    ramp(panner.positionY, np.y, ctx);
    ramp(panner.positionZ, np.z, ctx);
  };

  // Autopilot — a continuous "spatial choreographer". One AnalyserNode (lazy, live
  // only) feeds a per-frame MIR feature bus with per-feature AGC (so it reacts to
  // RELATIVE dynamics on any material), a flux-onset + inter-onset beat clock, a
  // soft hysteretic mood scorer, and drop/breakdown event detection. Those drive a
  // beat-aware azimuth orbit with slow elevation (brightness) + distance (bass)
  // followers, a mood-weighted LFO texture layer, and onset-fired accents that
  // decay back to the bed. dt-aware + allocation-free per frame; offline = Spherical.
  let analyser: AnalyserNode | null = null;
  let rafId = 0;
  let lastNow = 0;
  let binHz = 0;
  const baseAz = () => params.azimuth ?? 0;

  // One place to tune the whole brain.
  const AP = {
    onsetK: 1.8, refractoryMs: 120,
    agcFast: 0.2, agcSlow: 0.0006,
    elTau: 0.4, distTau: 0.25, distSlew: 0.15, angVelCap: 140,
    orbitMinHz: 0.05, orbitMaxHz: 1.8, maxRadiusDeg: 70,
    elMin: -8, elMax: 30, distMin: 1.3, distMax: 3.2, depthMin: 0.4, depthMax: 3.2,
  };

  // Live-only buffers (allocated in ensureAutopilot so offline never allocates them).
  let freqBuf: Uint8Array | null = null;
  let timeBuf: Uint8Array | null = null;
  let prevFreq: Uint8Array | null = null;
  let bands: Array<{ lo: number; hi: number }> = [];
  const agcState: Record<string, { min: number; max: number }> = {};
  let fastEnergy = 0, slowEnergy = 0, fluxMean = 0, fluxMad = 0;
  let beatPeriod = 0.5, beatPhase = 0, lastOnset = 0, beatConf = 0;
  const iois = new Float32Array(8); let ioiIdx = 0, ioiCount = 0;
  let wCalm = 0.25, wGroove = 0.4, wIntense = 0.2, wEthereal = 0.15;
  let orbitPhase = 0, azS = 0, elS = 0, distS = 2.2;
  let accX = 0, accY = 0, accZ = 0, accEnv = 0, accTau = 0.2, accLR = 1;
  let dropLatch = 0;

  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const onePole = (cur: number, target: number, tau: number, dt: number) =>
    cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
  const agc = (x: number, key: string) => {
    let s = agcState[key];
    if (!s) { s = agcState[key] = { min: x, max: x + 1e-3 }; }
    s.max += (x - s.max) * (x > s.max ? AP.agcFast : AP.agcSlow);
    s.min += (x - s.min) * (x < s.min ? AP.agcFast : AP.agcSlow);
    return clamp01((x - s.min) / (s.max - s.min + 1e-6));
  };
  const fireAccent = (ax: number, ay: number, az: number, gain: number, tau: number) => {
    const mag = Math.hypot(ax, ay, az) || 1;
    accX = (ax / mag) * gain; accY = (ay / mag) * gain; accZ = (az / mag) * gain;
    accEnv = 1; accTau = tau;
  };

  const ensureAutopilot = () => {
    if (analyser) return;
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0.5; // 0.8 blurs onsets; 0.5 keeps spectral flux alive
    input.connect(a);
    analyser = a;
    freqBuf = new Uint8Array(a.frequencyBinCount); // 1024
    timeBuf = new Uint8Array(a.fftSize);           // 2048
    prevFreq = new Uint8Array(a.frequencyBinCount);
    binHz = ctx.sampleRate / a.fftSize;
    const edges = [20, 60, 150, 400, 1500, 5000, 16000];
    bands = [];
    for (let i = 0; i < edges.length - 1; i += 1) {
      bands.push({
        lo: Math.max(1, Math.floor(edges[i] / binHz)),
        hi: Math.min(freqBuf.length - 1, Math.ceil(edges[i + 1] / binHz)),
      });
    }
    setWave(lfoX, false); setWave(lfoY, false); setWave(lfoZ, false); // plain sines in autopilot
    azS = baseAz(); elS = 0; distS = 2.2; orbitPhase = 0;
  };

  const autopilotTick = (now: number) => {
    if (!rafId || !analyser || !freqBuf || !timeBuf || !prevFreq) return;
    const dt = lastNow ? Math.min(0.05, Math.max(0.005, (now - lastNow) / 1000)) : 0.016;
    lastNow = now;

    // time domain -> rms + crest (percussive vs sustained)
    analyser.getByteTimeDomainData(timeBuf);
    let sq = 0, peak = 0;
    for (let i = 0; i < timeBuf.length; i += 1) {
      const v = (timeBuf[i] - 128) / 128; sq += v * v;
      const av = v < 0 ? -v : v; if (av > peak) peak = av;
    }
    const rms = Math.sqrt(sq / timeBuf.length);
    const crest = peak / (rms + 1e-6);

    // freq domain -> centroid + spread + flux + per-band flux (one pass)
    analyser.getByteFrequencyData(freqBuf);
    const nb = freqBuf.length;
    let cNum = 0, cNum2 = 0, cDen = 0, flux = 0, bassFlux = 0, highFlux = 0;
    for (let i = 1; i < nb; i += 1) {
      const m = freqBuf[i];
      cNum += i * m; cNum2 += i * i * m; cDen += m;
      const d = m - prevFreq[i];
      if (d > 0) { flux += d; if (i < nb * 0.07) bassFlux += d; else if (i > nb * 0.45) highFlux += d; }
      prevFreq[i] = m;
    }
    flux = flux / 255 / nb;
    // band means (sub+bass, mid) — inline to avoid per-frame closures
    const b0 = bands[0], b1 = bands[1], bm = bands[3];
    let s0 = 0; for (let i = b0.lo; i <= b0.hi; i += 1) s0 += freqBuf[i];
    let s1 = 0; for (let i = b1.lo; i <= b1.hi; i += 1) s1 += freqBuf[i];
    let sm = 0; for (let i = bm.lo; i <= bm.hi; i += 1) sm += freqBuf[i];
    const bassRaw = (s0 / Math.max(1, b0.hi - b0.lo + 1) + s1 / Math.max(1, b1.hi - b1.lo + 1)) * 0.5 / 255;
    const midRaw = sm / Math.max(1, bm.hi - bm.lo + 1) / 255;
    const cHz = cDen > 0 ? (cNum / cDen) * binHz : 200;
    const brightness = clamp01(Math.log2(Math.max(200, cHz) / 200) / Math.log2(16000 / 200));
    const variance = cDen > 0 ? Math.max(0, cNum2 / cDen - (cNum / cDen) ** 2) : 0;
    const spread01 = clamp01(Math.sqrt(variance) / (nb * 0.3));

    const energyN = agc(rms, 'rms');
    const bassN = agc(bassRaw, 'bass');
    const fluxN = agc(flux, 'flux');
    const arousal = energyN * 0.6 + fluxN * 0.4;
    fastEnergy = onePole(fastEnergy, energyN, 0.15, dt);
    slowEnergy = onePole(slowEnergy, energyN, 2.0, dt);

    // onset detection (adaptive flux threshold + refractory) + IOI beat clock
    fluxMean = onePole(fluxMean, flux, 0.4, dt);
    fluxMad = onePole(fluxMad, Math.abs(flux - fluxMean), 0.4, dt);
    const sinceOnset = now - lastOnset;
    let onset = false;
    if (flux > fluxMean + AP.onsetK * fluxMad && sinceOnset > AP.refractoryMs) {
      onset = true;
      const dtOn = sinceOnset / 1000;
      if (dtOn >= 0.25 && dtOn <= 1.5) { // 40..240 BPM
        beatPeriod += (dtOn - beatPeriod) * 0.12;
        iois[ioiIdx] = dtOn; ioiIdx = (ioiIdx + 1) % iois.length; if (ioiCount < iois.length) ioiCount += 1;
      }
      lastOnset = now;
      beatPhase -= 0.15 * Math.sin(2 * Math.PI * beatPhase); // soft phase pull, no hard reset
    }
    beatPhase += dt / Math.max(0.2, beatPeriod);
    if (beatPhase >= 1) beatPhase -= 1;
    if (ioiCount >= 3) {
      let mean = 0; for (let i = 0; i < ioiCount; i += 1) mean += iois[i]; mean /= ioiCount;
      let mad = 0; for (let i = 0; i < ioiCount; i += 1) mad += Math.abs(iois[i] - mean); mad /= ioiCount;
      beatConf = clamp01(1 - mad / Math.max(0.1, beatPeriod));
    } else beatConf = 0;

    // soft mood weights (asymmetric slew: commit fast, linger slow)
    const sustainN = 1 - clamp01((crest - 1.4) / 3);
    const sGroove = beatConf * midRaw * (1 - spread01) + 0.3;
    const sIntense = energyN * fluxN * (0.3 + spread01);
    const sCalm = (1 - energyN) * (1 - fluxN) * (1 - spread01);
    const sEthereal = brightness * (1 - arousal) * sustainN;
    const sTot = sGroove + sIntense + sCalm + sEthereal + 1e-6;
    const slewW = (w: number, t: number) => onePole(w, t, t > w ? 0.45 : 2.2, dt);
    wGroove = slewW(wGroove, sGroove / sTot);
    wIntense = slewW(wIntense, sIntense / sTot);
    wCalm = slewW(wCalm, sCalm / sTot);
    wEthereal = slewW(wEthereal, sEthereal / sTot);

    // events: DROP = bass-flux + crest spike + energy jump (collapse-then-bloom)
    if (dropLatch > 0) dropLatch -= dt * 1000;
    if (bassFlux > 8 && crest > 3.4 && fastEnergy - slowEnergy > 0.3 && dropLatch <= 0) {
      dropLatch = 2000;
      distS = AP.distMin;             // snap in, then ease back out
      fireAccent(0, -0.3, -1, 1.0, 0.18);
    }
    const intenseBias = dropLatch > 0 ? 0.5 : 0;

    // orbit rate: arousal-driven, beat-quantized when confident
    let orbitHz = AP.orbitMinHz + arousal * (AP.orbitMaxHz - AP.orbitMinHz);
    if (beatConf > 0.5) {
      const beatHz = 1 / Math.max(0.2, beatPeriod);
      orbitHz = beatHz * (energyN > 0.6 ? 0.5 : energyN > 0.3 ? 0.25 : 0.125);
    }
    orbitPhase += 2 * Math.PI * orbitHz * dt;
    if (orbitPhase > Math.PI * 2) orbitPhase -= Math.PI * 2;
    const widthGate = clamp01(1.2 - spread01 * 0.5 - clamp01(highFlux / 6000) * 0.6);
    const orbitRadius = Math.min(AP.maxRadiusDeg, (8 + energyN * 62) * Math.max(0.3, widthGate));
    const breath = 1 + 0.15 * Math.cos(2 * Math.PI * beatPhase) * wGroove;

    accEnv = onePole(accEnv, 0, accTau, dt);

    // targets (azimuth = orbit + lateral accent; el/dist slow followers)
    const azTarget = baseAz() + orbitRadius * Math.sin(orbitPhase) + accX * accEnv * 40;
    const elTarget = clamp(AP.elMin + brightness * 38 + wEthereal * 20 - (wIntense + intenseBias) * 8 + accY * accEnv * 15, AP.elMin, AP.elMax);
    const distTarget = clamp(3.0 - bassN * 1.7 + accZ * accEnv * 0.6, AP.distMin, AP.distMax);
    elS = onePole(elS, elTarget, AP.elTau, dt);
    const distNext = onePole(distS, distTarget, AP.distTau, dt);
    distS += clamp(distNext - distS, -AP.distSlew, AP.distSlew);
    const maxStep = AP.angVelCap * dt;
    azS += clamp(azTarget - azS, -maxStep, maxStep); // angular-velocity cap (no seasickness)
    applyPosition(azS, elS, distS);

    // mood-weighted LFO texture layer (granular shimmer over the orbit bed)
    const depthCommon = clamp(0.8 + energyN * 1.6 + bassN * 1.0, AP.depthMin, AP.depthMax)
      * breath * (crest > 3.5 ? 0.7 : crest < 2 ? 1.15 : 1);
    ramp(depthX.gain, depthCommon * (wIntense * 0.8 + 0.1), ctx);
    ramp(depthY.gain, depthCommon * (wEthereal * 1.1 + wCalm * 0.5), ctx);
    ramp(depthZ.gain, depthCommon * (wGroove * 0.6 + wEthereal * 0.5 + (dropLatch > 0 ? 1.2 : 0)), ctx);
    const lfoHz = Math.max(0.05, orbitHz);
    lfoX.frequency.setTargetAtTime(lfoHz, ctx.currentTime, 0.3);
    lfoY.frequency.setTargetAtTime(lfoHz * 0.5, ctx.currentTime, 0.3);
    lfoZ.frequency.setTargetAtTime(lfoHz * 2, ctx.currentTime, 0.3);

    // onset accents (by band: kick -> in+down, hat -> up, snare -> alternating sides)
    if (onset && dropLatch <= 0) {
      if (bassFlux > highFlux) fireAccent(0, -0.3, -1, 0.7 + energyN * 0.4, 0.12 + wEthereal * 0.4);
      else if (highFlux > bassFlux * 1.5) fireAccent(0, 1, 0, 0.5, 0.15);
      else { fireAccent(accLR, 0, -0.3, 0.6, 0.15); accLR = -accLR; }
    }

    rafId = requestAnimationFrame(autopilotTick);
  };
  const startAutopilot = () => {
    if (rafId || isOffline) return;
    ensureAutopilot();
    lastNow = 0;
    rafId = requestAnimationFrame(autopilotTick);
  };
  const stopAutopilot = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  };

  // Build-time motion. Autopilot: live -> start the driver; offline -> Spherical so
  // the bounce still has motion. Everything else uses its static config.
  const motion0 = Math.round(params.motion ?? 0);
  if (motion0 === SPATIAL_AUTOPILOT) {
    if (isOffline) applyMotion(motionConfig({ ...params, motion: 5, motionRate: 0.3, motionDepth: 2.5 }));
    else { applyMotion(motionConfig({ motion: 0 })); startAutopilot(); }
  } else {
    applyMotion(motionConfig(params));
  }
  lfoX.start();
  lfoY.start();
  lfoZ.start();

  return {
    input,
    output,
    setParams: (p) => {
      const motion = Math.round(p.motion ?? 0);
      if (motion === SPATIAL_AUTOPILOT) {
        // The driver owns position + motion; nothing static to apply live.
        if (isOffline) applyMotion(motionConfig({ ...p, motion: 5, motionRate: 0.3, motionDepth: 2.5 }));
        else startAutopilot();
        return;
      }
      stopAutopilot();
      // Teleport owns position via its schedule; don't ramp it back to the base.
      if (motion !== SPATIAL_TELEPORT) applyPosition(p.azimuth ?? 0, p.elevation ?? 0, p.distance ?? 1.5);
      applyMotion(motionConfig(p));
    },
    scheduleTeleport: (events) => {
      // Jump (hold then step, no ramp) to each scheduled position. The LFO depths
      // are 0 in Teleport mode, so these setValueAtTime values fully own position.
      const t0 = ctx.currentTime;
      try {
        panner.positionX.cancelScheduledValues(t0);
        panner.positionY.cancelScheduledValues(t0);
        panner.positionZ.cancelScheduledValues(t0);
      } catch { /* no automation scheduled yet */ }
      for (const ev of events) {
        const when = Math.max(ev.when, t0);
        panner.positionX.setValueAtTime(ev.x, when);
        panner.positionY.setValueAtTime(ev.y, when);
        panner.positionZ.setValueAtTime(ev.z, when);
      }
    },
    dispose: () => {
      stopAutopilot();
      try { lfoX.stop(); lfoY.stop(); lfoZ.stop(); } catch { /* not started */ }
      try { input.disconnect(); output.disconnect(); analyser?.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── 6. Loudness Contour (ISO 226 equal-loudness) ──────────────────────────────
   As monitoring level drops, the ear loses lows and highs relative to mids
   (Fletcher-Munson). This applies the inverse: low + high shelves whose boost
   grows as the assumed listening level falls, so the perceived tonal balance
   holds when you turn it down. A real "night mode" for mixing quietly. */
const contourGains = (levelPhon: number, amount: number) => {
  // 80 phon ~ a loud reference where no compensation is needed.
  const deficit = clamp((80 - levelPhon) / 80, 0, 1) * clamp(amount, 0, 1);
  return { lowDb: deficit * 12, highDb: deficit * 6 };
};

const makeLoudnessContour: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 120;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 8000;
  const g0 = contourGains(params.level ?? 70, params.amount ?? 0.5);
  low.gain.value = g0.lowDb;
  high.gain.value = g0.highDb;
  input.connect(low).connect(high).connect(output);

  return {
    input,
    output,
    setParams: (p) => {
      const g = contourGains(p.level ?? 70, p.amount ?? 0.5);
      low.gain.setTargetAtTime(g.lowDb, ctx.currentTime, 0.03);
      high.gain.setTargetAtTime(g.highDb, ctx.currentTime, 0.03);
    },
    dispose: () => {
      try { input.disconnect(); output.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── 7. OWL-Pad (XY performance effect) ────────────────────────────────────────
   An assignable XY surface. The program picks a filter type and whether a
   feedback delay is engaged; X and Y then sweep two parameters live as the user
   drags. Built as a superset graph (filter + feedback delay always wired, then
   neutralized per program), so switching programs never rebuilds the chain. The
   pad UI lives in OwlPad and writes x/y/active straight into these params. */
export const OWLPAD_PROGRAMS = [
  'LPF Sweep',
  'HPF Sweep',
  'BPF Sweep',
  'Delay',
  'Filter + Delay',
] as const;

interface OwlPadTargets {
  filterType: BiquadFilterType;
  freq: number;
  q: number;
  delayTime: number;
  feedback: number;
  fwet: number; // level of the filtered-direct path
  dwet: number; // level of the delayed path
}

/** Map (program, x, y) onto concrete node targets. X sweeps a log frequency or a
 *  delay time; Y sweeps resonance or feedback, depending on the program. */
const owlPadTargets = (program: number, x: number, y: number): OwlPadTargets => {
  const xx = clamp(x, 0, 1);
  const yy = clamp(y, 0, 1);
  const freq = 200 * Math.pow(18000 / 200, xx); // log sweep 200..18000 Hz
  const q = 0.5 + yy * 17.5;
  switch (Math.round(program)) {
    case 1:
      return { filterType: 'highpass', freq, q, delayTime: 0, feedback: 0, fwet: 1, dwet: 0 };
    case 2:
      return { filterType: 'bandpass', freq, q, delayTime: 0, feedback: 0, fwet: 1, dwet: 0 };
    case 3:
      return { filterType: 'lowpass', freq: 18000, q: 0.7, delayTime: 0.02 + xx * 0.58, feedback: yy * 0.85, fwet: 0.4, dwet: 0.9 };
    case 4:
      return { filterType: 'lowpass', freq, q: 0.9, delayTime: 0.18, feedback: yy * 0.85, fwet: 0.8, dwet: 0.7 };
    default:
      return { filterType: 'lowpass', freq, q, delayTime: 0, feedback: 0, fwet: 1, dwet: 0 };
  }
};

const makeOwlPad: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const dry = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const delayIn = ctx.createGain();
  const delay = ctx.createDelay(1.0);
  const feedback = ctx.createGain();
  const fwet = ctx.createGain(); // filtered direct
  const dwet = ctx.createGain(); // delayed repeats

  input.connect(dry).connect(output);
  input.connect(filter);
  filter.connect(fwet).connect(output);
  filter.connect(delayIn);
  delayIn.connect(delay);
  delay.connect(feedback).connect(delayIn); // feedback loop (delay node breaks the cycle)
  delay.connect(dwet).connect(output);

  // Mirror setParams at make time so the offline bounce starts in the live state.
  const apply = (p: Record<string, number>) => {
    const t = owlPadTargets(p.program ?? 0, p.x ?? 0.5, p.y ?? 0.3);
    const mix = clamp(p.mix ?? 1, 0, 1);
    const engaged = (p.active ?? 1) >= 0.5;
    const w = engaged ? mix : 0;
    filter.type = t.filterType;
    ramp(filter.frequency, t.freq, ctx);
    ramp(filter.Q, t.q, ctx);
    delay.delayTime.setTargetAtTime(Math.max(0, t.delayTime), ctx.currentTime, 0.05);
    ramp(feedback.gain, engaged ? t.feedback : 0, ctx);
    ramp(fwet.gain, w * t.fwet, ctx);
    ramp(dwet.gain, w * t.dwet, ctx);
    ramp(dry.gain, engaged ? 1 - mix : 1, ctx);
  };
  apply(params);

  return {
    input,
    output,
    setParams: (p) => apply(p),
    dispose: () => {
      try {
        input.disconnect();
        output.disconnect();
        filter.disconnect();
        delay.disconnect();
        feedback.disconnect();
      } catch { /* gone */ }
    },
  };
};

/* ── 8. Gater (rhythmic tremolo gate) ──────────────────────────────────────────
   An LFO chops the level between full and (1 - depth) at the set rate. The shape
   selects the LFO wave: sine = smooth tremolo, square = hard gate, saw = ramp.
   The gate gain is driven by a constant-source bias plus the scaled LFO, so it
   oscillates between `low` and `high` with no per-sample callback.

   Tempo-sync (sync = 1): the rate is derived from `bpm` + `div` instead of the
   free Hz knob. `div` indexes GATER_DIVISIONS; the value is cycles-per-beat, so
   1/4 = 1 cycle/beat (one gate per quarter note), 1/8 = 2, 1/8T = 3, etc. The
   bpm rides in as a param so the factory stays pure and bakes identically. */
export const GATER_DIVISIONS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/4T', '1/8T', '1/16T'] as const;
const GATER_DIV_CYCLES = [0.25, 0.5, 1, 2, 4, 1.5, 3, 6]; // cycles per beat, parallel to GATER_DIVISIONS
const makeGater: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const gate = ctx.createGain();
  gate.gain.value = 0; // intrinsic 0; bias + lfo drive the computed value
  input.connect(gate).connect(output);

  const lfo = ctx.createOscillator();
  const amp = ctx.createGain();
  const bias = ctx.createConstantSource();
  bias.connect(gate.gain);
  lfo.connect(amp).connect(gate.gain);

  const apply = (p: Record<string, number>) => {
    const synced = (p.sync ?? 0) >= 0.5;
    const bpm = clamp(p.bpm ?? 120, 40, 240);
    const div = Math.round(clamp(p.div ?? 3, 0, GATER_DIV_CYCLES.length - 1));
    const rate = synced ? (bpm / 60) * GATER_DIV_CYCLES[div] : clamp(p.rate ?? 6, 0.1, 30);
    const depth = clamp(p.depth ?? 0.8, 0, 1);
    const low = 1 - depth;
    const center = (1 + low) / 2;
    const a = (1 - low) / 2;
    const shape = Math.round(p.shape ?? 1);
    lfo.type = shape >= 2 ? 'sawtooth' : shape >= 1 ? 'square' : 'sine';
    lfo.frequency.setTargetAtTime(rate, ctx.currentTime, 0.02);
    bias.offset.setTargetAtTime(center, ctx.currentTime, 0.02);
    amp.gain.setTargetAtTime(a, ctx.currentTime, 0.02);
  };
  apply(params);
  lfo.start();
  bias.start();

  return {
    input,
    output,
    setParams: (p) => apply(p),
    dispose: () => {
      try { lfo.stop(); bias.stop(); input.disconnect(); output.disconnect(); gate.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── 9. Bitcrush (bit-depth reduction) ──────────────────────────────────────────
   A stepped waveshaper quantizes the signal to 2^bits levels for lo-fi crunch,
   blended against the dry signal. (Sample-rate reduction, the other half of a
   classic crusher, needs a per-sample worklet and lands with the chop suite.) */
const bitcrushCurve = (bits: number): Float32Array => {
  const n = 2048;
  const curve = new Float32Array(n);
  const levels = Math.pow(2, clamp(bits, 1, 16));
  const half = levels / 2;
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * half) / half;
  }
  return curve;
};
const makeBitcrush: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.curve = bitcrushCurve(Math.round(params.bits ?? 8));
  input.connect(dry).connect(output);
  input.connect(shaper).connect(wet).connect(output);

  const apply = (p: Record<string, number>) => {
    shaper.curve = bitcrushCurve(Math.round(clamp(p.bits ?? 8, 1, 16)));
    const mix = clamp(p.mix ?? 1, 0, 1);
    ramp(wet.gain, mix, ctx);
    ramp(dry.gain, 1 - mix, ctx);
  };
  apply(params);

  return {
    input,
    output,
    setParams: (p) => apply(p),
    dispose: () => {
      try { input.disconnect(); output.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── 10. Ring Modulator ─────────────────────────────────────────────────────────
   Multiply the signal by a sine carrier for metallic / robotic sidebands. The
   carrier drives a gain node's value, so the node output is signal x carrier. */
const makeRingMod: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const ring = ctx.createGain();
  ring.gain.value = 0; // intrinsic 0; the carrier drives the computed value
  const carrier = ctx.createOscillator();
  carrier.connect(ring.gain);

  input.connect(dry).connect(output);
  input.connect(ring).connect(wet).connect(output);

  const apply = (p: Record<string, number>) => {
    carrier.frequency.setTargetAtTime(clamp(p.frequency ?? 200, 1, 4000), ctx.currentTime, 0.02);
    const mix = clamp(p.mix ?? 1, 0, 1);
    ramp(wet.gain, mix, ctx);
    ramp(dry.gain, 1 - mix, ctx);
  };
  apply(params);
  carrier.start();

  return {
    input,
    output,
    setParams: (p) => apply(p),
    dispose: () => {
      try { carrier.stop(); input.disconnect(); output.disconnect(); ring.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── 11. Chop (MPC-style buffer chop, worklet) ─────────────────────────────────
   Stutter / beat-repeat / shuffle by re-looping a rolling buffer. The DSP lives
   in a worklet (public/chop.worklet.js), so the module must be registered on the
   context before the node is built; ensureChopModule caches that per context
   (the editor preloads it on the live context, and commitEdit awaits it on the
   offline context). If the module is not ready yet, the factory degrades to a
   clean passthrough and kicks off the load so the next build gets the real node. */
const chopModuleByCtx = new WeakMap<BaseAudioContext, Promise<void>>();
export const ensureChopModule = (ctx: BaseAudioContext): Promise<void> => {
  let p = chopModuleByCtx.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule('/chop.worklet.js').catch((e) => {
      chopModuleByCtx.delete(ctx);
      throw e;
    });
    chopModuleByCtx.set(ctx, p);
  }
  return p;
};

const makeChop: RackEffectFactory = (ctx, params) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  let node: AudioWorkletNode | null = null;
  try {
    node = new AudioWorkletNode(ctx, 'chop-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
  } catch {
    node = null; // module not registered on this context yet
  }

  if (!node) {
    input.connect(output); // passthrough; load the module for the next build
    void ensureChopModule(ctx).catch(() => {});
    return {
      input,
      output,
      setParams: () => {},
      dispose: () => { try { input.disconnect(); output.disconnect(); } catch { /* gone */ } },
    };
  }

  const chop = node;
  input.connect(chop).connect(output);
  const apply = (p: Record<string, number>) => {
    const prog = chop.parameters.get('program');
    if (prog) prog.setValueAtTime(Math.round(clamp(p.program ?? 0, 0, 2)), ctx.currentTime);
    const set = (key: string, v: number) => {
      const ap = chop.parameters.get(key);
      if (ap) ap.setTargetAtTime(v, ctx.currentTime, 0.01);
    };
    set('rate', clamp(p.rate ?? 8, 0.5, 32));
    set('slice', clamp(p.slice ?? 0.5, 0.05, 1));
    // Engagement gate: latched on by default (continuous chop), or driven
    // momentarily by `gate` (the hold-to-chop trigger). Dry when neither is set.
    const engaged = (p.latch ?? 1) >= 0.5 || (p.gate ?? 0) >= 0.5;
    set('mix', engaged ? clamp(p.mix ?? 1, 0, 1) : 0);
  };
  apply(params);

  return {
    input,
    output,
    setParams: (p) => apply(p),
    dispose: () => {
      try { input.disconnect(); output.disconnect(); chop.disconnect(); } catch { /* gone */ }
    },
  };
};

/* ── registry ──────────────────────────────────────────────────────────────── */

export const RACK_EFFECTS: readonly RackEffectDef[] = [
  {
    id: 'crossfeed',
    label: 'Headphone Crossfeed',
    group: 'Spatial',
    description: 'Relieves hard-panned headphone "in-head" stereo (Bauer/BS2B).',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'cutFreq', label: 'Cut', min: 200, max: 2000, step: 10, default: 700, unit: 'Hz' },
    ],
    make: makeCrossfeed,
  },
  {
    id: 'phantom_bass',
    label: 'Phantom Bass',
    group: 'Low end',
    description: 'Implies the missing fundamental via synthesized harmonics.',
    params: [
      { key: 'drive', label: 'Drive', min: 1, max: 40, step: 1, default: 6 },
      { key: 'blend', label: 'Blend', min: 0, max: 1.5, step: 0.01, default: 0.6 },
      { key: 'crossover', label: 'Crossover', min: 50, max: 160, step: 1, default: 90, unit: 'Hz' },
    ],
    make: makePhantomBass,
  },
  {
    id: 'stereo_widener',
    label: 'Stereo Widener',
    group: 'Spatial',
    description: 'True mid/side widening with a mono-safe low end.',
    params: [
      { key: 'width', label: 'Width', min: 0, max: 2.5, step: 0.01, default: 1.4 },
      { key: 'bassMonoFreq', label: 'Bass mono', min: 20, max: 400, step: 5, default: 120, unit: 'Hz' },
    ],
    make: makeStereoWidener,
  },
  {
    id: 'exciter',
    label: 'Aural Exciter',
    group: 'Tone',
    description: 'Adds harmonic air/presence the ear reads as detail.',
    params: [
      { key: 'frequency', label: 'Freq', min: 1000, max: 9000, step: 50, default: 3500, unit: 'Hz' },
      { key: 'amount', label: 'Amount', min: 1, max: 40, step: 1, default: 8 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.4 },
    ],
    make: makeExciter,
  },
  {
    id: 'spatializer',
    label: 'The Owl',
    group: 'Spatial',
    description: 'Positions the track in 3D around the head, with motion presets.',
    params: [
      { key: 'azimuth', label: 'Azimuth', min: -180, max: 180, step: 1, default: 0, unit: 'deg' },
      { key: 'elevation', label: 'Elevation', min: -90, max: 90, step: 1, default: 0, unit: 'deg' },
      { key: 'distance', label: 'Distance', min: 0.5, max: 10, step: 0.1, default: 1.5 },
      { key: 'motion', label: 'Motion', min: 0, max: 11, step: 1, default: 0 },
      { key: 'motionRate', label: 'Rate', min: 0, max: 4, step: 0.01, default: 0.3, unit: 'Hz' },
      { key: 'motionDepth', label: 'Depth', min: 0, max: 8, step: 0.1, default: 1.5 },
    ],
    make: makeSpatializer,
  },
  {
    id: 'loudness_contour',
    label: 'Loudness Contour',
    group: 'Tone',
    description: 'Equal-loudness tilt so the balance holds at low volume.',
    params: [
      { key: 'level', label: 'Level', min: 0, max: 90, step: 1, default: 70, unit: 'phon' },
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    make: makeLoudnessContour,
  },
  {
    id: 'owlpad',
    label: 'OWL-Pad',
    group: 'Performance',
    description: 'An XY performance pad: pick a program, then sweep two params by dragging.',
    params: [
      { key: 'program', label: 'Program', min: 0, max: 4, step: 1, default: 0 },
      { key: 'x', label: 'X', min: 0, max: 1, step: 0.001, default: 0.5 },
      { key: 'y', label: 'Y', min: 0, max: 1, step: 0.001, default: 0.3 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 1 },
      { key: 'hold', label: 'Hold', min: 0, max: 1, step: 1, default: 1 },
      { key: 'active', label: 'Active', min: 0, max: 1, step: 1, default: 1 },
    ],
    make: makeOwlPad,
  },
  {
    id: 'gater',
    label: 'Gater',
    group: 'Performance',
    description: 'Rhythmic tremolo gate: chop the level with an LFO (sine/square/saw), free-run or tempo-synced.',
    params: [
      { key: 'rate', label: 'Rate', min: 0.1, max: 30, step: 0.1, default: 6, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, default: 0.8 },
      { key: 'shape', label: 'Shape', min: 0, max: 2, step: 1, default: 1 },
      { key: 'sync', label: 'Sync', min: 0, max: 1, step: 1, default: 0 },
      { key: 'div', label: 'Division', min: 0, max: 7, step: 1, default: 3 },
      { key: 'bpm', label: 'BPM', min: 40, max: 240, step: 1, default: 120 },
    ],
    make: makeGater,
  },
  {
    id: 'bitcrush',
    label: 'Bitcrush',
    group: 'Performance',
    description: 'Lo-fi bit-depth reduction (stepped quantization), blended with dry.',
    params: [
      { key: 'bits', label: 'Bits', min: 1, max: 16, step: 1, default: 8 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 1 },
    ],
    make: makeBitcrush,
  },
  {
    id: 'ringmod',
    label: 'Ring Mod',
    group: 'Performance',
    description: 'Multiply by a sine carrier for metallic / robotic sidebands.',
    params: [
      { key: 'frequency', label: 'Freq', min: 1, max: 4000, step: 1, default: 200, unit: 'Hz' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 1 },
    ],
    make: makeRingMod,
  },
  {
    id: 'chop',
    label: 'Chop',
    group: 'Performance',
    description: 'MPC-style buffer chop: stutter, beat-repeat, or shuffle. Latch for continuous, or hold to chop.',
    params: [
      { key: 'program', label: 'Program', min: 0, max: 2, step: 1, default: 0 },
      { key: 'rate', label: 'Rate', min: 0.5, max: 32, step: 0.5, default: 8, unit: 'Hz' },
      { key: 'slice', label: 'Slice', min: 0.05, max: 1, step: 0.01, default: 0.5 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 1 },
      { key: 'latch', label: 'Latch', min: 0, max: 1, step: 1, default: 1 },
      { key: 'gate', label: 'Gate', min: 0, max: 1, step: 1, default: 0 },
    ],
    make: makeChop,
  },
];

const RACK_BY_ID = new Map<string, RackEffectDef>(RACK_EFFECTS.map((d) => [d.id, d]));

export const getRackEffect = (id: string): RackEffectDef | undefined => RACK_BY_ID.get(id);

/** Default param object for an effect id (used when adding to a chain). */
export const rackEffectDefaults = (id: string): Record<string, number> => {
  const def = RACK_BY_ID.get(id);
  if (!def) return {};
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
};

const withDefaults = (id: string, params: Record<string, number>): Record<string, number> => ({
  ...rackEffectDefaults(id),
  ...params,
});

/* ── chain builder ─────────────────────────────────────────────────────────── */

export interface ChainHandle {
  /** Re-wire the chain to match `entries` (add/remove/reorder/toggle). */
  rebuild: (entries: ChainEntry[]) => void;
  /** Push live param values into one running effect without a rebuild. */
  updateParams: (entryId: string, params: Record<string, number>) => void;
  /** Live effect instances keyed by ChainEntry.id — lets the caller reach an
   *  instance for transport-synced scheduling (e.g. the spatializer's teleport). */
  instances: () => { id: string; effect: string; inst: RackEffectInstance }[];
  /** Disconnect and dispose everything (leaves input/output untouched). */
  dispose: () => void;
}

interface LiveInstance {
  effect: string;
  inst: RackEffectInstance;
}

/**
 * Wire `entries` in series between caller-owned `input` and `output`. Enabled
 * effects only; a disabled or absent chain is a clean `input -> output` pass.
 * Instances persist across rebuilds where the effect id at a slot is unchanged,
 * so param tweaks stay click-free.
 */
export function buildEffectChain(
  ctx: BaseAudioContext,
  input: AudioNode,
  output: AudioNode,
  entries: ChainEntry[],
): ChainHandle {
  const instances = new Map<string, LiveInstance>(); // keyed by ChainEntry.id

  const clearWiring = () => {
    try { input.disconnect(); } catch { /* nothing wired */ }
    for (const { inst } of instances.values()) {
      try { inst.output.disconnect(); } catch { /* gone */ }
    }
  };

  const rebuild = (next: ChainEntry[]) => {
    clearWiring();
    const enabled = next.filter((e) => e.enabled && RACK_BY_ID.has(e.effect));

    // Dispose instances that are no longer present.
    const keepIds = new Set(enabled.map((e) => e.id));
    for (const [id, li] of instances) {
      if (!keepIds.has(id)) { li.inst.dispose(); instances.delete(id); }
    }

    if (enabled.length === 0) {
      input.connect(output);
      return;
    }

    let prev: AudioNode = input;
    for (const e of enabled) {
      let li = instances.get(e.id);
      if (!li || li.effect !== e.effect) {
        if (li) li.inst.dispose();
        const def = RACK_BY_ID.get(e.effect)!;
        li = { effect: e.effect, inst: def.make(ctx, withDefaults(e.effect, e.params)) };
        instances.set(e.id, li);
      } else {
        li.inst.setParams(withDefaults(e.effect, e.params));
      }
      prev.connect(li.inst.input);
      prev = li.inst.output;
    }
    prev.connect(output);
  };

  rebuild(entries);

  return {
    rebuild,
    updateParams: (entryId, params) => {
      const li = instances.get(entryId);
      if (li) li.inst.setParams(withDefaults(li.effect, params));
    },
    instances: () =>
      Array.from(instances.entries()).map(([id, li]) => ({ id, effect: li.effect, inst: li.inst })),
    dispose: () => {
      clearWiring();
      for (const { inst } of instances.values()) inst.dispose();
      instances.clear();
    },
  };
}
