/**
 * MAKE (Magenta RealTime 2) bindable targets.
 *
 * Each target drives a LIVE generation parameter on the mounted Magenta
 * instrument through makeBridge. The value reaches the NEXT generated chunk
 * (~4 s), so response is chunk-rate, not knob-instant. Param keys are the
 * bridge's live `state` keys (see public/magenta-tools/bridge.js). These share
 * the BindableTarget shape with DJ_TARGETS, so the Sway routing engine and the
 * XR control source drive them with no per-control wiring.
 */
import type { BindableTarget } from '../components/surface/widgetTypes';
import { setMakeParam, toggleMakePlay } from './makeBridge';

const G = 'Make (Magenta)';

export const MAKE_TARGETS: BindableTarget[] = [
  { id: 'make.temperature', label: 'Temperature', group: G, kind: 'knob', min: 0.1, max: 2, step: 0.01, invoke: (v) => setMakeParam('temperature', Number(v)) },
  { id: 'make.topK', label: 'Top-K', group: G, kind: 'knob', min: 1, max: 256, step: 1, invoke: (v) => setMakeParam('topk', Math.round(Number(v))) },
  { id: 'make.cfgMusic', label: 'CFG Music', group: G, kind: 'knob', min: 0, max: 6, step: 0.05, invoke: (v) => setMakeParam('cfgmusiccoca', Number(v)) },
  { id: 'make.cfgNotes', label: 'CFG Notes', group: G, kind: 'knob', min: 0, max: 6, step: 0.05, invoke: (v) => setMakeParam('cfgnotes', Number(v)) },
  { id: 'make.cfgDrums', label: 'CFG Drums', group: G, kind: 'knob', min: 0, max: 6, step: 0.05, invoke: (v) => setMakeParam('cfgdrums', Number(v)) },
  { id: 'make.volume', label: 'Volume', group: G, kind: 'fader', min: 0, max: 1, step: 0.01, invoke: (v) => setMakeParam('volume', Number(v)) },
  { id: 'make.drumless', label: 'Drumless', group: G, kind: 'toggle', invoke: (v) => setMakeParam('drumless', v ? 1 : 0) },
  { id: 'make.bypass', label: 'Bypass', group: G, kind: 'toggle', invoke: (v) => setMakeParam('bypass', v ? 1 : 0) },
  { id: 'make.play', label: 'Play / Pause', group: G, kind: 'pad', invoke: () => toggleMakePlay() },
];
