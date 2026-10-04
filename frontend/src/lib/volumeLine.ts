/**
 * The EDIT track volume line's model.
 *
 * Every track row in the EDIT timeline draws one line
 * (components/audio/TrackVolumeLine). With no keyframes it is flat at the
 * track fader's value and a drag moves the fader. With keyframes it is the
 * track's volume automation lane: a keyframe drags in time and value, and the
 * stretch between two keyframes drags up and down as one.
 *
 * Values are LINEAR gain in 0..1, the unit the fader and every automation lane
 * already use. 1 is unity (0 dB) and there is no boost above it. Readouts and
 * typed values are in decibels.
 *
 * Pure: no React, no DOM, no store. The points are `CurvePoint`s and the line
 * is read through `sampleCurve`, the sampler playback uses, so the line, a new
 * keyframe's value and the sound cannot disagree.
 */
import { sampleCurve, type CurvePoint } from './automationModes';

/* ── The band ─────────────────────────────────────────────────────────────── */

/** Row px between a row's top edge and the band: the clip inset (6), the clip
 *  header strip (14) and 4 of air, so the line never covers a clip's name. */
export const VOLUME_BAND_TOP_PX = 24;
/** Row px between the band and a row's bottom edge: the clip inset (6) and 4 of air. */
export const VOLUME_BAND_BOTTOM_PX = 10;
/** The band is never shorter than this, however short the row. */
export const VOLUME_BAND_MIN_PX = 8;

/** The strip of one track row the line lives in, in the row's local px. Unity
 *  is its top edge and silence its bottom edge. */
export interface VolumeBand {
  top: number;
  height: number;
}

/** A volume is always a usable number in 0..1. Junk (NaN, an infinity) reads
 *  as silence, never as loud. */
export const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/** The band of a row `trackHeightPx` tall. */
export function volumeBand(trackHeightPx: number): VolumeBand {
  const rowPx = Number.isFinite(trackHeightPx) ? trackHeightPx : 0;
  return {
    top: VOLUME_BAND_TOP_PX,
    height: Math.max(VOLUME_BAND_MIN_PX, rowPx - VOLUME_BAND_TOP_PX - VOLUME_BAND_BOTTOM_PX),
  };
}

/** The row y of volume `v`. Screen y grows downward, so unity is the band's top. */
export function volumeToY(v: number, band: VolumeBand): number {
  return band.top + (1 - clamp01(v)) * band.height;
}

/** The volume at row y: unity at and above the band's top, silence at and below its bottom. */
export function yToVolume(y: number, band: VolumeBand): number {
  return clamp01(1 - (y - band.top) / Math.max(1e-6, band.height));
}

/* ── Decibels ─────────────────────────────────────────────────────────────── */

/** The quietest level that still reads as a number. Below this the line is silent. */
export const VOLUME_DB_FLOOR = -60;

/** Decibels to linear gain with no floor and no ceiling. */
const dbToGainRaw = (db: number): number => 10 ** (db / 20);

/** The linear gain of the floor itself, 0.001. */
const FLOOR_GAIN = dbToGainRaw(VOLUME_DB_FLOOR);

/** A gain under the floor is silence. The 0.1% of slack keeps a gain that IS
 *  the floor, give or take float error, on the floor. */
const isSilent = (v: number): boolean => v < FLOOR_GAIN * 0.999;

const roundToTenth = (db: number): number => Math.round(db * 10) / 10;

/** Linear gain to decibels. Silence (0, a negative, NaN) has no level: -Infinity. */
export function gainToDb(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : Number.NEGATIVE_INFINITY;
}

/** Decibels to the linear gain a keyframe stores: silence at and under the
 *  floor, unity at and above 0 dB. An unreadable level is silence. */
export function dbToGain(db: number): number {
  if (!(db > VOLUME_DB_FLOOR)) return 0;
  if (db >= 0) return 1;
  return dbToGainRaw(db);
}

/** The readout: "-inf dB" under the floor, "0.0 dB" at unity, otherwise one
 *  decimal, as "-6.0 dB". A level within 0.05 dB of unity reads as unity, so
 *  the text is never "-0.0 dB". */
export function formatVolumeDb(v: number): string {
  const gain = clamp01(v);
  if (isSilent(gain)) return '-inf dB';
  const db = gainToDb(gain);
  return db > -0.05 ? '0.0 dB' : `${db.toFixed(1)} dB`;
}

/** The words a typed value may use for silence. */
const SILENCE_WORDS: ReadonlySet<string> = new Set(['-inf', '-infinity', 'inf', 'mute', 'off']);

/** A plain decimal number with an optional sign: "-6", "-6.5", ".5", "+3". */
const DECIBEL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * A typed level, as linear gain, or null when the text is unreadable.
 *
 * Case and outer spaces do not matter, a trailing "dB" is dropped and a
 * decimal comma is read as a point, so a readout's own text can be typed back.
 * A number above 0 is unity and a number at or under the floor is silence. That
 * includes -60 itself: the floor is reached by a key step, never by typing.
 */
export function parseVolumeDb(text: string): number | null {
  let s = String(text ?? '').trim().toLowerCase();
  if (s.endsWith('db')) s = s.slice(0, -2).trim();
  if (SILENCE_WORDS.has(s)) return 0;
  s = s.replace(',', '.');
  if (!DECIBEL_NUMBER.test(s)) return null;
  const db = Number(s);
  return Number.isFinite(db) ? dbToGain(db) : null;
}

/**
 * Volume `v` moved by `deltaDb` decibels.
 *
 * The step is taken in dB and the result is rounded to one decimal, so
 * repeated presses land on clean values (-6.0206 + 0.1 gives -5.9). From
 * silence a step up lands exactly on the floor (-60 dB), from the floor a step
 * up is -59.9 (or -59 for a whole dB), and a step below the floor is silence.
 * The result never passes unity.
 */
export function nudgeVolumeDb(v: number, deltaDb: number): number {
  const gain = clamp01(v);
  if (!Number.isFinite(deltaDb) || deltaDb === 0) return gain;
  if (isSilent(gain)) return deltaDb > 0 ? FLOOR_GAIN : 0;
  const db = roundToTenth(gainToDb(gain) + deltaDb);
  if (db < VOLUME_DB_FLOOR) return 0;
  if (db >= 0) return 1;
  return dbToGainRaw(db);
}

/* ── Gesture constants ────────────────────────────────────────────────────── */

/** One arrow key press on a selected keyframe, in dB. */
export const KEYFRAME_NUDGE_DB = 0.1;
/** The same press with Shift held. */
export const KEYFRAME_NUDGE_DB_COARSE = 1;
/** A dragged or nudged keyframe stays this far (seconds) from its neighbours.
 *  It is AutomationLane's DRAG_GAP: comfortably beyond the store's 0.02 s
 *  thinning window, so a move never merges into a neighbour. */
export const KEYFRAME_DRAG_GAP_SEC = 0.03;
/** Client px a press must travel before it edits anything. */
export const LINE_DRAG_THRESHOLD_PX = 3;
/** Horizontal px a keyframe drag must travel before it changes the keyframe's
 *  time, so a drag meant to set the volume does not also shift it. */
export const KEYFRAME_TIME_STICK_PX = 6;
/** The share of the pointer's travel a drag applies while Shift is held. */
export const FINE_DRAG_FACTOR = 0.25;

/** How close two keyframe handles may sit on screen, in px, unless the caller says otherwise. */
const HANDLE_MIN_GAP_PX = 10;

/* ── The line ─────────────────────────────────────────────────────────────── */

/** The line's value at `t`: the lane's own value when it has keyframes, else
 *  the fader's. It is what a keyframe added at `t` takes, so the line does not
 *  move when the keyframe lands. */
export function lineValueAt(points: readonly CurvePoint[], faderVolume: number, t: number): number {
  return clamp01(sampleCurve(points, t) ?? faderVolume);
}

/** What a press on the line takes hold of: the fader while the line has no
 *  keyframes, else the keyframes at the ends of the stretch under the pointer. */
export type LineGrab = { kind: 'fader' } | { kind: 'segment'; indices: number[] };

/**
 * What a press on the line at time `t` grabs.
 *
 * At or before the first keyframe it is that keyframe alone, and at or after
 * the last it is the last alone: the flat run the line holds outside its
 * keyframes belongs to the nearest one. Anywhere else it is the two keyframes
 * that bracket `t`, found by the search `sampleCurve` runs, so the grabbed pair
 * is the pair the drawn stretch runs between.
 */
export function grabAt(points: readonly CurvePoint[], t: number): LineGrab {
  const n = points.length;
  if (n === 0) return { kind: 'fader' };
  if (!(t > points[0].t)) return { kind: 'segment', indices: [0] };
  if (t >= points[n - 1].t) return { kind: 'segment', indices: [n - 1] };
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return { kind: 'segment', indices: [lo, hi] };
}

/**
 * How far the grabbed keyframes, sitting at `values`, may move for a drag of
 * `dv`. The delta is limited to `[-min(values), 1 - max(values)]`, so the
 * keyframes keep their difference and none leaves 0..1: the stretch stops as a
 * whole when its loudest keyframe reaches unity or its quietest reaches silence.
 */
export function clampSegmentDelta(values: readonly number[], dv: number): number {
  if (values.length === 0 || !Number.isFinite(dv)) return 0;
  let min = 1;
  let max = 0;
  for (const raw of values) {
    const v = clamp01(raw);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const d = Math.max(-min, Math.min(1 - max, dv));
  return d === 0 ? 0 : d; // a limit of -0 reads as plain 0
}

/** The times keyframe `index` may take: clear of both neighbours by the drag
 *  gap and inside the timeline. Null when the two bounds cross, which leaves
 *  the keyframe no room to move in time at all. */
const timeBounds = (
  points: readonly CurvePoint[],
  index: number,
  maxT: number,
): { lower: number; upper: number } | null => {
  const prev = points[index - 1];
  const next = points[index + 1];
  const lower = Math.max(0, prev ? prev.t + KEYFRAME_DRAG_GAP_SEC : 0);
  const upper = Math.min(maxT, next ? next.t - KEYFRAME_DRAG_GAP_SEC : maxT);
  return lower <= upper ? { lower, upper } : null;
};

/**
 * Where a dragged keyframe sits.
 *
 * `start` is the keyframe at the press and `delta` the whole drag so far, so a
 * drag out and back returns it to where it was. The value is `start.v + dv`,
 * kept in 0..1. The time stays `start.t` until `timeUnlocked`. From then on it
 * is `start.t + dtSec`, passed through `snap` when one is given, then kept
 * clear of both neighbours by the drag gap and inside `[0, maxT]`. When the
 * neighbours leave no room the keyframe keeps `start.t` and still takes the
 * value.
 *
 * `points` is the lane and `index` the dragged keyframe's place in it. The
 * clamp keeps the keyframe between its neighbours, so the index holds for the
 * whole drag.
 */
export function dragKeyframe(
  points: readonly CurvePoint[],
  index: number,
  start: { t: number; v: number },
  delta: { dtSec: number; dv: number },
  opts: { maxT: number; timeUnlocked: boolean; snap?: (t: number) => number },
): { t: number; v: number } {
  const v = clamp01(start.v + (Number.isFinite(delta.dv) ? delta.dv : 0));
  if (!opts.timeUnlocked) return { t: start.t, v };
  const bounds = timeBounds(points, index, opts.maxT);
  if (!bounds) return { t: start.t, v };
  const moved = start.t + (Number.isFinite(delta.dtSec) ? delta.dtSec : 0);
  const snapped = opts.snap ? opts.snap(moved) : moved;
  const t = Number.isFinite(snapped) ? snapped : moved;
  return { t: Math.max(bounds.lower, Math.min(bounds.upper, t)), v };
}

/**
 * The time keyframe `index` lands on when a key moves it by `deltaSec`, under
 * the limits a drag has: clear of both neighbours by the drag gap and inside
 * `[0, maxT]`. With no room it keeps its time.
 *
 * A nudge never moves a keyframe against its own direction. The last keyframe
 * of a recorded run sits 0.02 s from its neighbour, inside the gap, and a
 * plain clamp would answer a press toward that neighbour by pushing the
 * keyframe away from it.
 *
 * An index outside the lane gives 0.
 */
export function nudgeKeyframeTime(points: readonly CurvePoint[], index: number, deltaSec: number, maxT: number): number {
  const p = points[index];
  if (!p) return 0;
  const bounds = timeBounds(points, index, maxT);
  if (!bounds || !Number.isFinite(deltaSec) || deltaSec === 0) return p.t;
  const t = Math.max(bounds.lower, Math.min(bounds.upper, p.t + deltaSec));
  if ((deltaSec > 0 && t < p.t) || (deltaSec < 0 && t > p.t)) return p.t;
  return t;
}

/** The first index whose keyframe is at or after `t`, or `points.length`. */
const lowerBound = (points: readonly CurvePoint[], t: number): number => {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * The keyframes that get a handle: the indices inside `[fromSec, toSec]`,
 * thinned so two handles are never closer than `minGapPx` on screen. A dense
 * recorded lane then shows a readable handful.
 *
 * The thinning is counted from the lane's FIRST keyframe, not from the
 * window's, so the handles stay on the same keyframes while the timeline
 * scrolls. `keepIndex` (the selected keyframe) always gets its handle when it
 * is inside the window, and takes the place of any handle closer to it than
 * the gap. The rest of the lane keeps the handles it had.
 */
export function visibleKeyframes(
  points: readonly CurvePoint[],
  zoom: number,
  fromSec: number,
  toSec: number,
  minGapPx: number = HANDLE_MIN_GAP_PX,
  keepIndex: number = -1,
): number[] {
  const pxPerSec = Number.isFinite(zoom) && zoom > 0 ? zoom : 0;
  const gap = Number.isFinite(minGapPx) && minGapPx > 0 ? minGapPx : 0;
  const keep = Number.isInteger(keepIndex) && keepIndex >= 0 && keepIndex < points.length ? keepIndex : -1;
  const keepX = keep >= 0 ? points[keep].t * pxPerSec : 0;
  const out: number[] = [];
  let lastX = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const t = points[i].t;
    if (t > toSec) break;
    const x = t * pxPerSec;
    const spaced = x - lastX >= gap;
    if (spaced) lastX = x;
    if (t < fromSec) continue;
    if (i === keep || (spaced && !(keep >= 0 && Math.abs(x - keepX) < gap))) out.push(i);
  }
  return out;
}

/** The keyframe nearest `t` when it is within `withinPx` of it on screen, else
 *  -1. Every keyframe counts, including one whose handle the thinning hides. */
export function keyframeNear(points: readonly CurvePoint[], t: number, zoom: number, withinPx: number): number {
  const pxPerSec = Number.isFinite(zoom) && zoom > 0 ? zoom : 0;
  const at = lowerBound(points, t);
  let best = -1;
  let bestDt = Number.POSITIVE_INFINITY;
  for (const i of [at - 1, at]) {
    if (i < 0 || i >= points.length) continue;
    const dt = Math.abs(points[i].t - t);
    if (dt < bestDt) {
      best = i;
      bestDt = dt;
    }
  }
  return best >= 0 && bestDt * pxPerSec <= withinPx ? best : -1;
}
