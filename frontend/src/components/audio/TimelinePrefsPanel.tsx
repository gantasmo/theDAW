/**
 * Timeline preferences popover (F05 wheel profile + zoom speeds, F06 click
 * profile, F08 grid style). The EDIT toolbar opens it at a viewport point;
 * every control writes straight to useTimelinePrefs, so changes apply live and
 * persist per browser (never to the project or the undo history).
 *
 * Portaled to document.body like ContextMenu and WaveformEditor's
 * PopoverPortal: the Shell scales the DAW with CSS `zoom`, and a fixed panel
 * inside that tree would drift from raw clientX/Y anchors. watchPopover keeps
 * the panel inside the window and above the transport footer.
 *
 * Dismissal: Escape (captured on window and stopped there, so the timeline's
 * own Escape handler does not also clear its selection), a mousedown outside
 * the panel, or the close button. Focus moves into the panel on open and back
 * to the opener on close. The root carries `data-wheel-passthrough`, so the
 * timeline's wheel handler leaves wheel events over the panel alone.
 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { RotateCcw, X } from 'lucide-react';
import { resolveEditThemeVars } from '../../lib/editThemes';
import { browserPopoverEnv, popoverMaxHeight, sameLayout, watchPopover, type PopoverLayout } from '../../lib/popoverPlacement';
import { useEditThemeStore } from '../../state/editThemeStore';
import {
  COARSE_ZOOM_SPEED_MAX,
  COARSE_ZOOM_SPEED_MIN,
  FINE_ZOOM_SPEED_MAX,
  FINE_ZOOM_SPEED_MIN,
  useTimelinePrefs,
} from '../../state/timelinePrefsStore';
import {
  CLICK_PROFILE_OPTIONS,
  GRID_OPACITY_FIELDS,
  GRID_PRESET_OPTIONS,
  WHEEL_PROFILE_OPTIONS,
  describeWheelProfile,
  gridPresetLabel,
  gridPreviewLines,
  opacityPercent,
  speedPercent,
} from './timelinePrefsPanelModel';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Slider resolution: 100 steps across each zoom-speed range. */
const COARSE_STEP = (COARSE_ZOOM_SPEED_MAX - COARSE_ZOOM_SPEED_MIN) / 100;
const FINE_STEP = (FINE_ZOOM_SPEED_MAX - FINE_ZOOM_SPEED_MIN) / 100;
/** Opacity slider resolution (alpha units); fine enough to land every preset value. */
const OPACITY_STEP = 0.005;

const SECTION_TITLE = 'font-display text-xs font-bold uppercase tracking-wider text-purple-300';
const HINT = 'font-sans text-xs et-ink-2 leading-snug';
const RANGE = 'w-full accent-[rgb(var(--et-accent))]';
const PILL_BASE =
  'flex-1 px-2 py-1 rounded border font-display text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline focus-visible:outline-purple-400';

export function TimelinePrefsPanel(p: {
  onClose: () => void;
  anchor: { x: number; y: number } | null;
}): React.JSX.Element | null {
  const { onClose, anchor } = p;
  const open = anchor !== null;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const titleId = useId();

  const wheelProfile = useTimelinePrefs((s) => s.wheelProfile);
  const fineZoomSpeed = useTimelinePrefs((s) => s.fineZoomSpeed);
  const coarseZoomSpeed = useTimelinePrefs((s) => s.coarseZoomSpeed);
  const clickProfile = useTimelinePrefs((s) => s.clickProfile);
  const gridPreset = useTimelinePrefs((s) => s.gridPreset);
  const grid = useTimelinePrefs((s) => s.grid);
  const showMasterTrack = useTimelinePrefs((s) => s.showMasterTrack);
  const showVolumeLine = useTimelinePrefs((s) => s.showVolumeLine);
  const setWheelProfile = useTimelinePrefs((s) => s.setWheelProfile);
  const setFineZoomSpeed = useTimelinePrefs((s) => s.setFineZoomSpeed);
  const setCoarseZoomSpeed = useTimelinePrefs((s) => s.setCoarseZoomSpeed);
  const setClickProfile = useTimelinePrefs((s) => s.setClickProfile);
  const applyGridPreset = useTimelinePrefs((s) => s.applyGridPreset);
  const setGrid = useTimelinePrefs((s) => s.setGrid);
  const setGridVisible = useTimelinePrefs((s) => s.setGridVisible);
  const setShowMasterTrack = useTimelinePrefs((s) => s.setShowMasterTrack);
  const setShowVolumeLine = useTimelinePrefs((s) => s.setShowVolumeLine);
  const reset = useTimelinePrefs((s) => s.reset);

  // The panel portals outside the Shell's `.edit-theme-scope`, so it carries
  // its own scope (same as ContextMenu). `--et-root-bg` is left off: the
  // wrapper paints nothing, and on the custom-image theme it is a data URL.
  const editThemeId = useEditThemeStore((s) => s.themeId);
  const editThemeImage = useEditThemeStore((s) => s.customImage);
  const editTheme = useMemo(() => {
    const { vars, light } = resolveEditThemeVars(editThemeId, editThemeImage);
    const scopeVars = Object.fromEntries(Object.entries(vars).filter(([name]) => name !== '--et-root-bg'));
    return { vars: scopeVars, light };
  }, [editThemeId, editThemeImage]);

  // PLACEMENT. Rendered off-screen until measured so the un-clamped spot never flashes.
  const [layout, setLayout] = useState<PopoverLayout | null>(null);
  const ax = anchor?.x;
  const ay = anchor?.y;
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (ax == null || ay == null || !el) {
      setLayout(null);
      return;
    }
    const keep = (next: PopoverLayout) => setLayout((prev) => (prev && sameLayout(prev, next) ? prev : next));
    return watchPopover({ x: ax, y: ay }, browserPopoverEnv(el), (next, initial) => {
      if (initial) keep(next);
      else flushSync(() => keep(next));
    });
  }, [ax, ay]);

  // DISMISSAL. Escape is captured on window and stopped, so the timeline's
  // window keydown handler never sees it. The outside-mousedown listener is
  // attached a macrotask later so the click that opened the panel cannot
  // close it on its way up (ContextMenu's rule).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onCloseRef.current();
    };
    const onDown = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (panel && e.target instanceof Node && panel.contains(e.target)) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    let attached = false;
    const timer = window.setTimeout(() => {
      attached = true;
      window.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.clearTimeout(timer);
      if (attached) window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // FOCUS. Into the panel on open (a frame later, once it is placed, so
  // focusing never scrolls the page to the off-screen measuring spot), back to
  // the opener on close unless something else has taken focus meanwhile.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusFirst = () => {
      panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    };
    const framed = typeof requestAnimationFrame === 'function';
    const raf = framed ? requestAnimationFrame(focusFirst) : 0;
    if (!framed) focusFirst();
    return () => {
      if (framed) cancelAnimationFrame(raf);
      const active = document.activeElement;
      const lost = !active || active === document.body || (!!panel && panel.contains(active));
      if (lost && opener && opener !== document.body && document.contains(opener)) opener.focus();
    };
  }, [open]);

  if (!anchor) return null;

  const wheelRows = describeWheelProfile(wheelProfile);
  const previewLines = gridPreviewLines(grid, 4, 4);
  const pos = layout ?? { x: -9999, y: -9999 };
  const coarsePct = speedPercent(coarseZoomSpeed, COARSE_ZOOM_SPEED_MIN, COARSE_ZOOM_SPEED_MAX);
  const finePct = speedPercent(fineZoomSpeed, FINE_ZOOM_SPEED_MIN, FINE_ZOOM_SPEED_MAX);

  return createPortal(
    <div
      className="edit-theme-scope contents"
      data-et-light={editTheme.light ? '1' : undefined}
      style={editTheme.vars as React.CSSProperties}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby={titleId}
        data-wheel-passthrough=""
        className="fixed z-10000 w-80 overflow-y-auto bg-[#0a080f] border border-purple-500/40 rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.6)] p-3 flex flex-col gap-3 font-sans text-xs et-ink select-none"
        style={{ left: pos.x, top: pos.y, maxHeight: popoverMaxHeight(layout?.maxHeight ?? null) }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
          <h2 id={titleId} className={SECTION_TITLE}>
            Timeline preferences
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close timeline preferences"
            className="p-0.5 rounded et-ink-2 hover:et-ink hover:bg-white/10 focus-visible:outline focus-visible:outline-purple-400"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* MOUSE WHEEL */}
        <fieldset className="flex flex-col gap-1.5 min-w-0">
          <legend className={`${SECTION_TITLE} mb-1`}>Mouse wheel</legend>
          {WHEEL_PROFILE_OPTIONS.map((o) => {
            const id = `timeline-wheel-profile-${o.id}`;
            return (
              <div key={o.id} className="flex items-start gap-2">
                <input
                  id={id}
                  name="timeline-wheel-profile"
                  type="radio"
                  value={o.id}
                  checked={wheelProfile === o.id}
                  onChange={() => setWheelProfile(o.id)}
                  aria-describedby={`${id}-desc`}
                  className="mt-0.5 accent-[rgb(var(--et-accent))]"
                />
                <div className="flex flex-col">
                  <label htmlFor={id} className="font-bold">
                    {o.label}
                  </label>
                  <span id={`${id}-desc`} className={HINT}>
                    {o.description}
                  </span>
                </div>
              </div>
            );
          })}
          <table className="mt-1 w-full border-collapse">
            <caption className="sr-only">What the mouse wheel does with each modifier</caption>
            <thead>
              <tr className="et-ink-2 text-left">
                <th scope="col" className="py-0.5 pr-2 font-bold">
                  Gesture
                </th>
                <th scope="col" className="py-0.5 font-bold">
                  Does
                </th>
              </tr>
            </thead>
            <tbody>
              {wheelRows.map((r) => (
                <tr key={r.gesture} className="border-t border-white/5">
                  <th scope="row" className="py-0.5 pr-2 text-left font-bold whitespace-nowrap">
                    {r.gesture}
                  </th>
                  <td className="py-0.5 et-ink-2">{r.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </fieldset>

        {/* ZOOM SPEED */}
        <section aria-labelledby="timeline-zoom-speed-title" className="flex flex-col gap-1.5">
          <h3 id="timeline-zoom-speed-title" className={SECTION_TITLE}>
            Zoom speed
          </h3>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between">
              <label htmlFor="timeline-zoom-coarse" className="font-bold">
                Coarse zoom
              </label>
              <output htmlFor="timeline-zoom-coarse" className="et-ink-2 tabular-nums">
                {coarsePct}%
              </output>
            </div>
            <input
              id="timeline-zoom-coarse"
              name="timeline-zoom-coarse"
              type="range"
              min={COARSE_ZOOM_SPEED_MIN}
              max={COARSE_ZOOM_SPEED_MAX}
              step={COARSE_STEP}
              value={coarseZoomSpeed}
              aria-valuetext={`${coarsePct}%`}
              onChange={(e) => setCoarseZoomSpeed(Number(e.target.value))}
              className={RANGE}
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between">
              <label htmlFor="timeline-zoom-fine" className="font-bold">
                Fine zoom
              </label>
              <output htmlFor="timeline-zoom-fine" className="et-ink-2 tabular-nums">
                {finePct}%
              </output>
            </div>
            <input
              id="timeline-zoom-fine"
              name="timeline-zoom-fine"
              type="range"
              min={FINE_ZOOM_SPEED_MIN}
              max={FINE_ZOOM_SPEED_MAX}
              step={FINE_STEP}
              value={fineZoomSpeed}
              aria-valuetext={`${finePct}%`}
              onChange={(e) => setFineZoomSpeed(Number(e.target.value))}
              className={RANGE}
            />
          </div>
        </section>

        {/* CLICK BEHAVIOR */}
        <fieldset className="flex flex-col gap-1.5 min-w-0">
          <legend className={`${SECTION_TITLE} mb-1`}>Click behavior</legend>
          {CLICK_PROFILE_OPTIONS.map((o) => {
            const id = `timeline-click-profile-${o.id}`;
            return (
              <div key={o.id} className="flex items-start gap-2">
                <input
                  id={id}
                  name="timeline-click-profile"
                  type="radio"
                  value={o.id}
                  checked={clickProfile === o.id}
                  onChange={() => setClickProfile(o.id)}
                  aria-describedby={`${id}-desc`}
                  className="mt-0.5 accent-[rgb(var(--et-accent))]"
                />
                <div className="flex flex-col">
                  <label htmlFor={id} className="font-bold">
                    {o.label}
                  </label>
                  <span id={`${id}-desc`} className={HINT}>
                    {o.description}
                  </span>
                </div>
              </div>
            );
          })}
        </fieldset>

        {/* MASTER ROW */}
        <section aria-labelledby="timeline-master-row-title" className="flex flex-col gap-2">
          <h3 id="timeline-master-row-title" className={SECTION_TITLE}>
            Master row
          </h3>
          <div className="flex items-center gap-2">
            <input
              id="timeline-show-master-track"
              name="timeline-show-master-track"
              type="checkbox"
              checked={showMasterTrack}
              onChange={(e) => setShowMasterTrack(e.target.checked)}
              className="accent-[rgb(var(--et-accent))]"
            />
            <label htmlFor="timeline-show-master-track" className="font-bold">
              Show master track
            </label>
          </div>
          <span className={HINT}>
            Pins the master above the tracks. It is a view of the master you already have.
          </span>
        </section>

        {/* VOLUME LINE */}
        <section aria-labelledby="timeline-volume-line-title" className="flex flex-col gap-2">
          <h3 id="timeline-volume-line-title" className={SECTION_TITLE}>
            Volume line
          </h3>
          <div className="flex items-center gap-2">
            <input
              id="timeline-show-volume-line"
              name="timeline-show-volume-line"
              type="checkbox"
              checked={showVolumeLine}
              onChange={(e) => setShowVolumeLine(e.target.checked)}
              aria-describedby="timeline-show-volume-line-desc"
              className="accent-[rgb(var(--et-accent))]"
            />
            <label htmlFor="timeline-show-volume-line" className="font-bold">
              Show volume line
            </label>
          </div>
          <span id="timeline-show-volume-line-desc" className={HINT}>
            Draws each track's volume over its lane. Drag it to set the level. Right-click it to add a keyframe.
          </span>
        </section>

        {/* GRID */}
        <section aria-labelledby="timeline-grid-title" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 id="timeline-grid-title" className={SECTION_TITLE}>
              Grid
            </h3>
            <span className="et-ink-2">Preset: {gridPresetLabel(gridPreset)}</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="timeline-grid-visible"
              name="timeline-grid-visible"
              type="checkbox"
              checked={grid.visible}
              onChange={(e) => setGridVisible(e.target.checked)}
              className="accent-[rgb(var(--et-accent))]"
            />
            <label htmlFor="timeline-grid-visible" className="font-bold">
              Show grid
            </label>
          </div>
          <div role="group" aria-label="Grid presets" className="flex gap-1.5">
            {GRID_PRESET_OPTIONS.map((o) => {
              const active = gridPreset === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => applyGridPreset(o.id)}
                  className={`${PILL_BASE} ${active ? 'border-purple-400/60 bg-purple-500/20 et-ink' : 'border-white/10 et-ink-2 hover:bg-white/5'}`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>

          {/* One-bar preview: 4 beats x 4 subdivisions, lane divider across the middle. */}
          <div
            role="img"
            aria-label={
              grid.visible
                ? `Grid preview: bar lines ${opacityPercent(grid.barOpacity)}, beat lines ${opacityPercent(grid.beatOpacity)}, subdivision lines ${opacityPercent(grid.subdivOpacity)}, lane divider ${opacityPercent(grid.laneDividerOpacity)}`
                : 'Grid preview: grid hidden'
            }
            className="relative h-10 rounded border border-white/10 bg-black/40 overflow-hidden et-ink"
          >
            {grid.visible && (
              <div
                className="absolute inset-x-0 top-1/2 h-px bg-current"
                style={{ opacity: grid.laneDividerOpacity }}
              />
            )}
            {previewLines.map((l, i) => (
              <div
                key={i}
                className="absolute inset-y-0 bg-current"
                style={{
                  left: `calc(${l.at * 100}% - ${l.at === 1 ? l.widthPx : 0}px)`,
                  width: l.widthPx,
                  opacity: l.opacity,
                }}
              />
            ))}
            {!grid.visible && (
              <span className="absolute inset-0 flex items-center justify-center et-ink-2">Grid hidden</span>
            )}
          </div>

          <details className="flex flex-col gap-1.5">
            <summary className="cursor-pointer font-bold et-ink-2 hover:et-ink focus-visible:outline focus-visible:outline-purple-400">
              Advanced
            </summary>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {GRID_OPACITY_FIELDS.map((f) => (
                <div key={f.key} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between">
                    <label htmlFor={f.id} className="font-bold">
                      {f.label}
                    </label>
                    <output htmlFor={f.id} className="et-ink-2 tabular-nums">
                      {opacityPercent(grid[f.key])}
                    </output>
                  </div>
                  <input
                    id={f.id}
                    name={f.id}
                    type="range"
                    min={0}
                    max={1}
                    step={OPACITY_STEP}
                    value={grid[f.key]}
                    aria-valuetext={opacityPercent(grid[f.key])}
                    onChange={(e) => setGrid({ [f.key]: Number(e.target.value) })}
                    className={RANGE}
                  />
                </div>
              ))}
              <fieldset className="flex items-center gap-3 min-w-0">
                <legend className="font-bold mb-1">Bar line width</legend>
                {([1, 2] as const).map((w) => {
                  const id = `timeline-grid-bar-width-${w}`;
                  return (
                    <div key={w} className="flex items-center gap-1.5">
                      <input
                        id={id}
                        name="timeline-grid-bar-width"
                        type="radio"
                        value={w}
                        checked={grid.barWidthPx === w}
                        onChange={() => setGrid({ barWidthPx: w })}
                        className="accent-[rgb(var(--et-accent))]"
                      />
                      <label htmlFor={id}>{w} px</label>
                    </div>
                  );
                })}
              </fieldset>
            </div>
          </details>
        </section>

        <button
          type="button"
          onClick={reset}
          className="btn-ghost inline-flex items-center justify-center gap-1.5 font-sans text-xs font-bold focus-visible:outline focus-visible:outline-purple-400"
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
          Reset timeline preferences
        </button>
      </div>
    </div>,
    document.body,
  );
}
