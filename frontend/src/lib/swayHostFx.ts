/**
 * swayHostFx: the object theDAW hands the SWAY cockpit's window so a cockpit
 * track can play theDAW's rack effects.
 *
 * The cockpit (SwayCommand, framed same-origin at /sway-app/) owns its own
 * AudioContext and its own track graph. It cannot import this app's modules,
 * and a rack effect is a Web Audio subgraph, which no postMessage frame can
 * carry. So SwayView puts this object on the cockpit's window before it
 * answers the handshake, and lists `HOST_CAP_RACK_FX` in sway/host-ready's
 * caps. The cockpit then calls:
 *
 *   catalog()                       every RACK_EFFECTS entry: id, name and the
 *                                   parameter schema (range, step, default,
 *                                   unit, control kind, option labels)
 *   prepare(audioContext)           registers the three worklet modules the
 *                                   rack needs on THAT context; resolves with
 *                                   the effect ids whose module did not load
 *   build(audioContext, id, params) the effect's node pair, built by the
 *                                   rack's own factory on THAT context
 *
 * Every rack factory creates its nodes through the context it is given
 * (`ctx.createGain()` ...), so the nodes belong to the cockpit's context. The
 * three worklet effects (chop, kargyraa, ares) construct an AudioWorkletNode
 * and pass through until their module is registered, which `prepare` does.
 */
import { optionValue, paramKind, isLog } from '../components/audio/effects/paramFormat';
import { swayHostVstApi, type SwayHostVstApi } from './swayHostVst';
import {
  RACK_EFFECTS,
  ensureChopModule,
  ensureGranularModule,
  ensureSubharmonicModule,
  getRackEffect,
  rackEffectDefaults,
  type RackEffectDef,
} from './rackEffects';

/** The property SwayView sets on the cockpit's window. */
export const SWAY_HOST_API_KEY = 'theDAWHost';
/** Bumped when a method changes shape; additions keep the number. */
export const SWAY_HOST_API_VERSION = 1;

/** One parameter of a rack effect, as the cockpit draws it. */
export interface SwayHostFxParam {
  key: string;
  name: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** 'Hz', 'dB', 'ms', ... or '' for a bare number. */
  unit: string;
  kind: 'knob' | 'slider' | 'toggle' | 'select';
  /** Option labels of a select, else null. */
  options: string[] | null;
  /** The value each option sets, parallel to `options`. */
  values: number[] | null;
  curve: 'lin' | 'log';
  /** True when a 0..1 value reads as 0..100 %. */
  percent: boolean;
  group: string;
  tip: string;
}

export interface SwayHostFxEffect {
  id: string;
  name: string;
  group: string;
  description: string;
  /** The wet/dry parameter's key, or null. */
  mix: string | null;
  params: SwayHostFxParam[];
}

export interface SwayHostFxNode {
  input: AudioNode;
  output: AudioNode;
  /** Merges `params` into the effect's current values and applies them. */
  setParams: (params: Record<string, number>) => void;
  dispose: () => void;
}

export interface SwayHostApi {
  version: number;
  host: 'theDAW';
  catalog: () => SwayHostFxEffect[];
  prepare: (ctx: BaseAudioContext) => Promise<string[]>;
  build: (ctx: BaseAudioContext, effectId: string, params?: Record<string, number>) => SwayHostFxNode | null;
  /** VST3 plugins on cockpit tracks, live (lib/swayHostVst, cap `vst-live`). */
  vst: SwayHostVstApi;
}

/** The rack effects that hold an AudioWorkletNode, by the module they need. */
const WORKLET_EFFECTS: ReadonlyArray<{ ids: readonly string[]; ensure: (ctx: BaseAudioContext) => Promise<void> }> = [
  { ids: ['chop'], ensure: ensureChopModule },
  { ids: ['ares'], ensure: ensureGranularModule },
  { ids: ['kargyraa'], ensure: ensureSubharmonicModule },
];

function describeEffect(def: RackEffectDef): SwayHostFxEffect {
  return {
    id: def.id,
    name: def.label,
    group: def.group,
    description: def.description,
    mix: def.mixKey ?? null,
    params: def.params.map((p) => {
      const kind = paramKind(p);
      const labels = p.options ? [...p.options] : kind === 'toggle' ? ['Off', 'On'] : null;
      return {
        key: p.key,
        name: p.label,
        min: p.min,
        max: p.max,
        step: p.step,
        default: p.default,
        unit: p.unit ?? '',
        kind,
        options: labels,
        values: labels ? labels.map((_, i) => (p.options ? optionValue(p, i) : i)) : null,
        curve: isLog(p) ? 'log' : 'lin',
        percent: p.display === 'percent',
        group: p.group ?? '',
        tip: p.tip ?? '',
      };
    }),
  };
}

/** The finite values of `params` that `def` declares, each inside its range. */
function ownParams(def: RackEffectDef, params: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!params || typeof params !== 'object') return out;
  for (const p of def.params) {
    const v = params[p.key];
    if (typeof v === 'number' && Number.isFinite(v)) out[p.key] = Math.max(p.min, Math.min(p.max, v));
  }
  return out;
}

/** The host API. One object serves every cockpit this page frames. */
export function createSwayHostApi(vst: SwayHostVstApi = swayHostVstApi): SwayHostApi {
  return {
    version: SWAY_HOST_API_VERSION,
    host: 'theDAW',
    vst,
    catalog: () => RACK_EFFECTS.map(describeEffect),
    prepare: async (ctx) => {
      const failed: string[] = [];
      await Promise.all(
        WORKLET_EFFECTS.map(({ ids, ensure }) =>
          ensure(ctx).catch(() => {
            failed.push(...ids);
          }),
        ),
      );
      return failed;
    },
    build: (ctx, effectId, params) => {
      const def = getRackEffect(effectId);
      if (!def) return null;
      let current = { ...rackEffectDefaults(effectId), ...ownParams(def, params) };
      const inst = def.make(ctx, current);
      return {
        input: inst.input,
        output: inst.output,
        setParams: (next) => {
          // A rack instance takes its whole parameter set on every call.
          current = { ...current, ...ownParams(def, next) };
          inst.setParams(current);
        },
        dispose: () => inst.dispose(),
      };
    },
  };
}

export const swayHostApi: SwayHostApi = createSwayHostApi();

/**
 * Puts the host API on the cockpit's window. True when the cockpit can now
 * read it, which is what lets sway/host-ready list `HOST_CAP_RACK_FX`.
 */
export function handSwayHostApi(target: Window | null | undefined, api: SwayHostApi = swayHostApi): boolean {
  if (!target) return false;
  try {
    (target as unknown as Record<string, unknown>)[SWAY_HOST_API_KEY] = api;
    return (target as unknown as Record<string, unknown>)[SWAY_HOST_API_KEY] === api;
  } catch {
    // A frame on another origin refuses the write; the cap is then left out.
    return false;
  }
}
