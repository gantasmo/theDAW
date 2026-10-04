/**
 * swayHostVst: a SWAY cockpit track's VST3 row becomes one live plugin in
 * theDAW's host, named by the row's id, spawned with the row's state, on the
 * cockpit's transport, and handing every state the host captures back to the
 * row.
 *
 *   npx tsx src/lib/swayHostVst.test.ts
 */
import assert from 'node:assert/strict';

import {
  __setSwayVstDepsForTest,
  swayHostVstApi,
  swayVstEntryId,
  swayVstOwner,
} from './swayHostVst.ts';
import { vstEntryTransport } from './vstLive/vstLiveNode.ts';
import { SWAY_HOLDER } from './vstLive/projectSessions.ts';
import type { ChainEntry } from '../state/effectChainStore.ts';

const calls: string[] = [];
const built: ChainEntry[] = [];
const pushed: Record<string, number>[] = [];
let disposed = 0;

const ctx = { sampleRate: 48000, currentTime: 0 } as unknown as BaseAudioContext;
const fakeNode = () => ({ id: Math.random() }) as unknown as AudioNode;

__setSwayVstDepsForTest({
  createNode: (_ctx, entry) => {
    built.push(entry);
    return {
      input: fakeNode(),
      output: fakeNode(),
      setParams: (p: Record<string, number>) => pushed.push(p),
      dispose: () => {
        disposed++;
      },
    };
  },
  registry: {
    hold: async (entry, _sr, holder) => {
      calls.push(`hold ${entry.id} ${holder}`);
      return null;
    },
    unhold: (id, holder) => calls.push(`unhold ${id} ${holder}`),
    forget: (id) => calls.push(`forget ${id}`),
    get: () => undefined,
    markUserParamsChanged: (id) => calls.push(`moved ${id}`),
  },
});

const row = { id: 'vst-a1', path: 'C:/VST3/Delay.vst3', name: 'Delay', rawState: 'U1RBVEU=', stateHost: 'pedalboard' };
const states: [string, string][] = [];
const sink = { state: (raw: string, host: string) => states.push([raw, host]) };

// The cockpit's transport, told before the row exists, is the first one its plugin hears.
const playing = { playing: true, positionSamples: 96000, tempoBpm: 99, discontinuity: true, atTime: 3, atSec: 3 };
swayHostVstApi.transport(playing);

const node = swayHostVstApi.build(ctx, row, sink);
assert.ok(node, 'a row with an id and a path builds');
const entryId = swayVstEntryId(row.id);
assert.equal(built[0].id, entryId, "the plugin is named by the row's id");
assert.equal(built[0].effect, 'vst3');
assert.equal(built[0].vst?.plugin_path, row.path);
assert.equal(built[0].vst?.raw_state, row.rawState, "the plugin is spawned with the row's state");
assert.equal(built[0].vst?.state_host, 'pedalboard');
assert.deepEqual(calls, [`hold ${entryId} ${SWAY_HOLDER}`], "held under the cockpit's holder, which EDIT's teardown spares");
assert.equal(vstEntryTransport(entryId).positionSamples, 96000, "the cockpit's transport, not EDIT's");
assert.equal(vstEntryTransport(entryId).tempoBpm, 99);

// A later transport reaches the running row.
swayHostVstApi.transport({ playing: false, positionSamples: 0, tempoBpm: 99, discontinuity: true });
assert.equal(vstEntryTransport(entryId).playing, false);

// A parameter moved in the cockpit reaches the plugin and marks a user move.
node.setParam(3, 0.25);
assert.deepEqual(pushed.at(-1), { p3: 0.25 });
assert.ok(calls.includes(`moved ${entryId}`));
node.setParam(-1, 0.5);
node.setParam(2, Number.NaN);
assert.equal(pushed.length, 1, 'a bad index or value never reaches the plugin');

// A state the live host captures lands on the row, through the editor store's owner.
assert.equal(swayVstOwner.find(entryId)?.vst?.plugin_path, row.path, 'the editor store finds the plugin');
swayVstOwner.setRawState(entryId, 'TkVX', 'thedaw');
assert.deepEqual(states, [['TkVX', 'thedaw']]);
assert.equal(swayVstOwner.find(entryId)?.vst?.raw_state, 'TkVX');
assert.equal(swayVstOwner.find(entryId)?.params.p3, 0.25, 'the moved parameter stays on the entry for a respawn');

// A rebuild (the cockpit rewires its graph) keeps the same entry and its state.
const again = swayHostVstApi.build(ctx, { ...row, rawState: 'TkVX', stateHost: 'thedaw' }, sink);
assert.ok(again);
assert.equal(built[1].id, entryId);
assert.equal(built[1].params.p3, 0.25);
node.dispose();
assert.equal(disposed, 1);
assert.ok(!calls.includes(`unhold ${entryId} ${SWAY_HOLDER}`), 'still held while another node carries the row');
again.dispose();
assert.ok(calls.includes(`unhold ${entryId} ${SWAY_HOLDER}`), 'the last node gives the hold back');

// The row leaves the project.
swayHostVstApi.forget(row.id);
assert.ok(calls.includes(`forget ${entryId}`));
assert.equal(swayVstOwner.find(entryId), undefined);

// A row with no id or no path is refused.
assert.equal(swayHostVstApi.build(ctx, { id: '', path: 'x.vst3' }), null);
assert.equal(swayHostVstApi.build(ctx, { id: 'r', path: '' }), null);

__setSwayVstDepsForTest(null);
console.log('swayHostVst: ok');
process.exit(0);
