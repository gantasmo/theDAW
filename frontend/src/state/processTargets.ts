/**
 * PROCESS (MIX effect chain) bindable targets -- the offline "voice / process"
 * surface for SWAY.
 *
 * Each target drives one parameter of a MIX effect by EFFECT TYPE: it finds that
 * effect in the live effect chain and updates its param, so the value applies on
 * the next MIX render (offline FFmpeg via /api/studio). If the effect is not in
 * the chain, the move is a no-op -- add the effect in MIX first, then SWAY shapes
 * it. No effect is ever auto-added from a gesture.
 *
 * The vocal_processing effect (highpassFreq / presenceBoost / targetLUFS) is the
 * real vocal-processing path; the rest are general process controls. Same
 * BindableTarget shape as DJ/MAKE, so the routing engine and XR source drive them
 * with no per-control wiring.
 */
import type { BindableTarget } from '../components/surface/widgetTypes';
import { useEffectChainStore } from './effectChainStore';

const G = 'Process (MIX)';

/** Drive one param of the first chain entry of `effect`. No-op if absent. */
function setChainParam(effect: string, key: string, value: number): void {
  const st = useEffectChainStore.getState();
  const entry = st.chain.find((e) => e.effect === effect);
  if (!entry) return;
  st.updateParams(entry.id, { ...entry.params, [key]: value });
}

export const PROCESS_TARGETS: BindableTarget[] = [
  { id: 'process.vocalHighpass', label: 'Vocal High-Pass', group: G, kind: 'knob', min: 20, max: 400, step: 1, unit: 'Hz', invoke: (v) => setChainParam('vocal_processing', 'highpassFreq', Number(v)) },
  { id: 'process.vocalPresence', label: 'Vocal Presence', group: G, kind: 'knob', min: 0, max: 12, step: 0.1, unit: 'dB', invoke: (v) => setChainParam('vocal_processing', 'presenceBoost', Number(v)) },
  { id: 'process.vocalLufs', label: 'Vocal LUFS', group: G, kind: 'fader', min: -24, max: -9, step: 0.5, unit: 'LUFS', invoke: (v) => setChainParam('vocal_processing', 'targetLUFS', Number(v)) },
  { id: 'process.eqMid', label: 'Mid EQ Gain', group: G, kind: 'knob', min: -12, max: 12, step: 0.5, unit: 'dB', invoke: (v) => setChainParam('eq_mid', 'gain', Number(v)) },
  { id: 'process.width', label: 'Stereo Width', group: G, kind: 'knob', min: 0, max: 40, step: 1, unit: 'ms', invoke: (v) => setChainParam('stereo_widener', 'delayMs', Number(v)) },
  { id: 'process.pitch', label: 'Pitch Shift', group: G, kind: 'knob', min: -12, max: 12, step: 1, unit: 'st', invoke: (v) => setChainParam('pitch_shift', 'shift', Number(v)) },
];
