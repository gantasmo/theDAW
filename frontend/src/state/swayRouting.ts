/**
 * Sway routing -- a small fan-out from the six Sway dimensions to BindableTargets.
 *
 * Each dimension can bind to one target; when the dimension's normalized value
 * changes, the bound target is driven (scaled into its [min,max] for ranges,
 * thresholded for toggles, rising-edge for pads). Today the catalogue is
 * DJ_TARGETS, so a Sway can drive DJ controls hands-on; VJ, MAKE, and vocal
 * targets join the picker as their catalogues land, and the unified Show Designer
 * matrix can later subsume this scoped engine.
 *
 * The DJ catalogue (and through it djEngine) is imported lazily, so this stays out
 * of app boot and only loads when a Sway target is wired or the panel opens.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { BindableTarget } from '../components/surface/widgetTypes';
import { subscribeSwayValue, type SwayDim } from './swayBus';

let targetCache: BindableTarget[] | null = null;
let targetLoad: Promise<BindableTarget[]> | null = null;

function loadTargets(): Promise<BindableTarget[]> {
  if (targetCache) return Promise.resolve(targetCache);
  if (!targetLoad) {
    targetLoad = Promise.all([
      import('./bindableTargets'),
      import('./makeTargets'),
      import('./processTargets'),
    ]).then(([dj, make, proc]) => {
      targetCache = [...dj.DJ_TARGETS, ...make.MAKE_TARGETS, ...proc.PROCESS_TARGETS];
      return targetCache;
    });
  }
  return targetLoad;
}

/** Targets a Sway dimension can route to (lazy-loads the DJ catalogue). */
export function loadSwayTargets(): Promise<BindableTarget[]> {
  return loadTargets();
}

interface SwayRoutingState {
  /** dim -> targetId. */
  routes: Partial<Record<SwayDim, string>>;
  setRoute: (dim: SwayDim, targetId: string | null) => void;
}

export const useSwayRoutingStore = create<SwayRoutingState>()(
  persist(
    (set) => ({
      routes: {},
      setRoute: (dim, targetId) =>
        set((s) => {
          const next = { ...s.routes };
          if (targetId) next[dim] = targetId;
          else delete next[dim];
          return { routes: next };
        }),
    }),
    { name: 'thedaw-sway-routes-v1' },
  ),
);

/** First-run defaults: the six dims to live Magenta make-targets, so SWAY drives
 *  generation out of the box. Seeded only when no routes exist at all, so a
 *  returning user's saved DJ/MAKE bindings are never overwritten. */
const DEFAULT_MAKE_ROUTES: Partial<Record<SwayDim, string>> = {
  strike: 'make.cfgDrums',
  sway: 'make.cfgMusic',
  pulse: 'make.temperature',
  glide: 'make.cfgNotes',
  press: 'make.volume',
  sculpt: 'make.topK',
};

const prev: Record<SwayDim, number> = {
  strike: 0,
  sway: 0,
  pulse: 0,
  glide: 0,
  press: 0,
  sculpt: 0,
};

function drive(t: BindableTarget, value01: number, previous: number): void {
  try {
    if (t.kind === 'toggle') {
      t.invoke(value01 > 0.5);
    } else if (t.kind === 'pad') {
      if (value01 > 0.5 && previous <= 0.5) t.invoke(true); // rising edge triggers once
    } else {
      const min = t.min ?? 0;
      const max = t.max ?? 1;
      t.invoke(min + value01 * (max - min));
    }
  } catch {
    /* a setter that throws (engine not started yet) is non-fatal */
  }
}

let unsub: (() => void) | null = null;

/** Fan the six Sway dimensions out to their bound targets. Idempotent. Started by
 *  App in the midiEnabled effect; returns a stop function. */
export function startSwayRouting(): () => void {
  if (unsub) return () => {};
  // Seed the MAKE defaults non-destructively: only when the user has no routes,
  // so existing bindings (DJ or MAKE) are never clobbered.
  if (Object.keys(useSwayRoutingStore.getState().routes).length === 0) {
    useSwayRoutingStore.setState({ routes: { ...DEFAULT_MAKE_ROUTES } });
  }
  void loadTargets(); // warm so the first move routes without a stall
  unsub = subscribeSwayValue((dim, value) => {
    const previous = prev[dim];
    prev[dim] = value;
    const targetId = useSwayRoutingStore.getState().routes[dim];
    if (!targetId || !targetCache) return;
    const t = targetCache.find((x) => x.id === targetId);
    if (t) drive(t, value, previous);
  });
  return stopSwayRouting;
}

export function stopSwayRouting(): void {
  if (unsub) {
    unsub();
    unsub = null;
  }
}
