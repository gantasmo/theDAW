import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { browserPopoverEnv, popoverMaxHeight, sameLayout, watchPopover, type PopoverLayout } from '../../lib/popoverPlacement';

/**
 * Floating popover portaled to document.body, mirroring ContextMenu's pattern:
 * the Shell scales the DAW with CSS `zoom` (`.dense-layout`), so a fixed panel
 * rendered INSIDE the zoomed tree drifts away from raw clientX/Y anchors. The
 * body portal escapes the zoom, so the coords land at the click. The panel is
 * laid out inside the window and above the transport footer (watchPopover)
 * when it opens, again whenever its own size changes (a rack gaining rows),
 * and again when the window resizes, so no edge runs off screen or over the
 * transport as the content grows. Its max-height is that room less the edge
 * gaps, and it scrolls inside itself past that. When no coords are given the
 * panel renders at `anchorClassName` (the legacy fixed position) instead.
 */
export const PopoverPortal: React.FC<{
  x?: number;
  y?: number;
  anchorClassName?: string;
  className: string;
  /** The panel's design max-height as a CSS length (`70vh`). The window's
   *  height less the edge gaps caps it either way. */
  maxHeight?: string;
  /** Optional external ref (outside-click dismissal needs the panel node). */
  innerRef?: React.RefObject<HTMLDivElement | null>;
  /** The panel is one of EDIT's FX popups: a press outside the family closes
   *  it (lib/fxPopupDismiss.ts). */
  fxPopup?: boolean;
  children: React.ReactNode;
}> = ({ x, y, anchorClassName = '', className, maxHeight, innerRef, fxPopup, children }) => {
  const localRef = useRef<HTMLDivElement | null>(null);
  const ref = innerRef ?? localRef;
  const hasCoords = x != null && y != null;
  const [layout, setLayout] = useState<PopoverLayout | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (x == null || y == null || !el) {
      setLayout(null);
      return;
    }
    const keep = (next: PopoverLayout) => setLayout((prev) => (prev && sameLayout(prev, next) ? prev : next));
    // Size changes are reported after layout; flushSync renders the new spot
    // before that frame paints, so a grown panel never shows past the edge.
    return watchPopover({ x, y }, browserPopoverEnv(el), (next, initial) => {
      if (initial) keep(next);
      else flushSync(() => keep(next));
    });
  }, [x, y, ref]);
  // While measuring (first paint) the panel renders off-screen, exactly like
  // ContextMenu, so the un-clamped position never flashes.
  const shown = hasCoords ? layout ?? { x: -9999, y: -9999 } : null;
  return createPortal(
    <div
      ref={ref}
      className={`${className}${shown ? '' : ` ${anchorClassName}`}`}
      data-fx-popup={fxPopup ? '' : undefined}
      style={{
        maxHeight: popoverMaxHeight(hasCoords ? layout?.maxHeight ?? null : null, maxHeight),
        overflowY: 'auto',
        ...(shown ? { left: shown.x, top: shown.y } : {}),
      }}
    >
      {children}
    </div>,
    document.body,
  );
};
