import { create, type StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WidgetId, CustomWidgetDef, ButtonShape, FrameShape } from '../components/surface/widgetTypes';

/* Generic, data-driven control-surface layout.
 *
 * A surface is a TREE of containers (row | column) whose leaves are PANELS, and
 * each panel holds an ordered list of placed widget ids. The tree is stored as
 * a FLAT id-keyed `nodes` map so every reducer is an O(1) map update with no
 * recursive cloning — the tree is reconstructed by walking root → children.
 *
 * Design Mode lets the user drag splitters to RESIZE siblings, drag panel
 * headers to MOVE/reorder panels across containers, drag individual widgets
 * between panels, add/remove panels, and split a panel into a row/column. The
 * layout persists per-surface (localStorage `thedaw.surface.<id>.v1`); a
 * `merge`/`version` guard falls back to the default on schema mismatch or
 * corruption, and an auto-prune keeps the tree minimal (no empty/▢single-child
 * containers) so the grid is always valid and nothing overlaps.
 *
 * This supersedes the DJ-only `djLayoutStore` + `DesignLayout`; the DJ tab is
 * the first consumer via `createLayoutStore('dj', defaultDjLayout)`. */

export type NodeId = string;
export type Axis = 'row' | 'column';
/** A directional dock target relative to a node. */
export type EdgeDir = 'left' | 'right' | 'top' | 'bottom';
/** Widget ids beginning with this prefix are flexible empty spacers (not in any
 *  tab registry); they render blank and only push other controls around. */
export const SPACER_PREFIX = 'spacer:';
export const isSpacer = (id: string) => id.startsWith(SPACER_PREFIX);

export interface ContainerNode {
  id: NodeId;
  type: 'container';
  axis: Axis;
  /** Ordered child node ids (containers or panels). */
  children: NodeId[];
  /** fr weight per child id (relative track size). */
  fr: Record<NodeId, number>;
  /** Draw a region frame (border + filled background spanning the whole cell)
   *  around this container. Borders live on framed REGION containers, not on
   *  every leaf panel, so a region reads as one box instead of many. */
  framed?: boolean;
  /** Framed-region styling: an outline shape, an accent tint (hue 0..1), a glow
   *  toggle, and an optional label tab. Only meaningful when `framed`. */
  frameShape?: FrameShape;
  frameTint?: number;
  frameGlow?: boolean;
  frameTitle?: string;
  /** Paint a filled panel background over the whole cell (the contextual
   *  "fill" affordance, bg mode) so interior dead space isn't bare black. */
  bgFill?: boolean;
}

export interface PanelNode {
  id: NodeId;
  type: 'panel';
  title: string;
  /** Ordered placed widget ids. */
  widgets: WidgetId[];
  /** Inner flow of the placed widgets. */
  flow: Axis;
  /** Optional fr weight per placed widget (equal when absent). */
  widgetFr?: Record<WidgetId, number>;
  /** Per-widget content alignment within its cell (center when absent). */
  widgetJustify?: Record<WidgetId, 'start' | 'center' | 'end'>;
  /** Per-widget four-side margins in px (top/right/bottom/left). */
  widgetMargins?: Record<WidgetId, { t: number; r: number; b: number; l: number }>;
  /** Per-widget pad/button shape override. */
  widgetShapes?: Record<WidgetId, ButtonShape>;
  /** Mirror this panel: reverse horizontal widget order + flip composite
   *  controls/icons (left/right deck symmetry). */
  mirror?: boolean;
  /** Uniform control sizing: match same-kind control sizes (fill + equalize)
   *  within this panel. */
  uniform?: boolean;
  /** Paint a filled background over the whole cell (contextual "fill", bg mode). */
  bgFill?: boolean;
  /** Inner padding (px) between the panel border and its controls. */
  padPx?: number;
  /** Fixed-content panel: hosts ONE widget full-bleed, no widget DnD, hidden
   *  from the palette (e.g. the library, the source tree). */
  pinned?: WidgetId | null;
  /** Optional fixed cross-axis size in px (used for bands). */
  fixedPx?: number | null;
}

export type LayoutNode = ContainerNode | PanelNode;

export interface SurfaceLayout {
  version: number;
  root: NodeId;
  nodes: Record<NodeId, LayoutNode>;
  /** User-created controls (Add-Control picker), keyed by their widget id. They
   *  persist with the layout and are rendered by `CustomControl`. */
  customWidgets?: Record<WidgetId, CustomWidgetDef>;
}

export const MIN_FR = 0.45;

/* ── id generation (runtime only; never used in persisted defaults) ───────── */
let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${idCounter}-${rnd}`;
}

/* ── pure helpers ─────────────────────────────────────────────────────────── */
export function cloneLayout(l: SurfaceLayout): SurfaceLayout {
  const nodes: Record<NodeId, LayoutNode> = {};
  for (const id in l.nodes) {
    const n = l.nodes[id];
    if (n.type === 'container') {
      nodes[id] = { ...n, children: [...n.children], fr: { ...n.fr } };
    } else {
      nodes[id] = {
        ...n,
        widgets: [...n.widgets],
        widgetFr: n.widgetFr ? { ...n.widgetFr } : undefined,
        widgetJustify: n.widgetJustify ? { ...n.widgetJustify } : undefined,
        widgetMargins: n.widgetMargins
          ? Object.fromEntries(Object.entries(n.widgetMargins).map(([k, v]) => [k, { ...v }]))
          : undefined,
        widgetShapes: n.widgetShapes ? { ...n.widgetShapes } : undefined,
      };
    }
  }
  const customWidgets = l.customWidgets
    ? Object.fromEntries(Object.entries(l.customWidgets).map(([k, v]) => [k, { ...v }]))
    : undefined;
  return { version: l.version, root: l.root, nodes, customWidgets };
}

export function findParentId(nodes: Record<NodeId, LayoutNode>, childId: NodeId): NodeId | null {
  for (const id in nodes) {
    const n = nodes[id];
    if (n.type === 'container' && n.children.includes(childId)) return id;
  }
  return null;
}

function findPanelOfWidget(nodes: Record<NodeId, LayoutNode>, widgetId: WidgetId): NodeId | null {
  for (const id in nodes) {
    const n = nodes[id];
    if (n.type === 'panel' && n.widgets.includes(widgetId)) return id;
  }
  return null;
}

/** True if `nodeId` is `ancestorId` or lives anywhere in its subtree. Used to
 *  stop a container being docked into itself (which would cycle the tree). */
function isDescendant(nodes: Record<NodeId, LayoutNode>, ancestorId: NodeId, nodeId: NodeId): boolean {
  if (ancestorId === nodeId) return true;
  const a = nodes[ancestorId];
  if (!a || a.type !== 'container') return false;
  return a.children.some((c) => isDescendant(nodes, c, nodeId));
}

/** The mirror-companion of a node id by swapping the A↔B deck token
 *  (pdA-trans↔pdB-trans, eqAP↔eqBP, deckAcont↔deckBcont, fxAP↔fxBP, …). Returns
 *  null when no such sibling exists — ids without an uppercase A/B token (rails,
 *  spacer wrappers, `cont-*`) have no companion, so the user's asymmetric
 *  wrappers are never touched. */
export function companionOf(nodes: Record<NodeId, LayoutNode>, id: NodeId): NodeId | null {
  const cands: string[] = [];
  if (id.includes('A')) cands.push(id.replace('A', 'B'));
  if (id.includes('B')) cands.push(id.replace('B', 'A'));
  for (const c of cands) if (c !== id && nodes[c]) return c;
  return null;
}

/** A panel is "empty" (absorbable dead space) when it's not pinned and holds
 *  only spacers / nothing. The deck wrappers' `panel-N` spacer panels qualify. */
function isEmptyPanel(n: LayoutNode | undefined): boolean {
  return !!n && n.type === 'panel' && !n.pinned && n.widgets.every((w) => isSpacer(w));
}

/** An immediate sibling of `nodeId` (in its parent container) that is an empty
 *  panel — i.e. a black gap this node could absorb. Null when none. */
export function absorbableSibling(nodes: Record<NodeId, LayoutNode>, nodeId: NodeId): NodeId | null {
  if (isEmptyPanel(nodes[nodeId])) return null; // the gap itself never absorbs
  const parentId = findParentId(nodes, nodeId);
  if (!parentId) return null;
  const parent = nodes[parentId];
  if (!parent || parent.type !== 'container') return null;
  const i = parent.children.indexOf(nodeId);
  for (const sib of [parent.children[i - 1], parent.children[i + 1]]) {
    if (sib && isEmptyPanel(nodes[sib])) return sib;
  }
  return null;
}

const MIRROR_SHAPE: Partial<Record<ButtonShape, ButtonShape>> = {
  'tri-tl': 'tri-tr',
  'tri-tr': 'tri-tl',
  'tri-bl': 'tri-br',
  'tri-br': 'tri-bl',
};

/** Copy size/padding/margins/shapes from src → dst as a horizontal MIRROR
 *  (margins l↔r swapped, triangle shapes flipped, dst.mirror inverted). Panels
 *  copy per-widget data BY POSITION (companions hold different widget ids);
 *  containers copy fr by position only when child counts match (no deep recurse,
 *  so asymmetric subtrees are safe). Mutates `layout` in place. */
function mirrorNode(layout: SurfaceLayout, srcId: NodeId, dstId: NodeId): void {
  const a = layout.nodes[srcId];
  const b = layout.nodes[dstId];
  if (!a || !b || a.type !== b.type) return;
  if (a.type === 'panel' && b.type === 'panel') {
    b.padPx = a.padPx;
    b.uniform = a.uniform;
    b.flow = a.flow;
    b.mirror = !a.mirror;
    const n = Math.min(a.widgets.length, b.widgets.length);
    const fr: Record<WidgetId, number> = {};
    const mg: Record<WidgetId, { t: number; r: number; b: number; l: number }> = {};
    const sh: Record<WidgetId, ButtonShape> = {};
    for (let i = 0; i < n; i++) {
      const aw = a.widgets[i];
      const bw = b.widgets[i];
      const af = a.widgetFr?.[aw];
      if (af != null) fr[bw] = af;
      const am = a.widgetMargins?.[aw];
      if (am) mg[bw] = { t: am.t, r: am.l, b: am.b, l: am.r };
      const as = a.widgetShapes?.[aw];
      if (as) sh[bw] = MIRROR_SHAPE[as] ?? as;
    }
    b.widgetFr = Object.keys(fr).length ? fr : undefined;
    b.widgetMargins = Object.keys(mg).length ? mg : undefined;
    b.widgetShapes = Object.keys(sh).length ? sh : undefined;
  } else if (a.type === 'container' && b.type === 'container' && a.children.length === b.children.length) {
    const fr: Record<NodeId, number> = {};
    a.children.forEach((ac, i) => {
      fr[b.children[i]] = a.fr[ac] ?? 1;
    });
    b.fr = fr;
  }
}

/** Every widget id currently placed in (or pinned to) a panel. */
export function collectPlacedWidgets(layout: SurfaceLayout): Set<WidgetId> {
  const set = new Set<WidgetId>();
  for (const id in layout.nodes) {
    const n = layout.nodes[id];
    if (n.type === 'panel') {
      n.widgets.forEach((w) => set.add(w));
      if (n.pinned) set.add(n.pinned);
    }
  }
  return set;
}

function medianFr(c: ContainerNode): number {
  const vals = c.children.map((id) => c.fr[id] ?? 1).sort((a, b) => a - b);
  if (!vals.length) return 1;
  return vals[Math.floor(vals.length / 2)];
}

/** Remove empty containers and dissolve single-child containers; drop dangling
 *  refs; re-normalize fr. Keeps the tree minimal and the grid always valid. */
function prune(l: SurfaceLayout): SurfaceLayout {
  for (let guard = 0; guard < 500; guard++) {
    let mutated = false;
    for (const id of Object.keys(l.nodes)) {
      const n = l.nodes[id];
      if (!n || n.type !== 'container' || id === l.root) continue;

      const valid = n.children.filter((c) => l.nodes[c]);
      if (valid.length !== n.children.length) {
        n.children = valid;
        mutated = true;
        break;
      }
      const parentId = findParentId(l.nodes, id);
      if (!parentId) continue;
      const parent = l.nodes[parentId] as ContainerNode;

      if (n.children.length === 0) {
        parent.children = parent.children.filter((c) => c !== id);
        delete parent.fr[id];
        delete l.nodes[id];
        mutated = true;
        break;
      }
      if (n.children.length === 1) {
        const only = n.children[0];
        const idx = parent.children.indexOf(id);
        parent.children[idx] = only;
        parent.fr[only] = parent.fr[id] ?? 1;
        delete parent.fr[id];
        delete l.nodes[id];
        mutated = true;
        break;
      }
    }
    const root = l.nodes[l.root];
    if (root && root.type === 'container') {
      const valid = root.children.filter((c) => l.nodes[c]);
      if (valid.length !== root.children.length) {
        root.children = valid;
        mutated = true;
      }
    }
    if (!mutated) break;
  }
  return l;
}

/** Move/reorder a widget into a panel at `toIndex`, removing it from wherever it
 *  currently lives. `toIndex` is interpreted against the target panel WITHOUT
 *  the dragged widget, so within-panel reordering is off-by-one safe. */
function internalMove(layout: SurfaceLayout, widgetId: WidgetId, toPanelId: NodeId, toIndex: number): void {
  const target = layout.nodes[toPanelId];
  if (!target || target.type !== 'panel' || target.pinned) return;
  const fromId = findPanelOfWidget(layout.nodes, widgetId);
  if (fromId && fromId !== toPanelId) {
    const from = layout.nodes[fromId] as PanelNode;
    from.widgets = from.widgets.filter((w) => w !== widgetId);
  }
  const without = target.widgets.filter((w) => w !== widgetId);
  const idx = Math.max(0, Math.min(toIndex, without.length));
  without.splice(idx, 0, widgetId);
  target.widgets = without;
}

/* ── store ────────────────────────────────────────────────────────────────── */
export interface SurfaceStore {
  designMode: boolean;
  layout: SurfaceLayout;
  /** Undo/redo history of layout snapshots (session-only, never persisted). */
  past: SurfaceLayout[];
  future: SurfaceLayout[];
  /** Node to softly glow (its symmetric companion when hovering a Sync button);
   *  session-only, never persisted. */
  highlightId: NodeId | null;
  /** Node the cursor is over (target for design-mode hotkeys); session-only. */
  hoverNodeId: NodeId | null;

  setDesignMode: (v: boolean) => void;
  setHighlight: (id: NodeId | null) => void;
  setHoverNode: (id: NodeId | null) => void;

  /** Mirror size/padding/margins/shapes from a node onto its A↔B companion. */
  mirrorToCompanion: (id: NodeId) => void;
  /** Symmetrize every container's track sizes (palindromic fr) so the layout is
   *  balanced around its centre — "centre the hero". */
  centerHero: () => void;
  /** Make the other side follow the preferred side: mirror every A↔B companion
   *  panel from `side` onto its counterpart, layout-wide. */
  mirrorSide: (side: 'left' | 'right') => void;

  /** Step layout history (Ctrl+Z / Ctrl+Shift+Z). No-op at the ends. */
  undo: () => void;
  redo: () => void;
  /** Persist the current layout as this surface's reset target (Ctrl+S). */
  saveAsDefault: () => void;

  resize: (containerId: NodeId, leftId: NodeId, rightId: NodeId, frac: number) => void;
  resizeWidget: (panelId: NodeId, left: WidgetId, right: WidgetId, frac: number) => void;

  moveWidget: (widgetId: WidgetId, toPanelId: NodeId, toIndex: number) => void;
  placeWidget: (widgetId: WidgetId, toPanelId: NodeId, toIndex: number) => void;
  removeWidget: (widgetId: WidgetId) => void;
  /** Create a user-defined control and place it in a panel. Returns its id. */
  addCustomWidget: (panelId: NodeId, def: Omit<CustomWidgetDef, 'id'>) => WidgetId;
  /** Patch an existing custom control's definition (label/kind/tint/target). */
  updateCustomWidget: (id: WidgetId, patch: Partial<Omit<CustomWidgetDef, 'id'>>) => void;

  addPanel: (containerId: NodeId, atIndex: number, title?: string) => NodeId;
  removePanel: (panelId: NodeId) => void;
  renamePanel: (panelId: NodeId, title: string) => void;
  reorderPanel: (panelId: NodeId, toContainerId: NodeId, toIndex: number) => void;
  togglePanelMirror: (panelId: NodeId) => void;
  togglePanelFlow: (panelId: NodeId) => void;
  /** Flip a container between a row and a column (flow at every nesting level). */
  toggleContainerAxis: (containerId: NodeId) => void;
  /** Toggle a region frame (border + filled bg) on a container. */
  toggleContainerFramed: (containerId: NodeId) => void;
  /** Patch a framed region's outline shape / tint / glow / title. */
  setContainerFrame: (containerId: NodeId, patch: Partial<Pick<ContainerNode, 'frameShape' | 'frameTint' | 'frameGlow' | 'frameTitle'>>) => void;
  /** Toggle uniform control sizing on a panel. */
  togglePanelUniform: (panelId: NodeId) => void;
  /** Absorb an adjacent empty/spacer sibling into this node (eat the gap). */
  fillAdjacent: (nodeId: NodeId) => void;
  /** Toggle a filled background on a node (bg-fill mode of the fill affordance). */
  toggleBgFill: (nodeId: NodeId) => void;
  setPanelPad: (panelId: NodeId, px: number) => void;
  cycleWidgetJustify: (panelId: NodeId, widgetId: WidgetId) => void;
  setWidgetMargin: (panelId: NodeId, widgetId: WidgetId, side: 't' | 'r' | 'b' | 'l', px: number) => void;
  /** Set the pad/button shape for a placed widget. */
  setWidgetShape: (panelId: NodeId, widgetId: WidgetId, shape: ButtonShape) => void;
  /** Insert a flexible empty spacer into a panel. Returns the spacer id. */
  addSpacer: (panelId: NodeId) => NodeId;
  /** Dock a panel/container to an edge of a target node, creating the row or
   *  column structure as needed (directional drag-drop). */
  dockNode: (draggedId: NodeId, targetId: NodeId, edge: EdgeDir) => void;

  addContainer: (parentId: NodeId, axis: Axis, atIndex: number) => NodeId;
  splitPanel: (panelId: NodeId, axis: Axis) => NodeId;
  removeContainer: (containerId: NodeId) => void;

  reset: () => void;
  exportJSON: () => string;
}

/* ── undo/redo history ────────────────────────────────────────────────────── */
const HISTORY_LIMIT = 60;
// Consecutive layout changes closer together than this collapse into ONE undo
// step, so a continuous splitter/margin drag (which fires many mutations) is a
// single undo rather than dozens.
const COALESCE_MS = 350;

/** The store's own actions, minus the history fields the middleware injects. */
type BaseStore = Omit<SurfaceStore, 'past' | 'future' | 'undo' | 'redo'>;

/* A tiny history middleware: it wraps `set` so every action that changes
 * `layout` snapshots the PREVIOUS layout into `past` (coalescing rapid drags)
 * and clears `future`. `undo`/`redo` use the raw `set` so they don't record
 * themselves. This needs zero changes to the ~20 existing actions. */
type AnySet = (partial: unknown, replace?: boolean) => void;
type SurfacePersist = [['zustand/persist', { layout: SurfaceLayout }]];
const withHistory =
  (config: (set: AnySet, get: () => SurfaceStore, api: unknown) => BaseStore): StateCreator<SurfaceStore, [], SurfacePersist> =>
  (set, get, api) => {
    const rawSet = set as unknown as AnySet;
    let lastPush = 0;
    const recordingSet: AnySet = (partial, replace) => {
      const prev = get().layout;
      rawSet(partial, replace);
      const next = get().layout;
      if (next !== prev) {
        const now = Date.now();
        if (now - lastPush > COALESCE_MS) {
          rawSet({ past: [...get().past, prev].slice(-HISTORY_LIMIT), future: [] });
        }
        lastPush = now;
      }
    };
    return {
      ...config(recordingSet, get, api),
      past: [],
      future: [],
      undo: () => {
        const { past, future, layout } = get();
        if (!past.length) return;
        rawSet({
          layout: past[past.length - 1],
          past: past.slice(0, -1),
          future: [layout, ...future].slice(0, HISTORY_LIMIT),
        });
      },
      redo: () => {
        const { past, future, layout } = get();
        if (!future.length) return;
        rawSet({
          layout: future[0],
          past: [...past, layout].slice(-HISTORY_LIMIT),
          future: future.slice(1),
        });
      },
    };
  };

export function createLayoutStore(surfaceId: string, defaultLayout: SurfaceLayout) {
  // A user "Save as default" target, separate from the live persisted layout.
  // Versioned so a default-tree bump invalidates a stale saved default.
  const defaultKey = `thedaw.surface.${surfaceId}.default.v${defaultLayout.version}`;
  const readUserDefault = (): SurfaceLayout | null => {
    try {
      const raw = localStorage.getItem(defaultKey);
      if (!raw) return null;
      const l = JSON.parse(raw) as SurfaceLayout;
      if (l && l.nodes && l.root && l.nodes[l.root] && l.version === defaultLayout.version) return l;
    } catch {
      /* ignore corrupt saved default */
    }
    return null;
  };

  return create<SurfaceStore>()(
    persist(
      withHistory((set, get) => ({
        designMode: false,
        layout: cloneLayout(defaultLayout),
        highlightId: null,
        hoverNodeId: null,

        setDesignMode: (v) => set({ designMode: v }),
        setHighlight: (id) => set({ highlightId: id }),
        setHoverNode: (id) => set({ hoverNodeId: id }),

        mirrorToCompanion: (id) =>
          set((s) => {
            const dst = companionOf(s.layout.nodes, id);
            if (!dst) return s;
            const layout = cloneLayout(s.layout);
            mirrorNode(layout, id, dst);
            return { layout };
          }),

        centerHero: () =>
          set((s) => {
            const layout = cloneLayout(s.layout);
            for (const nid in layout.nodes) {
              const n = layout.nodes[nid];
              if (n.type !== 'container') continue;
              const ids = n.children;
              const len = ids.length;
              for (let i = 0; i < Math.floor(len / 2); i++) {
                const j = len - 1 - i;
                const avg = ((n.fr[ids[i]] ?? 1) + (n.fr[ids[j]] ?? 1)) / 2;
                n.fr[ids[i]] = avg;
                n.fr[ids[j]] = avg;
              }
            }
            return { layout };
          }),

        mirrorSide: (side) =>
          set((s) => {
            const layout = cloneLayout(s.layout);
            for (const id of Object.keys(layout.nodes)) {
              const comp = companionOf(layout.nodes, id);
              if (!comp) continue;
              const isA = id.includes('A') && id.replace('A', 'B') === comp;
              const isB = id.includes('B') && id.replace('B', 'A') === comp;
              if (side === 'left' ? isA : isB) mirrorNode(layout, id, comp);
            }
            return { layout };
          }),

        resize: (containerId, leftId, rightId, frac) =>
          set((s) => {
            const node = s.layout.nodes[containerId];
            if (!node || node.type !== 'container') return s;
            const total = node.children.reduce((a, id) => a + (node.fr[id] ?? 1), 0);
            const d = frac * total;
            const l0 = (node.fr[leftId] ?? 1) + d;
            const r0 = (node.fr[rightId] ?? 1) - d;
            if (l0 < MIN_FR || r0 < MIN_FR) return s;
            const layout = cloneLayout(s.layout);
            const c = layout.nodes[containerId] as ContainerNode;
            c.fr[leftId] = l0;
            c.fr[rightId] = r0;
            return { layout };
          }),

        resizeWidget: (panelId, left, right, frac) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const fr = node.widgetFr ?? {};
            const total = node.widgets.reduce((a, id) => a + (fr[id] ?? 1), 0);
            const d = frac * total;
            const l0 = (fr[left] ?? 1) + d;
            const r0 = (fr[right] ?? 1) - d;
            if (l0 < MIN_FR || r0 < MIN_FR) return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[panelId] as PanelNode;
            const wf = { ...(p.widgetFr ?? {}) };
            for (const id of p.widgets) if (wf[id] == null) wf[id] = 1;
            wf[left] = l0;
            wf[right] = r0;
            p.widgetFr = wf;
            return { layout };
          }),

        moveWidget: (widgetId, toPanelId, toIndex) =>
          set((s) => {
            const layout = cloneLayout(s.layout);
            internalMove(layout, widgetId, toPanelId, toIndex);
            return { layout };
          }),

        placeWidget: (widgetId, toPanelId, toIndex) =>
          set((s) => {
            const layout = cloneLayout(s.layout);
            internalMove(layout, widgetId, toPanelId, toIndex);
            return { layout };
          }),

        removeWidget: (widgetId) =>
          set((s) => {
            const fromId = findPanelOfWidget(s.layout.nodes, widgetId);
            const layout = cloneLayout(s.layout);
            if (fromId) {
              const from = layout.nodes[fromId] as PanelNode;
              from.widgets = from.widgets.filter((w) => w !== widgetId);
              if (from.widgetFr) delete from.widgetFr[widgetId];
            }
            // A removed custom control is gone for good (not returned to a
            // palette — its definition lived only here).
            if (layout.customWidgets && layout.customWidgets[widgetId]) {
              const cw = { ...layout.customWidgets };
              delete cw[widgetId];
              layout.customWidgets = cw;
            } else if (!fromId) {
              return s;
            }
            return { layout };
          }),

        addCustomWidget: (panelId, def) => {
          let id = '';
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel' || node.pinned) return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[panelId] as PanelNode;
            id = newId('custom');
            layout.customWidgets = { ...(layout.customWidgets ?? {}), [id]: { ...def, id } };
            p.widgets = [...p.widgets, id];
            return { layout };
          });
          return id;
        },

        updateCustomWidget: (id, patch) =>
          set((s) => {
            const cur = s.layout.customWidgets?.[id];
            if (!cur) return s;
            const layout = cloneLayout(s.layout);
            layout.customWidgets = { ...(layout.customWidgets ?? {}), [id]: { ...cur, ...patch, id } };
            return { layout };
          }),

        addPanel: (containerId, atIndex, title) => {
          let newPanelId = '';
          set((s) => {
            const node = s.layout.nodes[containerId];
            if (!node || node.type !== 'container') return s;
            const layout = cloneLayout(s.layout);
            const c = layout.nodes[containerId] as ContainerNode;
            newPanelId = newId('panel');
            layout.nodes[newPanelId] = {
              id: newPanelId,
              type: 'panel',
              title: title ?? 'Panel',
              widgets: [],
              flow: 'row',
            };
            const idx = Math.max(0, Math.min(atIndex, c.children.length));
            c.children.splice(idx, 0, newPanelId);
            c.fr[newPanelId] = medianFr(c);
            return { layout };
          });
          return newPanelId;
        },

        removePanel: (panelId) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            const parentId = findParentId(layout.nodes, panelId);
            if (parentId) {
              const parent = layout.nodes[parentId] as ContainerNode;
              parent.children = parent.children.filter((c) => c !== panelId);
              delete parent.fr[panelId];
            }
            delete layout.nodes[panelId];
            return { layout: prune(layout) };
          }),

        renamePanel: (panelId, title) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            (layout.nodes[panelId] as PanelNode).title = title;
            return { layout };
          }),

        togglePanelMirror: (panelId) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[panelId] as PanelNode;
            p.mirror = !p.mirror;
            return { layout };
          }),

        togglePanelFlow: (panelId) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[panelId] as PanelNode;
            p.flow = p.flow === 'row' ? 'column' : 'row';
            return { layout };
          }),

        toggleContainerAxis: (containerId) =>
          set((s) => {
            const node = s.layout.nodes[containerId];
            if (!node || node.type !== 'container') return s;
            const layout = cloneLayout(s.layout);
            const c = layout.nodes[containerId] as ContainerNode;
            c.axis = c.axis === 'row' ? 'column' : 'row';
            return { layout };
          }),

        toggleContainerFramed: (containerId) =>
          set((s) => {
            const node = s.layout.nodes[containerId];
            if (!node || node.type !== 'container') return s;
            const layout = cloneLayout(s.layout);
            const c = layout.nodes[containerId] as ContainerNode;
            c.framed = !c.framed;
            return { layout };
          }),

        setContainerFrame: (containerId, patch) =>
          set((s) => {
            const node = s.layout.nodes[containerId];
            if (!node || node.type !== 'container') return s;
            const layout = cloneLayout(s.layout);
            Object.assign(layout.nodes[containerId] as ContainerNode, patch);
            return { layout };
          }),

        togglePanelUniform: (panelId) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[panelId] as PanelNode;
            p.uniform = !p.uniform;
            // Equalize fr so uniform sizing isn't fighting old per-widget weights.
            if (p.uniform) p.widgetFr = {};
            return { layout };
          }),

        fillAdjacent: (nodeId) =>
          set((s) => {
            const sib = absorbableSibling(s.layout.nodes, nodeId);
            const parentId = findParentId(s.layout.nodes, nodeId);
            if (!sib || !parentId) return s;
            const layout = cloneLayout(s.layout);
            const parent = layout.nodes[parentId] as ContainerNode;
            parent.fr[nodeId] = (parent.fr[nodeId] ?? 1) + (parent.fr[sib] ?? 1);
            parent.children = parent.children.filter((c) => c !== sib);
            delete parent.fr[sib];
            delete layout.nodes[sib];
            return { layout: prune(layout) };
          }),

        toggleBgFill: (nodeId) =>
          set((s) => {
            const node = s.layout.nodes[nodeId];
            if (!node) return s;
            const layout = cloneLayout(s.layout);
            layout.nodes[nodeId].bgFill = !layout.nodes[nodeId].bgFill;
            return { layout };
          }),

        addSpacer: (panelId) => {
          let spacerId = '';
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel' || node.pinned) return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[panelId] as PanelNode;
            spacerId = `${SPACER_PREFIX}${newId('s')}`;
            p.widgets = [...p.widgets, spacerId];
            return { layout };
          });
          return spacerId;
        },

        dockNode: (draggedId, targetId, edge) =>
          set((s) => {
            if (draggedId === targetId) return s;
            const dragged = s.layout.nodes[draggedId];
            const target = s.layout.nodes[targetId];
            if (!dragged || !target) return s;
            // never dock a container into its own subtree (would cycle)
            if (isDescendant(s.layout.nodes, draggedId, targetId)) return s;

            const layout = cloneLayout(s.layout);
            // detach dragged from its current parent
            const fromParentId = findParentId(layout.nodes, draggedId);
            let carriedFr = 1;
            if (fromParentId) {
              const fp = layout.nodes[fromParentId] as ContainerNode;
              carriedFr = fp.fr[draggedId] ?? 1;
              fp.children = fp.children.filter((c) => c !== draggedId);
              delete fp.fr[draggedId];
            }

            const wantAxis: Axis = edge === 'left' || edge === 'right' ? 'row' : 'column';
            const before = edge === 'left' || edge === 'top';
            const parentId = findParentId(layout.nodes, targetId);

            if (parentId) {
              const parent = layout.nodes[parentId] as ContainerNode;
              if (parent.axis === wantAxis) {
                const idx = parent.children.indexOf(targetId);
                parent.children.splice(before ? idx : idx + 1, 0, draggedId);
                parent.fr[draggedId] = parent.fr[targetId] ?? carriedFr;
              } else {
                const wrapId = newId('cont');
                const slotFr = parent.fr[targetId] ?? 1;
                const tIdx = parent.children.indexOf(targetId);
                parent.children[tIdx] = wrapId;
                delete parent.fr[targetId];
                parent.fr[wrapId] = slotFr;
                const kids = before ? [draggedId, targetId] : [targetId, draggedId];
                layout.nodes[wrapId] = { id: wrapId, type: 'container', axis: wantAxis, children: kids, fr: { [draggedId]: 1, [targetId]: 1 } };
              }
            } else {
              // target is the root → wrap it in a new root container
              const wrapId = newId('cont');
              const kids = before ? [draggedId, targetId] : [targetId, draggedId];
              layout.nodes[wrapId] = { id: wrapId, type: 'container', axis: wantAxis, children: kids, fr: { [draggedId]: 1, [targetId]: 1 } };
              layout.root = wrapId;
            }
            return { layout: prune(layout) };
          }),

        setPanelPad: (panelId, px) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            (layout.nodes[panelId] as PanelNode).padPx = Math.max(0, Math.min(Math.round(px), 48));
            return { layout };
          }),

        cycleWidgetJustify: (panelId, widgetId) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[panelId] as PanelNode;
            const order: Array<'start' | 'center' | 'end'> = ['center', 'start', 'end'];
            const cur = p.widgetJustify?.[widgetId] ?? 'center';
            const next = order[(order.indexOf(cur) + 1) % order.length];
            p.widgetJustify = { ...(p.widgetJustify ?? {}), [widgetId]: next };
            return { layout };
          }),

        setWidgetMargin: (panelId, widgetId, side, px) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[panelId] as PanelNode;
            const m = { ...(p.widgetMargins ?? {}) };
            const cur = m[widgetId] ?? { t: 0, r: 0, b: 0, l: 0 };
            m[widgetId] = { ...cur, [side]: Math.max(0, Math.min(Math.round(px), 64)) };
            p.widgetMargins = m;
            return { layout };
          }),

        setWidgetShape: (panelId, widgetId, shape) =>
          set((s) => {
            const node = s.layout.nodes[panelId];
            if (!node || node.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[panelId] as PanelNode;
            p.widgetShapes = { ...(p.widgetShapes ?? {}), [widgetId]: shape };
            return { layout };
          }),

        reorderPanel: (panelId, toContainerId, toIndex) =>
          set((s) => {
            const panel = s.layout.nodes[panelId];
            const target = s.layout.nodes[toContainerId];
            if (!panel || panel.type !== 'panel' || !target || target.type !== 'container') return s;
            const layout = cloneLayout(s.layout);
            const fromParentId = findParentId(layout.nodes, panelId);
            let carriedFr = 1;
            if (fromParentId) {
              const fromParent = layout.nodes[fromParentId] as ContainerNode;
              carriedFr = fromParent.fr[panelId] ?? 1;
              fromParent.children = fromParent.children.filter((c) => c !== panelId);
              delete fromParent.fr[panelId];
            }
            const tgt = layout.nodes[toContainerId] as ContainerNode;
            const without = tgt.children.filter((c) => c !== panelId);
            const idx = Math.max(0, Math.min(toIndex, without.length));
            without.splice(idx, 0, panelId);
            tgt.children = without;
            tgt.fr[panelId] = carriedFr;
            return { layout: prune(layout) };
          }),

        addContainer: (parentId, axis, atIndex) => {
          let newContainerId = '';
          set((s) => {
            const parent = s.layout.nodes[parentId];
            if (!parent || parent.type !== 'container') return s;
            const layout = cloneLayout(s.layout);
            const p = layout.nodes[parentId] as ContainerNode;
            newContainerId = newId('cont');
            const panelId = newId('panel');
            layout.nodes[panelId] = { id: panelId, type: 'panel', title: 'Panel', widgets: [], flow: 'row' };
            layout.nodes[newContainerId] = {
              id: newContainerId,
              type: 'container',
              axis,
              children: [panelId],
              fr: { [panelId]: 1 },
            };
            const idx = Math.max(0, Math.min(atIndex, p.children.length));
            p.children.splice(idx, 0, newContainerId);
            p.fr[newContainerId] = medianFr(p);
            return { layout };
          });
          return newContainerId;
        },

        splitPanel: (panelId, axis) => {
          let siblingId = '';
          set((s) => {
            const panel = s.layout.nodes[panelId];
            if (!panel || panel.type !== 'panel') return s;
            const layout = cloneLayout(s.layout);
            const parentId = findParentId(layout.nodes, panelId);
            siblingId = newId('panel');
            layout.nodes[siblingId] = { id: siblingId, type: 'panel', title: 'Panel', widgets: [], flow: 'row' };
            if (parentId) {
              const parent = layout.nodes[parentId] as ContainerNode;
              if (parent.axis === axis) {
                const idx = parent.children.indexOf(panelId);
                parent.children.splice(idx + 1, 0, siblingId);
                parent.fr[siblingId] = parent.fr[panelId] ?? 1;
              } else {
                const wrapId = newId('cont');
                const slotFr = parent.fr[panelId] ?? 1;
                const idx = parent.children.indexOf(panelId);
                parent.children[idx] = wrapId;
                delete parent.fr[panelId];
                parent.fr[wrapId] = slotFr;
                layout.nodes[wrapId] = {
                  id: wrapId,
                  type: 'container',
                  axis,
                  children: [panelId, siblingId],
                  fr: { [panelId]: 1, [siblingId]: 1 },
                };
              }
            } else {
              const wrapId = newId('cont');
              layout.nodes[wrapId] = {
                id: wrapId,
                type: 'container',
                axis,
                children: [panelId, siblingId],
                fr: { [panelId]: 1, [siblingId]: 1 },
              };
              layout.root = wrapId;
            }
            return { layout };
          });
          return siblingId;
        },

        removeContainer: (containerId) =>
          set((s) => {
            const node = s.layout.nodes[containerId];
            if (!node || node.type !== 'container' || containerId === s.layout.root) return s;
            const layout = cloneLayout(s.layout);
            const parentId = findParentId(layout.nodes, containerId);
            if (parentId) {
              const parent = layout.nodes[parentId] as ContainerNode;
              parent.children = parent.children.filter((c) => c !== containerId);
              delete parent.fr[containerId];
            }
            const stack = [containerId];
            while (stack.length) {
              const id = stack.pop() as NodeId;
              const n = layout.nodes[id];
              if (n && n.type === 'container') stack.push(...n.children);
              delete layout.nodes[id];
            }
            return { layout: prune(layout) };
          }),

        reset: () => set({ layout: readUserDefault() ?? cloneLayout(defaultLayout) }),
        saveAsDefault: () => {
          try {
            localStorage.setItem(defaultKey, JSON.stringify(get().layout));
          } catch {
            /* storage blocked / full */
          }
        },
        exportJSON: () => JSON.stringify(get().layout, null, 2),
      })),
      {
        name: `thedaw.surface.${surfaceId}.v1`,
        version: defaultLayout.version,
        // designMode is session-only; never persist it.
        partialize: (s) => ({ layout: s.layout }),
        // Pass the persisted blob straight to `merge`, which does the real
        // version/shape validation and falls back to the default. Without this
        // a `version` bump logs "no migrate function was provided".
        migrate: (persisted) => persisted as { layout: SurfaceLayout },
        // Fall back to the default on schema mismatch / corruption / missing root.
        merge: (persisted, current) => {
          const p = (persisted ?? {}) as Partial<SurfaceStore>;
          const pl = p.layout;
          if (!pl || !pl.nodes || !pl.root || !pl.nodes[pl.root] || pl.version !== current.layout.version) {
            return current;
          }
          return { ...current, layout: pl };
        },
      },
    ),
  );
}

export type SurfaceStoreApi = ReturnType<typeof createLayoutStore>;
