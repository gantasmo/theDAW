/**
 * EDIT's FX popups close on a press outside them, and an effect window resizes
 * from its grips.
 *
 * Run: npx tsx src/lib/fxPopupDismiss.test.ts
 */
import assert from 'node:assert/strict';

import {
  EFFECT_WINDOW_MIN_H,
  EFFECT_WINDOW_MIN_W,
  FX_OPENER_ATTR,
  FX_POPUP_ATTR,
  pressClosesFxPopups,
  resizedWindowSize,
} from './fxPopupDismiss';

/** An element whose ancestors carry `attrs` (attribute selectors) and `roles`. */
const el = (attrs: string[] = [], roles: string[] = []) => ({
  closest: (selector: string) => {
    const parts = selector.split(',');
    const hit = parts.some(
      (p) => attrs.some((a) => p === `[${a}]`) || roles.some((r) => p === `[role="${r}"]`),
    );
    return hit ? {} : null;
  },
});

// ── a press outside closes, a press inside keeps ───────────────────────────
assert.equal(pressClosesFxPopups(el() as unknown as EventTarget), true, 'the timeline closes the popups');
assert.equal(pressClosesFxPopups(el([FX_POPUP_ATTR]) as unknown as EventTarget), false, 'a popup keeps itself');
assert.equal(pressClosesFxPopups(el([FX_OPENER_ATTR]) as unknown as EventTarget), false, 'the FX key decides by its own click');
for (const role of ['menu', 'listbox', 'tooltip']) {
  assert.equal(pressClosesFxPopups(el([], [role]) as unknown as EventTarget), false, `a ${role} hanging off a popup keeps it`);
}
assert.equal(pressClosesFxPopups(el([], ['dialog']) as unknown as EventTarget), true, 'another dialog is outside');
assert.equal(pressClosesFxPopups(null), false, 'no target, no verdict');
assert.equal(pressClosesFxPopups({} as EventTarget), false, 'a target that is no element closes nothing');

// ── resize ──────────────────────────────────────────────────────────────────
const start = { w: 600, h: 400, left: 100, top: 80 };
const viewport = { w: 1920, h: 1080 };
assert.deepEqual(resizedWindowSize(start, 50, 30, { right: true, bottom: true }, viewport), { w: 650, h: 430 });
assert.deepEqual(resizedWindowSize(start, 50, 30, { right: true, bottom: false }, viewport), { w: 650, h: 400 }, 'the right grip keeps the height');
assert.deepEqual(resizedWindowSize(start, 50, 30, { right: false, bottom: true }, viewport), { w: 600, h: 430 }, 'the bottom grip keeps the width');
assert.deepEqual(
  resizedWindowSize(start, -5000, -5000, { right: true, bottom: true }, viewport),
  { w: EFFECT_WINDOW_MIN_W, h: EFFECT_WINDOW_MIN_H },
  'a window never shrinks past its floor',
);
assert.deepEqual(
  resizedWindowSize(start, 5000, 5000, { right: true, bottom: true }, viewport),
  { w: 1920 - 100 - 8, h: 1080 - 80 - 8 },
  'a window never grows past the viewport',
);

console.log('fxPopupDismiss: all assertions passed');
