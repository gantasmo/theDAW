/**
 * PROCESS control source for the XR control bus. Mirrors xrControlDjSource and
 * makeControlSource: publishes PROCESS_TARGETS as manifest entries and routes an
 * inbound control-set to each target's wired `invoke`, so the MIX process surface
 * is bidirectional on XR like DJ and MAKE. processTargets is imported lazily so
 * it stays out of app boot.
 */
import type { XrControlSource, XrManifestEntry, XrControlValue } from './xrControlClient';
import type { BindableTarget } from '../components/surface/widgetTypes';

let cache: BindableTarget[] | null = null;

async function targets(): Promise<BindableTarget[]> {
  if (!cache) {
    const mod = await import('./processTargets');
    cache = mod.PROCESS_TARGETS;
  }
  return cache;
}

function toKind(k: BindableTarget['kind']): string {
  if (k === 'pad') return 'button';
  if (k === 'crossfader') return 'fader';
  return k;
}

export const processControlSource: XrControlSource = {
  area: 'process',

  async buildEntries(): Promise<XrManifestEntry[]> {
    const list = await targets();
    return list.map((t) => ({
      id: t.id,
      area: 'process',
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
