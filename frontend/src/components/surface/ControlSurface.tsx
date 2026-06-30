/**
 * Entry point for a control surface. Resolves (and caches, per surfaceId) the
 * persisted layout store, provides it + the widget registry through context,
 * and renders the container tree plus the Design-Mode palette, toolbar, guides,
 * and the shared right-click context menu.
 *
 * A tab uses it like:
 *   <ControlSurface surfaceId="dj" registry={djRegistry} defaultLayout={defaultDjLayout} />
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { SurfaceContext } from './surfaceContext';
import type { SurfaceMenuTarget } from './surfaceContext';
import { SurfaceNode } from './SurfaceContainer';
import { PaletteDrawer } from './PaletteDrawer';
import { SurfaceToolbar } from './SurfaceToolbar';
import { AlignmentGuides } from './AlignmentGuides';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { useLayoutPrefs } from '../../state/layoutPrefsStore';
import { useEditLayoutStore } from '../../state/editLayoutStore';
import { createLayoutStore, companionOf, absorbableSibling } from '../../state/surfaceLayoutStore';
import type { SurfaceLayout, SurfaceStoreApi } from '../../state/surfaceLayoutStore';
import type { WidgetRegistry, BindableTarget, ButtonShape } from './widgetTypes';

const NO_TARGETS: BindableTarget[] = [];
const SHAPE_ORDER: ButtonShape[] = ['default', 'square', 'rect', 'circle', 'tri-tl', 'tri-tr', 'tri-bl', 'tri-br'];

// One persisted store instance per surface id, reused across (re)mounts + HMR.
const storeCache = new Map<string, SurfaceStoreApi>();
function getStore(surfaceId: string, defaultLayout: SurfaceLayout): SurfaceStoreApi {
  let s = storeCache.get(surfaceId);
  if (!s) {
    s = createLayoutStore(surfaceId, defaultLayout);
    storeCache.set(surfaceId, s);
  }
  return s;
}

/** Build the right-click menu for a node/widget — surfaces the editor actions
 *  (otherwise behind tiny grip buttons) with their hotkey hints. */
function buildMenu(target: SurfaceMenuTarget, store: SurfaceStoreApi): { title: string; items: ContextMenuItem[] } {
  const st = store.getState();
  const nodes = st.layout.nodes;
  const node = nodes[target.nodeId];
  const items: ContextMenuItem[] = [];

  if (target.kind === 'widget') {
    const wid = target.widgetId;
    items.push({ type: 'item', label: 'Justify (cycle)', onSelect: () => store.getState().cycleWidgetJustify(target.nodeId, wid) });
    items.push({
      type: 'item',
      label: 'Shape (cycle)',
      onSelect: () => {
        const p = store.getState().layout.nodes[target.nodeId];
        const cur = (p && p.type === 'panel' ? p.widgetShapes?.[wid] : undefined) ?? 'default';
        const next = SHAPE_ORDER[(SHAPE_ORDER.indexOf(cur) + 1) % SHAPE_ORDER.length];
        store.getState().setWidgetShape(target.nodeId, wid, next);
      },
    });
    items.push({ type: 'item', label: 'Reset margins', onSelect: () => (['t', 'r', 'b', 'l'] as const).forEach((s) => store.getState().setWidgetMargin(target.nodeId, wid, s, 0)) });
    items.push({ type: 'separator' });
    items.push({ type: 'item', label: 'Remove', hint: 'Del', danger: true, onSelect: () => store.getState().removeWidget(wid) });
    return { title: `Control · ${wid}`, items };
  }

  if (target.kind === 'panel' && node && node.type === 'panel') {
    items.push({ type: 'item', label: node.mirror ? 'Un-mirror' : 'Mirror', hint: 'M', onSelect: () => store.getState().togglePanelMirror(target.nodeId) });
    items.push({ type: 'item', label: node.uniform ? 'Free sizing' : 'Match sizes', hint: 'U', onSelect: () => store.getState().togglePanelUniform(target.nodeId) });
    items.push({ type: 'item', label: node.flow === 'row' ? 'Flow: vertical' : 'Flow: horizontal', hint: 'L', onSelect: () => store.getState().togglePanelFlow(target.nodeId) });
    items.push({ type: 'item', label: 'Split → column', onSelect: () => store.getState().splitPanel(target.nodeId, 'row') });
    items.push({ type: 'item', label: 'Split → row', onSelect: () => store.getState().splitPanel(target.nodeId, 'column') });
    if (absorbableSibling(nodes, target.nodeId)) items.push({ type: 'item', label: 'Fill adjacent gap', onSelect: () => store.getState().fillAdjacent(target.nodeId) });
    items.push({ type: 'item', label: node.bgFill ? 'Clear background' : 'Fill background', onSelect: () => store.getState().toggleBgFill(target.nodeId) });
    items.push({ type: 'separator' });
    items.push({ type: 'item', label: 'Remove panel', hint: 'Del', danger: true, onSelect: () => store.getState().removePanel(target.nodeId) });
    return { title: `Panel · ${node.title}`, items };
  }

  if (target.kind === 'container' && node && node.type === 'container') {
    items.push({ type: 'item', label: node.framed ? 'Remove frame' : 'Add frame', hint: 'F', onSelect: () => store.getState().toggleContainerFramed(target.nodeId) });
    items.push({ type: 'item', label: node.axis === 'row' ? 'Axis: vertical' : 'Axis: horizontal', hint: 'X', onSelect: () => store.getState().toggleContainerAxis(target.nodeId) });
    if (companionOf(nodes, target.nodeId)) items.push({ type: 'item', label: 'Sync to companion', onSelect: () => store.getState().mirrorToCompanion(target.nodeId) });
    items.push({ type: 'item', label: 'Center / balance', onSelect: () => store.getState().centerHero() });
    if (absorbableSibling(nodes, target.nodeId)) items.push({ type: 'item', label: 'Fill adjacent gap', onSelect: () => store.getState().fillAdjacent(target.nodeId) });
    items.push({ type: 'item', label: node.bgFill ? 'Clear background' : 'Fill background', onSelect: () => store.getState().toggleBgFill(target.nodeId) });
    items.push({ type: 'separator' });
    items.push({ type: 'item', label: 'Remove region', danger: true, onSelect: () => store.getState().removeContainer(target.nodeId) });
    return { title: `Region · ${node.axis}`, items };
  }
  return { title: '', items };
}

export const ControlSurface: React.FC<{
  surfaceId: string;
  registry: WidgetRegistry;
  defaultLayout: SurfaceLayout;
  className?: string;
  /** Backend endpoints a user-added control can bind to (for the Add-Control
   *  picker). Omit on surfaces with no bindable targets yet. */
  targets?: BindableTarget[];
  /** A stale localStorage key to clear once (migration cleanup). */
  legacyKeyToClear?: string;
}> = ({ surfaceId, registry, defaultLayout, className, targets, legacyKeyToClear }) => {
  const store = getStore(surfaceId, defaultLayout);
  const tgts = targets ?? NO_TARGETS;
  const root = store((s) => s.layout.root);
  const design = store((s) => s.designMode);
  const editLayoutActive = useEditLayoutStore((s) => s.active);
  const showGuides = useLayoutPrefs((s) => s.showGuides);

  const menu = useContextMenu<SurfaceMenuTarget>();
  // Keep `openMenu` identity stable so the context value doesn't churn.
  const openRef = useRef(menu.open);
  openRef.current = menu.open;
  // So Esc closes an open menu without also exiting Design Mode.
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu.position != null;
  const openMenu = useCallback((e: React.MouseEvent, target: SurfaceMenuTarget) => openRef.current(e, target), []);

  const ctx = useMemo(
    () => ({ surfaceId, store, registry, targets: tgts, openMenu }),
    [surfaceId, store, registry, tgts, openMenu],
  );

  useEffect(() => {
    if (!legacyKeyToClear) return;
    try {
      localStorage.removeItem(legacyKeyToClear);
    } catch {
      /* ignore */
    }
  }, [legacyKeyToClear]);

  // The global top-header "Edit Layout" flag is the single source of truth for
  // design mode; mirror it one-way into this surface's session-only designMode
  // (runs on mount too, so navigating into a surface while edit-layout is on
  // arms it). Exit paths (Done button, Esc) clear the global flag, which flows
  // back here through this same effect.
  useEffect(() => {
    if (store.getState().designMode !== editLayoutActive) {
      store.getState().setDesignMode(editLayoutActive);
    }
  }, [editLayoutActive, store]);

  // Design-Mode hotkeys (ignored while typing). Ctrl/Cmd+Z undo,
  // Ctrl+Shift+Z / Ctrl+Y redo, Ctrl+S save-as-default, Esc exit; and single
  // keys acting on the HOVERED node: M mirror, U match, L flow, F frame, X axis,
  // Del remove.
  useEffect(() => {
    if (!design) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const api = store.getState();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) api.redo();
        else api.undo();
        return;
      }
      if (mod && k === 'y') { e.preventDefault(); api.redo(); return; }
      if (mod && k === 's') { e.preventDefault(); api.saveAsDefault(); return; }
      if (e.key === 'Escape') { if (menuOpenRef.current) return; e.preventDefault(); useEditLayoutStore.getState().setActive(false); return; }
      if (mod) return;
      const hv = api.hoverNodeId;
      const node = hv ? api.layout.nodes[hv] : null;
      if (!hv || !node) return;
      if (k === 'm' && node.type === 'panel') { e.preventDefault(); api.togglePanelMirror(hv); }
      else if (k === 'u' && node.type === 'panel') { e.preventDefault(); api.togglePanelUniform(hv); }
      else if (k === 'l' && node.type === 'panel') { e.preventDefault(); api.togglePanelFlow(hv); }
      else if (k === 'f' && node.type === 'container') { e.preventDefault(); api.toggleContainerFramed(hv); }
      else if (k === 'x' && node.type === 'container') { e.preventDefault(); api.toggleContainerAxis(hv); }
      else if (e.key === 'Delete') {
        e.preventDefault();
        if (node.type === 'panel') api.removePanel(hv);
        else api.removeContainer(hv);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [design, store]);

  const menuContent = menu.payload ? buildMenu(menu.payload, store) : null;

  return (
    <SurfaceContext.Provider value={ctx}>
      <div className={`relative h-full w-full min-h-0 ${className ?? ''}`}>
        <div className="absolute inset-0">
          <SurfaceNode nodeId={root} />
        </div>
        {design && showGuides && <AlignmentGuides />}
        {design && <PaletteDrawer />}
        <SurfaceToolbar />
        {menuContent && (
          <ContextMenu position={menu.position} onClose={menu.close} title={menuContent.title} items={menuContent.items} />
        )}
      </div>
    </SurfaceContext.Provider>
  );
};
