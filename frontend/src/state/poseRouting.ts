/**
 * Pose routing -- fan the six body-pose channels out to BindableTargets, mirroring
 * swayRouting. Each channel can bind to one target; when its value changes the
 * bound target is driven (scaled into [min,max] for ranges, thresholded for
 * toggles, rising-edge for pads). Reuses the same lazily-loaded target catalogue
 * as Sway (DJ targets today). The unified Show Designer matrix can later subsume
 * both scoped routers.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { BindableTarget } from '../components/surface/widgetTypes';
import { subscribePoseValue, type PoseChannel } from './poseBus';
import { loadSwayTargets } from './swayRouting';

let targets: BindableTarget[] | null = null;

interface PoseRoutingState {
  /** channel -> targetId. */
  routes: Partial<Record<PoseChannel, string>>;
  setRoute: (ch: PoseChannel, targetId: string | null) => void;
}

export const usePoseRoutingStore = create<PoseRoutingState>()(
  persist(
    (set) => ({
      routes: {},
      setRoute: (ch, targetId) =>
        set((s) => {
          const next = { ...s.routes };
          if (targetId) next[ch] = targetId;
          else delete next[ch];
          return { routes: next };
        }),
    }),
    { name: 'thedaw-pose-routes-v1' },
  ),
);

const prev: Record<PoseChannel, number> = {
  handLeft: 0,
  handRight: 0,
  armSpan: 0,
  bodyX: 0,
  bodyY: 0,
  lean: 0,
};

function drive(t: BindableTarget, value01: number, previous: number): void {
  try {
    if (t.kind === 'toggle') {
      t.invoke(value01 > 0.5);
    } else if (t.kind === 'pad') {
      if (value01 > 0.5 && previous <= 0.5) t.invoke(true);
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

/** Fan the six pose channels out to their bound targets. Idempotent. Camera-driven
 *  (not MIDI-gated), so App starts it on mount. Returns a stop function. */
export function startPoseRouting(): () => void {
  if (unsub) return () => {};
  void loadSwayTargets().then((t) => {
    targets = t;
  });
  unsub = subscribePoseValue((ch, value) => {
    const previous = prev[ch];
    prev[ch] = value;
    const targetId = usePoseRoutingStore.getState().routes[ch];
    if (!targetId || !targets) return;
    const t = targets.find((x) => x.id === targetId);
    if (t) drive(t, value, previous);
  });
  return stopPoseRouting;
}

export function stopPoseRouting(): void {
  if (unsub) {
    unsub();
    unsub = null;
  }
}
