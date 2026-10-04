/**
 * Unified per-effect control windows for the EDIT tab.
 *
 * ONE model for every effect kind — built-in rack effects, VST3s, and .gan
 * surfaces (Ares) are the same thing: a ChainEntry. The FX list (FxChainList)
 * shows a chain as compact rows; clicking a row opens THAT entry's control
 * window. Exactly one window can exist per entry id — reopening focuses it.
 *
 * Each window hosts the SAME control UI MIX's Effect Stage uses:
 *   - entry.vst        → VstEmbedHost (native GUI) while this entry owns the
 *                        one app-wide embed session, else MIX's "Open plugin
 *                        GUI" action card (no auto-reopen — deliberate parity
 *                        with MixView's stage).
 *   - entry 'ares'     → GanPluginStage while this entry owns the one active
 *                        gan session, else a "Take over surface" card.
 *   - built-in effects → the shared FxRack tile (same sliders/pads the rest
 *                        of the app edits params with), rendered solo.
 *
 * Windows are draggable floating cards portaled to document.body (outside the
 * .dense-layout zoom), stacked by click order. Window state lives in a
 * module-scope store so it survives EDIT's unmount on tab switch; the native
 * VST / gan sessions do close on tab switch (existing app-wide rules) and
 * their windows degrade to the reopen card.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import {
  Blocks, ChevronDown, ChevronUp, Eye, EyeOff, Loader2, Plug, Plus, RefreshCw,
  SlidersHorizontal, X,
} from 'lucide-react';
import { VstLiveRowBadge } from './VstLiveRowBadge';
import { VstParamPanel } from './VstParamPanel';
import { FxRack } from './FxRack';
import { EffectControls } from './effects/EffectControls';
import { schemaForRackEffect } from './effects/effectSchema';
import { VstEmbedHost } from './VstEmbedHost';
import { FX_POPUP_ATTR, resizedWindowSize, type ResizeEdges } from '../../lib/fxPopupDismiss';
import { GanPluginStage } from './GanPluginStage';
import { useEditorStore } from '../../state/editorStore';
import { sidechainsInto, wouldCycle, type RoutingRefusal } from '../../state/routingGraph';
import { requireFeature } from '../../notices/featureGateStore';
import { useVstEditorStore, vstEntryName } from '../../state/vstEditorStore';
import { useGanStore } from '../../state/ganStore';
import { useVstStore, vst3InstallHint } from '../../state/vstStore';
import { EFFECT_LABELS, type ChainEntry } from '../../state/effectChainStore';
import { getRackEffect, RACK_EFFECTS } from '../../lib/rackEffects';
import { registerAresBridge, ARES_XY_PAD_FALLBACK_ID } from '../../lib/aresBridge';
import type { Vst3PluginInfo } from '../../lib/vstClient';

// ── Scopes ───────────────────────────────────────────────────────────────────

export type FxScope =
  | { kind: 'master' }
  | { kind: 'masterVst' }
  | { kind: 'track'; trackId: string }
  | { kind: 'bus'; busId: string };

/** The chain of a lane that has never had an insert. One shared array, so a
 *  store selector that resolves to it returns the same reference on every read.
 *  Frozen and read-only, so a write to it throws before it can reach every
 *  chainless lane. */
const NO_ENTRIES: readonly ChainEntry[] = Object.freeze([]);

/** The chain a scope names in a given editor state. A track gets `fxChain`
 *  only when something first writes it, so every new lane (MIDI, audio or
 *  empty) resolves to NO_ENTRIES. FxChainList subscribes through this: a new
 *  `[]` per read made useSyncExternalStore see a changed snapshot on every
 *  check, re-render without end and throw "Maximum update depth exceeded" the
 *  moment the rack opened on such a lane, which unmounted the whole app. */
export function chainInState(
  st: ReturnType<typeof useEditorStore.getState>,
  scope: FxScope,
): readonly ChainEntry[] {
  if (scope.kind === 'master') return st.masterFxChain;
  if (scope.kind === 'masterVst') return st.masterVstChain;
  if (scope.kind === 'bus') return st.buses.find((b) => b.id === scope.busId)?.fxChain ?? NO_ENTRIES;
  return st.tracks.find((t) => t.id === scope.trackId)?.fxChain ?? NO_ENTRIES;
}

export function chainForScope(scope: FxScope): readonly ChainEntry[] {
  return chainInState(useEditorStore.getState(), scope);
}

/** One label resolver for every effect kind. A rack effect takes its rack label,
 *  the same one the Add effect select and the header menu list, so an id shared
 *  with a backend effect ('delay': "Delay", the backend's "Stereo Delay") reads
 *  the same in the menu and in its row. */
export function effectEntryLabel(entry: ChainEntry): string {
  // A VST entry is named after the PLUGIN. vstEntryName covers a chain saved
  // before the scanner learned real names (or written by an importer) whose
  // stored plugin_name is empty, so a row never falls back to the blank string
  // — nor to 'vst3', which names the hosting format, not the effect.
  if (entry.vst) return vstEntryName(entry.vst.plugin_name, entry.vst.plugin_path);
  return getRackEffect(entry.effect)?.label || EFFECT_LABELS[entry.effect] || entry.label || entry.effect;
}

const entryKind = (entry: ChainEntry): 'vst' | 'gan' | 'fx' =>
  entry.vst ? 'vst' : entry.effect === 'ares' ? 'gan' : 'fx';

// ── Window store (module-scope; survives EDIT unmount) ───────────────────────

interface EffectWindowRec {
  entryId: string;
  scope: FxScope;
  z: number;
  /** Viewport px; null until first drag → cascaded default position. */
  x: number | null;
  y: number | null;
  /** Viewport px beside the FX list the window opened from; null when it
   *  opened from elsewhere, and it then opens at the right edge. */
  ox: number | null;
  oy: number | null;
  /** Viewport px the window was dragged to from a resize grip; null until
   *  then, and the window takes the size of what it shows. */
  w: number | null;
  h: number | null;
}

/** The viewport point an effect window opens at until it is dragged. */
export interface EffectWindowOrigin {
  x: number;
  y: number;
}

interface EffectWindowState {
  windows: EffectWindowRec[];
  topZ: number;
  /** The 'ares' entry currently driving the one app-wide gan session. */
  aresOwnerEntryId: string | null;
  aresOwnerScope: FxScope | null;
  open: (scope: FxScope, entryId: string, origin?: EffectWindowOrigin) => void;
  close: (entryId: string) => void;
  /** Close every window, each the way `close` does (a press outside them). */
  closeAll: () => void;
  bringToFront: (entryId: string) => void;
  move: (entryId: string, x: number, y: number) => void;
  /** Give a window a size of its own, or null to fit what it shows again. */
  resize: (entryId: string, w: number | null, h: number | null) => void;
  setAresOwner: (scope: FxScope | null, entryId: string | null) => void;
}

export const useEffectWindowStore = create<EffectWindowState>((set, get) => ({
  windows: [],
  topZ: 80,
  aresOwnerEntryId: null,
  aresOwnerScope: null,
  open: (scope, entryId, origin) => {
    const s = get();
    if (s.windows.some((w) => w.entryId === entryId)) {
      s.bringToFront(entryId);
      return;
    }
    set({
      windows: [
        ...s.windows,
        { entryId, scope, z: s.topZ + 1, x: null, y: null, ox: origin?.x ?? null, oy: origin?.y ?? null, w: null, h: null },
      ],
      topZ: s.topZ + 1,
    });
  },
  close: (entryId) => {
    const s = get();
    if (s.aresOwnerEntryId === entryId) {
      useGanStore.getState().close();
      set({ aresOwnerEntryId: null, aresOwnerScope: null });
    }
    const entry = findWindowEntry(entryId);
    if (entry?.vst && useVstEditorStore.getState().entryId === entryId) {
      useVstEditorStore.getState().close();
    }
    set({ windows: get().windows.filter((w) => w.entryId !== entryId) });
  },
  closeAll: () => {
    for (const w of get().windows) get().close(w.entryId);
  },
  bringToFront: (entryId) => {
    const s = get();
    const win = s.windows.find((w) => w.entryId === entryId);
    if (!win || win.z === s.topZ) return;
    set({
      windows: s.windows.map((w) => (w.entryId === entryId ? { ...w, z: s.topZ + 1 } : w)),
      topZ: s.topZ + 1,
    });
  },
  move: (entryId, x, y) =>
    set({ windows: get().windows.map((w) => (w.entryId === entryId ? { ...w, x, y } : w)) }),
  resize: (entryId, w, h) =>
    set({ windows: get().windows.map((rec) => (rec.entryId === entryId ? { ...rec, w, h } : rec)) }),
  setAresOwner: (scope, entryId) => set({ aresOwnerScope: scope, aresOwnerEntryId: entryId }),
}));

function findWindowEntry(entryId: string): ChainEntry | undefined {
  const win = useEffectWindowStore.getState().windows.find((w) => w.entryId === entryId);
  if (!win) return undefined;
  return chainForScope(win.scope).find((e) => e.id === entryId);
}

/** Make an 'ares' entry the surface's target: package/open the .gan and route
 *  its controls onto this entry (the bridge itself is registered by the Host). */
export function takeAresOwnership(scope: FxScope, entryId: string): void {
  useEffectWindowStore.getState().setAresOwner(scope, entryId);
  void (async () => {
    const gan = useGanStore.getState();
    if (!gan.plugins.some((p) => p.id === 'ares')) await gan.ensureAres();
    await useGanStore.getState().openById('ares');
  })();
}

/**
 * Open a VST entry's own editor, with its captured state written back onto the
 * chain the scope names: a track's inserts, a bus's inserts or the master VST
 * chain. The one opener every FX list shares, EDIT's racks and the mixer's.
 */
export function openVstEditorForScope(scope: FxScope, entry: ChainEntry): void {
  const sink = (entryId: string, raw: string): void => {
    const st = useEditorStore.getState();
    if (scope.kind === 'track') st.setTrackVstRawState(scope.trackId, entryId, raw);
    else if (scope.kind === 'bus') st.setBusVstRawState(scope.busId, entryId, raw);
    else st.setMasterVstRawState(entryId, raw);
  };
  useVstEditorStore.getState().open(entry, sink);
}

/** The single entry point the FX lists use: open (or focus) the entry's
 *  window and kick the kind-specific session (native VST GUI / gan surface). */
export function openEffectWindow(
  scope: FxScope,
  entry: ChainEntry,
  openVst: (scope: FxScope, entry: ChainEntry) => void,
  origin?: EffectWindowOrigin,
): void {
  useEffectWindowStore.getState().open(scope, entry.id, origin);
  if (entry.vst) openVst(scope, entry);
  else if (entry.effect === 'ares') takeAresOwnership(scope, entry.id);
}

// ── Host props (WaveformEditor supplies its automation-aware param plumbing) ─

export interface EffectWindowsHostProps {
  writeParams: (scope: FxScope, entryId: string, params: Record<string, number>) => void;
  /** The gesture boundary around a run of `writeParams` calls. Every panel a
   *  window can show reports one — FxRack's bespoke panels and the
   *  schema-driven EffectControls alike. Per ENTRY: one surface writes several
   *  param keys. See FxRack's `onParamsGestureStart`. */
  gestureStart: (scope: FxScope, entryId: string) => void;
  gestureEnd: (scope: FxScope, entryId: string) => void;
  displayParams: (scope: FxScope, entryId: string) => Record<string, number> | undefined;
  openVst: (scope: FxScope, entry: ChainEntry) => void;
  projectBpm: number;
}

// ── Scope-aware chain mutations (shared by list + windows) ───────────────────

function removeEntry(scope: FxScope, entryId: string): void {
  const st = useEditorStore.getState();
  if (scope.kind === 'master') st.removeMasterEffect(entryId);
  else if (scope.kind === 'masterVst') st.removeMasterVst(entryId);
  else if (scope.kind === 'bus') st.removeBusEffect(scope.busId, entryId);
  else st.removeTrackEffect(scope.trackId, entryId);
  useEffectWindowStore.getState().close(entryId);
}

function toggleEntry(scope: FxScope, entryId: string): void {
  const st = useEditorStore.getState();
  if (scope.kind === 'master') st.toggleMasterEffect(entryId);
  else if (scope.kind === 'masterVst') st.toggleMasterVst(entryId);
  else if (scope.kind === 'bus') st.toggleBusEffect(scope.busId, entryId);
  else st.toggleTrackEffect(scope.trackId, entryId);
}

function reorderEntry(scope: FxScope, from: number, to: number): void {
  const st = useEditorStore.getState();
  if (scope.kind === 'master') st.reorderMasterEffect(from, to);
  else if (scope.kind === 'masterVst') st.reorderMasterVst(from, to);
  else if (scope.kind === 'bus') st.reorderBusEffect(scope.busId, from, to);
  else st.reorderTrackEffect(scope.trackId, from, to);
}

// ── "Key from": the sidechain picker ─────────────────────────────────────────

/** Why the graph said no, in the picker's own words. Only `'cycle'` is
 *  reachable from a list that offers other strips and nothing else; the rest are
 *  named rather than swallowed, because a silent no-op on a `<select>` that
 *  visibly moved is the worst outcome. */
function keyRefusalMessage(reason: RoutingRefusal): string {
  if (reason === 'cycle') {
    return 'That strip already receives this one, so keying from it would feed the mix back '
      + 'into itself — which in Web Audio is silence, not feedback.';
  }
  return `The routing graph refused the key (${reason}).`;
}

/**
 * The "Key from" `<select>`: choose which strip's output drives this effect's
 * key input, or none.
 *
 * Its own component so it can hold hooks — the card renders it only for an
 * effect that declares `keyInput`, and hooks cannot be called conditionally.
 *
 * An option that would close a loop is DISABLED rather than offered and then
 * rejected (`MixerStrips`' output picker does the same), because the model's
 * `wouldCycle` is the same predicate the store will apply. A refusal that gets
 * through anyway — the store is the authority, and the graph can move between
 * render and click — is surfaced as a notice.
 */
const KeyFromPicker: React.FC<{ nodeKind: 'track' | 'bus'; nodeId: string; entryId: string; label: string }> = ({
  nodeKind, nodeId, entryId, label,
}) => {
  const routing = useEditorStore((s) => s.routing);
  const tracks = useEditorStore((s) => s.tracks);
  const buses = useEditorStore((s) => s.buses);
  const setEffectSidechain = useEditorStore((s) => s.setEffectSidechain);
  const selectId = `fxwin-key-${entryId}`;

  // The entry's current key, straight off the graph — no mirrored state, so an
  // undo or a mixer edit moves this select with it.
  const current = sidechainsInto(routing, nodeId).find((e) => e.targetEntryId === entryId)?.from ?? '';

  // Every OTHER track, then every bus. The master is not offered: it is
  // downstream of everything, so keying from it is a loop by definition.
  const sources = [
    ...tracks.filter((t) => t.id !== nodeId).map((t) => ({ id: t.id, name: t.name })),
    ...buses.filter((b) => b.id !== nodeId).map((b) => ({ id: b.id, name: b.name })),
  ];

  return (
    <div className="flex items-center gap-2 rounded border border-purple-500/20 bg-purple-500/5 px-2 py-1.5">
      <label htmlFor={selectId} className="font-display text-xs font-bold uppercase tracking-wider text-purple-300/80 shrink-0">
        Key from
      </label>
      <select
        id={selectId}
        name={selectId}
        value={current}
        title={`Sidechain key input for ${label}`}
        onChange={(e) => {
          const next = e.target.value;
          const refusal = setEffectSidechain({ kind: nodeKind, id: nodeId }, entryId, next || null);
          if (!refusal) return;
          requireFeature({
            id: 'routing:refused',
            kind: 'error',
            title: 'That key was refused',
            message: keyRefusalMessage(refusal),
            autoDismissMs: 6000,
          });
        }}
        className="flex-1 min-w-0 rounded-md bg-white/5 border border-white/10 px-1 py-0.5 text-xs text-zinc-300 hover:text-white focus:outline-hidden focus:ring-1 focus:ring-[rgb(var(--et-accent))]"
      >
        <option value="">None</option>
        {sources.map((s) => {
          const loops = wouldCycle(routing, s.id, nodeId);
          return (
            <option key={s.id} value={s.id} disabled={loops && s.id !== current}>
              {loops ? `${s.name} (would feed back)` : s.name}
            </option>
          );
        })}
      </select>
    </div>
  );
};

// ── The floating window card ─────────────────────────────────────────────────

const KIND_TINT: Record<'vst' | 'gan' | 'fx', { border: string; text: string }> = {
  vst: { border: 'border-teal-500/30', text: 'text-teal-300' },
  gan: { border: 'border-indigo-500/30', text: 'text-indigo-300' },
  fx: { border: 'border-purple-500/30', text: 'text-purple-300' },
};

const EffectWindowCard: React.FC<{
  win: EffectWindowRec;
  index: number;
  host: EffectWindowsHostProps;
}> = ({ win, index, host }) => {
  // Subscribe to the owning chain so the window re-renders with param edits
  // and auto-closes when the entry (or its track) is removed elsewhere.
  const entry = useEditorStore((s) => chainInState(s, win.scope).find((e) => e.id === win.entryId));
  const close = useEffectWindowStore((s) => s.close);
  const bringToFront = useEffectWindowStore((s) => s.bringToFront);
  const move = useEffectWindowStore((s) => s.move);
  const resize = useEffectWindowStore((s) => s.resize);
  const aresOwnerEntryId = useEffectWindowStore((s) => s.aresOwnerEntryId);

  const vstSessionEntryId = useVstEditorStore((s) => s.entryId);
  const vstSessionPath = useVstEditorStore((s) => s.pluginPath);
  const vstSessionName = useVstEditorStore((s) => s.pluginName);
  const vstSessionError = useVstEditorStore((s) => s.error);
  const vstSessionOwnerTab = useVstEditorStore((s) => s.ownerTab);
  const ganActiveUrl = useGanStore((s) => s.activeUrl);
  const ganActiveName = useGanStore((s) => s.activeName);

  // Natural VST editor size (CSS px) so the window fits the plugin.
  const [vstNatural, setVstNatural] = useState<{ w: number; h: number } | null>(null);
  const onVstNaturalSize = useCallback((w: number, h: number) => {
    setVstNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!entry) close(win.entryId);
  }, [entry, close, win.entryId]);
  if (!entry) return null;

  const kind = entryKind(entry);
  const tint = KIND_TINT[kind];
  const label = effectEntryLabel(entry);

  const vstOwnsSession = !!entry.vst && vstSessionEntryId === entry.id && vstSessionOwnerTab === 'edit' && !!vstSessionPath;
  const aresOwnsSession = kind === 'gan' && aresOwnerEntryId === entry.id && !!ganActiveUrl;

  // Sizing per kind (viewport px; the card is portaled outside the zoom). A
  // window dragged from a grip keeps that size. A plugin's window otherwise
  // takes the size of the plugin's own editor: the host box inside it is as
  // large as the editor and the card wraps it, so no fixed frame clips a large
  // editor or leaves a small one in a corner. `size` is then only the estimate
  // the opening position is clamped with.
  const userSized = win.w != null && win.h != null;
  const vstFits = kind === 'vst' && vstOwnsSession && !userSized;
  const size: React.CSSProperties = userSized
    ? { width: `${win.w}px`, height: `${win.h}px` }
    : kind === 'vst'
      ? vstOwnsSession && vstNatural
        ? { width: `min(${vstNatural.w + 36}px, calc(100vw - 16px))`, height: `min(${vstNatural.h + 96}px, calc(100vh - 16px))` }
        : vstOwnsSession
          ? { width: 'min(500px, 92vw)', height: 'min(400px, 85vh)' }
          : { width: 'min(360px, 92vw)' }
      : kind === 'gan'
        ? aresOwnsSession
          ? { width: 'min(720px, 92vw)', height: 'min(520px, 72vh)' }
          : { width: 'min(540px, 92vw)', maxHeight: '78vh' }
        : { width: 'min(500px, 92vw)', maxHeight: '78vh' };
  const applied: React.CSSProperties = vstFits
    ? { minWidth: 'min(360px, 92vw)', maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)' }
    : size;

  // An undragged window opens beside the FX list it came from, or at the right
  // edge when it opened from elsewhere, clear of the track headers either way.
  // CSS clamp keeps it on screen without measuring. The offsets cascade windows
  // opened one after another; the vertical one sits outside the clamp, so each
  // window's title bar and close button stay clear of the next window.
  const cascade = index % 6;
  const widthCss = String(size.width);
  const heightCss = String(size.height ?? size.maxHeight ?? '200px');
  const position: React.CSSProperties =
    win.x != null && win.y != null
      ? { left: win.x, top: win.y }
      : {
          left:
            win.ox != null
              ? `clamp(8px, ${win.ox + cascade * 40}px, calc(100vw - ${widthCss} - 8px))`
              : `max(8px, calc(100vw - ${widthCss} - ${48 + cascade * 40}px))`,
          top: `calc(clamp(8px, ${win.oy ?? 96}px, calc(100vh - ${heightCss} - 8px)) + ${cascade * 34}px)`,
        };

  const startDrag = (e: React.PointerEvent) => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const w = el.offsetWidth;
      const x = Math.max(4, Math.min(window.innerWidth - Math.min(w, 160), ev.clientX - d.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 40, ev.clientY - d.dy));
      move(win.entryId, x, y);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // A grip on the right edge, the bottom edge or the corner sizes the window.
  // The pointer is captured, so the drag keeps arriving while it crosses a
  // plugin's native window. The window is pinned where it stands first: an
  // undragged window is placed from its width, and would slide as it resized.
  const startResize = (edges: ResizeEdges) => (e: React.PointerEvent) => {
    const el = rootRef.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    const start = { w: rect.width, h: rect.height, left: rect.left, top: rect.top };
    const x0 = e.clientX;
    const y0 = e.clientY;
    move(win.entryId, rect.left, rect.top);
    resize(win.entryId, Math.round(rect.width), Math.round(rect.height));
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const next = resizedWindowSize(start, ev.clientX - x0, ev.clientY - y0, edges, {
        w: window.innerWidth,
        h: window.innerHeight,
      });
      resize(win.entryId, next.w, next.h);
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

  const paramScope = win.scope;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`${label} controls`}
      className={`fixed hardware-card bg-black/95 border ${tint.border} rounded-lg shadow-2xl flex flex-col overflow-hidden`}
      style={{ ...position, zIndex: win.z, ...applied }}
      onMouseDown={() => bringToFront(win.entryId)}
      {...{ [FX_POPUP_ATTR]: '' }}
    >
      {/* Title bar — the drag handle. Same chrome for every effect kind. */}
      <div
        className="flex items-center gap-2 border-b border-white/10 px-3 py-2 shrink-0 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={startDrag}
      >
        {kind === 'vst' ? <Plug className={`w-3.5 h-3.5 ${tint.text}`} />
          : kind === 'gan' ? <Blocks className={`w-3.5 h-3.5 ${tint.text}`} />
            : <SlidersHorizontal className={`w-3.5 h-3.5 ${tint.text}`} />}
        <span className={`font-display text-xs font-bold uppercase tracking-wider truncate ${tint.text}`}>{label}</span>
        {kind !== 'vst' && (
          <button
            onClick={() => toggleEntry(win.scope, entry.id)}
            aria-pressed={entry.enabled}
            aria-label={entry.enabled ? `Bypass ${label}` : `Enable ${label}`}
            title={entry.enabled ? 'Bypass' : 'Enable'}
            className={`p-0.5 rounded ${entry.enabled ? 'text-emerald-300 hover:text-emerald-200' : 'text-zinc-600 hover:text-zinc-400'}`}
          >
            {entry.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          </button>
        )}
        <button
          onClick={() => close(win.entryId)}
          aria-label={`Close ${label} window`}
          className="ml-auto p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body — exactly what MIX's Effect Stage renders for this kind. */}
      {kind === 'vst' ? (
        vstOwnsSession ? (
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <VstEmbedHost
              pluginPath={vstSessionPath!}
              pluginName={vstSessionName ?? label}
              error={vstSessionError ?? undefined}
              onClose={() => useVstEditorStore.getState().close()}
              onNaturalSize={onVstNaturalSize}
              fit
            />
          </div>
        ) : (
          /* The plugin's own window is closed (or cannot open here): its parameters are still one
             panel away — every one the plugin declares, with the plugin's own words for each value. */
          <div className="p-2 flex flex-col gap-2 min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 rounded border border-teal-500/20 bg-teal-500/5 px-2 py-1.5">
              <Plug className="w-4 h-4 text-teal-300/70 shrink-0" />
              <span className="font-sans text-xs font-bold text-zinc-400 flex-1 min-w-0 truncate">
                {entry.vst?.raw_state ? 'Custom settings saved.' : 'Native editor closed.'}
              </span>
              <button
                onClick={() => host.openVst(win.scope, entry)}
                className="shrink-0 px-2 py-1 rounded border border-teal-500/40 bg-teal-500/15 text-teal-200 hover:bg-teal-500/25 font-display text-xs font-bold uppercase tracking-wider"
              >
                Open plugin GUI
              </button>
            </div>
            <VstParamPanel
              entry={entry}
              idPrefix={`fxwin-${entry.id}`}
              display={host.displayParams(paramScope, entry.id)}
              onWrite={(p) => host.writeParams(paramScope, entry.id, p)}
              onGestureStart={() => host.gestureStart(paramScope, entry.id)}
              onGestureEnd={() => host.gestureEnd(paramScope, entry.id)}
            />
          </div>
        )
      ) : kind === 'gan' ? (
        aresOwnsSession ? (
          <div className="flex-1 min-h-0">
            <GanPluginStage url={ganActiveUrl} name={ganActiveName ?? label} />
          </div>
        ) : (
          /* Surface closed: the composite is still fully editable — every
             Ares stage (filter/delay/reverb/grains/gate + wet/dry) through
             the schema panel, with the .gan surface one click away. */
          <div className="p-2 overflow-y-auto min-h-0 flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded border border-indigo-500/20 bg-indigo-500/5 px-2 py-1.5">
              <Blocks className="w-4 h-4 text-indigo-300/70 shrink-0" />
              <span className="font-sans text-xs font-bold text-zinc-400 flex-1 min-w-0 truncate">
                {aresOwnerEntryId ? 'The surface is driving another Ares insert.' : 'Surface closed — knobs below drive this insert directly.'}
              </span>
              <button
                onClick={() => takeAresOwnership(win.scope, entry.id)}
                className="shrink-0 px-2 py-1 rounded border border-indigo-500/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25 font-display text-xs font-bold uppercase tracking-wider"
              >
                {aresOwnerEntryId ? 'Take over surface' : 'Open surface'}
              </button>
            </div>
            {(() => {
              const def = getRackEffect(entry.effect);
              return def ? (
                <EffectControls
                  schema={schemaForRackEffect(def)}
                  params={entry.params}
                  display={host.displayParams(paramScope, entry.id)}
                  idPrefix={`fxwin-${entry.id}`}
                  layout="expanded"
                  hideHeader
                  onChange={(p) => host.writeParams(paramScope, entry.id, p)}
                  onGestureStart={() => host.gestureStart(paramScope, entry.id)}
                  onGestureEnd={() => host.gestureEnd(paramScope, entry.id)}
                />
              ) : null;
            })()}
          </div>
        )
      ) : (
        <div className="p-2 overflow-y-auto min-h-0 flex flex-col gap-2">
          {/* The key picker, for an effect that takes one: `wireRoutingGraph`
              keys track and bus racks alike. The master rack is downstream of
              the sum and is deliberately not keyable. */}
          {win.scope.kind === 'track' && getRackEffect(entry.effect)?.keyInput && (
            <KeyFromPicker nodeKind="track" nodeId={win.scope.trackId} entryId={entry.id} label={label} />
          )}
          {win.scope.kind === 'bus' && getRackEffect(entry.effect)?.keyInput && (
            <KeyFromPicker nodeKind="bus" nodeId={win.scope.busId} entryId={entry.id} label={label} />
          )}
          <FxRack
            chain={[entry]}
            idPrefix={`fxwin-${entry.id}`}
            layout="expanded"
            hideAdd
            onAdd={() => undefined}
            onRemove={(id) => removeEntry(win.scope, id)}
            onReorder={() => undefined}
            onToggle={(id) => toggleEntry(win.scope, id)}
            onUpdateParams={(id, p) => host.writeParams(paramScope, id, p)}
            onParamsGestureStart={(id) => host.gestureStart(paramScope, id)}
            onParamsGestureEnd={(id) => host.gestureEnd(paramScope, id)}
            projectBpm={host.projectBpm}
            displayParams={(id) => host.displayParams(paramScope, id)}
          />
        </div>
      )}

      {/* Resize grips: the right edge, the bottom edge and the corner. They sit
          in the card's own border and padding, clear of a plugin's window.
          Pointer-only, like the title bar's drag. */}
      <div
        aria-hidden="true"
        onPointerDown={startResize({ right: true, bottom: false })}
        className="absolute top-9 bottom-3.5 right-0 w-1.5 cursor-ew-resize touch-none"
      />
      <div
        aria-hidden="true"
        onPointerDown={startResize({ right: false, bottom: true })}
        className="absolute bottom-0 left-0 right-3.5 h-1.5 cursor-ns-resize touch-none"
      />
      <div
        aria-hidden="true"
        title="Drag to resize. Double-click to fit."
        onPointerDown={startResize({ right: true, bottom: true })}
        onDoubleClick={() => resize(win.entryId, null, null)}
        className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-nwse-resize touch-none text-zinc-500 hover:text-white"
      >
        <svg viewBox="0 0 14 14" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M12 6 6 12M12 10l-2 2" />
        </svg>
      </div>
    </div>,
    document.body,
  );
};

// ── Host: renders every window + owns the Ares bridge ────────────────────────

export const EffectWindowsHost: React.FC<EffectWindowsHostProps> = (props) => {
  const windows = useEffectWindowStore((s) => s.windows);
  const aresOwnerEntryId = useEffectWindowStore((s) => s.aresOwnerEntryId);
  const aresOwnerScope = useEffectWindowStore((s) => s.aresOwnerScope);

  // While an EDIT entry owns the surface, EDIT owns the ONE app-wide Ares
  // bridge; releasing ownership lets MIX re-register on mount.
  useEffect(() => {
    if (!aresOwnerEntryId || !aresOwnerScope) return;
    const scope = aresOwnerScope;
    const entryId = aresOwnerEntryId;
    return registerAresBridge({
      getXyPadId: () => {
        const ares = useGanStore.getState().plugins.find((pl) => pl.id === 'ares');
        return ares?.controls.find((c) => c.name === 'ares_xy_kaoss_pad')?.id ?? ARES_XY_PAD_FALLBACK_ID;
      },
      findEntry: () => chainForScope(scope).find((e) => e.id === entryId) ?? null,
      updateParams: (id, params) => {
        const st = useEditorStore.getState();
        if (scope.kind === 'track') st.updateTrackEffectParams(scope.trackId, id, params);
        else if (scope.kind === 'bus') st.updateBusEffectParams(scope.busId, id, params);
        else st.updateMasterEffectParams(id, params);
      },
    });
  }, [aresOwnerEntryId, aresOwnerScope]);

  // EDIT unmounts on tab switch; the app-wide gan session must not stay bound
  // to an EDIT entry (it would hijack MIX's Effect Stage). Windows persist.
  useEffect(() => () => {
    const s = useEffectWindowStore.getState();
    if (s.aresOwnerEntryId) {
      useGanStore.getState().close();
      s.setAresOwner(null, null);
    }
  }, []);

  return (
    <>
      {windows.map((w, i) => (
        <EffectWindowCard key={w.entryId} win={w} index={i} host={props} />
      ))}
    </>
  );
};

// ── FxChainList: the compact unified chain rows + one add menu ───────────────

export interface FxChainListProps {
  scope: FxScope;
  /** Open (or focus) an entry's control window at `origin`, beside this list. */
  onOpenEntry: (scope: FxScope, entry: ChainEntry, origin?: EffectWindowOrigin) => void;
  /** Add a built-in rack effect (undefined hides the rack-add select). */
  onAddEffect?: (effectId: string) => void;
  /** Add a VST3 (undefined hides the plugin browser). */
  onAddVst?: (plugin: Vst3PluginInfo) => void;
  vstPlugins?: Vst3PluginInfo[];
  vstScanning?: boolean;
  onRescanVst?: () => void;
  emptyHint?: string;
  /** Scroll the rows inside whatever height the holding panel leaves them, and
   *  keep the add controls below the rows in view. For a flex-column panel with
   *  a max-height, such as EDIT's track FX rack. */
  scrollRows?: boolean;
}

// The "no chain yet" case takes the one shared NO_ENTRIES reference through
// `chainInState` above — a fresh `[]` per read makes useSyncExternalStore see a
// new snapshot every render ("getSnapshot should be cached" → infinite
// re-render loop), so both lists subscribe through that single helper.

export const FxChainList: React.FC<FxChainListProps> = ({
  scope,
  onOpenEntry,
  onAddEffect,
  onAddVst,
  vstPlugins = [],
  vstScanning = false,
  onRescanVst,
  emptyHint = 'No effects yet — add one below.',
  scrollRows = false,
}) => {
  // Subscribe so rows live-update with the chain. chainInState returns a stable
  // reference for a lane with no chain yet; see its comment.
  const chain = useEditorStore((s) => chainInState(s, scope));
  const openWindows = useEffectWindowStore((s) => s.windows);
  const vstInstallFolder = useVstStore((s) => s.installFolder);
  const [showVstBrowser, setShowVstBrowser] = useState(false);
  const addEffectId = `fx-add-effect-${useId()}`;
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  // A row added while the rows scroll lands at the bottom, out of view; bring
  // it into view so the effect just added is the one on screen.
  const rowCountRef = useRef(chain.length);
  useLayoutEffect(() => {
    const grew = chain.length > rowCountRef.current;
    rowCountRef.current = chain.length;
    const rows = rowsRef.current;
    if (grew && scrollRows && rows) rows.scrollTop = rows.scrollHeight;
  }, [chain.length, scrollRows]);
  // Where a row's control window opens: just right of the panel holding this
  // list (the list sits inside the panel's 12px padding), level with the list.
  const windowOrigin = (): EffectWindowOrigin | undefined => {
    const r = listRef.current?.getBoundingClientRect();
    return r ? { x: Math.round(r.right + 20), y: Math.round(r.top) } : undefined;
  };

  return (
    <div ref={listRef} className={`flex flex-col gap-1.5 ${scrollRows ? 'min-h-0' : ''}`} {...{ [FX_POPUP_ATTR]: '' }}>
      {chain.length === 0 ? (
        <p className="font-sans text-xs font-bold text-zinc-500">{emptyHint}</p>
      ) : (
        // A scrolling list shows a visible thumb: the app's 5px bg-white/5 thumb
        // does not show, and a cut-off list then reads as the whole chain.
        <div
          ref={rowsRef}
          className={`flex flex-col gap-1 ${scrollRows ? 'min-h-7 overflow-y-auto pr-0.5 scrollbar-thin [scrollbar-color:rgba(168,85,247,0.8)_rgba(255,255,255,0.08)]' : ''}`}
        >
          {chain.map((entry, i) => {
            const kind = entryKind(entry);
            const tint = KIND_TINT[kind];
            const isOpen = openWindows.some((w) => w.entryId === entry.id);
            return (
              <div
                key={entry.id}
                className={`flex items-center gap-1.5 rounded border px-1.5 py-1 transition-colors ${
                  isOpen ? 'border-purple-500/40 bg-purple-500/10' : 'border-white/5 bg-black/40 hover:bg-white/5'
                }`}
              >
                <button
                  onClick={() => toggleEntry(scope, entry.id)}
                  aria-pressed={entry.enabled}
                  aria-label={entry.enabled ? `Bypass ${effectEntryLabel(entry)}` : `Enable ${effectEntryLabel(entry)}`}
                  title={entry.enabled ? 'Bypass' : 'Enable'}
                  className={`w-2.5 h-2.5 rounded-full shrink-0 border ${
                    entry.enabled
                      ? 'bg-purple-400 border-purple-300 shadow-[0_0_6px_rgba(192,132,252,0.7)]'
                      : 'bg-transparent border-zinc-600'
                  }`}
                />
                {/* Row body — clicking opens the entry's control window. */}
                <button
                  onClick={() => onOpenEntry(scope, entry, windowOrigin())}
                  title={`Open ${effectEntryLabel(entry)} controls`}
                  className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                >
                  <span className="flex-1 min-w-0 font-sans text-xs font-bold text-zinc-200 truncate">
                    {effectEntryLabel(entry)}
                  </span>
                  <span className={`shrink-0 font-display text-xs font-bold uppercase tracking-wide px-1 rounded border ${tint.border} ${tint.text} bg-black/40`}>
                    {kind === 'vst' ? 'VST' : kind === 'gan' ? 'GAN' : 'FX'}
                  </span>
                </button>
                {/* A hosted plugin says what it is doing right now: LIVE + latency, starting, a dead
                    host with a retry, or render-only. Outside the row-body button: the retry is a
                    control of its own and a button cannot hold another. */}
                <VstLiveRowBadge entry={entry} label={effectEntryLabel(entry)} />
                <button
                  onClick={() => reorderEntry(scope, i, i - 1)}
                  disabled={i === 0}
                  aria-label="Move up"
                  className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-30 shrink-0"
                >
                  <ChevronUp className="w-3 h-3" />
                </button>
                <button
                  onClick={() => reorderEntry(scope, i, i + 1)}
                  disabled={i === chain.length - 1}
                  aria-label="Move down"
                  className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-30 shrink-0"
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
                <button
                  onClick={() => removeEntry(scope, entry.id)}
                  aria-label={`Remove ${effectEntryLabel(entry)}`}
                  className="p-0.5 text-zinc-500 hover:text-red-300 shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ONE add area: built-ins and VSTs together, no separate sections. */}
      {(onAddEffect || onAddVst) && (
        <div className="shrink-0 flex flex-col gap-1 border-t border-white/10 pt-1.5">
          <div className="flex items-center gap-1.5">
            {onAddEffect && (
              <>
                <label htmlFor={addEffectId} className="sr-only">Add effect</label>
                <select
                  id={addEffectId}
                  name="fx-add-effect"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) onAddEffect(e.target.value);
                    e.target.value = '';
                  }}
                  className="form-select flex-1 min-w-0 px-1.5 py-1 font-sans font-bold text-xs"
                >
                  <option value="">+ Add effect…</option>
                  {RACK_EFFECTS.map((def) => (
                    <option key={def.id} value={def.id}>{def.label}</option>
                  ))}
                </select>
              </>
            )}
            {onAddVst && (
              <button
                onClick={() => setShowVstBrowser((v) => !v)}
                aria-pressed={showVstBrowser}
                title="Add a VST3 plugin"
                className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border font-display text-xs font-bold uppercase tracking-wider transition-colors ${
                  showVstBrowser ? 'border-teal-500/40 bg-teal-500/15 text-teal-200' : 'border-white/10 text-zinc-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Plug className="w-3 h-3" /> VST
              </button>
            )}
          </div>
          {onAddVst && showVstBrowser && (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between">
                <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400">Plugins ({vstPlugins.length})</span>
                {onRescanVst && (
                  <button
                    onClick={onRescanVst}
                    disabled={vstScanning}
                    className="btn-ghost inline-flex items-center gap-1 disabled:opacity-40"
                    title="Rescan VST3 folders"
                    aria-label="Rescan VST3 folders"
                  >
                    {vstScanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  </button>
                )}
              </div>
              {vstPlugins.length === 0 ? (
                <p className="font-sans text-xs font-bold text-zinc-500 leading-relaxed">
                  {vstScanning ? 'Scanning…' : `No VST3 plugins found. ${vst3InstallHint(vstInstallFolder)}`}
                </p>
              ) : (
                <div className="max-h-32 overflow-y-auto flex flex-col gap-0.5">
                  {vstPlugins.map((pl) => {
                    const inChain = chain.some((e) => e.vst?.plugin_path === pl.path);
                    // The plugin's OWN name once the backend probe has read it;
                    // the file stem is only the fallback. The vendor rides
                    // alongside as a muted secondary label, so two plugins that
                    // share a short name stay tellable apart.
                    const name = pl.display_name || pl.name;
                    return (
                      <button
                        key={pl.path}
                        onClick={() => onAddVst(pl)}
                        title={inChain ? `Open ${name} controls` : `Insert ${name}`}
                        className={`flex items-center gap-1.5 text-left px-1.5 py-1 rounded font-sans text-xs font-bold truncate transition-colors border ${
                          inChain ? 'bg-teal-500/15 text-teal-300 border-teal-500/30' : 'text-zinc-400 hover:bg-white/5 hover:text-white border-transparent'
                        }`}
                      >
                        <Plug className="w-3 h-3 text-teal-300 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{name}</span>
                        {pl.manufacturer && (
                          <span className="shrink-0 max-w-20 truncate font-sans text-xs font-bold text-zinc-600">{pl.manufacturer}</span>
                        )}
                        {!inChain && <Plus className="w-3 h-3 text-zinc-500 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
