// PERFORM's effect slots take the whole catalog: every rack effect and every
// scanned VST3 plugin goes onto every track, lands as a live chain entry, is
// routable from the Sway deck, and is written by a save.
//
// The app's order, replayed: a pick in the add menu becomes a device
// (performRackDevice / performVstDevice), the device joins the track
// (addPerformDevice), the grid re-wires the column from performChainEntries,
// the rail lists it (performSlots), the deck offers its parameters
// (performFxParamOptions), a routed knob addresses it (ccModFxRoute), and
// "Save as .tasmo" writes it (dawProjectToTasmo).
//
//   cd frontend && npx tsx src/lib/performSlots.test.ts
import assert from 'node:assert/strict';
import type { DawProject, DawTrack } from './dawImportClient.ts';
import {
  addPerformDevice,
  performChainEntries,
  performFxParamOptions,
  performRackDevice,
  performSlotOfEntry,
  performSlots,
  performVstDevice,
  storePerformVstState,
} from './performModel.ts';
import { dawProjectToTasmo } from './projectClient.ts';
import { RACK_EFFECTS } from './rackEffects.ts';
import { ccModFxRoute } from '../components/session/ccModFxRouteModel.ts';

const track = (name: string, type: string, devices: DawTrack['devices'] = []): DawTrack => ({
  name, type, volume_db: 0, pan: 0, mute: false, solo: false, clips: [], devices,
});

/** A set as an import leaves it: an empty MIDI track, and an audio track that
 *  already holds an instrument, a rack container, a device with no match here
 *  and a hosted plugin. */
const emptyMidi = track('Keys', 'midi');
const busy = track('Drums', 'audio', [
  { name: 'Sampler', plugin_type: 'builtin', is_instrument: true },
  { name: 'Drum Rack', plugin_type: 'builtin', is_rack: true },
  { name: 'Zzyx Mangler', plugin_type: 'builtin' },
  { name: 'Pro-Q 4', plugin_type: 'vst3', plugin_path: 'C:/VST3/Pro-Q 4.vst3' },
]);
const before = performChainEntries(busy, 1).map((e) => `${e.id}:${e.effect}`);
assert.deepEqual(before, ['perform-1-0:Zzyx Mangler', 'perform-1-1:vst3']);

/* ── every rack effect goes onto every track ─────────────────────────────── */
assert.ok(RACK_EFFECTS.length > 0);
for (const [mixIndex, t] of [emptyMidi, busy].entries()) {
  for (const def of RACK_EFFECTS) {
    const at = addPerformDevice(t, performRackDevice(def.id));
    const entry = performChainEntries(t, mixIndex)[at];
    assert.equal(entry.id, `perform-${mixIndex}-${at}`, `${def.id} takes the next chain index`);
    assert.equal(entry.effect, def.id, `${def.id} is a live rack entry, whatever its name resembles`);
    assert.equal(entry.enabled, true);
    const slot = performSlots(t, mixIndex)[at];
    assert.equal(slot.kind, 'fx');
    assert.equal(slot.name, def.label, 'the rail names it as the add menu does');
    const keys = performFxParamOptions(t, mixIndex).filter((o) => o.deviceIndex === at);
    assert.deepEqual(keys.map((o) => [o.paramKey, o.min, o.max]), def.params.map((p) => [p.key, p.min, p.max]),
      `every ${def.id} parameter is routable, with its own range`);
  }
}
assert.equal(performSlots(emptyMidi, 0).length, RACK_EFFECTS.length, 'a track with no devices takes the whole catalog');
// A pick goes on the END: what was already running keeps its entry id.
assert.deepEqual(performChainEntries(busy, 1).slice(0, 2).map((e) => `${e.id}:${e.effect}`), before);
assert.equal(performSlots(busy, 1)[0].kind, 'inert', 'a device from another DAW with no match stays listed');

/* ── every scanned plugin goes onto every track ──────────────────────────── */
const plugin = { name: 'ValhallaRoom', display_name: 'Valhalla Room', path: 'C:/VST3/ValhallaRoom.vst3' };
for (const [mixIndex, t] of [emptyMidi, busy].entries()) {
  const at = addPerformDevice(t, performVstDevice(plugin));
  const entry = performChainEntries(t, mixIndex)[at];
  assert.equal(entry.effect, 'vst3', 'the chain builder hosts it');
  assert.equal(entry.vst?.plugin_path, plugin.path);
  assert.equal(entry.vst?.plugin_name, 'Valhalla Room');
  const slot = performSlots(t, mixIndex)[at];
  assert.equal(slot.kind, 'vst');

  // No host has listed its parameters yet: nothing to route, nothing invented.
  assert.equal(performFxParamOptions(t, mixIndex).filter((o) => o.deviceIndex === at).length, 0);
  // The running host's list is what the deck offers: p<index> over 0..1.
  const listed = performFxParamOptions(t, mixIndex, {
    [entry.id]: [
      { index: 0, name: 'Mix' },
      { index: 1, name: 'Bookkeeping', hidden: true },
      { index: 2, name: 'Meter', readOnly: true },
      { index: 7, name: 'Decay' },
    ],
  }).filter((o) => o.deviceIndex === at);
  assert.deepEqual(listed.map((o) => [o.paramKey, o.paramLabel, o.min, o.max]), [['p0', 'Mix', 0, 1], ['p7', 'Decay', 0, 1]]);

  // A knob routed to one reaches that chain entry with the raw 0..1 value.
  const route = ccModFxRoute({
    id: 'r', channel: -1, number: 21, isNote: false, trackIndex: mixIndex, target: 'fx',
    deviceIndex: listed[1].deviceIndex, paramKey: listed[1].paramKey, min: listed[1].min, max: listed[1].max, label: 'r',
  }, 0.25);
  assert.deepEqual(route, { entryId: entry.id, paramKey: 'p7', normalized: 0.25, scaled: 0.25 });
}

/* ── a slot is bypassed in place ─────────────────────────────────────────── */
performSlots(emptyMidi, 0)[0].device.bypass = true;
assert.equal(performChainEntries(emptyMidi, 0)[0].enabled, false, 'the chain routes around it');
assert.equal(performChainEntries(emptyMidi, 0)[1].enabled, true);

/* ── a save writes what the slots hold ───────────────────────────────────── */
// A track opened from a .tasmo keeps the file's own inserts as they were (an
// older studio id like "compression" is not re-read as the rack effect it
// resembles), with each slot's bypass, and gains the devices put after them.
const own = [
  { id: 'fx-a', node_type: 'builtin', effect_name: 'compression', parameters: { amount: 3 }, bypass: false },
  { id: 'fx-b', node_type: 'builtin', effect_name: 'reverb', parameters: {}, bypass: false },
];
const opened: DawTrack = {
  ...track('Lead', 'audio', own.map((n) => ({ name: n.effect_name, plugin_type: 'builtin', parameters: n.parameters, bypass: false, id: n.id }))),
  tasmo: { id: 't-lead', effect_chain: own } as unknown as DawTrack['tasmo'],
};
const project: DawProject = {
  source_daw: 'tasmo', source_version: '', name: 'Set', tempo: 120, time_signature: [4, 4], sample_rate: 48000,
  tracks: [opened], locators: [], controller_mappings: [], scenes: [], plugins_used: [], warnings: [], missing_files: [],
};
assert.equal(dawProjectToTasmo(project).tracks[0].effect_chain, own, 'an untouched chain is written as the file has it');

opened.devices[1].bypass = true;
addPerformDevice(opened, performRackDevice('delay'));
addPerformDevice(opened, performVstDevice(plugin));
const saved = dawProjectToTasmo(project).tracks[0].effect_chain ?? [];
assert.equal(saved.length, 4);
assert.equal(saved[0], own[0], 'the file\'s own insert is the same node');
assert.deepEqual(saved[1], { ...own[1], bypass: true }, 'a bypass set in PERFORM is saved');
assert.deepEqual([saved[2].node_type, saved[2].effect_name, saved[2].bypass], ['builtin', 'delay', false]);
assert.equal(saved[3].node_type, 'vst3');
assert.equal(saved[3].vst_state?.plugin_path, plugin.path);

/* ── a plugin's captured state is kept on its slot and saved ─────────────── */
assert.equal(performSlotOfEntry(project, 'perform-0-3')?.kind, 'vst');
assert.equal(performSlotOfEntry(project, 'perform-0-9'), undefined);
assert.equal(storePerformVstState(project, 'perform-0-2', 'AAAA', 'thedaw'), false, 'a rack effect holds no plugin state');
assert.equal(storePerformVstState(project, 'perform-0-3', 'QUJD', 'thedaw'), true);
assert.equal(performChainEntries(opened, 0)[3].vst?.raw_state, 'QUJD', 'a rebuilt chain starts the plugin on it');
const resaved = dawProjectToTasmo(project).tracks[0].effect_chain ?? [];
assert.equal(resaved[3].vst_state?.raw_state, 'QUJD', 'a save writes it');
assert.equal(resaved[3].vst_state?.state_host, 'thedaw');

console.log('performSlots.test.ts: all assertions passed');
