/**
 * Sway control bus.
 *
 * Normalizes the Audima Sway's six expressive dimensions (Strike / Sway / Pulse /
 * Glide / Press / Sculpt) from raw MIDI CCs into 0..1 signals other subsystems can
 * route. The Sway is class-compliant MIDI, so its CCs already arrive on the global
 * midiBus; this bus adds the named-dimension layer plus learn. The CC numbers are
 * firmware-configurable and there is no MIDI 1.0 way to query a device's layout,
 * so every dimension binds by LEARN rather than a hardcoded CC (the same reason
 * controllerProfiles never hardcodes CCs).
 *
 * The six dims are target-agnostic: the same 0..1 signals can drive VFX (shader
 * uniforms, the akvj cloud, VJ FX), 3D audio placement (the Spatializer), and
 * MUSIC and VOICE targets (MAKE / Magenta generation and the vocal / SoulX path)
 * once those consumers subscribe. swayControlSource publishes them onto the XR
 * control bus so a headset can see and bind them too.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { subscribeToMidi } from './midiBus';

export type SwayDim = 'strike' | 'sway' | 'pulse' | 'glide' | 'press' | 'sculpt';

export const SWAY_DIMS: { id: SwayDim; label: string }[] = [
  { id: 'strike', label: 'Strike' },
  { id: 'sway', label: 'Sway' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'glide', label: 'Glide' },
  { id: 'press', label: 'Press' },
  { id: 'sculpt', label: 'Sculpt' },
];

/** A learned CC binding for one dimension (channel 0..15, cc 0..127). */
export interface SwayBinding {
  channel: number;
  cc: number;
}

interface SwayState {
  /** Persisted dim -> CC bindings (learned). */
  bindings: Partial<Record<SwayDim, SwayBinding>>;
  /** Live normalized values 0..1 (session only). */
  values: Record<SwayDim, number>;
  /** The dimension currently armed for learn, or null. Session only. */
  learningDim: SwayDim | null;

  startLearn: (dim: SwayDim) => void;
  cancelLearn: () => void;
  clearBinding: (dim: SwayDim) => void;
}

const ZERO_VALUES: Record<SwayDim, number> = {
  strike: 0,
  sway: 0,
  pulse: 0,
  glide: 0,
  press: 0,
  sculpt: 0,
};

export const useSwayStore = create<SwayState>()(
  persist(
    (set) => ({
      bindings: {},
      values: { ...ZERO_VALUES },
      learningDim: null,
      startLearn: (dim) => set({ learningDim: dim }),
      cancelLearn: () => set({ learningDim: null }),
      clearBinding: (dim) =>
        set((s) => {
          const next = { ...s.bindings };
          delete next[dim];
          return { bindings: next };
        }),
    }),
    {
      name: 'thedaw-sway-bindings-v1',
      partialize: (s) => ({ bindings: s.bindings }),
    },
  ),
);

/** Raw 0..1 value subscribers (high-rate, no React) for the control sources. */
type ValueListener = (dim: SwayDim, value: number) => void;
const valueListeners = new Set<ValueListener>();

export function subscribeSwayValue(cb: ValueListener): () => void {
  valueListeners.add(cb);
  return () => {
    valueListeners.delete(cb);
  };
}

/** Current normalized value for a dimension (0..1). */
export function getSwayValue(dim: SwayDim): number {
  return useSwayStore.getState().values[dim] ?? 0;
}

function ingestCc(channel: number, cc: number, value01: number): void {
  const st = useSwayStore.getState();
  // Learn: bind the armed dimension to the first CC it sees, then disarm.
  if (st.learningDim) {
    const dim = st.learningDim;
    useSwayStore.setState((s) => ({
      bindings: { ...s.bindings, [dim]: { channel, cc } },
      learningDim: null,
    }));
    return;
  }
  // Route: update every dimension bound to this (channel, cc) and notify the raw
  // value subscribers (the XR mirror, future matrix consumers).
  let changed = false;
  const nextValues = { ...st.values };
  for (const { id } of SWAY_DIMS) {
    const b = st.bindings[id];
    if (b && b.channel === channel && b.cc === cc) {
      nextValues[id] = value01;
      changed = true;
      for (const cb of valueListeners) {
        try {
          cb(id, value01);
        } catch {
          /* one faulty subscriber never breaks the bus */
        }
      }
    }
  }
  if (changed) useSwayStore.setState({ values: nextValues });
}

let unsub: (() => void) | null = null;

/** Start listening to the global midiBus for Sway CCs. Idempotent. The caller
 *  gates this behind the master MIDI toggle (App registers it in the midiEnabled
 *  effect, matching djControlSource). Returns a stop function. */
export function startSwayBus(): () => void {
  if (unsub) return () => {};
  unsub = subscribeToMidi((msg) => {
    const [status, data1, data2] = msg.data;
    if (typeof status !== 'number') return;
    if ((status & 0xf0) !== 0xb0) return; // control-change only
    const channel = status & 0x0f;
    const cc = data1 ?? 0;
    const value01 = Math.max(0, Math.min(1, (data2 ?? 0) / 127));
    ingestCc(channel, cc, value01);
  });
  return stopSwayBus;
}

export function stopSwayBus(): void {
  if (unsub) {
    unsub();
    unsub = null;
  }
}
