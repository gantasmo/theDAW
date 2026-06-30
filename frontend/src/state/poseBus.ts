/**
 * Pose control bus.
 *
 * Receives the six normalized body-pose scalars the VJ's MediaPipe gesture
 * detector forwards over the iframe bridge (`sa3-vj/pose`) and exposes them as
 * named 0..1 channels other subsystems can route, mirroring swayBus. Pose is a
 * camera-driven control SOURCE: the channels are target-agnostic, so the same
 * signals can drive VFX, 3D audio, and music/voice targets once those subscribe.
 *
 * The window listener auto-starts on import (like the VJ's own sa3Bridge), so the
 * meters and routing receive frames whenever the VJ is forwarding, regardless of
 * the MIDI gate. poseControlSource publishes the channels onto the XR control bus.
 */
import { create } from 'zustand';

export type PoseChannel = 'handLeft' | 'handRight' | 'armSpan' | 'bodyX' | 'bodyY' | 'lean';

export const POSE_CHANNELS: { id: PoseChannel; label: string }[] = [
  { id: 'handLeft', label: 'Hand L' },
  { id: 'handRight', label: 'Hand R' },
  { id: 'armSpan', label: 'Arm Span' },
  { id: 'bodyX', label: 'Body X' },
  { id: 'bodyY', label: 'Body Y' },
  { id: 'lean', label: 'Lean' },
];

const ZERO: Record<PoseChannel, number> = {
  handLeft: 0,
  handRight: 0,
  armSpan: 0,
  bodyX: 0,
  bodyY: 0,
  lean: 0,
};

interface PoseState {
  values: Record<PoseChannel, number>;
  /** True once a pose frame has arrived (the detector is live). */
  active: boolean;
}

export const usePoseStore = create<PoseState>(() => ({ values: { ...ZERO }, active: false }));

type ValueListener = (ch: PoseChannel, value: number) => void;
const valueListeners = new Set<ValueListener>();

export function subscribePoseValue(cb: ValueListener): () => void {
  valueListeners.add(cb);
  return () => {
    valueListeners.delete(cb);
  };
}

export function getPoseValue(ch: PoseChannel): number {
  return usePoseStore.getState().values[ch] ?? 0;
}

function ingest(p: Record<string, unknown>): void {
  const cur = usePoseStore.getState().values;
  const next = { ...cur };
  for (const { id } of POSE_CHANNELS) {
    const raw = p[id];
    if (typeof raw === 'number') {
      const val = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      next[id] = val;
      for (const cb of valueListeners) {
        try {
          cb(id, val);
        } catch {
          /* one faulty subscriber never breaks the bus */
        }
      }
    }
  }
  usePoseStore.setState({ values: next, active: true });
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || (d as { type?: unknown }).type !== 'sa3-vj/pose') return;
    ingest(d as Record<string, unknown>);
  });
}
