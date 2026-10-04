// Automation lanes edited while playing: which native (volume / pan) params are
// re-armed and which go back to the fader.
//
// `start()` writes each volume and pan lane's envelope onto its AudioParam once.
// Before this, an edit made while playing (a keyframe dragged on the EDIT volume
// line, a lane bypassed, an undo) was heard only after the next play or seek. A
// lane whose last point was deleted also kept its param: `automatedNativeKeys`
// went on counting the empty lane, so `applyMixLive` did not push the fader.
//
// What is pinned:
//
//   1. `nativeLaneRearmPlan`, the pure rule: only volume and pan lanes, the same
//      lane object skipped, a held target skipped, a lane that owns its param
//      scheduled, a lane that stopped owning it released.
//   2. The same rule over the REAL editor store, on the (state, prev) pairs its
//      own actions hand a subscriber. The mixer subscribes the same way, and the
//      per-lane reference gate is only worth anything if the store replaces
//      nothing but the lane it edits.
//   3. `automatedNativeKeys`: an enabled lane with no points owns nothing.
//
// Everything here runs with no audio context. The writes themselves
// (`scheduleLaneNative`, the glide back to the fader), the 30 ms wait and the
// subscription that asks for them are replayed on a fake AudioContext in
// `liveMixer.rearmLive.test.ts`.
//
// Run: npx tsx src/state/liveMixer.rearm.test.ts
import assert from 'node:assert/strict';

import { automatedNativeKeys, nativeLaneRearmPlan, type NativeLaneRearmStep } from './liveMixer.ts';
import {
  automationTargetKey,
  beginUndoStep,
  useEditorStore,
  type AutomationHold,
  type AutomationLane,
  type AutomationPoint,
  type AutomationTarget,
  type EditorTrack,
} from './editorStore.ts';

const VOL_A: AutomationTarget = { kind: 'trackVolume', trackId: 'a' };
const PAN_A: AutomationTarget = { kind: 'trackPan', trackId: 'a' };
const VOL_B: AutomationTarget = { kind: 'trackVolume', trackId: 'b' };
const FX_A: AutomationTarget = { kind: 'trackFx', trackId: 'a', entryId: 'e1', paramKey: 'mix' };
const CC_A: AutomationTarget = { kind: 'trackMidiCc', trackId: 'a', paramKey: '74' };
const BUS_FX: AutomationTarget = { kind: 'busFx', trackId: 'bus1', entryId: 'e2', paramKey: 'mix' };
const MASTER_FX: AutomationTarget = { kind: 'masterFx', entryId: 'm1', paramKey: 'drive' };

const keyOf = automationTargetKey;

const lane = (target: AutomationTarget, points: AutomationPoint[], enabled = true, id?: string): AutomationLane => ({
  id: id ?? `lane-${keyOf(target)}`,
  target,
  points,
  enabled,
});

/** Points one second apart carrying the given values. */
const pts = (...values: number[]): AutomationPoint[] => values.map((v, i) => ({ t: i, v }));

/** A plan as sorted `action key` lines, for comparing whole plans. */
const lines = (plan: NativeLaneRearmStep[]): string[] => plan.map((s) => `${s.action} ${s.key}`).sort();

const hold = (target: AutomationTarget): AutomationHold => ({ target, value: 0.5, lastT: 0, released: false });

/* -- 1. Only volume and pan lanes are read --------------------------------- */

function onlyNativeLanesAreRead(): void {
  const others = [FX_A, CC_A, BUS_FX, MASTER_FX];
  const prev = others.map((t) => lane(t, pts(0.2, 0.8)));

  // Every one of them edited, each in a way that would be a step on a native lane.
  const edited = [
    lane(FX_A, pts(0.9, 0.1)),
    lane(CC_A, []),
    lane(BUS_FX, pts(0.2, 0.8), false),
  ];
  assert.deepEqual(nativeLaneRearmPlan(prev, edited, {}), [], 'FX, MIDI CC and bus lanes plan nothing');
  assert.deepEqual(nativeLaneRearmPlan([], prev, {}), [], 'nor do new ones');
  assert.deepEqual(nativeLaneRearmPlan(prev, [], {}), [], 'nor removed ones');

  // Beside a native edit, only the native lane is in the plan.
  const vol = lane(VOL_A, pts(0.5));
  const moved = lane(VOL_A, pts(0.7));
  assert.deepEqual(
    lines(nativeLaneRearmPlan([...prev, vol], [...edited, moved], {})),
    [`schedule ${keyOf(VOL_A)}`],
  );
}

/* -- 2. The same lane object is skipped ------------------------------------ */

function theSameLaneObjectIsSkipped(): void {
  const volA = lane(VOL_A, pts(0.2, 0.8));
  const panA = lane(PAN_A, pts(-1, 1));
  const volB = lane(VOL_B, pts(0.6));
  const prev = [volA, panA, volB];

  assert.deepEqual(nativeLaneRearmPlan(prev, prev, {}), [], 'the same list plans nothing');
  assert.deepEqual(
    nativeLaneRearmPlan(prev, [...prev], {}), [],
    'a new list holding the same lane objects plans nothing',
  );
  assert.deepEqual(
    nativeLaneRearmPlan(prev, [volB, volA, panA], {}), [],
    'nor does a reorder: the gate is the lane object, not its place',
  );

  // One lane replaced: that lane alone, though all three own their params.
  const movedPan = { ...panA, points: pts(-0.5, 0.5) };
  const plan = nativeLaneRearmPlan(prev, [volA, movedPan, volB], {});
  assert.deepEqual(lines(plan), [`schedule ${keyOf(PAN_A)}`]);
  assert.equal(plan[0].lane, movedPan, 'the step carries the lane as it is now');

  // The gate is identity, not equality. A rebuilt lane with the same content is
  // armed again, which costs one envelope write and is never wrong.
  assert.deepEqual(
    lines(nativeLaneRearmPlan(prev, [{ ...volA }, panA, volB], {})),
    [`schedule ${keyOf(VOL_A)}`],
  );
}

/* -- 3. A held target is skipped ------------------------------------------- */

function aHeldTargetIsSkipped(): void {
  const before = lane(VOL_A, pts(0.2, 0.8));
  const holds = { [keyOf(VOL_A)]: hold(VOL_A) };

  assert.deepEqual(
    nativeLaneRearmPlan([before], [{ ...before, points: pts(0.3, 0.8) }], holds), [],
    'a record pass writing into its own lane does not re-arm it',
  );
  assert.deepEqual(
    nativeLaneRearmPlan([before], [{ ...before, points: [] }], holds), [],
    'nor is a held param released when its lane empties',
  );
  assert.deepEqual(nativeLaneRearmPlan([before], [], holds), [], 'nor when its lane is removed');
  assert.deepEqual(nativeLaneRearmPlan([], [before], holds), [], 'nor is a new lane armed over a hold');

  // A hold shields its own target and no other.
  const pan = lane(PAN_A, pts(0));
  assert.deepEqual(
    lines(nativeLaneRearmPlan(
      [before, pan],
      [{ ...before, points: pts(0.3, 0.8) }, { ...pan, points: pts(1) }],
      holds,
    )),
    [`schedule ${keyOf(PAN_A)}`],
    'the pan lane of the same track is not held and is armed',
  );
}

/* -- 4. A lane that owns its param is scheduled ---------------------------- */

function anOwningLaneIsScheduled(): void {
  const before = lane(VOL_A, pts(0.2, 0.8));

  // A keyframe dragged.
  const dragged = { ...before, points: pts(0.2, 0.4) };
  const plan = nativeLaneRearmPlan([before], [dragged], {});
  assert.deepEqual(plan, [{ key: keyOf(VOL_A), target: VOL_A, action: 'schedule', lane: dragged }]);

  // A lane that was not there before (an undo putting a deleted lane back).
  assert.deepEqual(lines(nativeLaneRearmPlan([], [before], {})), [`schedule ${keyOf(VOL_A)}`]);

  // The first keyframe on a lane that had none.
  assert.deepEqual(
    lines(nativeLaneRearmPlan([lane(VOL_A, [])], [lane(VOL_A, pts(0.8))], {})),
    [`schedule ${keyOf(VOL_A)}`],
  );

  // A bypassed lane switched back on.
  assert.deepEqual(
    lines(nativeLaneRearmPlan([{ ...before, enabled: false }], [{ ...before }], {})),
    [`schedule ${keyOf(VOL_A)}`],
  );

  // Pan is the other native kind.
  const pan = lane(PAN_A, pts(-1, 1));
  assert.deepEqual(
    lines(nativeLaneRearmPlan([pan], [{ ...pan, points: pts(-1, 0) }], {})),
    [`schedule ${keyOf(PAN_A)}`],
  );
}

/* -- 5. A lane that stopped owning its param is released ------------------- */

function aLaneThatStoppedOwningIsReleased(): void {
  const one = lane(VOL_A, pts(0.5));
  const many = lane(VOL_A, pts(0.2, 0.8, 0.4));
  const released = (was: AutomationLane) => [{ key: keyOf(VOL_A), target: VOL_A, action: 'release', lane: was }];

  assert.deepEqual(
    nativeLaneRearmPlan([one], [{ ...one, points: [] }], {}), released(one),
    'the last keyframe deleted: the fader takes the gain back',
  );
  assert.deepEqual(nativeLaneRearmPlan([many], [{ ...many, points: [] }], {}), released(many), 'the lane cleared');
  assert.deepEqual(nativeLaneRearmPlan([many], [{ ...many, enabled: false }], {}), released(many), 'the lane bypassed');
  assert.deepEqual(nativeLaneRearmPlan([many], [], {}), released(many), 'the lane removed');

  // The step carries the lane the param is LEAVING, as it was before the edit.
  // The mixer reads the value that lane is playing and glides from there.
  assert.equal(
    nativeLaneRearmPlan([many], [{ ...many, points: [] }], {})[0].lane, many,
    'a release carries the lane as it was, not the emptied one',
  );
  assert.equal(nativeLaneRearmPlan([many], [], {})[0].lane, many, 'and so does the release of a removed lane');
}

/* -- 6. A lane that owned nothing on either side changes nothing ----------- */

function aLaneThatNeverOwnedChangesNothing(): void {
  const empty = lane(VOL_A, []);
  const off = lane(VOL_A, pts(0.2, 0.8), false);

  assert.deepEqual(nativeLaneRearmPlan([], [empty], {}), [], 'a new lane with no points');
  assert.deepEqual(nativeLaneRearmPlan([empty], [], {}), [], 'an empty lane removed');
  assert.deepEqual(nativeLaneRearmPlan([off], [{ ...off, points: pts(0.9, 0.1) }], {}), [], 'a bypassed lane edited');
  assert.deepEqual(nativeLaneRearmPlan([off], [{ ...off, points: [] }], {}), [], 'a bypassed lane cleared');
  assert.deepEqual(nativeLaneRearmPlan([off], [], {}), [], 'a bypassed lane removed');
  assert.deepEqual(nativeLaneRearmPlan([empty], [{ ...empty, enabled: false }], {}), [], 'an empty lane bypassed');
}

/* -- 7. Several targets in one edit ---------------------------------------- */

function oneEditAcrossSeveralTargets(): void {
  // What an undo across a busy step looks like: one lane changed, one gone, one
  // back, one left alone.
  const volA = lane(VOL_A, pts(0.2, 0.8));
  const panA = lane(PAN_A, pts(-1, 1));
  const volB = lane(VOL_B, pts(0.6));
  const fx = lane(FX_A, pts(0.1));
  const volA2 = { ...volA, points: pts(0.2, 0.3) };
  const plan = nativeLaneRearmPlan([volA, panA, volB, fx], [volA2, volB, { ...fx, points: pts(0.9) }], {});
  assert.deepEqual(lines(plan), [`release ${keyOf(PAN_A)}`, `schedule ${keyOf(VOL_A)}`]);
  assert.equal(new Set(plan.map((s) => s.key)).size, plan.length, 'one step per target');
}

/* -- 8. Two lanes on one target -------------------------------------------- */

/** The store never makes a second lane for a target, but a file can carry one.
 *  `scheduleAutomation` arms each in turn, so the last one that owns the param is
 *  the one on it. The plan follows that lane and never plans a target twice. */
function twoLanesOnOneTargetPlanOnce(): void {
  const first = lane(VOL_A, pts(0.2), true, 'first');
  const second = lane(VOL_A, pts(0.9), true, 'second');

  const edited = { ...second, points: pts(0.7) };
  const moved = nativeLaneRearmPlan([first, second], [first, edited], {});
  assert.deepEqual(lines(moved), [`schedule ${keyOf(VOL_A)}`]);
  assert.equal(moved[0].lane, edited, 'the last owning lane is the one armed');

  assert.deepEqual(
    nativeLaneRearmPlan([first, second], [{ ...first, points: pts(0.3) }, second], {}), [],
    'an edit to the lane that is not on the param plans nothing',
  );

  // The owner bypassed: the other lane takes the param, it is not released.
  const fallback = nativeLaneRearmPlan([first, second], [first, { ...second, enabled: false }], {});
  assert.deepEqual(lines(fallback), [`schedule ${keyOf(VOL_A)}`]);
  assert.equal(fallback[0].lane, first);

  // Both gone: one release, not two, and it leaves the lane that was on the param.
  const gone = nativeLaneRearmPlan([first, second], [], {});
  assert.deepEqual(lines(gone), [`release ${keyOf(VOL_A)}`]);
  assert.equal(gone[0].lane, second);
}

/* -- 9. The real store, the way the mixer's subscription sees it ----------- */

const st = () => useEditorStore.getState();

const track = (id: string): EditorTrack => ({
  id, name: id, nameAutoGenerated: false, volume: 0.8, pan: 0,
  mute: false, solo: false, color: '#fff',
});

/** The reset `editorStore.automation.test.ts` uses: a known document, then the
 *  undo history counted from zero. */
function resetStore(lanes: AutomationLane[] = []): void {
  useEditorStore.setState({
    tracks: [track('a'), track('b')],
    clips: [],
    masterFxChain: [],
    automationLanes: lanes,
    automationHolds: {},
    automationMode: 'read',
  } as never);
  useEditorStore.setState({ _undo: [], _redo: [] });
  beginUndoStep();
}

function theStoreReplacesOnlyTheLaneItEdits(): void {
  resetStore();
  // One entry per store write that swapped the lane list: the plan the mixer
  // would run for it. Gated exactly as the mixer's subscription is.
  const plans: string[][] = [];
  const unsub = useEditorStore.subscribe((state, prev) => {
    if (state.automationLanes === prev.automationLanes) return;
    plans.push(lines(nativeLaneRearmPlan(prev.automationLanes, state.automationLanes, state.automationHolds)));
  });
  /** The plans the writes inside `fn` produced. */
  const during = (fn: () => void): string[][] => {
    plans.length = 0;
    fn();
    return plans.map((p) => [...p]);
  };
  const volAKey = keyOf(VOL_A);
  const volBKey = keyOf(VOL_B);

  try {
    // The first keyframe on a bare fader line: the lane, then its point, as one
    // undo step. The empty lane plans nothing, the point arms it.
    let volA = '';
    assert.deepEqual(
      during(() => st().undoGroup(() => {
        volA = st().addAutomationLane(VOL_A);
        st().addAutomationPoint(volA, 1, 0.8);
      })),
      [[], [`schedule ${volAKey}`]],
    );

    // A second track gets keyframes, and an FX lane beside them.
    let volB = '';
    during(() => {
      beginUndoStep();
      volB = st().addAutomationLane(VOL_B);
      st().addAutomationPoint(volB, 0, 0.5);
      st().addAutomationPoint(volB, 2, 0.9);
      const fx = st().addAutomationLane(FX_A);
      st().addAutomationPoint(fx, 0, 0.3);
    });
    const laneB = st().getLaneForTarget(VOL_B);

    // A keyframe drag on track a: every write arms a alone. Track b owns its
    // param the whole time and is never touched.
    assert.deepEqual(
      during(() => {
        st().updateAutomationPoint(volA, 0, 1, 0.6);
        st().updateAutomationPoint(volA, 0, 1.5, 0.4);
      }),
      [[`schedule ${volAKey}`], [`schedule ${volAKey}`]],
    );
    assert.equal(st().getLaneForTarget(VOL_B), laneB, 'the store left the other lane object alone');

    // A second keyframe, then the first one deleted: still armed.
    assert.deepEqual(
      during(() => {
        beginUndoStep();
        st().addAutomationPoint(volA, 3, 0.2);
        st().removeAutomationPoint(volA, 0);
      }),
      [[`schedule ${volAKey}`], [`schedule ${volAKey}`]],
    );

    // Bypass and back.
    assert.deepEqual(
      during(() => {
        beginUndoStep();
        st().toggleAutomationLane(volA);
        st().toggleAutomationLane(volA);
      }),
      [[`release ${volAKey}`], [`schedule ${volAKey}`]],
    );

    // The last keyframe deleted: the fader takes the gain back. The undo puts
    // the keyframe back and the lane is armed again, track b still untouched.
    assert.deepEqual(
      during(() => {
        beginUndoStep();
        st().removeAutomationPoint(volA, 0);
      }),
      [[`release ${volAKey}`]],
    );
    assert.equal(st().getLaneForTarget(VOL_A)?.points.length, 0, 'the empty lane stays in place');
    assert.deepEqual(during(() => st().undo()), [[`schedule ${volAKey}`]]);
    assert.equal(st().getLaneForTarget(VOL_B), laneB, 'an undo keeps the lanes it did not change');

    // An FX lane edit swaps the lane list and plans nothing.
    assert.deepEqual(
      during(() => {
        beginUndoStep();
        st().recordAutomationPoint(FX_A, 4, 0.7);
      }),
      [[]],
    );

    // Clear, then remove.
    assert.deepEqual(
      during(() => {
        beginUndoStep();
        st().clearAutomationLane(volA);
        st().removeAutomationLane(volA);
      }),
      [[`release ${volAKey}`], []],
    );

    // A touch pass on track b: begin and move write into the lane under a hold
    // and plan nothing. The release drops the hold in the same write as its last
    // span, so the lane is armed again.
    st().setAutomationMode('touch');
    assert.deepEqual(
      during(() => {
        st().beginAutomationTouch(VOL_B, 1, 0.3);
        st().moveAutomationTouch(VOL_B, 1.2, 0.35);
        st().moveAutomationTouch(VOL_B, 1.4, 0.4);
      }),
      [[], [], []],
    );
    assert.ok(st().automationHolds[volBKey], 'the fader is held');
    assert.deepEqual(during(() => st().endAutomationTouch(VOL_B, 1.6)), [[`schedule ${volBKey}`]]);
    st().setAutomationMode('read');
  } finally {
    unsub();
  }
}

/* -- 10. automatedNativeKeys ----------------------------------------------- */

/** What `applyMixLive` reads to decide whether to push a fader. Every other
 *  reader (`scheduleAutomation`, the offline render, the editor's fader display)
 *  already asked for a point; this one did not, so a track whose keyframes were
 *  all deleted while playing kept the last envelope value under a dead fader. */
function anEmptyLaneDoesNotOwnItsParam(): void {
  const keys = (lanes: AutomationLane[]): string[] => {
    resetStore(lanes);
    return [...automatedNativeKeys()].sort();
  };

  assert.deepEqual(keys([]), []);
  assert.deepEqual(keys([lane(VOL_A, [])]), [], 'an enabled lane with no points is not counted');
  assert.deepEqual(keys([lane(VOL_A, pts(0.5))]), [keyOf(VOL_A)], 'one point is enough');
  assert.deepEqual(keys([lane(VOL_A, pts(0.5), false)]), [], 'a bypassed lane is not counted');
  assert.deepEqual(
    keys([lane(VOL_A, pts(0.5)), lane(PAN_A, []), lane(VOL_B, pts(0.2, 0.9)), lane(FX_A, pts(0.4))]),
    [keyOf(VOL_A), keyOf(VOL_B)].sort(),
    'volume and pan lanes with points, and nothing else',
  );

  // The sequence that exposed it: the last keyframe deleted through the store.
  resetStore([lane(VOL_A, pts(0.5), true, 'vol-a')]);
  assert.deepEqual([...automatedNativeKeys()], [keyOf(VOL_A)]);
  st().removeAutomationPoint('vol-a', 0);
  assert.equal(st().getLaneForTarget(VOL_A)?.enabled, true, 'the lane is still there and still enabled');
  assert.deepEqual([...automatedNativeKeys()], [], 'and the fader decides again');
  resetStore();
}

onlyNativeLanesAreRead();
theSameLaneObjectIsSkipped();
aHeldTargetIsSkipped();
anOwningLaneIsScheduled();
aLaneThatStoppedOwningIsReleased();
aLaneThatNeverOwnedChangesNothing();
oneEditAcrossSeveralTargets();
twoLanesOnOneTargetPlanOnce();
theStoreReplacesOnlyTheLaneItEdits();
anEmptyLaneDoesNotOwnItsParam();

console.log('liveMixer.rearm: ok');
