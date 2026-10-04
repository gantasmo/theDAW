/**
 * VstEmbedHost - host box for a native VST3 editor session, shared by MIX's
 * Effect Stage and EDIT's floating plugin popup.
 *
 * EMBEDDED session: the backend sidecar pins the plugin's real OS window (owned
 * by Electron, positioned over this box) and CLIPS it to the box, so an
 * oversized editor keeps its natural size and is reachable by SCROLLING this
 * container (the inner spacer is sized to the plugin). EXPAND grows the box to a
 * large overlay for big GUIs — portaled to document.body so it escapes the
 * shell's CSS `zoom` (which would otherwise clip it and let sibling panels bury
 * its Collapse/Close buttons). We only REPORT geometry + scroll here; the editor
 * is closed explicitly (Close / its own window), NEVER on React unmount, so
 * StrictMode / panel re-renders can't kill it.
 *
 * FLOATING session: there is no window over this box at all — the plugin owns
 * its own top-level window, with every preset browser and modal dialog it draws
 * outside the editor intact. This panel then reports no geometry (nothing is
 * watching it) and shows a status card instead of an empty clip box.
 *
 * The header's mode toggle writes the per-plugin preference (vstEditorPrefs) and
 * relaunches the session in the chosen mode via vstEditorStore.setMode, which
 * drains the outgoing editor's state first.
 *
 * Coordinate spaces: getBoundingClientRect() is viewport px (already scaled by
 * the shell zoom) while clientWidth/scrollLeft are local px — every local value
 * sent to the native layer is multiplied by effectiveZoom() first.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ExternalLink, Maximize2, Minimize2, PictureInPicture2, X } from 'lucide-react';
import { vstApi, getContentBounds, getNativeWindowHandle } from '../../lib/vstClient';
import { effectiveZoom } from '../../lib/canvasScale';
import { useVstEditorStore, vstEntryName } from '../../state/vstEditorStore';

// The header label reuses MIX's section-title styling so the host reads the
// same in every view that mounts it.
const sectionTitle = 'font-display text-xs font-bold uppercase tracking-wider text-purple-300';
const headerButton = 'inline-flex items-center gap-1 font-sans text-xs font-bold text-zinc-500 transition-colors shrink-0';

/**
 * How long an embedded session may report no window before this panel offers
 * the floating fallback. The embed watcher (backend win_embed.find_editor)
 * gives up looking for the editor window after 10s and then logs "leaving it
 * floating" — but it only starts counting once the sidecar has spawned and
 * loaded the plugin, which is itself seconds of work. 20s therefore covers the
 * watcher's whole window plus a slow load, so the offer means "this really is
 * not going to appear here", not "be patient".
 *
 * It is an OFFER, never an automatic switch: silently moving a plugin's window
 * out of the panel would be the app deciding something the user did not ask
 * for, and the offer withdraws itself if the window does turn up late.
 */
const EMBED_WINDOW_TIMEOUT_MS = 20_000;

export const VstEmbedHost: React.FC<{
  pluginPath: string;
  pluginName: string;
  error?: string;
  onClose: () => void;
  /** Reports the plugin's natural editor size (CSS px) whenever it changes, so
   *  a hosting popup can size itself to the plugin instead of a fixed box. */
  onNaturalSize?: (w: number, h: number) => void;
  /** The box takes the plugin editor's own size and the parent wraps it (EDIT's
   *  effect window). It shrinks and scrolls when the parent is smaller. Without
   *  this the box fills its parent (MIX's Effect Stage, the roll's host). */
  fit?: boolean;
}> = ({ pluginPath, pluginName, error, onClose, onNaturalSize, fit }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Plugin's natural size in LOCAL px for the scrollable inner spacer (the
  // backend reports physical px; divided by dpr AND the ambient CSS zoom of
  // this mount so the spacer's on-screen size matches the native window).
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // The callback rides a ref so the polling effect below keeps its
  // [pluginPath, error] dependency list even when the parent re-creates it.
  const onNaturalSizeRef = useRef(onNaturalSize);
  onNaturalSizeRef.current = onNaturalSize;

  // How the session this box hosts ACTUALLY opened. Read off the store rather
  // than the preference, because a preference to embed still floats when there
  // is no host window handle to embed under (a plain browser). Guarded by path
  // so a stale mount never reads a different plugin's session.
  const sessionMode = useVstEditorStore((s) => (s.pluginPath === pluginPath ? s.mode : null));
  const floating = sessionMode === 'floating';
  const shownName = vstEntryName(pluginName, pluginPath);

  // Whether embedding is possible at all here (Electron exposes a window
  // handle; a plain browser does not). Offering "Embed in panel" where it can
  // only float again would be a button that visibly does nothing.
  const [canEmbed, setCanEmbed] = useState(true);
  useEffect(() => {
    let alive = true;
    void getNativeWindowHandle().then((h) => {
      if (alive) setCanEmbed(!!h);
    });
    return () => { alive = false; };
  }, []);

  // Expand only means anything for an embedded editor, and its Collapse button
  // lives in the header the floating card hides — so a session that goes
  // floating while expanded must leave the overlay, not strand the user in it.
  useEffect(() => {
    if (floating) setExpanded(false);
  }, [floating]);

  // A floating session has no window over this box, so it must NOT report
  // geometry: the rect file it would write is only ever read by the embed
  // watcher, which is not running.
  useEffect(() => {
    const el = ref.current;
    if (!el || error || floating) return; // no window to track
    let alive = true;
    const report = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // clientWidth/scrollLeft are local px; the rect is viewport px. Scale the
      // local values by the ambient zoom so w/h/sx/sy share the rect's space.
      const ez = effectiveZoom(el);
      void getContentBounds().then((cb) => {
        if (!alive) return;
        // Viewport origin in absolute physical screen px (content-area screen
        // origin (DIP) + element offset (CSS px, approximately DIP), scaled by dpr). Use the
        // client box (excludes the scrollbar) so the native window doesn't cover
        // the scrollbar; pass the scroll offset so it pans as we scroll.
        const ox = cb ? cb.x : 0;
        const oy = cb ? cb.y : 0;
        void vstApi.editorRect(pluginPath, {
          x: (ox + r.left) * dpr,
          y: (oy + r.top) * dpr,
          w: el.clientWidth * ez * dpr,
          h: el.clientHeight * ez * dpr,
          sx: el.scrollLeft * ez * dpr,
          sy: el.scrollTop * ez * dpr,
          dpr: 1, // values are already physical px
        });
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    el.addEventListener('scroll', report, { passive: true });
    window.addEventListener('resize', report);
    // Poll so the window follows Electron moves too (a move fires no 'resize').
    const iv = window.setInterval(report, 250);
    return () => {
      alive = false;
      ro.disconnect();
      el.removeEventListener('scroll', report);
      window.removeEventListener('resize', report);
      window.clearInterval(iv);
    };
  }, [pluginPath, error, expanded, floating]);

  // Poll the plugin's natural size so the scroll area matches it (and tracks a
  // plugin that resizes its own window). `expanded` is a dep because the mount
  // moves between the zoomed tree and the body portal, changing the zoom the
  // spacer must compensate for. A floating session publishes no size (the
  // watcher that writes it is not running), so it never polls.
  useEffect(() => {
    if (error || floating) return;
    let alive = true;
    const dpr = window.devicePixelRatio || 1;
    let last: { w: number; h: number } | null = null;
    const poll = () => {
      vstApi.editorSize(pluginPath)
        .then((res) => {
          if (!alive) return;
          if (res.status === 'ok' && res.w && res.h) {
            const w = Math.round(res.w / dpr);
            const h = Math.round(res.h / dpr);
            // Only propagate a real change; the poll fires every second and a
            // fresh object each tick would re-render the host (and the parent
            // popup) for nothing.
            if (!last || last.w !== w || last.h !== h) {
              last = { w, h };
              const ez = effectiveZoom(ref.current);
              const lw = Math.round(w / ez);
              const lh = Math.round(h / ez);
              setNatural((prev) => (prev && prev.w === lw && prev.h === lh ? prev : { w: lw, h: lh }));
              onNaturalSizeRef.current?.(w, h);
            }
          }
          // Until the first size lands the window is at its opening box, so
          // ask again soon; after that a slow poll follows a plugin that
          // resizes its own view.
          if (alive) window.setTimeout(poll, last ? 1000 : 250);
        })
        .catch(() => { if (alive) window.setTimeout(poll, 1500); });
    };
    poll();
    return () => { alive = false; };
  }, [pluginPath, error, expanded, floating]);

  // An embedded session that never produces a window: after the watchdog the
  // panel says so and offers the floating fallback (see EMBED_WINDOW_TIMEOUT_MS).
  const [windowLate, setWindowLate] = useState(false);
  useEffect(() => {
    if (error || floating || natural) {
      setWindowLate(false);
      return;
    }
    const t = window.setTimeout(() => setWindowLate(true), EMBED_WINDOW_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [pluginPath, error, floating, natural]);

  const setMode = useVstEditorStore((s) => s.setMode);
  const openFloating = () => setMode('floating');

  // The switch the header toggle performs, and why it is worth offering.
  const toggleTitle = floating
    ? (canEmbed
      ? `Embed ${shownName} back in this panel. Close its own window first — theDAW cannot close a floating plugin window for you.`
      : 'Embedding the editor in the panel needs the desktop app; in a browser the plugin always gets its own window.')
    : `Show ${shownName} in its own window instead. A floating window shows the plugin's FULL native GUI — preset browsers, menus and dialogs the panel would clip.`;

  const modeToggle = (
    <button
      type="button"
      onClick={() => setMode(floating ? 'embedded' : 'floating')}
      disabled={floating && !canEmbed}
      title={toggleTitle}
      aria-label={floating ? `Embed ${shownName} in this panel` : `Show ${shownName} in its own window`}
      aria-pressed={floating}
      className={`${headerButton} disabled:opacity-40 disabled:pointer-events-none ${floating ? 'text-teal-300 hover:text-teal-200' : 'hover:text-teal-300'}`}
    >
      {floating ? <PictureInPicture2 className="w-3.5 h-3.5" /> : <ExternalLink className="w-3.5 h-3.5" />}
      {floating ? 'Embed in panel' : 'Float window'}
    </button>
  );

  // The fitted box: the plugin's size plus the box's own 1px border, centred
  // when the window is larger and shrinking (then scrolling) when it is
  // smaller. Before the size is known it is the box the editor opens at.
  const fitBox: React.CSSProperties | undefined =
    fit && !expanded
      ? natural
        ? { flex: '0 1 auto', width: natural.w + 2, height: natural.h + 2, maxWidth: '100%', margin: 'auto' }
        : { flex: '0 1 auto', width: 480, height: 320, maxWidth: '100%', margin: 'auto' }
      : undefined;

  const body = (
    <div
      className={
        expanded
          ? 'fixed inset-6 z-100 bg-[#0c0a14] border border-teal-500/40 rounded-lg shadow-2xl flex flex-col min-h-0 overflow-hidden p-2 gap-2'
          : fit
            ? 'flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden p-2 gap-2'
            : 'h-full w-full flex flex-col min-h-0 overflow-hidden p-2 gap-2'
      }
      // The expanded overlay is portaled out of the window that opened it, and
      // is still part of EDIT's FX popups (lib/fxPopupDismiss.ts).
      data-fx-popup={expanded ? '' : undefined}
    >
      <div className="flex items-center gap-2 shrink-0">
        <span className={sectionTitle}>{shownName}</span>
        <span className="font-sans text-xs font-bold text-zinc-500">
          {error ? 'plugin error' : floating ? 'own window' : 'native VST GUI'}
        </span>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {!error && modeToggle}
          {!error && !floating && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Collapse' : 'Expand'}
              aria-label={expanded ? 'Collapse plugin editor' : 'Expand plugin editor'}
              aria-pressed={expanded}
              className={`${headerButton} hover:text-teal-300`}
            >
              {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />} {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
          <button onClick={onClose} title="Close the plugin editor" className={`${headerButton} hover:text-red-400`}>
            <X className="w-3.5 h-3.5" /> Close
          </button>
        </div>
      </div>
      {error ? (
        <div className="flex-1 min-h-0 rounded border border-red-500/30 bg-red-950/20 grid place-items-center p-3">
          <div className="text-center max-w-md flex flex-col items-center gap-2">
            <span className="font-sans text-xs font-bold text-red-300">This plugin could not be loaded</span>
            <span className="font-sans text-xs font-bold text-red-200/70 wrap-break-word">{error}</span>
            {/* Some plugins refuse to be reparented but open perfectly well on
                their own. Offered, not taken automatically. */}
            {!floating && (
              <button
                type="button"
                onClick={openFloating}
                title="Relaunch this plugin in its own window instead of inside the panel"
                className="px-2 py-1 rounded border border-teal-500/40 bg-teal-500/15 text-teal-200 hover:bg-teal-500/25 font-display text-xs font-bold uppercase tracking-wider"
              >
                Open floating instead
              </button>
            )}
          </div>
        </div>
      ) : floating ? (
        /* Nothing is pinned over this box, so it stays calm and says where the
           editor actually is instead of showing an empty clip frame. */
        <div className="flex-1 min-h-0 rounded border border-teal-500/30 bg-black/40 grid place-items-center p-3">
          <div className="text-center max-w-md flex flex-col items-center gap-2">
            <AppWindow className="w-5 h-5 text-teal-300/70" />
            <span className="font-sans text-xs font-bold text-zinc-200">{shownName} is open in its own window</span>
            <span className="font-sans text-xs font-bold text-zinc-500 leading-relaxed">
              Its full native GUI lives there, preset browsers included. Close that window to save its settings.
            </span>
          </div>
        </div>
      ) : (
        <div
          ref={ref}
          className={`${fitBox ? '' : 'flex-1 min-h-0 '}overflow-auto rounded border border-teal-500/30 bg-black/60 relative`}
          style={fitBox}
        >
          {/* Spacer sized to the plugin so the area scrolls; the native window is
              positioned over the visible viewport by the backend watcher. */}
          <div style={natural ? { width: natural.w, height: natural.h } : { width: '100%', height: '100%' }} />
          {!natural && (
            /* pointer-events-none so this overlay never eats clicks meant for
               the plugin window; the fallback button re-enables its own. */
            <div className="absolute inset-0 grid place-items-center p-3 pointer-events-none">
              <div className="text-center max-w-xs flex flex-col items-center gap-2">
                <span className="font-sans text-xs font-bold text-zinc-500">loading plugin editor...</span>
                {windowLate && (
                  <>
                    <span className="font-sans text-xs font-bold text-amber-300/80 leading-relaxed">
                      No plugin window has appeared in this panel. Some plugins will only open in a window of their own.
                    </span>
                    <button
                      type="button"
                      onClick={openFloating}
                      title="Relaunch this plugin in its own window instead of inside the panel"
                      className="pointer-events-auto px-2 py-1 rounded border border-teal-500/40 bg-teal-500/15 text-teal-200 hover:bg-teal-500/25 font-display text-xs font-bold uppercase tracking-wider"
                    >
                      Open floating instead
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Expanded: escape .dense-layout entirely (its zoom traps `fixed` descendants
  // in a scaled, clipped, low-stacking-order box) so the overlay truly covers
  // the viewport and its header buttons stay on top of every panel.
  return expanded ? createPortal(body, document.body) : body;
};
