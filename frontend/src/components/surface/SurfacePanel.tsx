/**
 * A leaf panel. In Design Mode it shows a header strip with a drag grip (a
 * PANEL_MIME source so the panel can be moved/reordered across containers),
 * an inline-editable title, a mirror toggle, a padding drag-handle, split-row /
 * split-column buttons, and a remove button. The body either hosts ONE pinned
 * component full-bleed (library / source tree — no widget DnD, hidden from the
 * palette) or an fr-grid of relocatable WidgetCells.
 *
 * Uniform chrome: widget panels adopt the hardware-card border/bg so every
 * panel edge reads the same; pinned panels stay transparent (their hosted
 * component supplies its own card). Per-panel padding (padPx) and mirror
 * (horizontal order + per-widget mirror opt) come from the layout store.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GripVertical, FlipHorizontal, Rows3, Columns3, SeparatorHorizontal, SplitSquareHorizontal, SplitSquareVertical, Grid2x2, CirclePlus, Link2, Combine, X } from 'lucide-react';
import { useSurface } from './surfaceContext';
import { FrGrid } from './FrGrid';
import { Splitter } from './Splitter';
import { WidgetCell } from './WidgetCell';
import { AddControlModal } from './AddControlModal';
import { PANEL_MIME, WIDGET_MIME, encode, decodeWidget, decodePanel } from './dnd';
import { companionOf, absorbableSibling } from '../../state/surfaceLayoutStore';
import type { Axis, EdgeDir, NodeId, PanelNode, SurfaceStoreApi } from '../../state/surfaceLayoutStore';

const PanelHeader: React.FC<{
  nodeId: NodeId;
  title: string;
  mirror: boolean;
  uniform: boolean;
  flow: Axis;
  padPx: number;
  surfaceId: string;
  store: SurfaceStoreApi;
  companionId?: NodeId | null;
  absorbId?: NodeId | null;
  onAddControl?: () => void;
}> = ({ nodeId, title, mirror, uniform, flow, padPx, surfaceId, store, companionId, absorbId, onAddControl }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  return (
    <div className="shrink-0 flex items-center gap-1 h-4 px-1 bg-purple-600/85 border-b border-purple-300/40 select-none">
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(PANEL_MIME, encode({ surfaceId, panelId: nodeId }));
        }}
        title="Drag to move this panel"
        className="cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="w-3 h-3 text-purple-50" />
      </div>

      {editing ? (
        <input
          autoFocus
          name="surface-panel-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            store.getState().renamePanel(nodeId, draft.trim() || 'Panel');
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(title);
              setEditing(false);
            }
          }}
          className="flex-1 min-w-0 bg-black/30 text-purple-50 text-[8px] font-black uppercase tracking-wider px-1 rounded focus:outline-none"
          title="Panel name"
        />
      ) : (
        <span
          onDoubleClick={() => {
            setDraft(title);
            setEditing(true);
          }}
          className="flex-1 min-w-0 truncate text-[8px] font-black uppercase tracking-wider text-purple-50"
          title="Double-click to rename"
        >
          {title}
        </span>
      )}

      {/* draggable inner padding (margin) */}
      <Splitter
        axis="x"
        onDelta={(d) => store.getState().setPanelPad(nodeId, padPx + d * 0.25)}
        title={`Drag to set inner padding (${padPx}px)`}
        className="h-3 w-1.5 shrink-0"
      />
      <button
        onClick={() => store.getState().togglePanelFlow(nodeId)}
        title={`Layout: ${flow === 'row' ? 'horizontal' : 'vertical'} (click to toggle)`}
        className="text-purple-50/80 hover:text-white"
      >
        {flow === 'row' ? <Columns3 className="w-3 h-3" /> : <Rows3 className="w-3 h-3" />}
      </button>
      <button
        onClick={() => store.getState().addSpacer(nodeId)}
        title="Add a spacer (flexible empty cell)"
        className="text-purple-50/80 hover:text-white"
      >
        <SeparatorHorizontal className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().togglePanelUniform(nodeId)}
        title={uniform ? 'Uniform sizing ON — click for free sizing' : 'Uniform control sizing (equal size for every control here)'}
        className={uniform ? 'text-amber-200' : 'text-purple-50/80 hover:text-white'}
      >
        <Grid2x2 className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().togglePanelMirror(nodeId)}
        title={mirror ? 'Mirrored — click to un-mirror' : 'Mirror this panel (horizontal order, flip icons)'}
        className={mirror ? 'text-amber-200' : 'text-purple-50/80 hover:text-white'}
      >
        <FlipHorizontal className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().splitPanel(nodeId, 'row')}
        title="Add a panel to the right (split into columns)"
        className="text-purple-50/80 hover:text-white"
      >
        <SplitSquareHorizontal className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().splitPanel(nodeId, 'column')}
        title="Add a panel below (split into rows)"
        className="text-purple-50/80 hover:text-white"
      >
        <SplitSquareVertical className="w-3 h-3" />
      </button>
      {absorbId && (
        <button
          onClick={() => store.getState().fillAdjacent(nodeId)}
          onMouseEnter={() => store.getState().setHighlight(absorbId)}
          onMouseLeave={() => store.getState().setHighlight(null)}
          title="Fill — absorb the adjacent empty gap into this panel"
          className="text-cyan-200/90 hover:text-cyan-100"
        >
          <Combine className="w-3 h-3" />
        </button>
      )}
      {companionId && (
        <button
          onClick={() => store.getState().mirrorToCompanion(nodeId)}
          onMouseEnter={() => store.getState().setHighlight(companionId)}
          onMouseLeave={() => store.getState().setHighlight(null)}
          title="Sync: mirror this panel's size, padding, margins and shapes onto its symmetric companion"
          className="text-amber-200/90 hover:text-amber-100"
        >
          <Link2 className="w-3 h-3" />
        </button>
      )}
      {onAddControl && (
        <button
          onClick={onAddControl}
          title="Add a control bound to the backend (knob / fader / toggle / pad / visualizer)"
          className="text-emerald-200/90 hover:text-emerald-100"
        >
          <CirclePlus className="w-3 h-3" />
        </button>
      )}
      <button
        onClick={() => store.getState().removePanel(nodeId)}
        title="Remove this panel (its controls return to the palette)"
        className="text-rose-200/90 hover:text-rose-100"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
};

export const SurfacePanel: React.FC<{ nodeId: NodeId }> = ({ nodeId }) => {
  const { store, surfaceId, registry, openMenu } = useSurface();
  const node = store((s) => s.layout.nodes[nodeId]) as PanelNode | undefined;
  const design = store((s) => s.designMode);
  const companionId = store((s) => companionOf(s.layout.nodes, nodeId));
  const absorbId = store((s) => absorbableSibling(s.layout.nodes, nodeId));
  const highlighted = store((s) => s.highlightId === nodeId);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodySize, setBodySize] = useState({ w: 0, h: 0 });
  const [dockEdge, setDockEdge] = useState<EdgeDir | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBodySize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!node || node.type !== 'panel') return null;
  const pinnedDef = node.pinned ? registry[node.pinned] : null;
  const isPinned = !!node.pinned;
  const padPx = node.padPx ?? 0;

  // Frames live on REGION CONTAINERS now, so leaf widget panels are transparent
  // (controls float on the region's background). Pinned panels host their own
  // card. In Design Mode a faint dashed outline keeps each panel grabbable.
  const chrome = isPinned
    ? 'bg-transparent'
    : node.bgFill
      ? `rounded bg-(--panel) border ${design ? 'border-purple-400/40' : 'border-(--panel-border)'}`
      : design
        ? 'rounded border border-dashed border-purple-400/30'
        : 'bg-transparent';
  // Pinned panels host scrollable components and must clip; widget panels stay
  // overflow-visible so a control's bulging readout/number can spill into the
  // (empty) gap instead of being clipped at the panel edge.
  const clip = isPinned ? 'overflow-hidden' : 'overflow-visible';

  // Mirror reverses horizontal widget order; vertical stacks keep their
  // declared top-to-bottom order (for controls such as HI/MID/LO EQ bands).
  // The true store index is still passed to each cell so drag-reorder + resize
  // stay correct.
  const widgets = node.widgets;
  const displayIds = node.mirror && node.flow === 'row' ? [...widgets].reverse() : widgets;

  // Which edge a dragged panel/row is hovering, for directional docking.
  const computeEdge = (e: React.DragEvent): EdgeDir => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    const dL = x, dR = 1 - x, dT = y, dB = 1 - y;
    const m = Math.min(dL, dR, dT, dB);
    return m === dL ? 'left' : m === dR ? 'right' : m === dT ? 'top' : 'bottom';
  };

  return (
    <div
      className={`relative h-full w-full min-h-0 min-w-0 flex flex-col ${clip} ${chrome} ${highlighted ? 'ring-2 ring-amber-300/70 shadow-[0_0_12px_rgba(252,211,77,0.5)]' : ''}`}
      onContextMenu={design ? (e) => { e.stopPropagation(); openMenu(e, { kind: 'panel', nodeId }); } : undefined}
      onPointerEnter={design ? () => store.getState().setHoverNode(nodeId) : undefined}
      onPointerLeave={design ? () => { if (store.getState().hoverNodeId === nodeId) store.getState().setHoverNode(null); } : undefined}
      onDragOver={design ? (e) => { if (!e.dataTransfer.types.includes(PANEL_MIME)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDockEdge(computeEdge(e)); } : undefined}
      onDragLeave={design ? (e) => { e.stopPropagation(); setDockEdge(null); } : undefined}
      onDrop={design ? (e) => { if (!e.dataTransfer.types.includes(PANEL_MIME)) return; const p = decodePanel(e.dataTransfer.getData(PANEL_MIME)); const edge = computeEdge(e); setDockEdge(null); if (!p || p.surfaceId !== surfaceId) return; e.preventDefault(); e.stopPropagation(); store.getState().dockNode(p.panelId, nodeId, edge); } : undefined}
    >
      {design && <PanelHeader nodeId={nodeId} title={node.title} mirror={!!node.mirror} uniform={!!node.uniform} flow={node.flow} padPx={padPx} surfaceId={surfaceId} store={store} companionId={companionId} absorbId={absorbId} onAddControl={isPinned ? undefined : () => setAddOpen(true)} />}
      {addOpen && <AddControlModal panelId={nodeId} onClose={() => setAddOpen(false)} />}

      <div
        ref={bodyRef}
        className="relative flex-1 min-h-0 min-w-0 flex"
        style={{ padding: padPx }}
        onDragOver={
          design && !isPinned
            ? (e) => {
                if (!e.dataTransfer.types.includes(WIDGET_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            : undefined
        }
        onDrop={
          design && !isPinned
            ? (e) => {
                if (!e.dataTransfer.types.includes(WIDGET_MIME)) return;
                const p = decodeWidget(e.dataTransfer.getData(WIDGET_MIME));
                if (!p || p.surfaceId !== surfaceId) return;
                e.preventDefault();
                store.getState().moveWidget(p.widgetId, nodeId, node.widgets.length);
              }
            : undefined
        }
      >
        {pinnedDef ? (
          <div className="flex-1 min-h-0 min-w-0">{pinnedDef.render(bodySize)}</div>
        ) : widgets.length === 0 ? (
          <div className="flex-1 grid place-items-center">
            <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest">
              {design ? 'drop controls here' : ''}
            </span>
          </div>
        ) : (
          <FrGrid
            axis={node.flow}
            ids={displayIds}
            fr={node.uniform ? {} : (node.widgetFr ?? {})}
            design={design}
            gap={4}
            className="flex-1 min-h-0 min-w-0"
            onResize={(l, r, frac) => store.getState().resizeWidget(nodeId, l, r, frac)}
            renderItem={(wid) => (
              <WidgetCell
                widgetId={wid}
                panelId={nodeId}
                index={widgets.indexOf(wid)}
                design={design}
                justify={node.widgetJustify?.[wid]}
                mirror={node.mirror}
                uniform={node.uniform}
                shape={node.widgetShapes?.[wid]}
                flow={node.flow}
                margins={node.widgetMargins?.[wid]}
              />
            )}
          />
        )}
      </div>
      {design && dockEdge && (
        <div
          className={`pointer-events-none absolute z-50 bg-cyan-400/80 rounded ${
            dockEdge === 'left'
              ? 'left-0 top-0 bottom-0 w-1'
              : dockEdge === 'right'
                ? 'right-0 top-0 bottom-0 w-1'
                : dockEdge === 'top'
                  ? 'top-0 left-0 right-0 h-1'
                  : 'bottom-0 left-0 right-0 h-1'
          }`}
        />
      )}
    </div>
  );
};
