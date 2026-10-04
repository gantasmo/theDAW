/**
 * Mount test for the "Volume line" section of the timeline preferences panel
 * (TimelinePrefsPanel.tsx), against the real prefs store.
 *
 * The sequence a user makes: the panel opens with the volume line shown; the
 * checkbox under "Volume line" is ticked and carries a real label; a click
 * unticks it and the store holds false; a click ticks it again; a change made
 * elsewhere (Reset) shows in the checkbox.
 *
 * Client-rendered (createRoot on jsdom), in the CcLane.test.tsx pattern.
 *
 *   cd frontend && npx tsx src/components/audio/TimelinePrefsPanel.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement,
  Node: win.Node,
  Event: win.Event,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const { TimelinePrefsPanel } = await import('./TimelinePrefsPanel.tsx');
const { useTimelinePrefs } = await import('../../state/timelinePrefsStore.ts');

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const prefs = () => useTimelinePrefs.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const box = () => win.document.getElementById('timeline-show-volume-line') as HTMLInputElement | null;

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => {
  prefs().reset();
  root.render(<TimelinePrefsPanel anchor={{ x: 40, y: 40 }} onClose={() => {}} />);
});

/* ------------------------ the control and its label ------------------------ */
{
  const el = box();
  assert.ok(el, 'the panel shows the volume line checkbox');
  assert.equal(el.type, 'checkbox');
  assert.equal(el.name, 'timeline-show-volume-line', 'the field carries a name');
  assert.equal(el.checked, true, 'the volume line is shown by default');

  const labels = [...win.document.querySelectorAll('label[for="timeline-show-volume-line"]')];
  assert.equal(labels.length, 1, 'one label points at the checkbox');
  assert.equal(labels[0].textContent?.trim(), 'Show volume line');

  const hintId = el.getAttribute('aria-describedby');
  assert.ok(hintId, 'the checkbox names its hint');
  assert.equal(
    win.document.getElementById(hintId)?.textContent?.trim(),
    "Draws each track's volume over its lane. Drag it to set the level. Right-click it to add a keyframe.",
  );
}

/* ----------------------- the section sits after Master row ----------------------- */
{
  const titles = [...win.document.querySelectorAll('[role="dialog"] h3, [role="dialog"] legend')]
    .map((h) => h.textContent?.trim());
  const master = titles.indexOf('Master row');
  assert.ok(master >= 0, 'the Master row section is there');
  assert.equal(titles[master + 1], 'Volume line', 'Volume line is the section after Master row');

  const section = box()?.closest('section');
  assert.ok(section, 'the checkbox sits in its own section');
  const titleId = section.getAttribute('aria-labelledby');
  assert.ok(titleId, 'the section is named by its title');
  assert.equal(win.document.getElementById(titleId)?.textContent?.trim(), 'Volume line');
}

/* ----------------------------- a click writes the pref ---------------------------- */
{
  await step(() => box()!.click());
  assert.equal(prefs().showVolumeLine, false, 'unticking hides the volume line');
  assert.equal(box()!.checked, false);
  assert.equal(prefs().showMasterTrack, true, 'the master row pref is untouched');

  await step(() => box()!.click());
  assert.equal(prefs().showVolumeLine, true, 'ticking shows it again');
  assert.equal(box()!.checked, true);
}

/* ------------------------- the checkbox follows the store ------------------------- */
{
  await step(() => prefs().setShowVolumeLine(false));
  assert.equal(box()!.checked, false, 'a pref set elsewhere shows in the checkbox');
  const reset = [...win.document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Reset timeline preferences',
  );
  assert.ok(reset, 'the panel has its reset button');
  await step(() => reset.click());
  assert.equal(prefs().showVolumeLine, true, 'Reset shows the volume line again');
  assert.equal(box()!.checked, true);
}

await step(() => root.unmount());

console.log('TimelinePrefsPanel: ok');
