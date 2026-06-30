/**
 * MAKE control source for the XR control bus.
 *
 * Mirrors xrControlDjSource: publishes MAKE_TARGETS as manifest entries and
 * routes an inbound control-set straight to each target's wired `invoke`, so the
 * MAKE surface is bidirectional on XR exactly like DJ, with no per-control code.
 * makeTargets (and through it makeBridge) is imported lazily so it stays out of
 * app boot.
 */
import type { XrControlSource, XrManifestEntry, XrControlValue } from './xrControlClient';
import type { BindableTarget } from '../components/surface/widgetTypes';

let cache: BindableTarget[] | null = null;

async function targets(): Promise<BindableTarget[]> {
  if (!cache) {
    const mod = await import('./makeTargets');
    cache = mod.MAKE_TARGETS;
  }
  return cache;
}

function toKind(k: BindableTarget['kind']): string {
  if (k === 'pad') return 'button';
  if (k === 'crossfader') return 'fader';
  return k; // knob | fader | toggle
}

export const makeControlSource: XrControlSource = {
  area: 'make',

  async buildEntries(): Promise<XrManifestEntry[]> {
    const list = await targets();
    return list.map((t) => ({
      id: t.id,
      area: 'make',
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
    if (t.kind === 'toggle') t.invoke(Boolean(value));
    else if (t.kind === 'pad') t.invoke(true);
    else t.invoke(Number(value));
    return true;
  },
};
