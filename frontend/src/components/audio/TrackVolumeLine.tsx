/**
 * The EDIT track volume line.
 *
 * Every track row of the EDIT timeline draws one line over its lane. With no
 * keyframes the line is flat at the track fader's value, and dragging it up or
 * down moves the fader. A right-click or a double-click on the line adds a
 * keyframe. From then on the line is the track's volume automation: a keyframe
 * drags in time and value, the stretch between two keyframes drags up and down
 * as one, and a selected keyframe shows its level in dB and takes the arrow
 * keys, a typed value and Delete.
 *
 * The model is lib/volumeLine and the edits are state/volumeKeyframes. A
 * keyframe is a point of the track's trackVolume automation lane, so playback,
 * the bounces, save and load already honour it.
 *
 * Only the line, the keyframe handles and the value chip take the pointer. The
 * row's wrapper and the svg take none, so a clip move, a trim, a fade, the
 * marquee, the menus and a drop work as before everywhere else in the row.
 *
 * Pointer math goes through lib/canvasScale clientToLocal, which takes the
 * shell's CSS zoom out. Every handler reads the document from the live store
 * and its props through a ref: a pointer move can arrive before the render
 * that follows the move before it.
 */
import React, { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpToLine, Eraser, Power, Trash2, Volume2 } from 'lucide-react';
import {
  automationTargetKey,
  useEditorStore,
  type AutomationLane,
  type AutomationPoint,
  type EditorTrack,
} from '../../state/editorStore';
import {
  addVolumeKeyframe,
  clearVolumeKeyframes,
  deleteVolumeKeyframe,
  keyframeIndexAt,
  moveVolumeKeyframeTime,
  nudgeVolumeKeyframe,
  resolveVolumeKeyframe,
  setVolumeKeyframeValue,
  toggleVolumeKeyframesBypass,
  useVolumeKeyframes,
  volumeLaneOf,
  volumeTarget,
  type VolumeKeyframeRef,
} from '../../state/volumeKeyframes';
import {
  FINE_DRAG_FACTOR,
  KEYFRAME_NUDGE_DB,
  KEYFRAME_NUDGE_DB_COARSE,
  KEYFRAME_TIME_STICK_PX,
  LINE_DRAG_THRESHOLD_PX,
  clamp01,
  clampSegmentDelta,
  dragKeyframe,
  formatVolumeDb,
  grabAt,
  keyframeNear,
  lineValueAt,
  nudgeVolumeDb,
  parseVolumeDb,
  visibleKeyframes,
  volumeBand,
  volumeToY,
} from '../../lib/volumeLine';
import type { CurvePoint } from '../../lib/automationModes';
import { clientToLocal, effectiveZoom } from '../../lib/canvasScale';
import { isPrimaryGestureButton } from '../../lib/timeline/pointerGesture';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { lanePathPoints } from './AutomationLane';
import { formatCursorTime } from './timelineInteraction';

// A ctrl+click with a mouse on macOS is a context-menu click, never a drag (WaveformEditor's own test).
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The volume colour every lane view uses (WaveformEditor laneVisual). */
const LINE_COLOR = '#34d399';
/** A bypassed line: its keyframes are kept and the track fader has the gain. */
const BYPASS_COLOR = '#a1a1aa';
/** The width of the invisible stroke that takes the pointer along the line. */
const HIT_WIDTH_PX = 12;
/** Half the side of a keyframe's diamond, and of the selected keyframe's. */
const HANDLE_HALF_PX = 3.5;
const HANDLE_HALF_SELECTED_PX = 4.5;
/** The radius of the invisible circle that takes the pointer on a keyframe. */
const HANDLE_GRAB_R_PX = 9;
/** Two handles are never drawn closer than this (lib/volumeLine visibleKeyframes). */
const HANDLE_MIN_GAP_PX = 10;
/** A right-click this close to a keyframe selects it. Further away it adds one. */
const KEYFRAME_PICK_PX = 8;
/** The gap between a keyframe and its value chip, the chip's height (h-5) and
 *  the room it needs before it flips to the keyframe's other side. */
const CHIP_GAP_PX = 10;
const CHIP_HEIGHT_PX = 20;
const CHIP_ROOM_PX = 72;
/** The readout's look: 12 px bold sans, the form every readout in EDIT uses. */
const CHIP = 'rounded bg-zinc-900 border border-emerald-400/50 px-1 h-5 font-sans text-xs font-bold tabular-nums text-emerald-200';

const NO_POINTS: readonly AutomationPoint[] = [];

/** The zoom (px per second) as a number that is safe to divide by. */
const perSecond = (zoom: number): number => (Number.isFinite(zoom) && zoom > 0 ? zoom : 1e-6);

/** Two times that name the same keyframe (state/volumeKeyframes keyframeIndexAt). */
const sameTime = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

const keyframeCount = (n: number): string => `${n} keyframe${n === 1 ? '' : 's'}`;

/** The index of the keyframe at time `t`, or -1. A binary search, for the
 *  drag that looks a keyframe up on every pointer move. */
const indexAtTime = (points: readonly CurvePoint[], t: number): number => {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t - 1e-6) lo = mid + 1;
    else hi = mid;
  }
  return lo < points.length && sameTime(points[lo].t, t) ? lo : -1;
};

/**
 * The keyframes a press on the line at time `t` takes hold of, or none when
 * the line has no keyframes and the press is on the fader.
 *
 * `grabAt` names the keyframes at the ends of the stretch under the pointer.
 * On a line with more keyframes than handles (a recorded ride leaves one every
 * 20 ms or so) that stretch is a sliver between two keyframes nobody can see.
 * The grab therefore reaches out to the handle drawn on either side and takes
 * every keyframe between the two, so the stretch that moves is the stretch
 * between two handles. Where every keyframe has a handle this is `grabAt`'s
 * own answer.
 *
 * `keepIndex` is the selected keyframe, which always has a handle.
 */
export function grabbedKeyframes(points: readonly CurvePoint[], zoom: number, t: number, keepIndex: number = -1): number[] {
  const grab = grabAt(points, t);
  if (grab.kind === 'fader') return [];
  const lo = grab.indices[0];
  const hi = grab.indices[grab.indices.length - 1];
  // The handles as they are drawn at any scroll position: the thinning counts
  // from the line's first keyframe, so the window does not change the answer.
  const shown = visibleKeyframes(points, zoom, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, HANDLE_MIN_GAP_PX, keepIndex);
  let from = lo;
  let to = points.length - 1;
  for (const i of shown) {
    if (i <= lo) from = i;
    if (i >= hi) {
      to = i;
      break;
    }
  }
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

/** Where the undo history stood when a drag began. */
interface UndoMark {
  depth: number;
  top: unknown;
}

const undoMark = (): UndoMark => {
  const stack = useEditorStore.getState()._undo;
  return { depth: stack.length, top: stack[stack.length - 1] };
};

/**
 * Take back what a drag recorded: undo until the history is back at `mark`
 * (the rule WaveformEditor's clip drags use). A drag is one undo group, so this
 * is one step, or none for a drag that changed nothing.
 *
 * The history keeps a fixed number of steps. Once it is full a new step pushes
 * the oldest out and the depth does not grow, so a step on top that was not
 * there at the mark counts as recorded too.
 */
const undoBackTo = (mark: UndoMark): void => {
  for (let guard = 0; guard < 64; guard += 1) {
    const stack = useEditorStore.getState()._undo;
    const grew = stack.length > mark.depth;
    const replaced = stack.length === mark.depth && stack.length > 0 && stack[stack.length - 1] !== mark.top;
    if (!grew && !replaced) return;
    useEditorStore.getState().undo();
  }
};

/** The selected keyframe's index on `trackId`'s line right now, or -1. */
const liveSelectedIndex = (trackId: string): number => {
  const sel = useVolumeKeyframes.getState().selected;
  return sel !== null && sel.trackId === trackId ? resolveVolumeKeyframe(sel)?.index ?? -1 : -1;
};

const preventSelectStart = (e: Event): void => e.preventDefault();
const stopBubble = (e: React.SyntheticEvent): void => e.stopPropagation();

/* The focus ring belongs to the keyboard. A press focuses the line from script
   (the focus has to move before the press is read), and the browser's own
   :focus-visible takes a script focus with nothing focused before it for a
   keyboard one, which drew the ring round the whole row on a mouse press. So
   the line keeps its own note of whether the last input was a key. */
let lastInputWasKey = false;
let modalityUsers = 0;
const noteKeyInput = (): void => {
  lastInputWasKey = true;
};
const notePointerInput = (): void => {
  lastInputWasKey = false;
};

/** Keep `lastInputWasKey` current while any line is mounted: one pair of
 *  window listeners, however many lines there are. */
function useInputModality(): void {
  useEffect(() => {
    if (modalityUsers === 0) {
      window.addEventListener('keydown', noteKeyInput, true);
      window.addEventListener('pointerdown', notePointerInput, true);
    }
    modalityUsers += 1;
    return () => {
      modalityUsers -= 1;
      if (modalityUsers > 0) return;
      window.removeEventListener('keydown', noteKeyInput, true);
      window.removeEventListener('pointerdown', notePointerInput, true);
    };
  }, []);
}

type GestureKind = 'fader' | 'segment' | 'keyframe';
type GestureEnd = 'release' | 'cancel' | 'escape' | 'unmount';

/** One press on the line or on a keyframe, from pointer-down to its teardown. */
interface LineGesture {
  pointerId: number;
  /** The pressed element. It holds the pointer capture. */
  el: Element;
  trackId: string;
  kind: GestureKind;
  /** The press in client px, for the travel thresholds. */
  downX: number;
  downY: number;
  /** The timeline time under the pointer at the press, and the last move's row y. */
  pressT: number;
  lastY: number;
  /** The line time the press took hold of: the pointer's on the line, a keyframe's own on a keyframe. */
  grabT: number;
  /** The volume travelled since the press. */
  acc: number;
  /** Set once the press has travelled the threshold: the undo group is open. */
  mark: UndoMark | null;
  /** Fader grab: the fader at the press, and the last value handed on. */
  startVolume: number;
  sentVolume: number;
  /** Stretch and keyframe grabs: the lane, and the grabbed keyframes at the press. */
  laneId: string;
  grabbed: { t: number; v: number }[];
  /** Keyframe grab: its time now, and whether the drag may change it. */
  t: number;
  timeUnlocked: boolean;
  /** Takes this gesture's window listeners off. */
  off: () => void;
}

/** What a press decides about its gesture. `begin` fills in the rest. */
type GestureStart = Pick<LineGesture, 'kind' | 'grabT'> & Partial<Pick<LineGesture, 'startVolume' | 'laneId' | 'grabbed'>>;

/** What the render shows of a drag in flight. */
interface DragView {
  kind: GestureKind;
  /** Keyframe drag: the dragged keyframe's index. */
  index: number;
  /** Fader and stretch drags: the pointer in row px, and the line time under the press. */
  x: number;
  t: number;
}

export interface TrackVolumeLineProps {
  track: EditorTrack;
  /** The track's trackVolume lane, when it has one. */
  lane: AutomationLane | undefined;
  /** Local px from the top of the lanes to this track's row. */
  top: number;
  /** px per second */
  zoom: number;
  /** local px */
  trackHeight: number;
  /** timeline content width, local px */
  width: number;
  /** visible time window, for windowing the handles */
  fromSec: number;
  toSec: number;
  /** false while the cut tool is active */
  interactive: boolean;
  /** The id of the help paragraph the slider is described by. */
  helpId: string;
  snap: (sec: number) => number;
  timeStep: (coarse: boolean, atSec: number) => number;
  onFaderChange: (trackId: string, v: number) => void;
  onFaderGestureStart: (trackId: string) => void;
  onFaderGestureEnd: (trackId: string) => void;
  onKeyframeSelected: () => void;
  /** Open the keyframe menu at a viewport point. */
  onKeyframeMenu: (at: { x: number; y: number }, ref: VolumeKeyframeRef) => void;
}

/**
 * The selected keyframe's value field: a dB number, typed.
 *
 * Enter commits and Escape cancels, and both hand the focus back to the line.
 * A blur commits and leaves the focus where the user put it. Unreadable text
 * just closes the field.
 */
function KeyframeValueField({
  id, target, value, commitRef, onDone,
}: {
  id: string;
  /** The keyframe the field edits. */
  target: VolumeKeyframeRef;
  value: number;
  /** Lets the line commit the field before a press outside drops the selection. */
  commitRef: React.RefObject<(() => void) | null>;
  onDone: (target: VolumeKeyframeRef, refocus: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The text the field opened with. Committing this exact text writes nothing:
  // it is rounded to a tenth of a dB, so writing it back would move the keyframe.
  const prefill = useRef(formatVolumeDb(value).replace(' dB', '')).current;
  const closed = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  const close = (commit: boolean, refocus: boolean): void => {
    if (closed.current) return;
    closed.current = true;
    const to = targetRef.current;
    if (commit) {
      const text = inputRef.current?.value ?? prefill;
      if (text.trim() !== prefill) {
        const v = parseVolumeDb(text);
        if (v !== null) setVolumeKeyframeValue(to, v);
      }
    }
    onDone(to, refocus);
  };
  // The newest `close` on every render, so a commit from outside names the keyframe the field shows now.
  const closeRef = useRef(close);
  closeRef.current = close;

  useLayoutEffect(() => {
    closed.current = false;
    const el = inputRef.current;
    el?.focus({ preventScroll: true });
    el?.select();
    commitRef.current = () => closeRef.current(true, false);
    return () => {
      commitRef.current = null;
    };
  }, [commitRef]);

  return (
    <>
      <label htmlFor={id} className="sr-only">Keyframe volume in decibels</label>
      <input
        ref={inputRef}
        id={id}
        name={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        defaultValue={prefill}
        className={`${CHIP} w-14 select-text outline-none focus:border-emerald-300`}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== 'Escape') return;
          // The line and the timeline both bind these two keys. Here they belong to the field.
          e.preventDefault();
          e.stopPropagation();
          close(e.key === 'Enter', true);
        }}
        onBlur={() => close(true, false)}
      />
    </>
  );
}

/** One track's volume line. `TrackVolumeLines` mounts one per track. */
export const TrackVolumeLine = memo(function TrackVolumeLine(props: TrackVolumeLineProps) {
  const { track, lane, top, zoom, trackHeight, width, fromSec, toSec, interactive, helpId } = props;
  const trackId = track.id;
  // Handlers read the newest props through this ref. A window listener, and the
  // teardown an unmount runs, outlive the render that made them.
  const latest = useRef(props);
  latest.current = props;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gestureRef = useRef<LineGesture | null>(null);
  /** Commits the value field while it is open. */
  const fieldCommitRef = useRef<(() => void) | null>(null);
  const fieldId = `volume-keyframe-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const selectedT = useVolumeKeyframes((s) => (s.selected !== null && s.selected.trackId === trackId ? s.selected.t : null));
  const editing = useVolumeKeyframes((s) => s.editing && s.selected !== null && s.selected.trackId === trackId);

  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  /** The focus came from the keyboard: the row shows its focus ring. */
  const [ringed, setRinged] = useState(false);
  const [drag, setDrag] = useState<DragView | null>(null);
  useInputModality();

  const toRow =(clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const at = clientToLocal(svg, clientX, clientY);
    return Number.isFinite(at.x) && Number.isFinite(at.y) ? at : null;
  };
  /** Give the line the keys. The ring follows the input that asked: a line
   *  that already had the focus fires no focus event to decide it. */
  const focusLine = (): void => {
    svgRef.current?.focus({ preventScroll: true });
    setRinged(lastInputWasKey);
  };

  /* ── The gesture ────────────────────────────────────────────────────────── */

  /**
   * The ONE teardown: a release, a cancel, a lost capture, Escape and an
   * unmount all end a gesture here, and only the first of them does anything.
   * It reads nothing from a render (refs and the live stores only), so the
   * copy a window listener or an unmount holds is as good as the newest.
   */
  const finish = useCallback((how: GestureEnd): void => {
    const g = gestureRef.current;
    if (!g) return;
    gestureRef.current = null;
    g.off();
    try {
      g.el.releasePointerCapture?.(g.pointerId);
    } catch {
      // The capture is already gone: a touch that lifted, or an element that left the page.
    }
    if (g.mark) {
      if (g.kind === 'fader') latest.current.onFaderGestureEnd(g.trackId);
      useEditorStore.getState().endUndoGroup();
    }
    if (how !== 'unmount') setDrag(null);
    if (how === 'escape' && g.mark) {
      undoBackTo(g.mark);
      // The drag carried the selection along in time. Undo put the keyframe
      // back, so the selection goes back with it.
      const keys = useVolumeKeyframes.getState();
      if (g.kind === 'keyframe' && keys.selected !== null && keys.selected.trackId === g.trackId && sameTime(keys.selected.t, g.t)) {
        keys.retime(g.grabbed[0].t);
      }
    }
  }, []);

  // The line left the page: a drag in flight ends with it (and its undo group
  // closes), and a value field that was open does not come back with the line.
  useEffect(() => () => {
    finish('unmount');
    const keys = useVolumeKeyframes.getState();
    if (keys.editing && keys.selected !== null && keys.selected.trackId === latest.current.track.id) keys.setEditing(false);
  }, [finish]);
  // The cut tool took the pointer away mid-drag.
  useEffect(() => {
    if (!interactive) finish('cancel');
  }, [interactive, finish]);

  /** A press while a gesture is still open. The same pointer: its release was
   *  never seen, so that gesture ends here. Another pointer (a second finger):
   *  the drag in flight keeps going and the new press is ignored. */
  const claimPointer = (pointerId: number): boolean => {
    const g = gestureRef.current;
    if (!g) return true;
    if (g.pointerId !== pointerId) return false;
    finish('cancel');
    return true;
  };

  const begin = (e: React.PointerEvent<Element>, at: { x: number; y: number }, start: GestureStart): void => {
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      el.setPointerCapture?.(pointerId);
    } catch {
      // A pointer that is already up cannot be captured. The window listeners below still end the gesture.
    }
    // The svg's own handlers take a release that reaches the line. These two are
    // for one that lands anywhere else, after the capture was lost.
    const onEnd = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const target = ev.target as Node | null;
      if (target && typeof target.nodeType === 'number' && svgRef.current?.contains(target)) return;
      finish(ev.type === 'pointerup' ? 'release' : 'cancel');
    };
    // Escape takes the drag back. Capture phase, and the key stops here, so
    // neither the line's own Escape (deselect) nor the timeline's runs as well.
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      finish('escape');
    };
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onEnd, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('selectstart', preventSelectStart);
    gestureRef.current = {
      pointerId,
      el,
      trackId: latest.current.track.id,
      kind: start.kind,
      downX: e.clientX,
      downY: e.clientY,
      pressT: at.x / perSecond(latest.current.zoom),
      lastY: at.y,
      grabT: start.grabT,
      acc: 0,
      mark: null,
      startVolume: start.startVolume ?? 0,
      sentVolume: start.startVolume ?? 0,
      laneId: start.laneId ?? '',
      grabbed: start.grabbed ?? [],
      t: start.grabbed?.[0]?.t ?? 0,
      timeUnlocked: false,
      off: () => {
        window.removeEventListener('pointerup', onEnd, true);
        window.removeEventListener('pointercancel', onEnd, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('selectstart', preventSelectStart);
      },
    };
  };

  const laneById = (laneId: string): AutomationLane | undefined =>
    useEditorStore.getState().automationLanes.find((l) => l.id === laneId);

  const moveGesture = (g: LineGesture, e: React.PointerEvent<Element>): void => {
    const p = latest.current;
    const at = toRow(e.clientX, e.clientY);
    if (!at) return;
    // Accumulated per move, so pressing or letting go of Shift mid-drag changes
    // the speed from here on and never makes the value jump.
    g.acc += (-(at.y - g.lastY) / volumeBand(p.trackHeight).height) * (e.shiftKey ? FINE_DRAG_FACTOR : 1);
    g.lastY = at.y;
    const dxClient = e.clientX - g.downX;
    const dyClient = e.clientY - g.downY;

    if (!g.mark) {
      // Nothing is written until the press has travelled. The fader and a
      // stretch move in value only, so only vertical travel makes them a drag.
      const travelled = g.kind === 'keyframe' ? Math.hypot(dxClient, dyClient) : Math.abs(dyClient);
      if (travelled < LINE_DRAG_THRESHOLD_PX) return;
      g.mark = undoMark();
      useEditorStore.getState().beginUndoGroup();
      if (g.kind === 'fader') p.onFaderGestureStart(g.trackId);
    }

    if (g.kind === 'fader') {
      const v = clamp01(g.startVolume + g.acc);
      if (v !== g.sentVolume) {
        g.sentVolume = v;
        p.onFaderChange(g.trackId, v);
      }
      setDrag({ kind: 'fader', index: -1, x: at.x, t: g.grabT });
      return;
    }

    if (g.kind === 'segment') {
      const d = clampSegmentDelta(g.grabbed.map((k) => k.v), g.acc);
      let found = 0;
      for (const k of g.grabbed) {
        // The write before this one replaced the lane, so it is read again.
        const l = laneById(g.laneId);
        const i = l ? indexAtTime(l.points, k.t) : -1;
        if (!l || i < 0) continue;
        found += 1;
        const v = clamp01(k.v + d);
        // A write that changes nothing would still record an undo step.
        if (l.points[i].v !== v) useEditorStore.getState().updateAutomationPoint(l.id, i, l.points[i].t, v);
      }
      // Every grabbed keyframe is gone (an undo, a cleared lane): nothing left to drag.
      if (found === 0) {
        finish('cancel');
        return;
      }
      setDrag({ kind: 'segment', index: -1, x: at.x, t: g.grabT });
      return;
    }

    const l = laneById(g.laneId);
    const index = l ? indexAtTime(l.points, g.t) : -1;
    if (!l || index < 0) {
      finish('cancel');
      return;
    }
    // The time stays put until the drag has clearly gone sideways, and is free from then on.
    if (!g.timeUnlocked && Math.abs(dxClient) >= KEYFRAME_TIME_STICK_PX) g.timeUnlocked = true;
    // In seconds from the press, so a zoom or a scroll during the drag does not move the keyframe.
    const pps = perSecond(p.zoom);
    const next = dragKeyframe(
      l.points,
      index,
      g.grabbed[0],
      { dtSec: at.x / pps - g.pressT, dv: g.acc },
      { maxT: p.width / pps, timeUnlocked: g.timeUnlocked, snap: e.altKey ? undefined : p.snap },
    );
    const was = l.points[index];
    if (next.t !== was.t || next.v !== was.v) {
      const keys = useVolumeKeyframes.getState();
      const selectedHere = keys.selected !== null && keys.selected.trackId === g.trackId && sameTime(keys.selected.t, was.t);
      useEditorStore.getState().updateAutomationPoint(l.id, index, next.t, next.v);
      g.t = next.t;
      if (selectedHere) keys.retime(next.t);
    }
    setDrag((cur) => (cur !== null && cur.kind === 'keyframe' && cur.index === index ? cur : { kind: 'keyframe', index, x: 0, t: 0 }));
  };

  /* ── Pointer ────────────────────────────────────────────────────────────── */

  const onHitPointerDown = (e: React.PointerEvent<SVGPolylineElement>): void => {
    // The lanes under the line never start a marquee from a press on it.
    e.stopPropagation();
    const p = latest.current;
    if (!p.interactive || !isPrimaryGestureButton(e, IS_MAC)) return;
    const at = toRow(e.clientX, e.clientY);
    if (!at || !claimPointer(e.pointerId)) return;
    focusLine();
    const id = p.track.id;
    const t = Math.max(0, at.x / perSecond(p.zoom));
    const ed = useEditorStore.getState();
    const liveLane = volumeLaneOf(ed.automationLanes, id);
    const points = liveLane?.points ?? NO_POINTS;
    const indices = grabbedKeyframes(points, p.zoom, t, liveSelectedIndex(id));
    if (liveLane && indices.length > 0) {
      begin(e, at, {
        kind: 'segment',
        grabT: t,
        laneId: liveLane.id,
        grabbed: indices.map((i) => ({ t: points[i].t, v: points[i].v })),
      });
      return;
    }
    const liveTrack = ed.tracks.find((x) => x.id === id);
    if (!liveTrack) return;
    begin(e, at, { kind: 'fader', grabT: t, startVolume: clamp01(liveTrack.volume) });
  };

  /** A right-click or a double-click on the line: a keyframe there. One that is
   *  already under the pointer is selected instead. */
  const addOrSelectAt = (clientX: number, clientY: number, offGrid: boolean): void => {
    const p = latest.current;
    const at = toRow(clientX, clientY);
    if (!p.interactive || !at || gestureRef.current) return;
    // First, so a value field that was open commits before the line is read.
    focusLine();
    const id = p.track.id;
    const raw = Math.max(0, at.x / perSecond(p.zoom));
    const snapped = offGrid ? raw : p.snap(raw);
    const t = Number.isFinite(snapped) ? Math.max(0, snapped) : raw;
    const points = volumeLaneOf(useEditorStore.getState().automationLanes, id)?.points ?? NO_POINTS;
    const near = keyframeNear(points, t, p.zoom, KEYFRAME_PICK_PX);
    let ref: VolumeKeyframeRef | null;
    if (near >= 0) {
      ref = { trackId: id, t: points[near].t };
      useVolumeKeyframes.getState().select(ref);
    } else {
      ref = addVolumeKeyframe(id, t);
    }
    if (ref) p.onKeyframeSelected();
  };

  const onHitContextMenu = (e: React.MouseEvent<SVGPolylineElement>): void => {
    // Never the browser's menu and never the lanes' "Add to track" menu.
    e.preventDefault();
    e.stopPropagation();
    addOrSelectAt(e.clientX, e.clientY, e.altKey);
  };

  const onHitDoubleClick = (e: React.MouseEvent<SVGPolylineElement>): void => {
    e.stopPropagation();
    addOrSelectAt(e.clientX, e.clientY, e.altKey);
  };

  const onKeyframePointerDown = (e: React.PointerEvent<SVGCircleElement>, t: number): void => {
    e.stopPropagation();
    const p = latest.current;
    if (!p.interactive || !isPrimaryGestureButton(e, IS_MAC)) return;
    const ref: VolumeKeyframeRef = { trackId: p.track.id, t };
    const at = toRow(e.clientX, e.clientY);
    if (!resolveVolumeKeyframe(ref) || !at || !claimPointer(e.pointerId)) return;
    // Alt-click is the app's point-delete gesture (AutomationLane, CcLane).
    if (e.altKey) {
      deleteVolumeKeyframe(ref);
      return;
    }
    useVolumeKeyframes.getState().select(ref);
    p.onKeyframeSelected();
    focusLine();
    // Read after the focus moved: that commits a value field that was open, and
    // the drag starts from the value the keyframe holds once it has.
    const hit = resolveVolumeKeyframe(ref);
    if (!hit) return;
    begin(e, at, {
      kind: 'keyframe',
      grabT: hit.point.t,
      laneId: hit.lane.id,
      grabbed: [{ t: hit.point.t, v: hit.point.v }],
    });
  };

  /** Select a keyframe and open its menu at a viewport point. */
  const openMenuFor = (ref: VolumeKeyframeRef, at: { x: number; y: number }): void => {
    const p = latest.current;
    if (!p.interactive || gestureRef.current || !resolveVolumeKeyframe(ref)) return;
    useVolumeKeyframes.getState().select(ref);
    p.onKeyframeSelected();
    // Before the menu opens: it hands the focus back to whatever had it.
    focusLine();
    p.onKeyframeMenu(at, ref);
  };

  const onKeyframeContextMenu = (e: React.MouseEvent<Element>, t: number): void => {
    e.preventDefault();
    e.stopPropagation();
    openMenuFor({ trackId: latest.current.track.id, t }, { x: e.clientX, y: e.clientY });
  };

  const onKeyframeDoubleClick = (e: React.MouseEvent<SVGCircleElement>, t: number): void => {
    e.stopPropagation();
    const p = latest.current;
    const ref: VolumeKeyframeRef = { trackId: p.track.id, t };
    if (!p.interactive || !resolveVolumeKeyframe(ref)) return;
    const keys = useVolumeKeyframes.getState();
    keys.select(ref);
    p.onKeyframeSelected();
    keys.setEditing(true);
  };

  // The pressed element holds the capture, so its moves and its release arrive
  // here by way of it. A move or a release that is NOT this line's gesture is
  // left alone: a Ctrl+drag copy of a clip holds no capture, and its moves and
  // its release pass over the line on their way to the timeline's own handlers.
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    e.stopPropagation();
    moveGesture(g, e);
  };

  const onPointerEnd = (e: React.PointerEvent<SVGSVGElement>): void => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    e.stopPropagation();
    finish(e.type === 'pointerup' ? 'release' : 'cancel');
  };

  /** The Menu key or Shift+F10 on the focused line: the selected keyframe's
   *  menu, at the keyframe. With none selected the timeline's own menu opens. */
  const onLineContextMenu = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (e.target !== e.currentTarget) return;
    const p = latest.current;
    const sel = useVolumeKeyframes.getState().selected;
    const hit = sel !== null && sel.trackId === p.track.id ? resolveVolumeKeyframe(sel) : null;
    if (!p.interactive || !hit) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const cssZoom = effectiveZoom(svg);
    const x = rect.left + hit.point.t * p.zoom * cssZoom;
    const y = rect.top + volumeToY(hit.point.v, volumeBand(p.trackHeight)) * cssZoom;
    openMenuFor(
      { trackId: p.track.id, t: hit.point.t },
      { x: Math.max(0, Math.min(window.innerWidth, x)), y: Math.max(0, Math.min(window.innerHeight, y)) },
    );
  };

  /* ── Keys ───────────────────────────────────────────────────────────────── */

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>): void => {
    const p = latest.current;
    if (!p.interactive || e.ctrlKey || e.metaKey || e.altKey) return;
    const id = p.track.id;
    const points = volumeLaneOf(useEditorStore.getState().automationLanes, id)?.points ?? NO_POINTS;
    const keys = useVolumeKeyframes.getState();
    const own = keys.selected !== null && keys.selected.trackId === id ? keys.selected : null;
    const sel = own ? resolveVolumeKeyframe(own) : null;
    const ref: VolumeKeyframeRef | null = sel ? { trackId: id, t: sel.point.t } : null;
    const selectAt = (index: number): void => {
      keys.select({ trackId: id, t: points[index].t });
      p.onKeyframeSelected();
    };
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        const db = (e.shiftKey ? KEYFRAME_NUDGE_DB_COARSE : KEYFRAME_NUDGE_DB) * (e.key === 'ArrowUp' ? 1 : -1);
        if (ref) {
          nudgeVolumeKeyframe(ref, db);
        } else if (points.length === 0) {
          // The bare line is the fader: one press is one whole fader gesture.
          const liveTrack = useEditorStore.getState().tracks.find((x) => x.id === id);
          const next = liveTrack ? nudgeVolumeDb(liveTrack.volume, db) : null;
          if (liveTrack && next !== null && next !== liveTrack.volume) {
            p.onFaderGestureStart(id);
            p.onFaderChange(id, next);
            p.onFaderGestureEnd(id);
          }
        } else {
          handled = false;
        }
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        if (ref && sel) {
          const step = p.timeStep(e.shiftKey, sel.point.t) * (e.key === 'ArrowLeft' ? -1 : 1);
          moveVolumeKeyframeTime(ref, step, p.width / perSecond(p.zoom));
        } else {
          handled = false;
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (ref) deleteVolumeKeyframe(ref);
        else handled = false;
        break;
      case 'Enter':
        if (ref) keys.setEditing(true);
        else handled = false;
        break;
      case 'Escape':
        if (own) keys.select(null);
        else handled = false;
        break;
      case 'Home':
      case 'End':
        if (points.length > 0) selectAt(e.key === 'Home' ? 0 : points.length - 1);
        else handled = false;
        break;
      case 'PageUp':
      case 'PageDown':
        if (points.length > 0) {
          // The previous or the next keyframe. With none selected, the last or the first.
          const step = e.key === 'PageUp' ? -1 : 1;
          const from = sel ? sel.index : step < 0 ? points.length : -1;
          selectAt(Math.max(0, Math.min(points.length - 1, from + step)));
        } else {
          handled = false;
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      // Both, as SlideTrack does: the timeline's window shortcuts share these keys.
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /* ── The selection ──────────────────────────────────────────────────────── */

  // A press anywhere else drops this line's selection and its focus, so Delete
  // and the arrows cannot reach a keyframe after the user has clicked a clip.
  // A press on a menu is left alone: the keyframe menu acts on the selection.
  const holdsSelection = selectedT !== null;
  useEffect(() => {
    if (!holdsSelection && !focused) return undefined;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Element | null;
      if (!target || typeof target.closest !== 'function') return;
      if (wrapRef.current?.contains(target)) return;
      if (target.closest('[data-volume-keyframe-ui], [role="menu"]')) return;
      // A value still being typed is kept: the field commits on blur, and this
      // press is about to take the field away before its blur can run.
      fieldCommitRef.current?.();
      const keys = useVolumeKeyframes.getState();
      if (keys.selected !== null && keys.selected.trackId === latest.current.track.id) keys.select(null);
      const svg = svgRef.current;
      if (svg && document.activeElement === svg) svg.blur();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [holdsSelection, focused]);

  // The field closes when its keyframe is gone or the line stops taking input.
  useEffect(() => {
    if (!editing) return;
    const keys = useVolumeKeyframes.getState();
    if (!interactive || resolveVolumeKeyframe(keys.selected) === null) keys.setEditing(false);
  }, [editing, interactive, lane]);

  const onFieldDone = useCallback((target: VolumeKeyframeRef, refocus: boolean): void => {
    const keys = useVolumeKeyframes.getState();
    const sel = keys.selected;
    // Only this field's keyframe: the selection may have moved on by the time a blur commits.
    if (sel !== null && sel.trackId === target.trackId && sameTime(sel.t, target.t)) keys.setEditing(false);
    if (refocus) svgRef.current?.focus({ preventScroll: true });
  }, []);

  /* ── Drawing ────────────────────────────────────────────────────────────── */

  const points = lane?.points ?? NO_POINTS;
  const hasKeyframes = points.length > 0;
  const bypassed = hasKeyframes && lane?.enabled === false;
  const band = volumeBand(trackHeight);
  const faderVolume = clamp01(track.volume);

  // The lane's own path (it samples a bent stretch exactly as playback does),
  // carried flat to both edges of the timeline. With no keyframes, the fader.
  const linePoints = useMemo(() => {
    const b = volumeBand(trackHeight);
    const yOf = (v: number): number => volumeToY(v, b);
    let verts: [number, number][];
    if (points.length === 0) {
      const y = yOf(track.volume);
      verts = [[0, y], [width, y]];
    } else {
      const path = lanePathPoints(points, zoom, yOf);
      const last = path[path.length - 1];
      verts = ([[0, path[0][1]]] as [number, number][]).concat(path, [[Math.max(width, last[0]), last[1]]]);
    }
    return verts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  }, [points, zoom, trackHeight, width, track.volume]);

  const selectedIndex = selectedT === null ? -1 : keyframeIndexAt(points, selectedT);
  const selectedPoint = selectedIndex >= 0 ? points[selectedIndex] : null;
  const dragIndex = drag !== null && drag.kind === 'keyframe' && drag.index < points.length ? drag.index : -1;
  // The handles in view, a handle's reach past both edges so one does not pop
  // in half drawn. The handle under a drag holds the pointer capture, so it
  // stays mounted wherever the drag takes it.
  const reach = HANDLE_GRAB_R_PX / perSecond(zoom);
  const inView = visibleKeyframes(points, zoom, fromSec - reach, toSec + reach, HANDLE_MIN_GAP_PX, selectedIndex >= 0 ? selectedIndex : dragIndex);
  const handles = dragIndex >= 0 && !inView.includes(dragIndex) ? [...inView, dragIndex].sort((a, b) => a - b) : inView;

  const color = bypassed ? BYPASS_COLOR : LINE_COLOR;
  const emphasised = (hover && interactive) || drag !== null || focused;
  const strokeOpacity = emphasised ? 1 : bypassed ? 0.6 : hasKeyframes ? 0.9 : 0.5;

  const valueNow = selectedPoint ? clamp01(selectedPoint.v) : hasKeyframes ? clamp01(points[0].v) : faderVolume;
  const valueText = selectedPoint
    ? `${formatVolumeDb(selectedPoint.v)} at ${formatCursorTime(selectedPoint.t)}`
    : hasKeyframes
      ? 'No keyframe selected'
      : `${formatVolumeDb(faderVolume)}, no keyframes`;

  /** Where a chip sits for a point at row (x, y): to its right and centred on
   *  it, on its left when it would pass the right edge of the view, and inside
   *  the row. On whole px, so its text is drawn sharp. */
  const chipAt = (x: number, y: number): React.CSSProperties => {
    const flip = x + CHIP_GAP_PX + CHIP_ROOM_PX > toSec * zoom && x - CHIP_GAP_PX - CHIP_ROOM_PX >= fromSec * zoom;
    return {
      left: Math.round(flip ? x - CHIP_GAP_PX : x + CHIP_GAP_PX),
      top: Math.round(Math.max(0, Math.min(trackHeight - CHIP_HEIGHT_PX, y - CHIP_HEIGHT_PX / 2))),
      transform: flip ? 'translateX(-100%)' : undefined,
    };
  };

  // A fader or a stretch drag in flight: the level under the pointer, beside it.
  const dragLevel = drag === null || drag.kind === 'keyframe'
    ? null
    : drag.kind === 'fader' ? faderVolume : lineValueAt(points, faderVolume, drag.t);

  return (
    <div
      ref={wrapRef}
      data-volume-line={trackId}
      className="absolute left-0 z-26 pointer-events-none select-none"
      style={{ top, width, height: trackHeight }}
    >
      <svg
        ref={svgRef}
        role="slider"
        tabIndex={interactive ? 0 : -1}
        aria-orientation="vertical"
        aria-label={`${track.name} volume line, ${keyframeCount(points.length)}`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={valueNow}
        aria-valuetext={valueText}
        aria-describedby={helpId}
        aria-disabled={interactive ? undefined : true}
        width={width}
        height={trackHeight}
        className={`absolute left-0 top-0 overflow-visible outline-none${ringed ? ' ring-1 ring-inset ring-emerald-400/60' : ''}`}
        style={{ pointerEvents: 'none' }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setFocused(true);
          setRinged(lastInputWasKey);
        }}
        onBlur={() => {
          setFocused(false);
          setRinged(false);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onContextMenu={onLineContextMenu}
      >
        <polyline
          points={linePoints}
          fill="none"
          stroke={color}
          strokeWidth={emphasised ? 2 : 1.5}
          strokeOpacity={strokeOpacity}
          strokeDasharray={bypassed ? '4 3' : undefined}
          strokeLinejoin="round"
          pointerEvents="none"
        />
        <g onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
          {/* One element in both states (the fader and the keyframed line): it
              holds the pointer capture during a drag and must never remount. */}
          <polyline
            key="hit"
            data-volume-hit=""
            points={linePoints}
            fill="none"
            stroke="transparent"
            strokeWidth={HIT_WIDTH_PX}
            pointerEvents={interactive ? 'stroke' : 'none'}
            style={{ cursor: 'ns-resize', touchAction: 'none' }}
            onPointerDown={onHitPointerDown}
            onContextMenu={onHitContextMenu}
            onDoubleClick={onHitDoubleClick}
          >
            <title>Drag to set the volume. Right-click or double-click to add a keyframe.</title>
          </polyline>
          {/* Drawn after the hit line, so a keyframe wins where the two overlap. */}
          {handles.map((i) => {
            const point = points[i];
            const x = point.t * zoom;
            const y = volumeToY(point.v, band);
            const dragged = i === dragIndex;
            const selected = i === selectedIndex || dragged;
            const half = selected ? HANDLE_HALF_SELECTED_PX : HANDLE_HALF_PX;
            return (
              <g key={i}>
                <rect
                  x={x - half}
                  y={y - half}
                  width={half * 2}
                  height={half * 2}
                  transform={`rotate(45 ${x} ${y})`}
                  fill={selected ? '#fff' : color}
                  stroke={selected ? color : '#fff'}
                  strokeWidth={selected ? 2 : 1}
                  pointerEvents="none"
                />
                <circle
                  data-volume-keyframe={i}
                  cx={x}
                  cy={y}
                  r={HANDLE_GRAB_R_PX}
                  fill="transparent"
                  pointerEvents={interactive ? 'all' : 'none'}
                  style={{ cursor: dragged ? 'grabbing' : 'grab', touchAction: 'none' }}
                  onPointerDown={(e) => onKeyframePointerDown(e, point.t)}
                  onContextMenu={(e) => onKeyframeContextMenu(e, point.t)}
                  onDoubleClick={(e) => onKeyframeDoubleClick(e, point.t)}
                >
                  <title>Drag to move. Arrow keys nudge. Double-click to type a value. Right-click for more.</title>
                </circle>
              </g>
            );
          })}
        </g>
      </svg>
      {drag !== null && dragLevel !== null && (
        <span
          data-volume-keyframe-ui=""
          className={`absolute pointer-events-none flex items-center whitespace-nowrap ${CHIP}`}
          style={chipAt(drag.x, volumeToY(dragLevel, band))}
        >
          {formatVolumeDb(dragLevel)}
        </span>
      )}
      {selectedPoint && (
        <div
          data-volume-keyframe-ui=""
          className={`absolute flex ${interactive ? 'pointer-events-auto' : 'pointer-events-none'}`}
          style={chipAt(selectedPoint.t * zoom, volumeToY(selectedPoint.v, band))}
          // A press on the chip is the chip's: the lanes under it start no marquee
          // and open no menu of their own. A right-click opens the keyframe's menu,
          // except in the open field, where it is the text field's own.
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            if (editing) e.stopPropagation();
            else onKeyframeContextMenu(e, selectedPoint.t);
          }}
        >
          {!interactive ? (
            <span className={`flex items-center whitespace-nowrap ${CHIP}`}>{formatVolumeDb(selectedPoint.v)}</span>
          ) : editing ? (
            <KeyframeValueField
              // A field belongs to one keyframe: another keyframe gets a field of its own.
              key={selectedPoint.t}
              id={fieldId}
              target={{ trackId, t: selectedPoint.t }}
              value={selectedPoint.v}
              commitRef={fieldCommitRef}
              onDone={onFieldDone}
            />
          ) : (
            <button
              type="button"
              aria-label="Type a volume for this keyframe"
              title="Type a volume for this keyframe"
              className={`whitespace-nowrap cursor-text outline-none hover:border-emerald-300 hover:text-white focus-visible:ring-1 focus-visible:ring-emerald-300 ${CHIP}`}
              onClick={(e) => {
                e.stopPropagation();
                useVolumeKeyframes.getState().setEditing(true);
              }}
            >
              {formatVolumeDb(selectedPoint.v)}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export interface TrackVolumeLinesProps {
  tracks: readonly EditorTrack[];
  /** every lane; the component picks each track's trackVolume lane */
  lanes: readonly AutomationLane[];
  /** px per second */
  zoom: number;
  /** local px, uniform */
  trackHeight: number;
  /** timeline content width, local px */
  width: number;
  /** visible time window, for windowing the handles */
  fromSec: number;
  toSec: number;
  /** false while the cut tool is active */
  interactive: boolean;
  /** the editor's snapSec */
  snap: (sec: number) => number;
  /** the editor's nudge step, for the left/right keys */
  timeStep: (coarse: boolean, atSec: number) => number;
  /** the SAME write the header fader makes */
  onFaderChange: (trackId: string, v: number) => void;
  onFaderGestureStart: (trackId: string) => void;
  onFaderGestureEnd: (trackId: string) => void;
  /** the editor drops its clip selection */
  onKeyframeSelected: () => void;
}

/**
 * Every track's volume line, and the one keyframe menu they share. The editor
 * mounts it once, inside the lanes.
 */
export function TrackVolumeLines(props: TrackVolumeLinesProps) {
  const { tracks, lanes, zoom, trackHeight, width, fromSec, toSec, interactive } = props;
  // The editor hands over fresh callbacks on every render. The lines get stable
  // ones that read the newest through this ref, so a line re-renders only when
  // its own track, lane or geometry changed.
  const latest = useRef(props);
  latest.current = props;
  const snap = useCallback((sec: number) => latest.current.snap(sec), []);
  const timeStep = useCallback((coarse: boolean, atSec: number) => latest.current.timeStep(coarse, atSec), []);
  const onFaderChange = useCallback((trackId: string, v: number) => latest.current.onFaderChange(trackId, v), []);
  const onFaderGestureStart = useCallback((trackId: string) => latest.current.onFaderGestureStart(trackId), []);
  const onFaderGestureEnd = useCallback((trackId: string) => latest.current.onFaderGestureEnd(trackId), []);
  const onKeyframeSelected = useCallback(() => latest.current.onKeyframeSelected(), []);

  const helpId = `volume-line-help-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  // Each track's volume lane, found by the key the store resolves a lane by
  // (state/volumeKeyframes volumeLaneOf): the first lane with that key.
  const laneByKey = useMemo(() => {
    const byKey = new Map<string, AutomationLane>();
    for (const l of lanes) {
      if (l.target.kind !== 'trackVolume') continue;
      const key = automationTargetKey(l.target);
      if (!byKey.has(key)) byKey.set(key, l);
    }
    return byKey;
  }, [lanes]);
  const laneOf = (trackId: string): AutomationLane | undefined => laneByKey.get(automationTargetKey(volumeTarget(trackId)));

  const menu = useContextMenu<VolumeKeyframeRef>();
  const openMenu = menu.open;
  const onKeyframeMenu = useCallback(
    (at: { x: number; y: number }, ref: VolumeKeyframeRef) => {
      // useContextMenu reads its anchor off a mouse event. A menu opened from
      // the keyboard has no pointer, so the line hands over the point itself.
      openMenu({ clientX: at.x, clientY: at.y, preventDefault: () => undefined } as unknown as MouseEvent, ref);
    },
    [openMenu],
  );

  const menuRef = menu.payload;
  const menuLane = menuRef ? laneOf(menuRef.trackId) : undefined;
  const menuIndex = menuRef && menuLane ? keyframeIndexAt(menuLane.points, menuRef.t) : -1;
  const menuPoint = menuLane && menuIndex >= 0 ? menuLane.points[menuIndex] : null;
  const menuCount = menuLane?.points.length ?? 0;
  const menuItems: ContextMenuItem[] = menuRef
    ? [
      { type: 'header', label: `Keyframe at ${formatCursorTime(menuRef.t)}` },
      {
        type: 'item',
        label: 'Set volume',
        icon: <Volume2 className="w-3 h-3" />,
        hint: menuPoint ? formatVolumeDb(menuPoint.v) : undefined,
        title: 'Type a volume for this keyframe in decibels',
        disabled: !menuPoint,
        onSelect: () => {
          const keys = useVolumeKeyframes.getState();
          keys.select(menuRef);
          keys.setEditing(true);
        },
      },
      {
        type: 'item',
        label: 'Unity',
        icon: <ArrowUpToLine className="w-3 h-3" />,
        hint: '0.0 dB',
        title: 'Set this keyframe to 0.0 dB, the loudest the line goes',
        disabled: !menuPoint,
        onSelect: () => setVolumeKeyframeValue(menuRef, 1),
      },
      {
        type: 'item',
        label: 'Delete',
        icon: <Trash2 className="w-3 h-3" />,
        hint: 'Del',
        danger: true,
        disabled: !menuPoint,
        onSelect: () => deleteVolumeKeyframe(menuRef),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Bypass',
        icon: <Power className="w-3 h-3" />,
        title: 'Switch the volume keyframes of this track off and keep them. The track fader sets the volume while they are off.',
        checked: menuLane?.enabled === false,
        disabled: !menuLane,
        onSelect: () => toggleVolumeKeyframesBypass(menuRef.trackId),
      },
      {
        type: 'item',
        label: 'Clear',
        icon: <Eraser className="w-3 h-3" />,
        hint: keyframeCount(menuCount),
        title: 'Delete every volume keyframe on this track',
        danger: true,
        disabled: menuCount === 0,
        onSelect: () => clearVolumeKeyframes(menuRef.trackId),
      },
    ]
    : [];

  return (
    <>
      {/* A folder is a row with no audio of its own (it gets no mixer node), so
          it has no volume to draw. It still takes its row. */}
      {tracks.map((track, i) => (track.isFolder ? null : (
        <TrackVolumeLine
          key={track.id}
          track={track}
          lane={laneOf(track.id)}
          top={i * trackHeight}
          zoom={zoom}
          trackHeight={trackHeight}
          width={width}
          fromSec={fromSec}
          toSec={toSec}
          interactive={interactive}
          helpId={helpId}
          snap={snap}
          timeStep={timeStep}
          onFaderChange={onFaderChange}
          onFaderGestureStart={onFaderGestureStart}
          onFaderGestureEnd={onFaderGestureEnd}
          onKeyframeSelected={onKeyframeSelected}
          onKeyframeMenu={onKeyframeMenu}
        />
      )))}
      <p id={helpId} className="sr-only">
        Drag the line up or down to set the track volume. Right-click or double-click the line to add a keyframe. Drag
        a keyframe to move it, with Shift for a fine drag and Alt to leave the grid. Drag the line between two
        keyframes to move both. With a keyframe selected, the up and down arrow keys change its volume by 0.1 dB, or
        1 dB with Shift, the left and right arrow keys move it in time, Enter opens a field to type a volume, Delete
        removes it, Escape deselects it and the Menu key opens its menu. Home and End select the first and the last
        keyframe, Page Up and Page Down the one before and the one after. With no keyframes, the up and down arrow keys
        move the track fader.
      </p>
      {/* The menu is a portal, and React bubbles a portal's events to the
          portal's React parents: here, the lanes. Without this a press on a
          menu row would start the lanes' marquee, which takes the pointer
          capture and with it the click the row was waiting for. */}
      <div
        className="contents"
        onPointerDown={stopBubble}
        onPointerMove={stopBubble}
        onPointerUp={stopBubble}
        onPointerCancel={stopBubble}
      >
        <ContextMenu position={menu.position} onClose={menu.close} items={menuItems} />
      </div>
    </>
  );
}
