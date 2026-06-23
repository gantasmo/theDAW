/**
 * Catalogue of backend endpoints a custom DJ control can drive. Each target is
 * a CONCRETE, fully-wired setter (per deck / master) with its value domain, so
 * the Add-Control picker can offer them grouped and a `CustomControl` can push
 * values straight through `invoke` with no extra wiring. Kept DJ-specific here;
 * the generic surface only knows the `BindableTarget` shape and receives this
 * array as a prop from DJView.
 */
import * as dj from './djEngine';
import type { BindableTarget } from '../components/surface/widgetTypes';

const DECKS: dj.DeckId[] = ['A', 'B'];

const perDeck = (d: dj.DeckId): BindableTarget[] => {
  const g = `Deck ${d}`;
  return [
    { id: `dj.eqHi.${d}`, label: `EQ High ${d}`, group: g, kind: 'knob', min: -12, max: 12, step: 0.5, unit: 'dB', invoke: (v) => dj.setDeckEq(d, 'high', Number(v)) },
    { id: `dj.eqMid.${d}`, label: `EQ Mid ${d}`, group: g, kind: 'knob', min: -12, max: 12, step: 0.5, unit: 'dB', invoke: (v) => dj.setDeckEq(d, 'mid', Number(v)) },
    { id: `dj.eqLo.${d}`, label: `EQ Low ${d}`, group: g, kind: 'knob', min: -12, max: 12, step: 0.5, unit: 'dB', invoke: (v) => dj.setDeckEq(d, 'low', Number(v)) },
    { id: `dj.filter.${d}`, label: `Filter ${d}`, group: g, kind: 'knob', min: -1, max: 1, step: 0.01, invoke: (v) => dj.setDeckFilter(d, Number(v)) },
    { id: `dj.gain.${d}`, label: `Gain ${d}`, group: g, kind: 'knob', min: -12, max: 12, step: 0.5, unit: 'dB', invoke: (v) => dj.setDeckTrim(d, Number(v)) },
    { id: `dj.vol.${d}`, label: `Volume ${d}`, group: g, kind: 'fader', min: 0, max: 1, step: 0.01, invoke: (v) => dj.setDeckVolume(d, Number(v)) },
    { id: `dj.pitch.${d}`, label: `Pitch ${d}`, group: g, kind: 'fader', min: -15, max: 15, step: 0.1, unit: '%', invoke: (v) => dj.setDeckPitch(d, Number(v)) },
    { id: `dj.fxFlanger.${d}`, label: `FX Flanger ${d}`, group: g, kind: 'knob', min: 0, max: 1, step: 0.01, invoke: (v) => dj.setDeckFx(d, 'flanger', Number(v)) },
    { id: `dj.fxReverb.${d}`, label: `FX Reverb ${d}`, group: g, kind: 'knob', min: 0, max: 1, step: 0.01, invoke: (v) => dj.setDeckFx(d, 'reverb', Number(v)) },
    { id: `dj.fxWah.${d}`, label: `FX Wah ${d}`, group: g, kind: 'knob', min: 0, max: 1, step: 0.01, invoke: (v) => dj.setDeckFx(d, 'wahwah', Number(v)) },
    { id: `dj.play.${d}`, label: `Play / Pause ${d}`, group: g, kind: 'pad', invoke: () => dj.toggleDeck(d) },
    { id: `dj.cue.${d}`, label: `Cue ${d}`, group: g, kind: 'pad', invoke: () => dj.cueDeck(d) },
    { id: `dj.keylock.${d}`, label: `Key-Lock ${d}`, group: g, kind: 'toggle', invoke: (v) => void dj.setDeckKeylock(d, Boolean(v)) },
    { id: `dj.slip.${d}`, label: `Slip ${d}`, group: g, kind: 'toggle', invoke: (v) => dj.setSlip(d, Boolean(v)) },
    { id: `dj.headCue.${d}`, label: `Headphone Cue ${d}`, group: g, kind: 'toggle', invoke: (v) => dj.setDeckCue(d, Boolean(v)) },
  ];
};

export const DJ_TARGETS: BindableTarget[] = [
  ...DECKS.flatMap(perDeck),
  { id: 'dj.crossfade', label: 'Crossfader', group: 'Mixer', kind: 'crossfader', min: -1, max: 1, step: 0.01, invoke: (v) => dj.setCrossfade(Number(v)) },
  { id: 'dj.limiter', label: 'Master Limiter', group: 'Mixer', kind: 'toggle', invoke: (v) => dj.setLimiter(Boolean(v)) },
];
