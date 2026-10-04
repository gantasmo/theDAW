/**
 * vstLiveStore — what a `vst3` chain entry's live host session is doing.
 *
 * Two things ride on this store and both are load-bearing:
 *  - the FX row's badge (LIVE / starting / render-only / error), and
 *  - plugin-delay compensation, which reads `vstLiveLatencySec` through
 *    `chainLatencyReport`. A latency this store reports while the entry is NOT
 *    live would move every other track for a plugin that is not in the path,
 *    so "0 unless live" is asserted here rather than left to the caller.
 *
 * Run: npx tsx src/state/vstLiveStore.test.ts
 */
import assert from 'node:assert/strict';

import {
  entryLatencySamples,
  entryLatencySec,
  useVstLiveStore,
  vstLiveLatencySec,
  vstLiveStatusOf,
  type VstLivePlugin,
} from './vstLiveStore.ts';

const st = () => useVstLiveStore.getState();
const reset = () => {
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
};

const PLUGIN: VstLivePlugin = {
  name: 'Ozone 11',
  vendor: 'iZotope',
  version: '11.0.0',
  category: 'Fx|Mastering',
  identifier: 'ABCDEF0123456789ABCDEF0123456789',
  format: 'VST3',
};

/* ── an entry nobody has touched is 'off', with no latency ─────────────────── */
{
  reset();
  assert.deepEqual(st().entries, {});
  assert.equal(vstLiveStatusOf('nobody').status, 'off', 'an unknown entry reads as off, not undefined');
  assert.equal(vstLiveLatencySec('nobody'), 0);
  assert.equal(vstLiveStatusOf('nobody').xruns, 0);
  assert.equal(vstLiveStatusOf('nobody').hasEditor, false);
}

/* ── starting -> ready -> live, and the latency it then declares ───────────── */
{
  reset();
  st().setStatus('e1', 'starting');
  assert.equal(st().entries.e1.status, 'starting');
  assert.equal(vstLiveLatencySec('e1'), 0, 'a session that is still opening delays nothing yet');

  st().setReady('e1', {
    plugin: PLUGIN,
    pluginLatencySamples: 1024,
    bridgeLatencySamples: 1536, // 512 * (2 + 1)
    sampleRate: 48000,
    hasEditor: true,
  });
  const e = st().entries.e1;
  assert.equal(e.status, 'live');
  assert.equal(e.plugin?.name, 'Ozone 11');
  assert.equal(e.hasEditor, true);
  assert.equal(e.reason, undefined, 'a ready session carries no failure reason');
  assert.equal(entryLatencySamples(e), 1024 + 1536, 'the plugin AND the bridge are in the path');
  assert.equal(entryLatencySec(e), (1024 + 1536) / 48000);
  assert.equal(vstLiveLatencySec('e1'), 2560 / 48000);
}

/* ── a latency change from the host moves the number ───────────────────────── */
{
  st().setLatency('e1', 64);
  assert.equal(entryLatencySamples(st().entries.e1), 64 + 1536, 'only the plugin half changes');
  assert.equal(st().entries.e1.status, 'live', 'and it is still live');
  st().setLatency('e1', 0);
  assert.equal(vstLiveLatencySec('e1'), 1536 / 48000, 'a zero-latency plugin still costs the bridge');
}

/* ── latency is 0 in every state but 'live' ────────────────────────────────── */
{
  for (const s of ['off', 'starting', 'error', 'unavailable'] as const) {
    st().setStatus('e1', s, s === 'off' ? undefined : 'because');
    assert.equal(
      vstLiveLatencySec('e1'),
      0,
      `a '${s}' entry is not in the live path, so it declares no latency`,
    );
  }
  // The samples are REMEMBERED across the drop, so a reconnect that lands on
  // the same plugin does not have to re-learn them before the mixer is right.
  assert.equal(st().entries.e1.bridgeLatencySamples, 1536);
  st().setStatus('e1', 'live');
  assert.equal(vstLiveLatencySec('e1'), 1536 / 48000, 'and come back when it does');
}

/* ── error and unavailable carry the reason the row shows ──────────────────── */
{
  reset();
  st().setStatus('e2', 'error', 'socket closed (1006)');
  assert.equal(st().entries.e2.status, 'error');
  assert.equal(st().entries.e2.reason, 'socket closed (1006)');
  st().setStatus('e2', 'unavailable', 'host binary not built');
  assert.equal(st().entries.e2.reason, 'host binary not built');
  st().setStatus('e2', 'live');
  assert.equal(st().entries.e2.reason, undefined, 'recovering clears the stale reason');
}

/* ── xruns accumulate; the host reports a running count per second ─────────── */
{
  reset();
  st().addXruns('e3', 4);
  st().addXruns('e3', 3);
  assert.equal(st().entries.e3.xruns, 7, 'xruns accumulate across reports');
  st().addXruns('e3', 0);
  assert.equal(st().entries.e3.xruns, 7);
  assert.throws(() => st().addXruns('e3', -1), RangeError, 'a negative count is a bug, not a decrement');
  assert.throws(() => st().addXruns('e3', Number.NaN), RangeError);
}

/* ── the compensation clamp flag ───────────────────────────────────────────── */
{
  reset();
  st().setReady('e4', {
    plugin: PLUGIN,
    pluginLatencySamples: 96000, // 2 s at 48 k — past the 1 s comp ceiling
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });
  assert.equal(st().entries.e4.clamped, false, 'the store does not decide this — the mixer does');
  st().setClamped('e4', true);
  assert.equal(st().entries.e4.clamped, true);
  st().setClamped('e4', false);
  assert.equal(st().entries.e4.clamped, false);
}

/* ── host availability, and what an unknown host means ─────────────────────── */
{
  reset();
  assert.equal(st().host.available, null, 'unknown until the probe answers — not "no"');
  st().setHost({ available: false, reason: 'thedaw-vst-host.exe not found' });
  assert.equal(st().host.available, false);
  assert.equal(st().host.reason, 'thedaw-vst-host.exe not found');
  st().setHost({ available: true, path: 'C:/x/thedaw-vst-host.exe', version: '1.0.0' });
  assert.equal(st().host.available, true);
  assert.equal(st().host.reason, undefined, 'an available host has nothing to explain');
}

/* ── entries are cleared individually and wholesale ────────────────────────── */
{
  reset();
  st().setHost({ available: true, path: 'C:/x/thedaw-vst-host.exe' });
  st().setStatus('a', 'live');
  st().setStatus('b', 'live');
  st().clearEntry('a');
  assert.deepEqual(Object.keys(st().entries), ['b']);
  assert.equal(vstLiveLatencySec('a'), 0);
  st().clearEntry('nope'); // idempotent
  assert.deepEqual(Object.keys(st().entries), ['b']);
  st().clearAll();
  assert.deepEqual(st().entries, {}, 'closing a project forgets every session');
  assert.equal(st().host.available, true, 'but not what it learned about the host binary');
}

/* ── updates are immutable, so a subscriber sees the change ────────────────── */
{
  reset();
  st().setStatus('s1', 'starting');
  const before = st().entries;
  const beforeEntry = before.s1;
  st().setStatus('s1', 'live');
  assert.notEqual(st().entries, before, 'the entries map is replaced, not mutated');
  assert.notEqual(st().entries.s1, beforeEntry, 'and so is the entry');

  const seen: string[] = [];
  const unsub = useVstLiveStore.subscribe((s) => seen.push(s.entries.s1?.status ?? 'gone'));
  st().setLatency('s1', 128);
  st().clearEntry('s1');
  unsub();
  assert.deepEqual(seen, ['live', 'gone'], 'every change notifies');
}

/* ── state origin: is the plugin at the state the entry claims to hold? ─────
   Every saved state is sent to the host, whichever editor wrote it (the two
   encodings are interchangeable — measured). So the only way a plugin is NOT
   holding what the entry saved is the HOST saying so, and then the reason it
   gave is what the row shows. */
{
  reset();
  assert.equal(
    vstLiveStatusOf('fresh').stateOrigin,
    'live',
    'an entry with nothing saved starts at defaults, which IS its state — nothing to warn about',
  );
  assert.equal(vstLiveStatusOf('fresh').stateReason, undefined, 'and there is no reason to carry');

  st().setStateOrigin('rejected', 'state-rejected', 'component state too short');
  assert.equal(st().entries.rejected.stateOrigin, 'state-rejected');
  assert.equal(
    st().entries.rejected.stateReason,
    'component state too short',
    "the host's own words are kept for the badge",
  );
  // The status is independent: the plugin IS live, it is just not holding the
  // settings the entry has stored for it.
  st().setStatus('rejected', 'live');
  assert.equal(st().entries.rejected.status, 'live');
  assert.equal(st().entries.rejected.stateOrigin, 'state-rejected', 'going live does not close the gap');

  st().setStateOrigin('rejected', 'live');
  assert.equal(st().entries.rejected.stateOrigin, 'live', 'capturing a live state closes it');
  assert.equal(st().entries.rejected.stateReason, undefined, 'and drops the stale reason with it');
}

/* ── subscribeWithSelector: a listener only fires for the slice it watches ──
   vstLiveNode relies on this to scope its subscription to one entry's status
   instead of waking up for every entry in the store. */
{
  reset();
  st().setStatus('a', 'starting');
  st().setStatus('b', 'starting');

  const seenA: (string | undefined)[] = [];
  const unsub = useVstLiveStore.subscribe(
    (s) => s.entries.a?.status,
    (status) => seenA.push(status),
  );

  st().setStatus('b', 'live'); // unrelated entry — must not reach a selector scoped to 'a'
  st().addXruns('b', 1);
  assert.deepEqual(seenA, [], "another entry's changes do not invoke a selector scoped to 'a'");

  st().setStatus('a', 'live');
  assert.deepEqual(seenA, ['live'], "this entry's own change does");

  st().setStatus('a', 'live'); // same value again — no change to report
  assert.deepEqual(seenA, ['live'], 'setting the same status again is not a change');

  unsub();
  st().setStatus('a', 'error', 'x');
  assert.deepEqual(seenA, ['live'], 'unsubscribing stops delivery');
}

// ── the open editor's size: the host's two reports ─────────────────────────
// The host reports the plugin's real view size, then acknowledges open_editor by
// repeating the box the app asked for. The acknowledgement must not replace the
// real size (it showed a 1240x723 plugin cut to the 600x400 opening box).
{
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
  const size = () => st().entries.ed?.editorSize ?? null;

  st().setEditorRequest('ed', { w: 600, h: 400 });
  st().setEditorOpen('ed', true, { w: 1240, h: 723 }); // the plugin's own size
  st().setEditorOpen('ed', true, { w: 600, h: 400 }); // the acknowledgement
  assert.deepEqual(size(), { w: 1240, h: 723 }, 'the acknowledgement does not replace the real size');

  st().setEditorOpen('ed', true, { w: 600, h: 400 }); // the plugin now resizes itself to that size
  assert.deepEqual(size(), { w: 600, h: 400 }, 'only ONE report is taken as the acknowledgement');

  st().setEditorOpen('ed', true, { w: 0, h: 0 }); // a floating editor's report carries no box
  assert.deepEqual(size(), { w: 600, h: 400 }, 'a report with no size keeps the last one');
  assert.equal(st().entries.ed?.editorOpen, true);

  st().setEditorOpen('ed', false);
  assert.equal(size(), null, 'a closed editor has no size');

  // A plugin whose real size IS the requested box: both reports are equal, and
  // the size still lands.
  st().setEditorRequest('ed', { w: 600, h: 400 });
  st().setEditorOpen('ed', true, { w: 600, h: 400 });
  st().setEditorOpen('ed', true, { w: 600, h: 400 });
  assert.deepEqual(size(), { w: 600, h: 400 });

  // A new request forgets the editor before it; a host that reports the real
  // size in both messages is read the same way.
  st().setEditorRequest('ed', { w: 600, h: 400 });
  assert.equal(size(), null, 'a new request starts with no size');
  st().setEditorOpen('ed', true, { w: 900, h: 520 });
  st().setEditorOpen('ed', true, { w: 900, h: 520 });
  assert.deepEqual(size(), { w: 900, h: 520 });
}

console.log('vstLiveStore: ok');
