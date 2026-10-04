import assert from 'node:assert/strict';

import { persistBackend } from './persistStorage.ts';
import { sanitizeTimelinePrefs, useTimelinePrefs } from './timelinePrefsStore.ts';

// showVolumeLine is a plain boolean view pref, additive to the v1 persisted
// shape (no version bump): old blobs without the field must hydrate to true.

const tp = () => useTimelinePrefs.getState();

/** The key the store persists under (its `name` option). */
const STORAGE_KEY = 'thedaw.timelineprefs.v1';

/** The persisted blob as the storage holds it right now. */
const storedState = (): Record<string, unknown> => {
  const raw = persistBackend.getItem(STORAGE_KEY);
  assert.ok(raw, 'the store has written its blob');
  return (JSON.parse(raw) as { state: Record<string, unknown> }).state;
};

/* -------------------------------- default is on -------------------------------- */
{
  assert.equal(tp().showVolumeLine, true);
}

/* -------------------------------- setter toggles -------------------------------- */
{
  tp().reset();
  tp().setShowVolumeLine(false);
  assert.equal(tp().showVolumeLine, false);
  tp().setShowVolumeLine(true);
  assert.equal(tp().showVolumeLine, true);
}

/* --------------------------- setter rejects non-boolean --------------------------- */
{
  tp().reset();
  tp().setShowVolumeLine('no' as never);
  assert.equal(tp().showVolumeLine, true, 'non-boolean is ignored');
}

/* ------------------------- old blob hydrates to default -------------------------- */
{
  tp().reset();
  const current = tp();
  const out = sanitizeTimelinePrefs({ wheelProfile: 'reaper', showMasterTrack: false }, current);
  assert.equal(out.showVolumeLine, true);
  assert.equal(out.wheelProfile, 'reaper');
  assert.equal(out.showMasterTrack, false, 'the fields beside it are read as before');
}

/* ---------------------------- persisted false survives ---------------------------- */
{
  tp().reset();
  const current = tp();
  const out = sanitizeTimelinePrefs({ showVolumeLine: false }, current);
  assert.equal(out.showVolumeLine, false);
  assert.equal(out.showMasterTrack, true, 'the master row pref is a separate field');
}

/* -------------------------------- garbage falls back ------------------------------- */
{
  tp().reset();
  const current = tp();
  const out = sanitizeTimelinePrefs({ showVolumeLine: 3 }, current);
  assert.equal(out.showVolumeLine, true);
}

/* -------------------------------- reset restores default --------------------------- */
{
  tp().setShowVolumeLine(false);
  assert.equal(tp().showVolumeLine, false);
  tp().reset();
  assert.equal(tp().showVolumeLine, true);
}

/* --------------------- the two row prefs do not move each other -------------------- */
{
  tp().reset();
  tp().setShowVolumeLine(false);
  assert.equal(tp().showMasterTrack, true, 'hiding the volume line leaves the master row shown');
  tp().setShowMasterTrack(false);
  tp().setShowVolumeLine(true);
  assert.equal(tp().showMasterTrack, false, 'showing the volume line leaves the master row hidden');
  tp().reset();
}

/* ----------------------------- the written blob carries it ------------------------- */
// partialize decides what is saved. A field left out of it would toggle for the
// session and come back on at the next launch.
{
  tp().reset();
  assert.equal(storedState().showVolumeLine, true);
  tp().setShowVolumeLine(false);
  assert.equal(storedState().showVolumeLine, false, 'the saved blob holds the new value');
}

/* ------------------------------ a saved false is reloaded -------------------------- */
// The order a relaunch produces: the blob is on disk, the store starts at its
// defaults, then hydrate reads the blob through merge.
{
  tp().setShowVolumeLine(false);
  const saved = persistBackend.getItem(STORAGE_KEY);
  assert.ok(saved);
  useTimelinePrefs.setState({ showVolumeLine: true });
  persistBackend.setItem(STORAGE_KEY, saved);
  await useTimelinePrefs.persist.rehydrate();
  assert.equal(tp().showVolumeLine, false, 'hydrate restores the saved value');
  assert.equal(typeof tp().setShowVolumeLine, 'function', 'actions survive hydrate');
  tp().reset();
}

console.log('timelinePrefsStore.showVolumeLine: ok');
