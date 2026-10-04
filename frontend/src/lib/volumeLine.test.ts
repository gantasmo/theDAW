/**
 * The EDIT volume line's model (lib/volumeLine): the band a row draws the line
 * in, the dB readout and the typed value, and what a press, a drag and a key
 * do to the line and its keyframes.
 *
 * Pure helpers only: no React, no DOM, no store.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/lib/volumeLine.test.ts`
 * (`npm test` discovers it).
 */
import assert from 'node:assert/strict';
import { sampleCurve, type CurvePoint } from './automationModes.ts';
import {
  FINE_DRAG_FACTOR,
  KEYFRAME_DRAG_GAP_SEC,
  KEYFRAME_NUDGE_DB,
  KEYFRAME_NUDGE_DB_COARSE,
  KEYFRAME_TIME_STICK_PX,
  LINE_DRAG_THRESHOLD_PX,
  VOLUME_BAND_BOTTOM_PX,
  VOLUME_BAND_MIN_PX,
  VOLUME_BAND_TOP_PX,
  VOLUME_DB_FLOOR,
  clamp01,
  clampSegmentDelta,
  dbToGain,
  dragKeyframe,
  formatVolumeDb,
  gainToDb,
  grabAt,
  keyframeNear,
  lineValueAt,
  nudgeKeyframeTime,
  nudgeVolumeDb,
  parseVolumeDb,
  visibleKeyframes,
  volumeBand,
  volumeToY,
  yToVolume,
} from './volumeLine.ts';

const near = (a: number, b: number, eps = 1e-9, msg = ''): void =>
  assert.ok(Math.abs(a - b) <= eps, `${msg} (${a} !~ ${b})`);

// ── The band ─────────────────────────────────────────────────────────────────

// The band sits clear of the clip header strip at every row height the editor offers.
{
  assert.equal(VOLUME_BAND_TOP_PX + VOLUME_BAND_BOTTOM_PX, 34, 'the two insets the band leaves');
  assert.deepEqual(volumeBand(56), { top: 24, height: 22 }, 'the shortest row');
  assert.deepEqual(volumeBand(104), { top: 24, height: 70 }, 'the default row');
  assert.deepEqual(volumeBand(260), { top: 24, height: 226 }, 'the tallest row');
  assert.equal(volumeBand(30).height, VOLUME_BAND_MIN_PX, 'a row shorter than the insets keeps a usable band');
  assert.equal(volumeBand(Number.NaN).height, VOLUME_BAND_MIN_PX, 'a junk height does not make a junk band');
}

// Unity is the band top and silence its bottom, and y and volume round trip.
{
  const band = volumeBand(104);
  assert.equal(volumeToY(1, band), 24, 'unity is the band top');
  assert.equal(volumeToY(0, band), 94, 'silence is the band bottom');
  assert.equal(volumeToY(0.5, band), 59, 'the scale is linear gain');
  for (const v of [0, 0.001, 0.25, 0.5, 0.8, 1]) {
    near(yToVolume(volumeToY(v, band), band), v, 1e-12, `volume ${v} through y and back`);
  }
  for (const y of [24, 40.5, 59, 94]) {
    near(volumeToY(yToVolume(y, band), band), y, 1e-9, `y ${y} through volume and back`);
  }
  assert.equal(yToVolume(0, band), 1, 'above the band is unity');
  assert.equal(yToVolume(104, band), 0, 'below the band is silence');
  assert.equal(volumeToY(1.7, band), 24, 'a value above unity draws at unity');
  assert.equal(volumeToY(-3, band), 94, 'a negative value draws at silence');
  assert.equal(volumeToY(Number.NaN, band), 94, 'junk draws at silence, never at unity');
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 0, 'an infinity is junk too');
}

// ── Decibels ─────────────────────────────────────────────────────────────────

// gainToDb and dbToGain: unity is the ceiling and the floor is silence.
{
  assert.equal(VOLUME_DB_FLOOR, -60);
  assert.equal(gainToDb(1), 0, 'unity is 0 dB');
  near(gainToDb(0.5), -6.0205999132, 1e-9, 'half');
  assert.equal(gainToDb(0), Number.NEGATIVE_INFINITY, 'silence has no level');
  assert.equal(gainToDb(-1), Number.NEGATIVE_INFINITY);
  assert.equal(gainToDb(Number.NaN), Number.NEGATIVE_INFINITY);

  assert.equal(dbToGain(0), 1);
  assert.equal(dbToGain(6), 1, 'there is no boost above unity');
  near(dbToGain(-6), 0.5011872336, 1e-9, '-6 dB');
  near(dbToGain(-59.9), 0.0010115795, 1e-9, 'just above the floor still has a level');
  assert.equal(dbToGain(VOLUME_DB_FLOOR), 0, 'at the floor it is silence');
  assert.equal(dbToGain(-90), 0);
  assert.equal(dbToGain(Number.NEGATIVE_INFINITY), 0);
  assert.equal(dbToGain(Number.NaN), 0, 'an unreadable level is silence, never unity');
  for (const db of [-59.9, -40, -12.3, -6, -0.1]) near(gainToDb(dbToGain(db)), db, 1e-9, `round trip ${db} dB`);
}

// The readout.
{
  assert.equal(formatVolumeDb(1), '0.0 dB');
  assert.equal(formatVolumeDb(0.8), '-1.9 dB', 'the default fader');
  assert.equal(formatVolumeDb(0.5), '-6.0 dB');
  assert.equal(formatVolumeDb(0.99), '-0.1 dB');
  assert.equal(formatVolumeDb(0.9995), '0.0 dB', 'within 0.05 dB of unity reads as unity, never as -0.0');
  assert.equal(formatVolumeDb(0.001), '-60.0 dB', 'the floor itself still reads as a number');
  assert.equal(formatVolumeDb(0.0009), '-inf dB', 'under the floor is silence');
  assert.equal(formatVolumeDb(0), '-inf dB');
  assert.equal(formatVolumeDb(1.5), '0.0 dB', 'above unity reads as unity');
  assert.equal(formatVolumeDb(Number.NaN), '-inf dB');
}

// The typed value.
{
  near(parseVolumeDb('-6') as number, 0.5011872336, 1e-9, 'a bare number is decibels');
  assert.equal(parseVolumeDb('  -6.0 dB '), parseVolumeDb('-6'), 'outer spaces and the unit are dropped');
  assert.equal(parseVolumeDb('-6DB'), parseVolumeDb('-6'), 'whatever its case');
  near(parseVolumeDb('-6,5') as number, dbToGain(-6.5), 1e-12, 'a decimal comma is a decimal point');
  near(parseVolumeDb('-.5') as number, dbToGain(-0.5), 1e-12);
  assert.equal(parseVolumeDb('0'), 1);
  assert.equal(parseVolumeDb('+3'), 1, 'a number above 0 is unity');
  assert.equal(parseVolumeDb('-60'), 0, 'a number at the floor is silence');
  assert.equal(parseVolumeDb('-75.5'), 0, 'and so is one under it');
  for (const word of ['-inf', '-infinity', 'inf', 'mute', 'off', '-INF dB', ' Mute ']) {
    assert.equal(parseVolumeDb(word), 0, `"${word}" is silence`);
  }
  for (const junk of ['', '   ', 'dB', 'abc', '-', '--6', '1e-3', '0x10', '-6 -3', '1,234.5', 'NaN']) {
    assert.equal(parseVolumeDb(junk), null, `"${junk}" is unreadable`);
  }
  // A readout's own text can be typed back.
  for (const v of [1, 0.8, 0.5, 0.0123, 0]) {
    const text = formatVolumeDb(v);
    const back = parseVolumeDb(text);
    assert.notEqual(back, null, `"${text}" must be readable`);
    assert.equal(formatVolumeDb(back as number), text, `"${text}" parses back to itself`);
  }
  // The one exception is the floor: a key step reaches it, typing it is silence.
  assert.equal(parseVolumeDb(formatVolumeDb(0.001)), 0);
}

// The key step works in dB and lands on clean tenths.
{
  assert.equal(KEYFRAME_NUDGE_DB, 0.1);
  assert.equal(KEYFRAME_NUDGE_DB_COARSE, 1);
  near(gainToDb(nudgeVolumeDb(0.5, KEYFRAME_NUDGE_DB)), -5.9, 1e-9, '-6.0206 + 0.1 lands on -5.9');
  near(gainToDb(nudgeVolumeDb(0.5, -KEYFRAME_NUDGE_DB)), -6.1, 1e-9, '-6.0206 - 0.1 lands on -6.1');
  near(gainToDb(nudgeVolumeDb(0.5, KEYFRAME_NUDGE_DB_COARSE)), -5, 1e-9, 'the coarse step is a whole dB');
  let v = 0.5;
  for (let i = 0; i < 12; i += 1) v = nudgeVolumeDb(v, KEYFRAME_NUDGE_DB);
  assert.equal(formatVolumeDb(v), '-4.8 dB', 'twelve presses are twelve clean tenths');
  near(gainToDb(v), -4.8, 1e-9);

  // Unity is the ceiling.
  assert.equal(nudgeVolumeDb(1, KEYFRAME_NUDGE_DB), 1);
  assert.equal(nudgeVolumeDb(dbToGain(-0.1), KEYFRAME_NUDGE_DB), 1, 'the last step up lands exactly on unity');
  assert.equal(nudgeVolumeDb(dbToGain(-0.5), KEYFRAME_NUDGE_DB_COARSE), 1, 'a step past unity stops at it');
  near(gainToDb(nudgeVolumeDb(1, -KEYFRAME_NUDGE_DB)), -0.1, 1e-9);

  // Junk moves nothing.
  assert.equal(nudgeVolumeDb(0.5, 0), 0.5);
  assert.equal(nudgeVolumeDb(0.5, Number.NaN), 0.5);
}

// The floor walk, down and back up.
{
  let v = dbToGain(-59.8);
  v = nudgeVolumeDb(v, -KEYFRAME_NUDGE_DB);
  assert.equal(formatVolumeDb(v), '-59.9 dB');
  v = nudgeVolumeDb(v, -KEYFRAME_NUDGE_DB);
  assert.equal(formatVolumeDb(v), '-60.0 dB', 'the floor is the last step with a level');
  near(v, 0.001, 1e-12);
  v = nudgeVolumeDb(v, -KEYFRAME_NUDGE_DB);
  assert.equal(v, 0, 'a step below the floor is silence');
  assert.equal(nudgeVolumeDb(v, -KEYFRAME_NUDGE_DB), 0, 'and silence stays silence');

  v = nudgeVolumeDb(v, KEYFRAME_NUDGE_DB);
  near(v, 0.001, 1e-12, 'from silence a step up lands exactly on the floor');
  assert.equal(formatVolumeDb(v), '-60.0 dB');
  v = nudgeVolumeDb(v, KEYFRAME_NUDGE_DB);
  assert.equal(formatVolumeDb(v), '-59.9 dB', 'and the next one is a tenth above it');

  // The same walk in whole dB.
  let c = nudgeVolumeDb(0, KEYFRAME_NUDGE_DB_COARSE);
  assert.equal(formatVolumeDb(c), '-60.0 dB', 'a coarse step from silence lands on the floor too');
  c = nudgeVolumeDb(c, KEYFRAME_NUDGE_DB_COARSE);
  assert.equal(formatVolumeDb(c), '-59.0 dB');
  c = nudgeVolumeDb(c, -KEYFRAME_NUDGE_DB_COARSE);
  assert.equal(formatVolumeDb(c), '-60.0 dB');
  assert.equal(nudgeVolumeDb(c, -KEYFRAME_NUDGE_DB_COARSE), 0);
  assert.equal(nudgeVolumeDb(dbToGain(-59.5), -KEYFRAME_NUDGE_DB_COARSE), 0, 'a coarse step that passes the floor is silence');
}

// ── The line ─────────────────────────────────────────────────────────────────

const LANE: CurvePoint[] = [{ t: 1, v: 0.2 }, { t: 3, v: 0.6 }, { t: 4, v: 0.6 }];

// The line is the fader with no keyframes and the lane with them.
{
  assert.equal(lineValueAt([], 0.8, 5), 0.8, 'no keyframes: the fader');
  assert.equal(lineValueAt(LANE, 0.8, 0), 0.2, 'before the first keyframe its value is held');
  near(lineValueAt(LANE, 0.8, 2), 0.4, 1e-12, 'between two keyframes it is on the ramp');
  assert.equal(lineValueAt(LANE, 0.8, 9), 0.6, 'after the last keyframe its value is held');
  const bent: CurvePoint[] = [{ t: 0, v: 0, curve: 1 }, { t: 2, v: 1 }];
  assert.equal(lineValueAt(bent, 0.8, 1), sampleCurve(bent, 1), 'a bent stretch reads through the sampler playback uses');
  assert.equal(lineValueAt([], 1.4, 0), 1, 'a fader above unity reads as unity');
}

// What a press on the line grabs, at the four positions.
{
  assert.deepEqual(grabAt([], 2), { kind: 'fader' }, 'no keyframes: the fader');
  assert.deepEqual(grabAt(LANE, 0.5), { kind: 'segment', indices: [0] }, 'before the first keyframe: it alone');
  assert.deepEqual(grabAt(LANE, 1), { kind: 'segment', indices: [0] }, 'at the first keyframe: it alone');
  assert.deepEqual(grabAt(LANE, 2), { kind: 'segment', indices: [0, 1] }, 'between two: both');
  assert.deepEqual(grabAt(LANE, 3.5), { kind: 'segment', indices: [1, 2] });
  assert.deepEqual(grabAt(LANE, 4), { kind: 'segment', indices: [2] }, 'at the last keyframe: it alone');
  assert.deepEqual(grabAt(LANE, 7), { kind: 'segment', indices: [2] }, 'after the last keyframe: it alone');
  assert.deepEqual(grabAt([{ t: 2, v: 0.5 }], 0), { kind: 'segment', indices: [0] }, 'one keyframe owns the whole line');
  assert.deepEqual(grabAt([{ t: 2, v: 0.5 }], 9), { kind: 'segment', indices: [0] });
}

// A grabbed stretch stops as a whole at unity and at silence.
{
  assert.equal(clampSegmentDelta([0.2, 0.6], 0.1), 0.1, 'inside the limits the delta passes');
  near(clampSegmentDelta([0.2, 0.6], 0.9), 0.4, 1e-12, 'up: the louder keyframe stops at unity');
  near(clampSegmentDelta([0.2, 0.6], -0.9), -0.2, 1e-12, 'down: the quieter keyframe stops at silence');
  const up = clampSegmentDelta([0.2, 0.6], 5);
  near(0.6 + up, 1, 1e-12);
  near((0.6 + up) - (0.2 + up), 0.4, 1e-12, 'the two keep their difference at the limit');
  assert.equal(clampSegmentDelta([0, 1], 0.3), 0, 'a stretch that spans the whole range cannot move');
  assert.equal(clampSegmentDelta([0, 1], -0.3), 0);
  assert.equal(clampSegmentDelta([0.5], 0.25), 0.25, 'one keyframe moves alone');
  assert.equal(clampSegmentDelta([], 0.3), 0);
  assert.equal(clampSegmentDelta([0.5], Number.NaN), 0);
}

// A dragged keyframe: its value at once, its time once unlocked.
{
  assert.equal(KEYFRAME_DRAG_GAP_SEC, 0.03);
  assert.equal(LINE_DRAG_THRESHOLD_PX, 3);
  assert.equal(KEYFRAME_TIME_STICK_PX, 6);
  assert.equal(FINE_DRAG_FACTOR, 0.25);

  const start = { t: 3, v: 0.6 };
  const locked = { maxT: 10, timeUnlocked: false };
  const unlocked = { maxT: 10, timeUnlocked: true };

  // Locked: the value moves, the time does not, however far the pointer went sideways.
  const a = dragKeyframe(LANE, 1, start, { dtSec: 0.4, dv: 0.1 }, locked);
  assert.equal(a.t, 3, 'a locked drag keeps the time');
  near(a.v, 0.7, 1e-12);
  assert.equal(dragKeyframe(LANE, 1, start, { dtSec: 0, dv: 0.9 }, locked).v, 1, 'the value stops at unity');
  assert.equal(dragKeyframe(LANE, 1, start, { dtSec: 0, dv: -0.9 }, locked).v, 0, 'and at silence');

  // Unlocked: the time follows the pointer.
  const b = dragKeyframe(LANE, 1, start, { dtSec: 0.4, dv: 0 }, unlocked);
  near(b.t, 3.4, 1e-12, 'an unlocked drag moves the time');
  near(b.v, 0.6, 1e-12);
  const back = dragKeyframe(LANE, 1, start, { dtSec: 0, dv: 0 }, unlocked);
  assert.deepEqual(back, start, 'a drag out and back returns the keyframe to where it was');

  // Snapped: the time lands on the grid.
  const halves = (t: number): number => Math.round(t * 2) / 2;
  assert.equal(dragKeyframe(LANE, 1, start, { dtSec: 0.4, dv: 0 }, { ...unlocked, snap: halves }).t, 3.5, 'snapped to the grid');
  assert.equal(dragKeyframe(LANE, 1, start, { dtSec: 0.4, dv: 0 }, { ...locked, snap: halves }).t, 3, 'a locked drag does not snap either');

  // Clamped against each neighbour, by the drag gap.
  near(dragKeyframe(LANE, 1, start, { dtSec: -5, dv: 0 }, unlocked).t, 1 + KEYFRAME_DRAG_GAP_SEC, 1e-12, 'held off the keyframe before it');
  near(dragKeyframe(LANE, 1, start, { dtSec: 5, dv: 0 }, unlocked).t, 4 - KEYFRAME_DRAG_GAP_SEC, 1e-12, 'held off the keyframe after it');
  near(dragKeyframe(LANE, 1, start, { dtSec: 0.9, dv: 0 }, { ...unlocked, snap: halves }).t, 4 - KEYFRAME_DRAG_GAP_SEC, 1e-12,
    'a grid line that is a neighbour is clamped off it');

  // The first and the last keyframe are held inside the timeline.
  assert.equal(dragKeyframe(LANE, 0, { t: 1, v: 0.2 }, { dtSec: -9, dv: 0 }, unlocked).t, 0, 'the first stops at 0');
  assert.equal(dragKeyframe(LANE, 2, { t: 4, v: 0.6 }, { dtSec: 99, dv: 0 }, unlocked).t, 10, 'the last stops at the end');

  // No room: neighbours closer than two gaps. The time stays, the value still moves.
  const tight: CurvePoint[] = [{ t: 1, v: 0 }, { t: 1.02, v: 0.5 }, { t: 1.04, v: 1 }];
  assert.deepEqual(
    dragKeyframe(tight, 1, { t: 1.02, v: 0.5 }, { dtSec: 0.5, dv: 0.25 }, unlocked),
    { t: 1.02, v: 0.75 },
    'with no room the keyframe keeps its time',
  );
}

// A key moves a keyframe in time under the same limits.
{
  near(nudgeKeyframeTime(LANE, 1, 0.25, 10), 3.25, 1e-12);
  near(nudgeKeyframeTime(LANE, 1, -0.25, 10), 2.75, 1e-12);
  near(nudgeKeyframeTime(LANE, 1, 5, 10), 4 - KEYFRAME_DRAG_GAP_SEC, 1e-12, 'held off the keyframe after it');
  near(nudgeKeyframeTime(LANE, 1, -5, 10), 1 + KEYFRAME_DRAG_GAP_SEC, 1e-12, 'held off the keyframe before it');
  assert.equal(nudgeKeyframeTime(LANE, 0, -5, 10), 0, 'the first stops at 0');
  assert.equal(nudgeKeyframeTime(LANE, 2, 50, 10), 10, 'the last stops at the end');
  const tight: CurvePoint[] = [{ t: 1, v: 0 }, { t: 1.02, v: 0.5 }, { t: 1.04, v: 1 }];
  assert.equal(nudgeKeyframeTime(tight, 1, 0.5, 10), 1.02, 'with no room the keyframe keeps its time');

  // The last keyframe of a recorded run sits inside its neighbour's gap. A press
  // toward the neighbour leaves it where it is; a press away moves it.
  const run: CurvePoint[] = [{ t: 1, v: 0 }, { t: 1.02, v: 0.5 }];
  assert.equal(nudgeKeyframeTime(run, 1, -0.05, 10), 1.02, 'a nudge never pushes a keyframe against its direction');
  assert.equal(nudgeKeyframeTime(run, 1, 0, 10), 1.02, 'and a nudge of nothing moves nothing');
  near(nudgeKeyframeTime(run, 1, 0.05, 10), 1.07, 1e-12);
  assert.equal(nudgeKeyframeTime([{ t: 12, v: 1 }], 0, 0.5, 10), 12, 'a keyframe past the end is not pulled back by a press to the right');

  assert.equal(nudgeKeyframeTime(LANE, 1, Number.NaN, 10), 3);
  assert.equal(nudgeKeyframeTime(LANE, 9, 0.5, 10), 0, 'an index outside the lane');
}

// ── Handles ──────────────────────────────────────────────────────────────────

// A dense recorded lane shows a readable handful, and the selected keyframe always shows.
{
  // 2.4 px between keyframes: five steps (12 px) clear a 10 px gap, four (9.6 px) do not.
  const dense: CurvePoint[] = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.02, v: 0.5 }));
  const ZOOM = 120;
  const every5 = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let i = from; i <= to; i += 5) out.push(i);
    return out;
  };
  const gapsOk = (indices: number[]): void => {
    for (let k = 1; k < indices.length; k += 1) {
      const px = (dense[indices[k]].t - dense[indices[k - 1]].t) * ZOOM;
      assert.ok(px >= 10 - 1e-9, `handles ${indices[k - 1]} and ${indices[k]} are ${px} px apart`);
    }
  };

  const all = visibleKeyframes(dense, ZOOM, 0, 10);
  assert.deepEqual(all, every5(0, 95), 'every fifth keyframe keeps its handle');
  gapsOk(all);

  // The window only filters: indices 25 to 50 sit inside [0.49, 1.01].
  assert.deepEqual(visibleKeyframes(dense, ZOOM, 0.49, 1.01), every5(25, 50));
  // Scrolling does not move the handles onto other keyframes: the window now
  // starts between two of them and the same ones show.
  assert.deepEqual(visibleKeyframes(dense, ZOOM, 0.53, 1.01), every5(30, 50), 'the thinning does not restart at the window edge');

  // The selected keyframe is kept, and takes the place of the handles it crowds.
  const kept = visibleKeyframes(dense, ZOOM, 0.49, 1.01, 10, 27);
  assert.deepEqual(kept, [27, 35, 40, 45, 50], '27 shows; 25 and 30, closer than the gap, give way');
  gapsOk(kept);
  // Selecting a keyframe that already has a handle changes nothing.
  assert.deepEqual(visibleKeyframes(dense, ZOOM, 0.49, 1.01, 10, 30), every5(25, 50));
  // A selection outside the window gets no handle and does not disturb the window.
  assert.deepEqual(visibleKeyframes(dense, ZOOM, 0.49, 1.01, 10, 7), every5(25, 50));
  assert.deepEqual(visibleKeyframes(dense, ZOOM, 0.49, 1.01, 10, 999), every5(25, 50), 'an index outside the lane is no selection');

  // A wider gap thins further; no gap shows every keyframe in the window.
  assert.deepEqual(visibleKeyframes(dense, ZOOM, 0, 0.5, 23), [0, 10, 20], 'ten steps (24 px) clear a 23 px gap, nine (21.6 px) do not');
  assert.equal(visibleKeyframes(dense, ZOOM, 0.49, 1.01, 0).length, 26);

  // A sparse lane keeps every handle, and only the window's.
  assert.deepEqual(visibleKeyframes(LANE, 100, 0, 10), [0, 1, 2]);
  assert.deepEqual(visibleKeyframes(LANE, 100, 2, 3.5), [1], 'only the keyframes inside the window');
  assert.deepEqual(visibleKeyframes(LANE, 100, 3, 4), [1, 2], 'both edges of the window are inside it');
  assert.deepEqual(visibleKeyframes(LANE, 100, 5, 9), []);
  assert.deepEqual(visibleKeyframes([], 100, 0, 10), []);
}

// The keyframe under a right-click.
{
  assert.equal(keyframeNear(LANE, 1.05, 100, 8), 0, '5 px away is near');
  assert.equal(keyframeNear(LANE, 0.95, 100, 8), 0, 'on either side');
  assert.equal(keyframeNear(LANE, 1.2, 100, 8), -1, '20 px away is not');
  assert.equal(keyframeNear(LANE, 3.96, 100, 8), 2, 'the nearer of two');
  assert.equal(keyframeNear(LANE, 2, 100, 150), 0, 'a tie goes to the earlier keyframe');
  assert.equal(keyframeNear(LANE, 1.05, 1000, 8), -1, 'the reach is in screen px, so it shrinks in time as the zoom grows');
  assert.equal(keyframeNear([], 1, 100, 8), -1);
  // A keyframe the thinning hides is still found.
  const dense: CurvePoint[] = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.02, v: 0.5 }));
  assert.equal(keyframeNear(dense, 0.541, 120, 8), 27);
}

console.log('volumeLine: all assertions passed');
