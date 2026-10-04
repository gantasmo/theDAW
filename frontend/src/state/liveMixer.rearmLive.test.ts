// A volume or pan lane edited while the EDIT transport is rolling, replayed on
// the real mixer.
//
// `liveMixer.rearm.test.ts` pins the rule (which lanes are re-armed, which go
// back to the fader, how often). This file pins that the rule is WIRED: the real
// `start()` runs on a fake AudioContext, the real editor store is edited the way
// the volume line edits it, and what is checked is the calls that reached each
// track's gain and pan AudioParam.
//
// The sequence:
//
//   - `start()` writes the lane's envelope once. The playhead tick sets no timer
//     and writes nothing.
//   - A keyframe is dragged: nothing is written inside the store write, and one
//     wait later the gain is cancelled, anchored and ramped to the new value.
//     Before this it kept the old envelope until the next play or seek.
//   - A drag of twenty writes re-arms a handful of times and ends on its last one.
//   - The lane is bypassed: the gain glides to the fader. Switched back on: armed.
//   - Every keyframe is deleted: the gain glides to the fader, and the fader then
//     moves it. Before this the empty lane still counted as owning the gain, so
//     the fader was dead until the next play.
//   - Undo puts the keyframes back and the lane is armed again.
//   - A touch pass holds the fader: its lane is left to the hold, and the
//     punch-out hands the gain back.
//   - A pan lane does the same on the panner. Two lanes edited inside one wait
//     are both armed.
//   - A seek builds a new pass from the store. A re-arm still waiting from the
//     old pass is dropped, not applied to the new strips.
//   - Stop drops a re-arm that has not run. Stopped, an edit sets no timer, and
//     the next play opens on the lane as it was left.
//
// The fake context follows `state/djEngineTestRig.ts` (the DJ engine's rig): it
// is installed on `globalThis.window` AFTER the modules load, its nodes accept
// every call the mixer makes, and its params record them. The mixer reaches its
// re-arm timer through `window.setTimeout`, so the timers here are the test's
// own and no assertion waits on a real clock.
//
// Run: npx tsx src/state/liveMixer.rearmLive.test.ts
import assert from 'node:assert/strict';

import {
  currentTransportSec,
  dispose,
  isPlaying,
  playAsync,
  publishPlayhead,
  seek,
  stop,
} from './liveMixer.ts';
import {
  beginUndoStep,
  sampleLane,
  useEditorStore,
  type AudioClip,
  type AutomationTarget,
  type EditorTrack,
} from './editorStore.ts';

/* ----------------------------- the fake context ----------------------------- */

/** One recorded write: the method (or `value` for a plain assignment) and its numbers. */
type Call = [string, ...number[]];

/** An AudioParam that records every write it is sent. */
function recordingParam(initial: number) {
  const calls: Call[] = [];
  let current = initial;
  const param = {
    calls,
    get value(): number { return current; },
    set value(v: number) { current = v; calls.push(['value', v]); },
    setValueAtTime(v: number, t: number) { calls.push(['setValueAtTime', v, t]); current = v; return param; },
    linearRampToValueAtTime(v: number, t: number) { calls.push(['linearRampToValueAtTime', v, t]); return param; },
    exponentialRampToValueAtTime(v: number, t: number) { calls.push(['exponentialRampToValueAtTime', v, t]); return param; },
    setTargetAtTime(v: number, t: number, tc: number) { calls.push(['setTargetAtTime', v, t, tc]); current = v; return param; },
    setValueCurveAtTime(_values: Float32Array, t: number, d: number) { calls.push(['setValueCurveAtTime', t, d]); return param; },
    cancelScheduledValues(t: number) { calls.push(['cancelScheduledValues', t]); return param; },
  };
  return param;
}
type RecordingParam = ReturnType<typeof recordingParam>;

/** One node type for every node the mixer and the engine create. */
class FakeNode {
  gain = recordingParam(1);
  pan = recordingParam(0);
  delayTime = recordingParam(0);
  playbackRate = recordingParam(1);
  buffer: unknown = null;
  fftSize = 2048;
  smoothingTimeConstant = 0;
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  onended: (() => void) | null = null;
  connect<T>(to: T): T { return to; }
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}

/** The audio clock, in seconds. `advance` moves it with the timers. */
let audioNow = 100;
const gainNodes: FakeNode[] = [];
const pannerNodes: FakeNode[] = [];

class FakeAudioContext {
  sampleRate = 48000;
  state = 'running';
  outputLatency = 0;
  destination = new FakeNode();
  get currentTime(): number { return audioNow; }
  resume(): Promise<void> { return Promise.resolve(); }
  createGain() { const n = new FakeNode(); gainNodes.push(n); return n; }
  createStereoPanner() { const n = new FakeNode(); pannerNodes.push(n); return n; }
  createDelay() { return new FakeNode(); }
  createAnalyser() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createMediaElementSource() { return new FakeNode(); }
  /** Every clip decodes to a minute of stereo: only what the scheduler reads. */
  decodeAudioData(): Promise<unknown> {
    return Promise.resolve({
      duration: 60, length: 60 * 48000, numberOfChannels: 2, sampleRate: 48000,
      getChannelData: () => new Float32Array(16),
    });
  }
}

class FakeAudioElement {
  crossOrigin = '';
  preload = '';
  addEventListener(): void {}
  pause(): void {}
}

/* ------------------------------ the fake timers ------------------------------ */

let timerNowMs = 0;
let nextHandle = 1;
const timers = new Map<number, { at: number; fn: () => void }>();

/** Move the timers and the audio clock on by `ms`, firing what comes due in order. */
function advance(ms: number): void {
  const end = timerNowMs + ms;
  for (;;) {
    let due: number | null = null;
    for (const [handle, t] of timers) {
      if (t.at <= end && (due === null || t.at < timers.get(due)!.at)) due = handle;
    }
    if (due === null) break;
    const { at, fn } = timers.get(due)!;
    timers.delete(due);
    audioNow += (at - timerNowMs) / 1000;
    timerNowMs = at;
    fn();
  }
  audioNow += (end - timerNowMs) / 1000;
  timerNowMs = end;
}

// Installed after the imports above have run: `playerStore` checks for a
// `window` when it loads, and plain tsx has none.
const g = globalThis as unknown as Record<string, unknown>;
g.window = {
  AudioContext: FakeAudioContext,
  setTimeout: (fn: () => void, ms: number): number => {
    const handle = nextHandle;
    nextHandle += 1;
    timers.set(handle, { at: timerNowMs + ms, fn });
    return handle;
  },
  clearTimeout: (handle: number): void => { timers.delete(handle); },
  // The FX-lane and MIDI interval timers: none of them is the subject here.
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener() {},
  removeEventListener() {},
};
g.Audio = FakeAudioElement;
// The transport re-arms a frame while it plays. A frame that never fires keeps
// the test in charge of time.
g.requestAnimationFrame = () => 1;
g.cancelAnimationFrame = () => {};

/* --------------------------------- the project -------------------------------- */

/** The mixer's re-arm wait (`REARM_MIN_MS`) and its fader glide (`RAMP_TC`). */
const WAIT_MS = 30;
const RAMP_TC = 0.015;

// Fader and pan values no other node is ever set to, so each track's strip can
// be found by the value `buildTrackNodes` opened it at.
const FADER_A = 0.8125;
const FADER_B = 0.4375;
const PAN_A = -0.25;
const PAN_B = 0.5;

const VOL_A: AutomationTarget = { kind: 'trackVolume', trackId: 'a' };
const PAN_TARGET_B: AutomationTarget = { kind: 'trackPan', trackId: 'b' };

const track = (id: string, volume: number, pan: number): EditorTrack => ({
  id, name: id, nameAutoGenerated: false, volume, pan, mute: false, solo: false, color: '#fff',
});
const clip = (id: string, trackId: string): AudioClip => ({
  id, trackId, label: id, audioBlob: new Blob([id]), mimeType: 'audio/wav',
  sourceDuration: 60, offsetIntoSource: 0, durationSec: 60, startSec: 0, color: '#fff',
});

const st = () => useEditorStore.getState();

useEditorStore.setState({
  tracks: [track('a', FADER_A, PAN_A), track('b', FADER_B, PAN_B)],
  clips: [clip('clip-a', 'a'), clip('clip-b', 'b')],
  masterFxChain: [],
  automationLanes: [
    { id: 'vol-a', target: VOL_A, points: [{ t: 0, v: 0.2 }, { t: 40, v: 0.9 }], enabled: true },
  ],
  automationHolds: {},
  automationMode: 'read',
  playheadSec: 0,
} as never);
useEditorStore.setState({ _undo: [], _redo: [] } as never);
beginUndoStep();

await playAsync();
assert.equal(isPlaying(), true, 'the pass is rolling');

/** The param the mixer last opened at `value`: a track's gain or pan in the
 *  pass that is running (every `start()` builds the strips again). */
const opened = (nodes: FakeNode[], pick: (n: FakeNode) => RecordingParam, value: number): RecordingParam => {
  const hit = nodes.map(pick).reverse().find((p) => p.calls[0]?.[0] === 'value' && p.calls[0][1] === value);
  assert.ok(hit, `the mixer built a strip at ${value}`);
  return hit;
};
/** Let a `start()` that was not awaited (a seek) run to its end. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
const gainA = opened(gainNodes, (n) => n.gain, FADER_A);
const gainB = opened(gainNodes, (n) => n.gain, FADER_B);
const panB = opened(pannerNodes, (n) => n.pan, PAN_B);

/** What reached `param` since `from` calls. */
const since = (param: RecordingParam, from: number): Call[] => param.calls.slice(from);
const names = (calls: Call[]): string[] => calls.map((c) => c[0]);
/** Where a ramp from `from` at 0 s to `to` at `endSec` stands under the transport. */
const onRamp = (from: number, to: number, endSec: number): number =>
  from + (to - from) * (currentTransportSec() / endSec);
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/* ------------------------- start() writes the envelope ------------------------- */
{
  assert.deepEqual(gainA.calls, [
    ['value', FADER_A],
    ['cancelScheduledValues', 100],
    ['setValueAtTime', 0.2, 100],
    ['linearRampToValueAtTime', 0.9, 140],
  ], 'the lane is on track a from the first sample');
  assert.deepEqual(gainB.calls, [['value', FADER_B]], 'track b has no lane and sits on its fader');
}

/* ------------------------- the playhead tick costs nothing ------------------------- */
{
  const a = gainA.calls.length;
  for (let i = 1; i <= 12; i += 1) {
    audioNow += 1 / 60;
    publishPlayhead(i / 60, 0);
  }
  assert.equal(timers.size, 0, 'a playhead write sets no timer');
  assert.deepEqual(since(gainA, a), [], 'and reaches no param');
}

/* ----------------------------- a keyframe is dragged ----------------------------- */
{
  const a = gainA.calls.length;
  const b = gainB.calls.length;
  st().updateAutomationPoint('vol-a', 1, 40, 0.5);
  assert.deepEqual(since(gainA, a), [], 'nothing is written inside the store write');
  assert.equal(timers.size, 1, 'one re-arm is waiting');
  advance(WAIT_MS - 1);
  assert.deepEqual(since(gainA, a), [], 'not before the wait is over');
  advance(1);

  const wrote = since(gainA, a);
  assert.deepEqual(names(wrote), ['cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime']);
  const at = wrote[0][1];
  assert.ok(Math.abs(at - audioNow) < 1e-9, 'the old envelope is dropped from now');
  assert.equal(wrote[1][2], at, 'the anchor sits at now');
  // The anchor is the EDITED lane read at the transport position.
  const expected = 0.2 + (0.5 - 0.2) * (currentTransportSec() / 40);
  assert.ok(Math.abs(wrote[1][1] - expected) < 1e-9, `anchored on the lane as it is now: ${wrote[1][1]}`);
  assert.deepEqual(wrote[2], ['linearRampToValueAtTime', 0.5, 140], 'the keyframe plays at its new value');
  assert.deepEqual(since(gainB, b), [], 'track b is not touched');
  assert.equal(timers.size, 0, 'and no timer is left');
}

/* ------------------------- a drag is many writes, few re-arms ------------------------- */
{
  const a = gainA.calls.length;
  for (let i = 0; i < 20; i += 1) {
    st().updateAutomationPoint('vol-a', 1, 40, 0.5 + i * 0.01);
    advance(8);
  }
  advance(WAIT_MS);
  const wrote = since(gainA, a);
  const rearms = names(wrote).filter((n) => n === 'cancelScheduledValues').length;
  // 160 ms of writes: one re-arm per wait at most, and at least a few.
  assert.ok(rearms >= 3 && rearms <= 6, `twenty writes re-armed the gain ${rearms} times`);
  const lastRamp = wrote.filter((c) => c[0] === 'linearRampToValueAtTime').pop();
  assert.ok(lastRamp && Math.abs(lastRamp[1] - 0.69) < 1e-9, 'the last write of the drag is the one on the param');
  assert.equal(timers.size, 0);
}

/* --------------------------------- bypass and back --------------------------------- */
{
  let a = gainA.calls.length;
  beginUndoStep();
  st().toggleAutomationLane('vol-a');
  advance(WAIT_MS);
  let wrote = since(gainA, a);
  assert.deepEqual(names(wrote), ['cancelScheduledValues', 'setValueAtTime', 'setTargetAtTime']);
  // The lane is half way up a ramp. The gain is pinned where the ramp has it, so
  // the glide does not open with a step back to the ramp's start.
  assert.ok(near(wrote[1][1], onRamp(0.2, 0.69, 40)), `pinned on the value playing: ${wrote[1][1]}`);
  assert.deepEqual(wrote[2], ['setTargetAtTime', FADER_A, wrote[0][1], RAMP_TC], 'bypassed: the gain glides to the fader');

  a = gainA.calls.length;
  st().toggleAutomationLane('vol-a');
  advance(WAIT_MS);
  wrote = since(gainA, a);
  assert.deepEqual(
    names(wrote), ['cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime'],
    'switched back on: the lane is armed again',
  );
}

/* --------------------- a keyframed track's fader stays off the gain --------------------- */
{
  const a = gainA.calls.length;
  const b = gainB.calls.length;
  beginUndoStep();
  st().updateTrack('a', { volume: 0.75 });
  st().updateTrack('b', { volume: 0.5625 });
  advance(WAIT_MS);
  assert.deepEqual(since(gainA, a), [], 'the lane owns the gain');
  assert.ok(
    since(gainB, b).some((c) => c[0] === 'setTargetAtTime' && c[1] === 0.5625),
    'a track with no lane takes its fader as before',
  );
}

/* ----------------------------- every keyframe deleted ----------------------------- */
{
  let a = gainA.calls.length;
  beginUndoStep();
  st().removeAutomationPoint('vol-a', 1);
  st().removeAutomationPoint('vol-a', 0);
  const lane = st().getLaneForTarget(VOL_A);
  assert.ok(lane && lane.enabled && lane.points.length === 0, 'the lane stays in place, enabled and empty');
  advance(WAIT_MS);
  let wrote = since(gainA, a);
  assert.deepEqual(
    names(wrote), ['cancelScheduledValues', 'setValueAtTime', 'setTargetAtTime'],
    'one release for the two deletes',
  );
  assert.ok(near(wrote[1][1], onRamp(0.2, 0.69, 40)), 'from the value the two keyframes were playing');
  assert.deepEqual([wrote[2][1], wrote[2][3]], [0.75, RAMP_TC], 'the gain glides to the fader as it stands now');

  // And the fader decides again. This write is `applyMixLive`, which used to
  // skip the track for as long as the empty lane was enabled.
  a = gainA.calls.length;
  beginUndoStep();
  st().updateTrack('a', { volume: 0.625 });
  wrote = since(gainA, a);
  assert.deepEqual(names(wrote), ['setTargetAtTime'], 'the fader reaches the gain');
  assert.deepEqual([wrote[0][1], wrote[0][3]], [0.625, RAMP_TC]);
}

/* ------------------------------------- undo ------------------------------------- */
{
  st().undo(); // the fader move
  const a = gainA.calls.length;
  st().undo(); // the two deletes
  assert.equal(st().getLaneForTarget(VOL_A)?.points.length, 2, 'both keyframes are back');
  advance(WAIT_MS);
  const wrote = since(gainA, a);
  assert.deepEqual(
    names(wrote), ['cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime'],
    'the lane is armed again',
  );
  assert.ok(Math.abs(wrote[2][1] - 0.69) < 1e-9, 'with the keyframe the drag left');
}

/* ------------------------- a touch pass holds its own lane ------------------------- */
{
  st().setAutomationMode('touch');
  advance(WAIT_MS);
  const a = gainA.calls.length;
  st().beginAutomationTouch(VOL_A, currentTransportSec(), 0.3);
  advance(10);
  st().moveAutomationTouch(VOL_A, currentTransportSec(), 0.35);
  advance(WAIT_MS * 2);
  assert.deepEqual(since(gainA, a), [], 'the hold writes its lane and the lane is not re-armed under it');

  st().endAutomationTouch(VOL_A, currentTransportSec());
  advance(WAIT_MS);
  assert.equal(names(since(gainA, a))[0], 'cancelScheduledValues', 'the punch-out hands the gain back to the lane');
  st().setAutomationMode('read');
  advance(WAIT_MS);
}

/* ------------------------------------ a pan lane ------------------------------------ */
{
  let p = panB.calls.length;
  let panLane = '';
  st().undoGroup(() => {
    panLane = st().addAutomationLane(PAN_TARGET_B);
    st().addAutomationPoint(panLane, 0, -1);
    st().addAutomationPoint(panLane, 50, 1);
  });
  advance(WAIT_MS);
  let wrote = since(panB, p);
  assert.deepEqual(
    names(wrote), ['cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime'],
    'a new pan lane is armed on the panner, once for the three writes',
  );
  assert.deepEqual(wrote[2], ['linearRampToValueAtTime', 1, 150]);

  // Two lanes edited inside one wait: the re-arm diffs from the lanes the params
  // were last armed from, so the earlier of the two edits is not lost.
  p = panB.calls.length;
  const a = gainA.calls.length;
  beginUndoStep();
  // The touch pass left points of its own on the lane, so its last keyframe
  // (the one at 40 s) is found by position, not assumed to be the second.
  const lastKeyframe = (st().getLaneForTarget(VOL_A)?.points.length ?? 0) - 1;
  assert.equal(st().getLaneForTarget(VOL_A)?.points[lastKeyframe]?.t, 40);
  st().updateAutomationPoint('vol-a', lastKeyframe, 40, 0.6);
  advance(10);
  st().updateAutomationPoint(panLane, 1, 50, 0.5);
  advance(WAIT_MS);
  assert.deepEqual(since(gainA, a).pop(), ['linearRampToValueAtTime', 0.6, 140], 'the volume edit is on the gain');
  assert.deepEqual(since(panB, p).pop(), ['linearRampToValueAtTime', 0.5, 150], 'and the pan edit is on the panner');
  assert.equal(names(since(gainA, a)).filter((n) => n === 'cancelScheduledValues').length, 1, 'each armed once');

  p = panB.calls.length;
  beginUndoStep();
  st().clearAutomationLane(panLane);
  advance(WAIT_MS);
  wrote = since(panB, p);
  assert.deepEqual(names(wrote), ['cancelScheduledValues', 'setValueAtTime', 'setTargetAtTime']);
  assert.ok(near(wrote[1][1], onRamp(-1, 0.5, 50)), 'from where the pan lane had the panner');
  assert.deepEqual([wrote[2][1], wrote[2][3]], [PAN_B, RAMP_TC], 'cleared: the pan glides back to the knob');
}

/* ------------------- a seek starts a new pass, which drops the wait ------------------- */
// A seek tears the pass down and builds another. An edit that lands while the
// new pass is being set up is already in the store that pass arms from. Its
// waiting re-arm was diffed against the old pass and must not reach the new
// strips: a stale release would pin the new gain on the old lane's value and
// glide it back, which is heard as a short dip or bump.
{
  const lastKeyframe = (st().getLaneForTarget(VOL_A)?.points.length ?? 0) - 1;
  seek(10);
  beginUndoStep();
  st().updateAutomationPoint('vol-a', lastKeyframe, 40, 0.9); // dragged while the new pass is being built
  assert.equal(timers.size, 1, 'the edit asked for a re-arm');
  await settle();
  assert.equal(isPlaying(), true, 'the new pass is rolling');
  assert.equal(timers.size, 0, 'arming the new pass dropped the wait');

  const seekGainA = opened(gainNodes, (n) => n.gain, 0.75);
  assert.notEqual(seekGainA, gainA, 'the seek built new strips');
  const armed = seekGainA.calls.length;
  assert.deepEqual(
    seekGainA.calls[armed - 1], ['linearRampToValueAtTime', 0.9, audioNow + 30],
    'the new pass is armed from the store, the edit included',
  );
  advance(WAIT_MS * 2);
  assert.equal(seekGainA.calls.length, armed, 'and no stale re-arm reaches the new strip');
  assert.ok(currentTransportSec() > 10, 'the transport runs from the seek position');

  // The next edit diffs from the lanes the NEW pass armed. Bypassed, the gain
  // leaves from the value the edited lane is playing, not the one it had
  // before the seek.
  const armedLane = st().getLaneForTarget(VOL_A);
  assert.ok(armedLane);
  beginUndoStep();
  st().toggleAutomationLane('vol-a');
  advance(WAIT_MS);
  const wrote = seekGainA.calls.slice(armed);
  assert.deepEqual(
    names(wrote), ['cancelScheduledValues', 'setValueAtTime', 'setTargetAtTime'],
    'an edit after the seek reaches the new strip',
  );
  const playingNow = sampleLane(armedLane, currentTransportSec());
  assert.ok(playingNow !== null && near(wrote[1][1], playingNow), `pinned on the lane the new pass armed: ${wrote[1][1]}`);

  st().toggleAutomationLane('vol-a'); // back on for what follows
  advance(WAIT_MS);
}

/* -------------------------- stop drops a waiting re-arm -------------------------- */
{
  const liveGainA = opened(gainNodes, (n) => n.gain, 0.75);
  st().updateAutomationPoint('vol-a', 0, 0, 0.25);
  assert.equal(timers.size, 1, 'a re-arm is waiting');
  const a = liveGainA.calls.length;
  stop();
  assert.equal(isPlaying(), false);
  assert.equal(timers.size, 0, 'stop drops it');
  advance(1000);
  assert.deepEqual(since(liveGainA, a), [], 'and nothing reaches the gain after the stop');

  // Stopped, an edit needs no timer: the next play schedules every lane from the
  // store, the dropped edit and this one included.
  st().updateAutomationPoint('vol-a', 0, 0, 0.3);
  assert.equal(timers.size, 0, 'an edit while stopped sets no timer');
  await playAsync();
  const nextGainA = opened(gainNodes, (n) => n.gain, 0.75); // the new strip opens at the fader as it stands
  assert.notEqual(nextGainA, liveGainA, 'play built new strips');
  assert.deepEqual(nextGainA.calls[2], ['setValueAtTime', 0.3, audioNow], 'the next pass opens on the edited lane');
  stop();
}

dispose();

console.log('liveMixer.rearmLive: ok');
