/**
 * The EDIT volume line's keyframes: which one is selected, and the edits the
 * line, its keys and its menus make.
 *
 * A track's volume keyframes are not a model of their own. They ARE the points
 * of the automation lane whose target is `{ kind: 'trackVolume', trackId }`, so
 * live playback, the offline bounces, save and load already honour them. Every
 * operation here is the editor store's own lane actions, wrapped so that one
 * thing the user does is one undo step.
 *
 * The selection is view state: a zustand store that is not persisted and not
 * in the undo history. It names a keyframe by its track and its time, never by
 * its index, so a keyframe that is gone (an undo, a delete, a removed lane or
 * track) simply resolves to nothing. Nothing has to clean up after it.
 */
import { create } from 'zustand';
import {
  automationTargetKey,
  beginUndoStep,
  useEditorStore,
  type AutomationLane,
  type AutomationPoint,
  type AutomationTarget,
} from './editorStore';
import { clamp01, lineValueAt, nudgeKeyframeTime, nudgeVolumeDb } from '../lib/volumeLine';

/** A keyframe, named by its track and its time on the timeline in seconds. */
export interface VolumeKeyframeRef {
  trackId: string;
  t: number;
}

export interface VolumeKeyframeState {
  /** The selected keyframe, or null. At most one, across every track. */
  selected: VolumeKeyframeRef | null;
  /** The selected keyframe's value field is open. */
  editing: boolean;
  /** Select a keyframe, or nothing with null. Closes the value field. */
  select: (ref: VolumeKeyframeRef | null) => void;
  /** Open or close the selected keyframe's value field. With nothing selected it stays closed. */
  setEditing: (on: boolean) => void;
  /** The selected keyframe moved in time: the selection follows it to `t`. */
  retime: (t: number) => void;
}

/** Two times closer than this (seconds) name the same keyframe. The store keeps
 *  keyframes 0.02 s apart, so this can never match two. */
const SAME_TIME_SEC = 1e-6;

/** The store's breakpoint thinning window (editorStore MIN_POINT_DT, which it
 *  does not export). A point written closer than this to a keyframe is not
 *  added: that keyframe takes the new value in its place. */
const STORE_MERGE_WINDOW_SEC = 0.02;

export const useVolumeKeyframes = create<VolumeKeyframeState>()((set) => ({
  selected: null,
  editing: false,

  select: (ref) =>
    set((s) => {
      if (ref === null) return s.selected === null && !s.editing ? s : { selected: null, editing: false };
      // The same keyframe again with the field closed: the same state object, so no subscriber wakes.
      if (s.selected && !s.editing && s.selected.trackId === ref.trackId && s.selected.t === ref.t) return s;
      return { selected: { trackId: ref.trackId, t: ref.t }, editing: false };
    }),

  setEditing: (on) =>
    set((s) => {
      const editing = on && s.selected !== null;
      return s.editing === editing ? s : { editing };
    }),

  retime: (t) =>
    set((s) =>
      s.selected === null || s.selected.t === t || !Number.isFinite(t)
        ? s
        : { selected: { trackId: s.selected.trackId, t } },
    ),
}));

/** The automation target a track's volume keyframes are stored under. */
export const volumeTarget = (trackId: string): AutomationTarget => ({ kind: 'trackVolume', trackId });

/** The track's volume lane among `lanes`, found by the target key the store
 *  itself resolves a lane by, so it is the lane `addAutomationLane` hands back. */
export function volumeLaneOf(lanes: readonly AutomationLane[], trackId: string): AutomationLane | undefined {
  const key = automationTargetKey(volumeTarget(trackId));
  return lanes.find((l) => automationTargetKey(l.target) === key);
}

/** The index of the keyframe at time `t` (within a microsecond), or -1. */
export function keyframeIndexAt(points: readonly AutomationPoint[], t: number): number {
  let best = -1;
  let bestDt = SAME_TIME_SEC;
  for (let i = 0; i < points.length; i += 1) {
    const dt = Math.abs(points[i].t - t);
    if (dt < bestDt) {
      best = i;
      bestDt = dt;
    }
  }
  return best;
}

/** A keyframe as the document holds it right now. */
export interface ResolvedVolumeKeyframe {
  lane: AutomationLane;
  index: number;
  point: AutomationPoint;
}

/** The lane, index and point `ref` names right now, or null when that keyframe is gone. */
export function resolveVolumeKeyframe(ref: VolumeKeyframeRef | null): ResolvedVolumeKeyframe | null {
  if (!ref) return null;
  const lane = volumeLaneOf(useEditorStore.getState().automationLanes, ref.trackId);
  if (!lane) return null;
  const index = keyframeIndexAt(lane.points, ref.t);
  return index < 0 ? null : { lane, index, point: lane.points[index] };
}

/** The selected keyframe as the document holds it right now, or null when
 *  nothing is selected or the selected keyframe no longer exists. */
export function resolveSelectedKeyframe(): ResolvedVolumeKeyframe | null {
  return resolveVolumeKeyframe(useVolumeKeyframes.getState().selected);
}

/** True when `ref` names the selected keyframe. */
const isSelected = (ref: VolumeKeyframeRef): boolean => {
  const sel = useVolumeKeyframes.getState().selected;
  return sel !== null && sel.trackId === ref.trackId && Math.abs(sel.t - ref.t) < SAME_TIME_SEC;
};

/** The index of the keyframe nearest `t`, or -1 for an empty lane. */
const nearestIndex = (points: readonly AutomationPoint[], t: number): number => {
  let best = -1;
  let bestDt = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const dt = Math.abs(points[i].t - t);
    if (dt < bestDt) {
      best = i;
      bestDt = dt;
    }
  }
  return best;
};

/**
 * Run one discrete edit (a typed value, a menu row, the Delete key) as an undo
 * step of its own. The cut before it keeps it out of whatever was edited in
 * the last 300 ms. The cut after it keeps a key nudge that follows at once
 * from folding into it: the store names a nudge and a typed value by the same
 * lane key. Inside an open undo group both cuts are inert and the edit joins
 * the group.
 */
const discreteEdit = (write: () => void): void => {
  beginUndoStep();
  write();
  beginUndoStep();
};

/**
 * Add a keyframe to `trackId`'s volume line at time `t` and select it. Returns
 * the keyframe, or null for an unknown track or an unusable time.
 *
 * The keyframe takes the line's value at `t`: the lane's sampled value when it
 * has keyframes, else the track fader's. The line therefore does not move when
 * the keyframe lands. The first keyframe on a track creates its lane, and lane
 * and keyframe are ONE undo step.
 *
 * A time closer than the store's thinning window to a keyframe that is already
 * there adds nothing and selects that keyframe. The store would otherwise fold
 * the new point into it and overwrite its value with the line's value at `t`,
 * which on a steep stretch is not the value it had.
 */
export function addVolumeKeyframe(trackId: string, t: number): VolumeKeyframeRef | null {
  if (!Number.isFinite(t)) return null;
  const ed = useEditorStore.getState();
  const track = ed.tracks.find((x) => x.id === trackId);
  if (!track) return null;
  const at = Math.max(0, t);

  const existing = volumeLaneOf(ed.automationLanes, trackId);
  const beside = existing ? nearestIndex(existing.points, at) : -1;
  let ref: VolumeKeyframeRef | null;
  if (existing && beside >= 0 && Math.abs(existing.points[beside].t - at) < STORE_MERGE_WINDOW_SEC) {
    ref = { trackId, t: existing.points[beside].t };
  } else {
    ref = ed.undoGroup(() => {
      const laneId = ed.addAutomationLane(volumeTarget(trackId));
      const lane = useEditorStore.getState().automationLanes.find((l) => l.id === laneId);
      ed.addAutomationPoint(laneId, at, lineValueAt(lane?.points ?? [], track.volume, at));
      // Read the keyframe back instead of trusting `at`: the store owns where a
      // written point ends up.
      const points = volumeLaneOf(useEditorStore.getState().automationLanes, trackId)?.points ?? [];
      const index = nearestIndex(points, at);
      return index < 0 ? null : { trackId, t: points[index].t };
    });
  }
  if (ref) useVolumeKeyframes.getState().select(ref);
  return ref;
}

/** Set a keyframe's volume (linear gain, kept in 0..1). An undo step of its
 *  own. A keyframe that is gone, or one already at that value, writes nothing. */
export function setVolumeKeyframeValue(ref: VolumeKeyframeRef, v: number): void {
  const hit = resolveVolumeKeyframe(ref);
  if (!hit || !Number.isFinite(v)) return;
  const next = clamp01(v);
  if (next === hit.point.v) return;
  discreteEdit(() => useEditorStore.getState().updateAutomationPoint(hit.lane.id, hit.index, hit.point.t, next));
}

/**
 * Move a keyframe's volume by `deltaDb` decibels (lib/volumeLine nudgeVolumeDb).
 *
 * No `beginUndoStep()` here: `updateAutomationPoint` names its write by the
 * lane, so the repeats of a held key fold into one undo step, and a press that
 * comes after the store's 300 ms window starts a new one. A step that changes
 * nothing (up at unity, down at silence) writes nothing, so it leaves no empty
 * undo step behind.
 */
export function nudgeVolumeKeyframe(ref: VolumeKeyframeRef, deltaDb: number): void {
  const hit = resolveVolumeKeyframe(ref);
  if (!hit) return;
  const next = nudgeVolumeDb(hit.point.v, deltaDb);
  if (next === hit.point.v) return;
  useEditorStore.getState().updateAutomationPoint(hit.lane.id, hit.index, hit.point.t, next);
}

/**
 * Move a keyframe by `deltaSec` in time, kept clear of its neighbours and
 * inside `[0, maxT]` (lib/volumeLine nudgeKeyframeTime). Returns the keyframe
 * at its new time, or null when it is gone. The selection follows when the
 * moved keyframe is the selected one. Held-key repeats fold into one undo step,
 * as a volume nudge's do, and a move with nowhere to go writes nothing.
 */
export function moveVolumeKeyframeTime(ref: VolumeKeyframeRef, deltaSec: number, maxT: number): VolumeKeyframeRef | null {
  const hit = resolveVolumeKeyframe(ref);
  if (!hit) return null;
  const t = nudgeKeyframeTime(hit.lane.points, hit.index, deltaSec, maxT);
  if (t === hit.point.t) return { trackId: ref.trackId, t };
  const wasSelected = isSelected(ref);
  useEditorStore.getState().updateAutomationPoint(hit.lane.id, hit.index, t, hit.point.v);
  if (wasSelected) useVolumeKeyframes.getState().retime(t);
  return { trackId: ref.trackId, t };
}

/**
 * Delete a keyframe. An undo step of its own. The selection is dropped when it
 * was the selected one.
 *
 * Deleting a track's last keyframe leaves its empty lane in place: with no
 * points the lane has no say and the track fader has the gain back.
 */
export function deleteVolumeKeyframe(ref: VolumeKeyframeRef): void {
  const hit = resolveVolumeKeyframe(ref);
  if (!hit) return;
  const wasSelected = isSelected(ref);
  discreteEdit(() => useEditorStore.getState().removeAutomationPoint(hit.lane.id, hit.index));
  if (wasSelected) useVolumeKeyframes.getState().select(null);
}

/** Delete every keyframe on a track's volume line, leaving its empty lane in
 *  place. An undo step of its own. A selection on that track is dropped. */
export function clearVolumeKeyframes(trackId: string): void {
  const lane = volumeLaneOf(useEditorStore.getState().automationLanes, trackId);
  if (!lane || lane.points.length === 0) return;
  discreteEdit(() => useEditorStore.getState().clearAutomationLane(lane.id));
  const keyframes = useVolumeKeyframes.getState();
  if (keyframes.selected?.trackId === trackId) keyframes.select(null);
}

/** Switch a track's volume keyframes off, or back on. While they are off the
 *  lane is kept and the track fader has the gain. An undo step of its own. */
export function toggleVolumeKeyframesBypass(trackId: string): void {
  const lane = volumeLaneOf(useEditorStore.getState().automationLanes, trackId);
  if (!lane) return;
  discreteEdit(() => useEditorStore.getState().toggleAutomationLane(lane.id));
}
