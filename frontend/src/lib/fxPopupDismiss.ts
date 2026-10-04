/**
 * Which presses close EDIT's FX popups: the track FX rack, the master FX panel
 * and every effect window (built-in, VST3, .gan).
 *
 * The popups are one family. A press inside any of them, on the key that opens
 * one, or in a menu hanging off one keeps them all; a press anywhere else in
 * the app closes them all. A press inside a plugin's own native window never
 * reaches the page, so it closes nothing.
 */

/** On every FX popup's root, and on the FX lists that open effect windows. */
export const FX_POPUP_ATTR = 'data-fx-popup';
/** On a key that opens or toggles an FX popup, so its own click decides. */
export const FX_OPENER_ATTR = 'data-fx-opener';

const KEEP_SELECTOR = [
  `[${FX_POPUP_ATTR}]`,
  `[${FX_OPENER_ATTR}]`,
  // Menus, pickers and tips are portaled to the body, outside the popup that
  // opened them.
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
].join(',');

/** True when a press on `target` is outside every FX popup and should close them. */
export function pressClosesFxPopups(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  // A press with no element behind it (the window, a text node) says nothing
  // about where it landed.
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(KEEP_SELECTOR) === null;
}

// ── Effect window size ───────────────────────────────────────────────────────

export const EFFECT_WINDOW_MIN_W = 260;
export const EFFECT_WINDOW_MIN_H = 140;

/** Which edges a resize grip moves. */
export interface ResizeEdges {
  right: boolean;
  bottom: boolean;
}

/**
 * The size a window takes while a grip is dragged by (dx, dy) from the size it
 * had when the drag began. An edge the grip does not move keeps its length. The
 * window stays inside the viewport from its top-left corner, with an 8px gap.
 */
export function resizedWindowSize(
  start: { w: number; h: number; left: number; top: number },
  dx: number,
  dy: number,
  edges: ResizeEdges,
  viewport: { w: number; h: number },
): { w: number; h: number } {
  const maxW = Math.max(EFFECT_WINDOW_MIN_W, viewport.w - start.left - 8);
  const maxH = Math.max(EFFECT_WINDOW_MIN_H, viewport.h - start.top - 8);
  const w = edges.right ? Math.min(maxW, Math.max(EFFECT_WINDOW_MIN_W, start.w + dx)) : start.w;
  const h = edges.bottom ? Math.min(maxH, Math.max(EFFECT_WINDOW_MIN_H, start.h + dy)) : start.h;
  return { w: Math.round(w), h: Math.round(h) };
}
