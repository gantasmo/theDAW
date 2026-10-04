/**
 * PerformVstWindow — the window a PERFORM track's hosted plugin opens its own
 * editor in.
 *
 * The rail's Window key opens the editor through the one app-wide editor
 * session (state/vstEditorStore). While that session belongs to a PERFORM slot
 * (`perform-<track>-<i>`), this window holds it: embedded, the plugin's window
 * is pinned inside it at the plugin's own size; floating, the plugin keeps its
 * own window and this one says so. It drags by the strip along its top. Closing
 * it leaves the plugin running on its track.
 */
import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVstEditorStore } from '../../state/vstEditorStore';
import { VstEmbedHost } from '../audio/VstEmbedHost';

/** The id prefix of every PERFORM chain entry (lib/performModel.ts). */
const PERFORM_ENTRY_PREFIX = 'perform-';
/** The plugin box before the plugin reports its own size. */
const DEFAULT_W = 480;
const DEFAULT_H = 320;
/** What the window adds around the plugin box: the host's padding, border and
 *  header, and the drag strip. A little over, so the box never scrolls a plugin
 *  that fits. */
const CHROME_W = 22;
const CHROME_H = 70;

export const PerformVstWindow: React.FC = () => {
  const entryId = useVstEditorStore((s) => s.entryId);
  const pluginPath = useVstEditorStore((s) => s.pluginPath);
  const pluginName = useVstEditorStore((s) => s.pluginName);
  const error = useVstEditorStore((s) => s.error);
  const ownerTab = useVstEditorStore((s) => s.ownerTab);

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const onNaturalSize = useCallback((w: number, h: number) => {
    setNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);
  // Viewport px once dragged; until then the window sits at the right edge.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  if (!entryId || !pluginPath || ownerTab !== 'session' || !entryId.startsWith(PERFORM_ENTRY_PREFIX)) return null;

  const w = (natural?.w ?? DEFAULT_W) + CHROME_W;
  const h = (natural?.h ?? DEFAULT_H) + CHROME_H;

  const startDrag = (e: React.PointerEvent) => {
    const el = rootRef.current;
    if (!el || e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      setPos({
        x: Math.max(4, Math.min(window.innerWidth - 160, ev.clientX - dx)),
        y: Math.max(4, Math.min(window.innerHeight - 40, ev.clientY - dy)),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return createPortal(
    <section
      ref={rootRef}
      role="dialog"
      aria-label={`${pluginName ?? 'Plugin'} window`}
      className="fixed z-80 flex flex-col overflow-hidden rounded-lg border border-teal-500/30 bg-black/95 shadow-2xl"
      style={{
        width: `min(${w}px, calc(100vw - 16px))`,
        height: `min(${h}px, calc(100vh - 16px))`,
        ...(pos
          ? { left: pos.x, top: pos.y }
          : { left: `max(8px, calc(100vw - ${w}px - 16px))`, top: `max(8px, min(72px, calc(100vh - ${h}px - 8px)))` }),
      }}
      data-perform-vst-window=""
    >
      {/* The drag strip. Pointer-only, like every floating window's title bar. */}
      <div
        aria-hidden="true"
        onPointerDown={startDrag}
        className="h-4 shrink-0 cursor-grab touch-none select-none border-b border-white/10 bg-white/5 active:cursor-grabbing"
      />
      <div className="min-h-0 flex-1">
        <VstEmbedHost
          pluginPath={pluginPath}
          pluginName={pluginName ?? 'Plugin'}
          error={error ?? undefined}
          onClose={() => useVstEditorStore.getState().close()}
          onNaturalSize={onNaturalSize}
        />
      </div>
    </section>,
    document.body,
  );
};
