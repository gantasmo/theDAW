/**
 * DJ control source for the XR control bus (spatialization P1).
 *
 * Publishes theDAW's DJ surface to XR by reusing DJ_TARGETS verbatim: each
 * BindableTarget becomes one manifest entry, and an inbound control-set is
 * routed straight to that target's wired `invoke`. There is no per-control code,
 * so the DJ surface stays in sync as DJ_TARGETS grows. bindableTargets (and
 * through it djEngine) is imported lazily so it stays in the DJ chunk and never
 * loads at app boot.
 */
import type {
  XrControlSource,
  XrManifestEntry,
  XrControlValue,
} from './xrControlClient';
import type { BindableTarget } from '../components/surface/widgetTypes';

let cache: BindableTarget[] | null = null;

async function targets(): Promise<BindableTarget[]> {
  if (!cache) {
    const mod = await import('./bindableTargets');
    cache = mod.DJ_TARGETS;
  }
  return cache;
}

// theDAW's BindableTarget.kind -> manifest kind. A momentary "pad" maps to a
// button; the crossfader is a horizontal fader.
function toKind(k: BindableTarget['kind']): string {
  if (k === 'pad') return 'button';
  if (k === 'crossfader') return 'fader';
  return k; // knob | fader | toggle
}

export const djControlSource: XrControlSource = {
  area: 'dj',

  async buildEntries(): Promise<XrManifestEntry[]> {
    const list = await targets();
    return list.map((t) => ({
      id: t.id,
      area: 'dj',
      group: t.group,
      label: t.label,
      kind: toKind(t.kind),
      min: t.min,
      max: t.max,
      step: t.step,
      unit: t.unit,
    }));
  },

  async apply(id: string, value: XrControlValue): Promise<boolean> {
    const t = (await targets()).find((x) => x.id === id);
    if (!t) return false;
    // Toggles want a boolean; ranges want a number; pads trigger (arg ignored).
    if (t.kind === 'toggle') t.invoke(Boolean(value));
    else if (t.kind === 'pad') t.invoke(true);
    else t.invoke(Number(value));
    return true;
  },
};
