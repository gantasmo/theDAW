import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Network, X, GitBranch, GitFork, Workflow, Maximize2, Minimize2, Sliders, Maximize, Copy, Crosshair, Package, GitMerge, Library as LibraryIcon, Home, Rocket } from 'lucide-react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { NodeInspector } from './NodeInspector';
import { SlideTrack } from '../audio/SlideTrack';

const ForceGraph3D = lazy(() => import('react-force-graph-3d').then((m) => ({ default: m.default })));
const ForceGraph2D = lazy(() => import('react-force-graph-2d').then((m) => ({ default: m.default })));

export interface GraphNode {
  id: string;
  kind?: string;
  title?: string;
  source?: string;
  duration_sec?: number;
  model?: string;
}

export interface GraphEdge {
  from_id: string;
  to_id: string;
  kind: string;
  weight?: number;
}

interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type LineageTab = 'track' | 'genealogy' | 'graph3d';

interface LineageModalProps {
  open: boolean;
  rootEntryId: string | null;
  onClose: () => void;
  /** 'modal' = current behaviour (portal, backdrop, close button, sized
   *  card). 'embedded' = render inline at parent's full size, no portal,
   *  no backdrop, no close button — for use as the LEARN tab in the
   *  new center bar. Defaults to 'modal' so existing callers don't
   *  change behaviour. */
  mode?: 'modal' | 'embedded';
}

type VizPreset =
  | 'default'           // glossy spheres + curved bezier links + particles
  | 'wireframe-grid'    // neon wireframe icosahedrons + straight tight links
  | 'particle-cloud'    // tiny billboard sprites + faint lines (codepen 'm00nb0y')
  | 'constellation'     // bright spheres with cyan haze, no particles (codepen 'hiteshsahu')
  | 'matrix-cube'       // wireframe cubes + arrow-only edges
  | 'plasma'            // glowy octahedrons with thick particle streams
  | 'galaxy'            // glowing star-spheres, wide spread, heavy particle streams
  | 'crystalline'       // faceted icosahedron gems, no particles, sharp links
  | 'tron-grid';        // wireframe cubes on a glowing ground grid, neon edges

type NodeShape =
  | 'sphere'
  | 'cube'
  | 'octahedron'
  | 'tetrahedron'
  | 'icosahedron'
  | 'torus';

interface GraphAppearance {
  renderMode: '2d' | '3d';
  vizPreset: VizPreset;
  nodeShape: NodeShape;
  nodeSizeScale: number;       // 0.5 – 3
  linkWidth: number;           // 1 – 6
  linkOpacity: number;         // 0.2 – 1
  particles: boolean;
  particleSpeed: number;       // 0.001 – 0.02
  edgeCurve: number;           // 0 = straight, 0.5 = bezier curl
  labelMode: 'hover' | 'always';
  background: 'dark' | 'midnight' | 'pure-black';
  controlType: 'orbit' | 'trackball' | 'fly';
  wireframe: boolean;
  /** When ON (3D only), render a translucent halo sphere per-source
   *  centered on each cluster's centroid — a lightweight "community
   *  tint" so the user can see groupings at a glance. */
  clusterColoring: boolean;
  /** 2D Genealogy spacing (px): gap between generations / between stacked rows. */
  colGap: number;
  rowGap: number;
  /** 3D force layout: node repulsion (negative) and link rest length. */
  charge: number;
  linkDistance: number;
  /** How many generations of ancestors/descendants a hover lights up (with a
   *  per-generation opacity falloff). */
  hoverDepth: number;
}

// Defaults are pinned to the "Particle cloud" preset — the values match
// PRESET_BUNDLES['particle-cloud'] one-for-one. We mirror them on the
// top-level fields so the AppearancePanel's preset dropdown lands on
// 'particle-cloud' AND the individual sliders display the right
// numbers on first open, without needing the panel to "apply preset"
// at mount time.
const DEFAULT_APPEARANCE: GraphAppearance = {
  renderMode: '3d',
  vizPreset: 'particle-cloud',
  nodeShape: 'sphere',
  nodeSizeScale: 0.7,
  linkWidth: 1.0,
  linkOpacity: 0.35,
  particles: true,
  particleSpeed: 0.004,
  edgeCurve: 0.15,
  labelMode: 'hover',
  background: 'pure-black',
  // Trackball is the library's default and avoids the bug in
  // react-force-graph-3d where OrbitControls + DragControls can race
  // on pointer-cancel and throw `Cannot read properties of undefined
  // (reading 'x')`. Orbit / Fly are still selectable in the panel.
  controlType: 'trackball',
  wireframe: false,
  clusterColoring: false,
  colGap: 90,
  rowGap: 14,
  charge: -90,
  linkDistance: 18,
  hoverDepth: 2,
};

const APPEARANCE_STORAGE_KEY = 'lineageGraphAppearance:v1';

function loadStoredAppearance(): GraphAppearance {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE;
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<GraphAppearance>;
    // Merge over defaults so newly-added fields take their default
    // when an older payload is read back.
    return { ...DEFAULT_APPEARANCE, ...parsed };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Preset bundles — selecting a preset swaps a coordinated set of
 *  rendering choices for a distinct visual style (inspired by the
 *  CodePen graph demos the user pointed at). */
const PRESET_BUNDLES: Record<VizPreset, Partial<GraphAppearance>> = {
  'default': {
    nodeShape: 'sphere',
    wireframe: false,
    linkWidth: 2.5,
    linkOpacity: 0.85,
    edgeCurve: 0.0,
    particles: true,
    particleSpeed: 0.006,
    background: 'midnight',
  },
  'wireframe-grid': {
    nodeShape: 'icosahedron',
    wireframe: true,
    linkWidth: 1.2,
    linkOpacity: 0.6,
    edgeCurve: 0.0,
    particles: false,
    background: 'pure-black',
  },
  'particle-cloud': {
    nodeShape: 'sphere',
    wireframe: false,
    nodeSizeScale: 0.7,
    linkWidth: 1.0,
    linkOpacity: 0.35,
    edgeCurve: 0.15,
    particles: true,
    particleSpeed: 0.004,
    background: 'pure-black',
  },
  'constellation': {
    nodeShape: 'sphere',
    wireframe: false,
    nodeSizeScale: 1.2,
    linkWidth: 1.2,
    linkOpacity: 0.5,
    edgeCurve: 0.0,
    particles: false,
    background: 'midnight',
  },
  'matrix-cube': {
    nodeShape: 'cube',
    wireframe: true,
    linkWidth: 1.0,
    linkOpacity: 0.7,
    edgeCurve: 0.0,
    particles: false,
    background: 'pure-black',
  },
  'plasma': {
    nodeShape: 'octahedron',
    wireframe: false,
    nodeSizeScale: 1.4,
    linkWidth: 3.5,
    linkOpacity: 0.95,
    edgeCurve: 0.25,
    particles: true,
    particleSpeed: 0.012,
    background: 'midnight',
  },
  // Glowing star-spheres flung wide (see PRESET_CHARGE) with heavy
  // particle streams over the starfield — reads like a star map, not a
  // tidy neural net.
  'galaxy': {
    nodeShape: 'sphere',
    wireframe: false,
    nodeSizeScale: 0.6,
    linkWidth: 0.8,
    linkOpacity: 0.28,
    edgeCurve: 0.4,
    particles: true,
    particleSpeed: 0.009,
    background: 'pure-black',
  },
  // Faceted low-poly gems, no particles, sharp straight links — angular
  // and mineral rather than organic.
  'crystalline': {
    nodeShape: 'icosahedron',
    wireframe: false,
    nodeSizeScale: 1.3,
    linkWidth: 1.0,
    linkOpacity: 0.5,
    edgeCurve: 0.0,
    particles: false,
    background: 'midnight',
  },
  // Wireframe cubes pinned over a glowing ground grid (see the grid
  // effect) with hard neon edges — a Tron/cityscape feel.
  'tron-grid': {
    nodeShape: 'cube',
    wireframe: true,
    nodeSizeScale: 1.0,
    linkWidth: 1.4,
    linkOpacity: 0.7,
    edgeCurve: 0.0,
    particles: false,
    background: 'pure-black',
  },
};

// Per-preset force-charge override. Galaxy flings nodes wide for a
// dispersed star-map; tron/crystalline sit a touch tighter than the
// default so their structure reads. Anything absent uses DEFAULT_CHARGE.
const DEFAULT_CHARGE = -90;
const PRESET_CHARGE: Partial<Record<VizPreset, number>> = {
  galaxy: -200,
  'tron-grid': -70,
  crystalline: -110,
};

const BG_COLORS: Record<GraphAppearance['background'], string> = {
  dark: '#0c0a14',
  midnight: '#06030c',
  'pure-black': '#000000',
};

/** Directed BFS from `start`: the FULL ancestry (via `parentsOf`) + the FULL
 *  descendant set (via `childrenOf`), all the way to the ends in both
 *  directions. Returns the set of lineage-connected node ids. */
function computeLineage(
  start: string | null,
  parentsOf: Record<string, string[]>,
  childrenOf: Record<string, string[]>,
): Set<string> {
  const out = new Set<string>();
  if (!start) return out;
  out.add(start);
  const walk = (adj: Record<string, string[]>) => {
    const stack = [start];
    while (stack.length) {
      const id = stack.pop() as string;
      for (const nb of adj[id] ?? []) {
        if (!out.has(nb)) {
          out.add(nb);
          stack.push(nb);
        }
      }
    }
  };
  walk(parentsOf);
  walk(childrenOf);
  return out;
}

/** Uniform highlight: every lineage-connected node/edge is full brightness, the
 *  rest is heavily dimmed (no per-generation falloff). */
const lineageOpacity = (onPath: boolean): number => (onPath ? 1 : 0.12);

const LINEAGE_HOVER_INTENT_MS = 200;

// Genealogy grid geometry (px). Square cards; the gaps come from the sliders.
const NODE_W = 140;
const NODE_H = 140;
const PAD = 24;
const TOP_MARGIN = 8;

const EDGE_COLOR_BY_KIND: Record<string, string> = {
  chimera_source_of: '#a78bfa',
  init_for: '#34d399',
  inpaint_for: '#fbbf24',
  stem_of: '#60a5fa',
  midi_of: '#f472b6',
  derived_from: '#94a3b8',
  used_in_lora: '#fb7185',
};

// Translucent halo tint per cluster (by node `source`). Used by the
// cluster-coloring overlay; colors picked to be distinct from the
// node colors so the halo reads as ambient backdrop, not as the
// node itself.
const CLUSTER_TINT_BY_SOURCE: Record<string, string> = {
  generate: '#a855f7',
  import: '#38bdf8',
  studio: '#34d399',
  chimera: '#f97316',
  stem: '#60a5fa',
  midi: '#f472b6',
  other: '#94a3b8',
};

export const LineageModal: React.FC<LineageModalProps> = ({ open, rootEntryId, onClose, mode = 'modal' }) => {
  const embedded = mode === 'embedded';
  const [tab, setTab] = useState<LineageTab>('track');
  const [perTrack, setPerTrack] = useState<GraphPayload | null>(null);
  const [libraryGraph, setLibraryGraph] = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Appearance options for the 3D graph; controlled in a side drawer.
  // Hydrated from localStorage so settings survive a reload.
  const [appearance, setAppearance] = useState<GraphAppearance>(loadStoredAppearance);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  // Genealogy Fit/Reset live in this header but operate on the GenealogyView.
  const genControls = useRef<{ fit: () => void; reset: () => void } | null>(null);

  // Persist appearance changes to localStorage (debounced via the
  // natural batching of React state updates — each setAppearance flushes
  // once per render, and JSON.stringify is cheap on this small object).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
    } catch {
      // Quota exceeded / SecurityError in private mode — silently skip;
      // session-only persistence is acceptable.
    }
  }, [appearance]);

  // "active" gates open-only side effects. In embedded mode the view
  // is always live (no open/close lifecycle), so we keep effects firing
  // whenever the component is mounted.
  const active = open || embedded;

  // When the modal opens for a specific track, default to that view.
  // When opened library-wide, jump straight to the genealogy view.
  useEffect(() => {
    if (!active) return;
    setTab(rootEntryId ? 'track' : 'genealogy');
  }, [active, rootEntryId]);

  // Fetch the per-track BFS.
  useEffect(() => {
    if (!active || !rootEntryId) return;
    setLoading(true);
    setPerTrack(null);
    void fetch(`/api/library/${rootEntryId}/lineage?depth=4`)
      .then((r) => r.json())
      .then((j: GraphPayload) => setPerTrack(j))
      .catch(() => setPerTrack({ nodes: [], edges: [] }))
      .finally(() => setLoading(false));
  }, [active, rootEntryId]);

  // Fetch the full library graph for the family-tree + 3D-graph views.
  useEffect(() => {
    if (!active) return;
    if (tab !== 'genealogy' && tab !== 'graph3d') return;
    if (libraryGraph !== null) return;
    setLoading(true);
    void fetch('/api/library/_graph/all')
      .then((r) => r.json())
      .then((j: GraphPayload) => setLibraryGraph(j))
      .catch(() => setLibraryGraph({ nodes: [], edges: [] }))
      .finally(() => setLoading(false));
  }, [active, tab, libraryGraph]);

  if (!active) return null;

  // The modal renders via a portal mounted at document.body so it
  // escapes the `.dense-layout { zoom: 0.85 }` ancestor on <Shell>.
  // CSS `zoom` re-scales the canvas but react-force-graph's tooltip
  // overlay uses unzoomed CSS pixel coordinates → the hover/click pop-
  // up landed several centimetres away from the cursor. Portalling out
  // of the zoomed subtree fixes that for both the genealogy SVG and
  // the 3D-graph WebGL canvas.
  //
  // In embedded mode + non-fullscreen, the view fills its parent (the
  // LEARN tab's content area) with no portal and no card. In embedded
  // + fullscreen the view portals out of the zoom-scaled Shell and
  // covers the viewport — same visual treatment as the modal's
  // fullscreen state. The fullscreen toggle is available in BOTH modes
  // per layout invariant; user noticed when it disappeared in embedded.
  const fullBleed = embedded || fullscreen;
  const modalShellClass = fullBleed
    ? 'relative w-full h-full bg-[#0c0a14] flex flex-col overflow-hidden'
    : 'relative w-[min(1100px,92vw)] h-[min(720px,86vh)] bg-[#0c0a14] border border-purple-500/30 rounded-lg shadow-2xl flex flex-col overflow-hidden';
  const useInlineLayout = embedded && !fullscreen;

  const content = (
    <div className={useInlineLayout ? 'absolute inset-0 flex' : 'fixed inset-0 z-200 flex items-center justify-center'}>
      {!embedded && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      )}
      <div className={modalShellClass}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-purple-300" />
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] font-black uppercase tracking-widest text-purple-200">Lineage</span>
              <span className="text-[8px] font-mono uppercase tracking-wider text-purple-300/60">
                {rootEntryId ? `rooted at ${rootEntryId.slice(0, 16)}…` : 'library-wide'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {rootEntryId && (
              <TabButton active={tab === 'track'} onClick={() => setTab('track')} icon={<GitBranch className="w-3 h-3" />}>
                Track
              </TabButton>
            )}
            <TabButton active={tab === 'genealogy'} onClick={() => setTab('genealogy')} icon={<GitFork className="w-3 h-3" />}>
              Genealogy
            </TabButton>
            <TabButton active={tab === 'graph3d'} onClick={() => setTab('graph3d')} icon={<Workflow className="w-3 h-3" />}>
              3D graph
            </TabButton>
            {tab === 'genealogy' && (
              <>
                <button
                  onClick={() => genControls.current?.fit()}
                  className="ml-1 flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:text-purple-200 bg-purple-500/15 border border-purple-500/30 hover:border-purple-400/60"
                  title="Fit the entire genealogy into the viewport"
                >
                  <Maximize className="w-2.5 h-2.5" /> Fit
                </button>
                <button
                  onClick={() => genControls.current?.reset()}
                  className="flex items-center px-2 py-1 rounded text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:text-zinc-200 bg-black/40 border border-white/10"
                  title="Reset to native scale"
                >
                  Reset
                </button>
              </>
            )}
            {tab === 'graph3d' && (
              <button
                onClick={() => setAppearanceOpen((v) => !v)}
                className={`ml-1 p-1 rounded transition-colors ${appearanceOpen ? 'bg-purple-500/20 text-purple-200' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
                title="Appearance options"
              >
                <Sliders className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Fullscreen toggle available in both modal AND embedded
                mode. In embedded mode it overlays the full viewport;
                in modal mode it expands the modal card. */}
            <button
              onClick={() => setFullscreen((v) => !v)}
              className="ml-1 p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5"
              title={fullscreen ? 'Exit full screen' : 'Full screen'}
            >
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            {!embedded && (
              <button onClick={onClose} className="ml-1 p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">
              Loading lineage…
            </div>
          )}
          {tab === 'track' && rootEntryId && perTrack && (
            <TrackTreeView root={rootEntryId} payload={perTrack} />
          )}
          {tab === 'genealogy' && libraryGraph && (
            <GenealogyView payload={libraryGraph} appearance={appearance} controlsRef={genControls} />
          )}
          {tab === 'graph3d' && libraryGraph && (
            <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">Loading 3D engine…</div>}>
              <Graph3DView
                payload={libraryGraph}
                highlight={rootEntryId}
                appearance={appearance}
              />
            </Suspense>
          )}

          {tab === 'graph3d' && appearanceOpen && (
            <AppearancePanel
              value={appearance}
              onChange={setAppearance}
              onClose={() => setAppearanceOpen(false)}
            />
          )}
        </div>

        {/* Footer: edge-kind color key (left) + genealogy spacing (right). */}
        <div className="flex items-center flex-wrap gap-3 px-4 py-2 border-t border-white/5 text-[8px] font-mono uppercase tracking-wider text-zinc-500 shrink-0">
          {Object.entries(EDGE_COLOR_BY_KIND).map(([kind, color]) => (
            <span key={kind} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: color }} />
              {kind}
            </span>
          ))}
          {tab === 'genealogy' && (
            <div className="ml-auto flex items-center gap-4 normal-case">
              <FooterRange label="Gen gap" value={appearance.colGap} min={40} max={1200} step={5} onChange={(v) => setAppearance({ ...appearance, colGap: v })} />
              <FooterRange label="Row gap" value={appearance.rowGap} min={4} max={800} step={2} onChange={(v) => setAppearance({ ...appearance, rowGap: v })} />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Inline embedded (no fullscreen) lives in the LEARN tab DOM tree.
  // Modal mode AND embedded+fullscreen portal to document.body to
  // escape the Shell's `.dense-layout { zoom: 0.85 }` ancestor — the
  // 3D canvas + tooltip overlays use unzoomed CSS pixels so they only
  // render correctly outside the zoomed subtree.
  if (useInlineLayout) return content;
  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
};

/** Embedded variant of LineageModal — mounts the lineage UI inline
 *  (no backdrop, no portal, no close button) for use as the LEARN tab
 *  in the new center bar. Always-live; doesn't take an `open` prop. */
export const LineageView: React.FC<{ rootEntryId?: string | null }> = ({ rootEntryId = null }) => (
  <LineageModal
    mode="embedded"
    open={true}
    rootEntryId={rootEntryId}
    onClose={() => {
      /* no-op in embedded mode */
    }}
  />
);


interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}

const TabButton: React.FC<TabButtonProps> = ({ active, onClick, icon, children }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border transition-colors ${
      active
        ? 'bg-purple-500/15 border-purple-500/40 text-purple-200'
        : 'border-white/5 text-zinc-500 hover:text-zinc-300'
    }`}
  >
    {icon}
    {children}
  </button>
);


/** Per-track BFS rendered as a horizontal hierarchy (parents on the left,
 *  the root in the middle, children on the right). Pure SVG — no extra dep. */
const TrackTreeView: React.FC<{ root: string; payload: GraphPayload }> = ({ root, payload }) => {
  // Group edges by direction from the root.
  const parents = useMemo(
    () => payload.edges.filter((e) => e.to_id === root).map((e) => e.from_id),
    [payload, root],
  );
  const children = useMemo(
    () => payload.edges.filter((e) => e.from_id === root).map((e) => e.to_id),
    [payload, root],
  );
  const nodeMap = useMemo(() => Object.fromEntries(payload.nodes.map((n) => [n.id, n])), [payload]);
  const rootNode = nodeMap[root];

  return (
    <div className="absolute inset-0 overflow-auto p-6">
      <div className="grid grid-cols-3 gap-6 min-h-full items-start">
        <Column title="Parents" nodes={parents.map((id) => nodeMap[id]).filter(Boolean) as GraphNode[]} accent="border-emerald-500/40 text-emerald-300" />
        <Column title="This track" nodes={rootNode ? [rootNode] : []} accent="border-purple-500/60 text-purple-200" highlight />
        <Column title="Children" nodes={children.map((id) => nodeMap[id]).filter(Boolean) as GraphNode[]} accent="border-amber-500/40 text-amber-300" />
      </div>
      {parents.length === 0 && children.length === 0 && (
        <p className="text-center text-[10px] text-zinc-500 italic py-8">
          This track has no recorded lineage yet. Generate a Chimera or use this track as an init / inpaint source to start populating it.
        </p>
      )}
    </div>
  );
};


const Column: React.FC<{ title: string; nodes: GraphNode[]; accent: string; highlight?: boolean }> = ({ title, nodes, accent, highlight }) => (
  <div className="flex flex-col gap-2">
    <div className={`text-[9px] font-black uppercase tracking-widest border-b pb-1 ${accent}`}>
      {title} ({nodes.length})
    </div>
    {nodes.length === 0 ? (
      <span className="text-[10px] text-zinc-600 italic">none</span>
    ) : (
      nodes.map((n) => (
        <div
          key={n.id}
          className={`rounded border p-2 ${highlight ? 'bg-purple-500/10 border-purple-500/40' : 'bg-white/3 border-white/5'}`}
        >
          <div className="text-[10px] text-zinc-100 truncate">{n.title ?? n.id}</div>
          <div className="text-[8px] font-mono text-zinc-500 truncate">
            {n.kind ?? 'entry'} · {n.source ?? '—'}
          </div>
        </div>
      ))
    )}
  </div>
);


/** Library-wide genealogy: a layered DAG layout (Sugiyama-style).
 *
 *  1. Filter to nodes that participate in at least one relation —
 *     isolated tracks aren't "genealogy", they're just unrelated entries.
 *  2. Assign each node to a generation = longest path from any root.
 *  3. Within each generation, order nodes via the median heuristic to
 *     minimize parent↔child edge crossings (cheap, gives a clearly
 *     readable layout even at 30+ nodes).
 *  4. Render rounded-rect cards with orthogonal connecting lines drawn
 *     as SVG paths, color-coded by relation kind, with arrowheads at
 *     the child end.
 *  5. Pan via mouse drag, zoom via wheel, Reset View button.
 */
/** A single genealogy node's inner SVG body (card chrome + 5 text rows).
 *  Memoized at module scope so hovering one node doesn't re-render every other
 *  node's ~13 SVG elements — only nodes whose `strong` (hovered/selected) state
 *  flips re-render. This is what kills the per-hover lag and flash; the outer
 *  <g> (opacity/transform/handlers) stays in the parent and is cheap to diff. */
const GenNodeBody = React.memo(function GenNodeBody({
  n, title, sourceColor, strong, w, h,
}: {
  n: GraphNode;
  title: string;
  sourceColor: string;
  strong: boolean;
  w: number;
  h: number;
}) {
  return (
    <>
      <rect
        width={w}
        height={h}
        rx={6}
        ry={6}
        fill="#0c0a14"
        stroke={sourceColor}
        strokeWidth={strong ? 3 : 1.5}
        style={{ transition: 'stroke-width 320ms ease' }}
      />
      <rect width={w} height={4} rx={2} ry={2} fill={sourceColor} opacity={0.85} />
      <text x={10} y={24} fill="#f4f4f5" fontSize={12} fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontWeight={700}>
        {truncate(title, 18)}
      </text>
      <line x1={10} y1={31} x2={w - 10} y2={31} stroke="#ffffff" strokeOpacity={0.08} />
      {(
        [
          ['SRC', n.source ?? '—'],
          ['KIND', n.kind ?? 'entry'],
          ['MODEL', n.model ?? '—'],
          ['DUR', typeof n.duration_sec === 'number' && n.duration_sec > 0 ? `${n.duration_sec.toFixed(1)}s` : '—'],
          ['ID', n.id],
        ] as const
      ).map(([k, v], i) => (
        <text key={k} x={10} y={48 + i * 15} fontSize={8.5} fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
          <tspan fill="#6b7280">{k} </tspan>
          <tspan fill="#cbd5e1">{truncate(String(v), 19)}</tspan>
        </text>
      ))}
    </>
  );
});

/** A single genealogy edge's inner SVG body (curve + arrowhead). Memoized so a
 *  hover only re-renders the bodies of edges whose `strong` state changed. */
const GenEdgeBody = React.memo(function GenEdgeBody({
  d, color, x2, y2, strong,
}: {
  d: string;
  color: string;
  x2: number;
  y2: number;
  strong: boolean;
}) {
  return (
    <>
      <path
        d={d}
        stroke={color}
        strokeWidth={strong ? 2.5 : 1.5}
        fill="none"
        opacity={0.7}
        style={{ transition: 'stroke-width 320ms ease' }}
      />
      <polygon
        points={`${x2 - 7},${y2 - 4} ${x2 - 7},${y2 + 4} ${x2},${y2}`}
        fill={color}
        opacity={0.9}
      />
    </>
  );
});

const GenealogyView: React.FC<{
  payload: GraphPayload;
  appearance: GraphAppearance;
  /** Lets the parent header drive Fit/Reset (moved out of the canvas corner). */
  controlsRef?: React.MutableRefObject<{ fit: () => void; reset: () => void } | null>;
}> = ({ payload, appearance, controlsRef }) => {
  // Hover lights up a node's full lineage (uniform brightness both ways).
  const [hovered, setHovered] = useState<string | null>(null);
  // Hover is smoothed: moving the cursor straight from one node to the next
  // keeps the highlight (a short clear-timer absorbs the gap, so it never blinks
  // back to the un-highlighted state), and a wheel-zoom freezes hover entirely
  // so the highlight doesn't thrash as nodes slide under a stationary cursor.
  const hoverClearRef = useRef<number | null>(null);
  const hoverIntentRef = useRef<number | null>(null);
  const zoomingRef = useRef(false);
  const zoomEndRef = useRef<number | null>(null);
  const clearHoverIntent = useCallback(() => {
    if (hoverIntentRef.current != null) {
      window.clearTimeout(hoverIntentRef.current);
      hoverIntentRef.current = null;
    }
  }, []);
  const enterNode = useCallback((id: string) => {
    if (zoomingRef.current) return;
    clearHoverIntent();
    if (hoverClearRef.current != null) { window.clearTimeout(hoverClearRef.current); hoverClearRef.current = null; }
    hoverIntentRef.current = window.setTimeout(() => {
      setHovered(id);
      hoverIntentRef.current = null;
    }, LINEAGE_HOVER_INTENT_MS);
  }, [clearHoverIntent]);
  const leaveNode = useCallback(() => {
    if (zoomingRef.current) return;
    clearHoverIntent();
    if (hoverClearRef.current != null) { window.clearTimeout(hoverClearRef.current); hoverClearRef.current = null; }
    setHovered(null);
  }, [clearHoverIntent]);
  useEffect(() => () => {
    clearHoverIntent();
    if (hoverClearRef.current != null) window.clearTimeout(hoverClearRef.current);
  }, [clearHoverIntent]);
  // Click opens the detail/analytics inspector for that node.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Viewport size — the grid uses the panel's aspect ratio to choose its row
  // count so it fills the window (see fillRows).
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  // -- Filter to the connected subgraph --------------------------------
  const connected = useMemo(() => {
    const involved = new Set<string>();
    // Defensive: a malformed/empty payload (e.g. backend offline) must degrade
    // to an empty graph, never crash the whole tab.
    const allEdges = payload?.edges ?? [];
    const allNodes = payload?.nodes ?? [];
    allEdges.forEach((e) => {
      involved.add(e.from_id);
      involved.add(e.to_id);
    });
    const nodes = allNodes.filter((n) => involved.has(n.id));
    // Also keep any edges whose endpoints both still exist (defensive).
    const idSet = new Set(nodes.map((n) => n.id));
    const edges = allEdges.filter(
      (e) => idSet.has(e.from_id) && idSet.has(e.to_id),
    );
    return { nodes, edges };
  }, [payload]);

  // -- Build adjacency -------------------------------------------------
  const { nodeMap, childrenOf, parentsOf } = useMemo(() => {
    const nm: Record<string, GraphNode> = {};
    connected.nodes.forEach((n) => {
      nm[n.id] = n;
    });
    const co: Record<string, string[]> = {};
    const po: Record<string, string[]> = {};
    connected.edges.forEach((e) => {
      (co[e.from_id] = co[e.from_id] || []).push(e.to_id);
      (po[e.to_id] = po[e.to_id] || []).push(e.from_id);
    });
    return { nodeMap: nm, childrenOf: co, parentsOf: po };
  }, [connected]);

  const lineage = useMemo(
    () => computeLineage(hovered, parentsOf, childrenOf),
    [hovered, parentsOf, childrenOf],
  );

  // -- Step 1: assign layer = longest path from any root --------------
  const layers = useMemo(() => {
    const out: Record<string, number> = {};
    const roots = connected.nodes.filter(
      (n) => !(parentsOf[n.id] && parentsOf[n.id].length),
    );
    // Multi-pass relaxation so that a node at the bottom of a long
    // chain ends up at the deepest layer.
    roots.forEach((r) => {
      out[r.id] = 0;
    });
    let changed = true;
    let safety = 0;
    while (changed && safety < 50) {
      changed = false;
      safety += 1;
      connected.edges.forEach((e) => {
        const fromLayer = out[e.from_id] ?? 0;
        const want = fromLayer + 1;
        if ((out[e.to_id] ?? -1) < want) {
          out[e.to_id] = want;
          changed = true;
        }
      });
    }
    connected.nodes.forEach((n) => {
      if (out[n.id] == null) out[n.id] = 0;
    });
    return out;
  }, [connected, parentsOf]);

  // -- Step 2: order within layer via median heuristic ----------------
  const orderedRows = useMemo(() => {
    const grouped: Record<number, string[]> = {};
    connected.nodes.forEach((n) => {
      const d = layers[n.id] ?? 0;
      (grouped[d] = grouped[d] || []).push(n.id);
    });
    const layerKeys = Object.keys(grouped)
      .map((k) => Number(k))
      .sort((a, b) => a - b);

    // Initial alphabetical order for stability.
    layerKeys.forEach((d) => {
      grouped[d].sort((a, b) =>
        (nodeMap[a]?.title ?? a).localeCompare(nodeMap[b]?.title ?? b),
      );
    });

    // Median-of-parents heuristic, sweeping top-down then bottom-up
    // a few times. This is the simplest crossing-reduction step in
    // the Sugiyama framework.
    const positionInRow = (id: string, row: string[]): number => row.indexOf(id);
    for (let iter = 0; iter < 12; iter += 1) {
      const topDown = iter % 2 === 0;
      const order = topDown ? layerKeys.slice(1) : layerKeys.slice(0, -1).reverse();
      order.forEach((d) => {
        const adjLayer = topDown ? d - 1 : d + 1;
        const adjRow = grouped[adjLayer] || [];
        const adjMap = topDown ? parentsOf : childrenOf;
        const newRow = [...grouped[d]];
        const medianOf = (id: string): number => {
          const refs = (adjMap[id] || []).filter((n) => adjRow.includes(n));
          if (refs.length === 0) return positionInRow(id, grouped[d]);
          const positions = refs
            .map((r) => positionInRow(r, adjRow))
            .filter((p) => p >= 0)
            .sort((a, b) => a - b);
          if (positions.length === 0) return positionInRow(id, grouped[d]);
          return positions[Math.floor(positions.length / 2)];
        };
        newRow.sort((a, b) => medianOf(a) - medianOf(b));
        grouped[d] = newRow;
      });
    }

    return layerKeys.map((d) => ({ layer: d, ids: grouped[d] }));
  }, [connected, nodeMap, layers, parentsOf, childrenOf]);

  // -- Step 3: coordinate assignment ----------------------------------
  // Square cards pack into a grid that fills the panel; gaps come from sliders.
  const ROW_GAP = appearance.rowGap;            // vertical gap between nodes
  const SUBCOL_GAP = ROW_GAP;                    // uniform horizontal gap inside a generation
  const GEN_GAP = appearance.colGap;            // larger gap BETWEEN generations

  // Row count chosen so the layout's aspect ratio matches the panel's — that is
  // what fills the window instead of leaving tall empty bands above and below.
  // For N nodes in an A:1 panel with ~square cells the space-optimal grid is
  // R = sqrt(N / A) rows × ~N/R columns (e.g. 144 nodes @ 16:9 → 9×16). Each
  // generation packs its nodes column-major into R rows.
  const fillRows = useMemo(() => {
    const n = connected.nodes.length;
    if (n <= 1) return 1;
    const A = containerSize.w > 0 && containerSize.h > 0 ? containerSize.w / containerSize.h : 16 / 9;
    const cellW = NODE_W + SUBCOL_GAP;
    const cellH = NODE_H + ROW_GAP;
    const r = Math.round(Math.sqrt((n * cellW) / (A * cellH)));
    return Math.max(1, Math.min(n, r));
  }, [connected.nodes.length, containerSize.w, containerSize.h, SUBCOL_GAP, ROW_GAP]);

  const generationLayouts = useMemo(() => {
    const layouts: Array<{ layer: number; ids: string[]; subColCount: number; genStartX: number; genEndX: number }> = [];
    let cursorX = PAD;
    orderedRows.forEach((row) => {
      const subColCount = Math.max(1, Math.ceil(row.ids.length / fillRows));
      const genStartX = cursorX;
      const genEndX = genStartX + subColCount * NODE_W + (subColCount - 1) * SUBCOL_GAP;
      layouts.push({ layer: row.layer, ids: row.ids, subColCount, genStartX, genEndX });
      cursorX = genEndX + GEN_GAP;
    });
    return layouts;
  }, [orderedRows, fillRows, SUBCOL_GAP, GEN_GAP]);

  const positions = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    generationLayouts.forEach((g) => {
      g.ids.forEach((id, i) => {
        const subcol = Math.floor(i / fillRows);
        const r = i % fillRows;
        pos[id] = {
          x: g.genStartX + subcol * (NODE_W + SUBCOL_GAP),
          y: TOP_MARGIN + PAD + r * (NODE_H + ROW_GAP),
        };
      });
    });
    return pos;
  }, [generationLayouts, fillRows, SUBCOL_GAP, ROW_GAP]);

  // -- Bounds for the SVG ---------------------------------------------
  const bounds = useMemo(() => {
    const ids = Object.keys(positions);
    if (ids.length === 0) return { minX: 0, maxX: 800, minY: 0, maxY: 400 };
    const xs = ids.map((id) => positions[id].x);
    const ys = ids.map((id) => positions[id].y);
    return {
      minX: Math.min(...xs) - PAD,
      maxX: Math.max(...xs) + NODE_W + PAD,
      minY: Math.min(...ys) - PAD,
      maxY: Math.max(...ys) + NODE_H + PAD,
    };
  }, [positions]);

  // -- Pan + zoom -----------------------------------------------------
  // `view` is what renders; `targetRef` is where zoom is heading. A rAF loop
  // eases view → target so wheel-zoom glides (and zooms toward the cursor)
  // instead of snapping. Pan writes both view + target so dragging stays 1:1.
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  const targetRef = useRef(view);
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const draggedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keep the panel size current so the grid can size itself to fill it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Snap view + target together (Fit / Reset / autofit) — no animation.
  const setViewImmediate = React.useCallback((v: { x: number; y: number; k: number }) => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    viewRef.current = v;
    targetRef.current = v;
    setView(v);
  }, []);

  // Ease view → target each frame; stop once converged.
  const kick = React.useCallback(() => {
    if (rafRef.current != null) return;
    const tick = () => {
      const v = viewRef.current;
      const t = targetRef.current;
      const nx = v.x + (t.x - v.x) * 0.28;
      const ny = v.y + (t.y - v.y) * 0.28;
      const nk = v.k + (t.k - v.k) * 0.28;
      const done = Math.abs(t.x - nx) < 0.4 && Math.abs(t.y - ny) < 0.4 && Math.abs(t.k - nk) < 0.0008;
      const next = done ? t : { x: nx, y: ny, k: nk };
      viewRef.current = next;
      setView(next);
      if (done) { rafRef.current = null; } else { rafRef.current = requestAnimationFrame(tick); }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  // Auto-fit on first mount + when bounds change so the whole tree
  // lands visible inside the modal regardless of how wide the widest
  // generation is. The "Fit" button re-runs this on demand.
  const fitToView = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const gw = bounds.maxX - bounds.minX;
    const gh = bounds.maxY - bounds.minY;
    if (cw <= 0 || ch <= 0 || gw <= 0 || gh <= 0) return;
    // Reserve a top strip for the generation numbers, then scale to fill the
    // rest. No 1.0 cap so a small graph zooms up; the grid layout already makes
    // the aspect ratio match the panel, so both axes fill with little waste.
    const margin = 12;
    const topReserve = 34;
    const k = Math.min(
      (cw - margin) / gw,
      (ch - margin - topReserve) / gh,
      4,
    );
    const x = (cw - gw * k) / 2 - bounds.minX * k;
    const y = topReserve + (ch - topReserve - gh * k) / 2 - bounds.minY * k;
    setViewImmediate({ x, y, k });
  }, [bounds, setViewImmediate]);

  // Fit once the layout settles + whenever the bounds change shape.
  useEffect(() => {
    fitToView();
  }, [fitToView]);

  // Publish Fit/Reset to the parent so they can live in the Lineage header.
  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = { fit: fitToView, reset: () => setViewImmediate({ x: 0, y: 0, k: 1 }) };
    return () => { controlsRef.current = null; };
  }, [controlsRef, fitToView, setViewImmediate]);

  // Esc closes the inspector.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  // Stems / MIDI nodes are titled "bass" / "piano" etc — show the TRACK they
  // were derived from. Find a non-derived neighbor (the source track) and prefix
  // its title.
  const displayTitle = useCallback((n: GraphNode): string => {
    const own = n.title ?? n.id;
    const derived = (x?: GraphNode) =>
      !!x && (x.source === 'stem' || x.source === 'midi' || x.kind === 'stem' || x.kind === 'midi');
    if (!derived(n)) return own;
    const nbrs = [...(parentsOf[n.id] ?? []), ...(childrenOf[n.id] ?? [])];
    for (const id of nbrs) {
      const src = nodeMap[id];
      if (src && !derived(src) && src.title) return `${src.title} · ${own}`;
    }
    return own;
  }, [parentsOf, childrenOf, nodeMap]);

  // The whole SVG is memoized on graph/hover/selection/layout — NOT on `view`.
  // Pan/zoom only updates the wrapper div's transform, so dragging/zooming no
  // longer rebuilds hundreds of node/edge elements every frame (the old hot path).
  const svgContent = useMemo(() => (
    <svg
      width={bounds.maxX - bounds.minX}
      height={bounds.maxY - bounds.minY}
      viewBox={`${bounds.minX} ${bounds.minY} ${bounds.maxX - bounds.minX} ${bounds.maxY - bounds.minY}`}
      style={{ display: 'block' }}
    >
      {/* Generation bands: plain alternating grey / darker-grey, full height.
          The gen NUMBER lives in a screen-space strip above the nodes (below the
          header) — not stamped here. */}
      {generationLayouts.map((g) => (
        <rect
          key={`genbg-${g.layer}`}
          x={g.genStartX - GEN_GAP / 2}
          y={bounds.minY}
          width={g.genEndX - g.genStartX + GEN_GAP}
          height={bounds.maxY - bounds.minY}
          fill={g.layer % 2 === 0 ? '#17171c' : '#0d0d11'}
        />
      ))}

      {/* Edges under nodes. Hovering a node lights up its WHOLE lineage: the
          lineage edges stay full and thicken, off-path edges fade — without
          dimming any nodes. */}
      {connected.edges.map((edge, i) => {
        const from = positions[edge.from_id];
        const to = positions[edge.to_id];
        if (!from || !to) return null;
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const dx = (x2 - x1) * 0.5;
        const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        const color = EDGE_COLOR_BY_KIND[edge.kind] ?? '#71717a';
        const onPath = lineage.has(edge.from_id) && lineage.has(edge.to_id);
        const eOp = !hovered ? 0.85 : onPath ? 1 : 0.07;
        return (
          <g key={i} opacity={eOp} style={{ transition: 'opacity 240ms ease' }}>
            <GenEdgeBody d={d} color={color} x2={x2} y2={y2} strong={!!hovered && onPath} />
          </g>
        );
      })}

      {/* Nodes are never dimmed. Hovering glows the hovered node strongly and the
          rest of its lineage softly, in each node's source color. */}
      {connected.nodes.map((n) => {
        const p = positions[n.id];
        if (!p) return null;
        const sourceColor = pickNodeColor(n);
        const isHovered = hovered === n.id;
        const isSelected = selectedId === n.id;
        const inLineage = !!hovered && lineage.has(n.id);
        const glow = isHovered
          ? `drop-shadow(0 0 14px ${sourceColor}) drop-shadow(0 0 5px ${sourceColor})`
          : inLineage
            ? `drop-shadow(0 0 8px ${sourceColor})`
            : undefined;
        return (
          <g
            key={n.id}
            transform={`translate(${p.x}, ${p.y})`}
            style={{ cursor: 'pointer', filter: glow, transition: 'filter 160ms ease' }}
            onMouseEnter={() => enterNode(n.id)}
            onMouseLeave={leaveNode}
            onClick={(e) => {
              e.stopPropagation();
              if (draggedRef.current) return;
              setSelectedId((cur) => (cur === n.id ? null : n.id));
            }}
          >
            <GenNodeBody n={n} title={displayTitle(n)} sourceColor={sourceColor} strong={isHovered || isSelected || inLineage} w={NODE_W} h={NODE_H} />
          </g>
        );
      })}
    </svg>
  ), [bounds, generationLayouts, GEN_GAP, connected, positions, lineage, hovered, selectedId, enterNode, leaveNode, displayTitle]);

  if (connected.nodes.length === 0) {
    return (
      <p className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-500 italic px-12 text-center">
        No genealogy yet — entries become connected when you generate from
        chimera sources, separate stems, convert to MIDI, or mark a
        track as derived-from another. Right-click a track → "Show
        lineage" to start populating relationships.
      </p>
    );
  }

  // Wheel listener must be attached non-passively so we can preventDefault
  // and stop the parent (Shell) from scrolling. React's JSX wheel handler
  // is registered as passive by default → console fires
  // "Unable to preventDefault inside passive event listener invocation".
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Freeze hover for the duration of the zoom gesture so the lineage
      // highlight stays put instead of thrashing as nodes slide under the cursor.
      zoomingRef.current = true;
      if (zoomEndRef.current != null) window.clearTimeout(zoomEndRef.current);
      zoomEndRef.current = window.setTimeout(() => { zoomingRef.current = false; }, 200);
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const t = targetRef.current;
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      const newK = Math.max(0.2, Math.min(4, t.k * factor));
      // Keep the world point under the cursor fixed as we zoom.
      const worldX = (cx - t.x) / t.k;
      const worldY = (cy - t.y) / t.k;
      targetRef.current = { k: newK, x: cx - worldX * newK, y: cy - worldY * newK };
      kick();
    };
    el.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => el.removeEventListener('wheel', onNativeWheel);
  }, [kick]);

  // Pan: capture only once a real drag begins (>4px) so a plain click still
  // reaches a node's onClick. `draggedRef` suppresses the click that ends a drag.
  const onPointerDown = (e: React.PointerEvent) => {
    draggingRef.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    draggedRef.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = draggingRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!draggedRef.current && Math.hypot(dx, dy) > 4) {
      draggedRef.current = true;
      try { containerRef.current?.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    if (!draggedRef.current) return;
    const v = { ...viewRef.current, x: d.vx + dx, y: d.vy + dy };
    viewRef.current = v;
    targetRef.current = { ...targetRef.current, x: v.x, y: v.y };
    setView(v);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    draggingRef.current = null;
    try { containerRef.current?.releasePointerCapture(e.pointerId); } catch { /* */ }
    // Reset AFTER the click event (which fires right after pointerup) so a
    // drag-release doesn't select/clear.
    setTimeout(() => { draggedRef.current = false; }, 0);
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 bg-[#06030c] overflow-hidden cursor-grab active:cursor-grabbing select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={() => { if (!draggedRef.current) setSelectedId(null); }}
    >
      {/* Generation numbers — a screen-space strip just below the header that
          tracks the canvas horizontally so each number floats above its
          generation's column. Fit reserves the top margin so these stay clear. */}
      <div className="absolute top-0 left-0 right-0 h-8 z-10 overflow-hidden pointer-events-none">
        {generationLayouts.map((g) => {
          const centerX = ((g.genStartX + g.genEndX) / 2) * view.k + view.x;
          return (
            <span
              key={g.layer}
              className="absolute top-2 -translate-x-1/2 text-[12px] font-mono font-bold tracking-widest text-zinc-300"
              style={{ left: centerX }}
            >
              {g.layer}
            </span>
          );
        })}
      </div>

      <div
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transformOrigin: '0 0',
        }}
      >
        {svgContent}
      </div>

      {/* Help hint */}
      <div className="absolute bottom-2 left-2 z-10 text-[8px] font-mono text-zinc-600 pointer-events-none">
        drag to pan · wheel to zoom · click a node for details · {connected.nodes.length} connected entries · {connected.edges.length} relationships
      </div>

      {/* Detail / analytics inspector (screen-space; outside the pan/zoom transform). */}
      <NodeInspector
        nodeId={selectedId}
        nodes={connected.nodes}
        edges={connected.edges}
        edgeColor={(k) => EDGE_COLOR_BY_KIND[k] ?? '#71717a'}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
};


function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}


interface AppearancePanelProps {
  value: GraphAppearance;
  onChange: (next: GraphAppearance) => void;
  onClose: () => void;
}

/** Side drawer of toggles for the 3D graph. Inspired by the
 *  graphrag-workbench appearance panel — node-size scale, link weight,
 *  particles, edge curvature, control type, background. */
const AppearancePanel: React.FC<AppearancePanelProps> = ({ value, onChange, onClose }) => {
  const patch = (p: Partial<GraphAppearance>) => onChange({ ...value, ...p });
  return (
    <div className="absolute top-2 right-2 z-30 w-60 bg-[#0c0a14]/95 border border-purple-500/30 rounded-lg shadow-2xl p-3 flex flex-col gap-2 backdrop-blur-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] font-black uppercase tracking-widest text-purple-200">Appearance</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onChange(DEFAULT_APPEARANCE)}
            className="text-[8px] font-mono uppercase tracking-widest text-zinc-400 hover:text-zinc-100 border border-white/10 hover:border-white/20 px-1.5 py-0.5 rounded"
            title="Reset appearance to defaults"
          >
            Reset
          </button>
          <button onClick={onClose} className="p-0.5 text-zinc-500 hover:text-white rounded hover:bg-white/5">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      <SelectRow
        label="Render mode"
        value={value.renderMode}
        options={[
          { value: '3d', label: '3D (force)' },
          { value: '2d', label: '2D (canvas)' },
        ]}
        onChange={(v) => patch({ renderMode: v as GraphAppearance['renderMode'] })}
      />
      <SelectRow
        label="Style preset"
        value={value.vizPreset}
        options={[
          { value: 'default',         label: 'Default spheres' },
          { value: 'wireframe-grid',  label: 'Wireframe grid' },
          { value: 'particle-cloud',  label: 'Particle cloud' },
          { value: 'constellation',   label: 'Constellation' },
          { value: 'matrix-cube',     label: 'Matrix cubes' },
          { value: 'plasma',          label: 'Plasma' },
          { value: 'galaxy',          label: 'Galaxy / orbital' },
          { value: 'crystalline',     label: 'Crystalline / faceted' },
          { value: 'tron-grid',       label: 'Tron grid' },
        ]}
        onChange={(v) => {
          const next = v as VizPreset;
          // Applying a preset swaps a coordinated bundle of options.
          onChange({
            ...value,
            vizPreset: next,
            ...PRESET_BUNDLES[next],
            // Presets still drive the forces; the sliders below override after.
            charge: PRESET_CHARGE[next] ?? DEFAULT_CHARGE,
            linkDistance: next === 'galaxy' ? 28 : 18,
          });
        }}
      />
      <SelectRow
        label="Node shape"
        value={value.nodeShape}
        options={[
          { value: 'sphere',       label: 'Sphere' },
          { value: 'cube',         label: 'Cube' },
          { value: 'octahedron',   label: 'Octahedron' },
          { value: 'tetrahedron',  label: 'Tetrahedron' },
          { value: 'icosahedron',  label: 'Icosahedron' },
          { value: 'torus',        label: 'Torus' },
        ]}
        onChange={(v) => patch({ nodeShape: v as NodeShape })}
      />
      <ToggleRow
        label="Wireframe"
        on={value.wireframe}
        onChange={(on) => patch({ wireframe: on })}
      />
      <SelectRow
        label="Labels"
        value={value.labelMode}
        options={[
          { value: 'hover', label: 'On hover only' },
          { value: 'always', label: 'Always visible (2D)' },
        ]}
        onChange={(v) => patch({ labelMode: v as GraphAppearance['labelMode'] })}
      />

      <SliderRow
        label={`Node size ${value.nodeSizeScale.toFixed(1)}×`}
        min={0.5} max={3.0} step={0.1}
        value={value.nodeSizeScale}
        onChange={(v) => patch({ nodeSizeScale: v })}
      />
      <SliderRow
        label={`Link width ${value.linkWidth.toFixed(1)}`}
        min={1} max={6} step={0.5}
        value={value.linkWidth}
        onChange={(v) => patch({ linkWidth: v })}
      />
      <SliderRow
        label={`Link opacity ${value.linkOpacity.toFixed(2)}`}
        min={0.2} max={1} step={0.05}
        value={value.linkOpacity}
        onChange={(v) => patch({ linkOpacity: v })}
      />
      <SliderRow
        label={`Edge curve ${value.edgeCurve.toFixed(2)}`}
        min={0} max={0.6} step={0.05}
        value={value.edgeCurve}
        onChange={(v) => patch({ edgeCurve: v })}
      />

      <ToggleRow
        label="Particles"
        on={value.particles}
        onChange={(on) => patch({ particles: on })}
      />
      {value.particles && (
        <SliderRow
          label={`Particle speed ${value.particleSpeed.toFixed(3)}`}
          min={0.001} max={0.02} step={0.001}
          value={value.particleSpeed}
          onChange={(v) => patch({ particleSpeed: v })}
        />
      )}

      <SelectRow
        label="Controls"
        value={value.controlType}
        options={[
          { value: 'orbit', label: 'Orbit (calm)' },
          { value: 'trackball', label: 'Trackball (free)' },
          { value: 'fly', label: 'Fly' },
        ]}
        onChange={(v) => patch({ controlType: v as GraphAppearance['controlType'] })}
      />
      <SelectRow
        label="Background"
        value={value.background}
        options={[
          { value: 'midnight', label: 'Midnight' },
          { value: 'dark', label: 'Dark' },
          { value: 'pure-black', label: 'Pure black' },
        ]}
        onChange={(v) => patch({ background: v as GraphAppearance['background'] })}
      />
      <ToggleRow
        label="Cluster tint (by source)"
        on={value.clusterColoring}
        onChange={(on) => patch({ clusterColoring: on })}
      />

      <div className="mt-1 pt-2 border-t border-white/5 flex flex-col gap-2">
        <span className="text-[8px] font-black uppercase tracking-widest text-purple-300/80">Forces</span>
        <SliderRow
          label={`Repulsion ${Math.round(-value.charge)}`}
          min={20} max={400} step={10}
          value={-value.charge}
          onChange={(v) => patch({ charge: -v })}
        />
        <SliderRow
          label={`Link distance ${value.linkDistance}`}
          min={6} max={80} step={2}
          value={value.linkDistance}
          onChange={(v) => patch({ linkDistance: v })}
        />
      </div>
    </div>
  );
};


const labelIdFrom = (prefix: string, label: string): string => `${prefix}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

const SliderRow: React.FC<{ label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }> = ({ label, min, max, step, value, onChange }) => {
  const labelId = labelIdFrom('lineage-slider-label', label);
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-[8px] font-mono uppercase tracking-widest text-zinc-400">{label}</span>
      <SlideTrack min={min} max={max} step={step} value={value} onChange={onChange} className="w-full" ariaLabelledBy={labelId} />
    </div>
  );
};


/** Compact inline range for the footer bar: "Label [====O==] 220". */
const FooterRange: React.FC<{ label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }> = ({ label, min, max, step, value, onChange }) => {
  const labelId = labelIdFrom('lineage-footer-range-label', label);
  return (
    <div className="flex items-center gap-1.5">
      <span id={labelId} className="text-zinc-400">{label}</span>
      <SlideTrack min={min} max={max} step={step} value={value} onChange={onChange} className="w-24" ariaLabelledBy={labelId} />
      <span className="text-zinc-300 tabular-nums w-7 text-right">{value}</span>
    </div>
  );
};


const ToggleRow: React.FC<{ label: string; on: boolean; onChange: (on: boolean) => void }> = ({ label, on, onChange }) => (
  <button
    onClick={() => onChange(!on)}
    className="flex items-center justify-between text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:text-white px-1 py-1 rounded hover:bg-white/5"
  >
    <span>{label}</span>
    <span className={`text-[8px] ${on ? 'text-emerald-300' : 'text-zinc-600'}`}>{on ? 'ON' : 'OFF'}</span>
  </button>
);


const SelectRow: React.FC<{ label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void }> = ({ label, value, options, onChange }) => (
  <label className="flex flex-col gap-0.5">
    <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-400">{label}</span>
    <select
      name={`lineage-select-${label.toLowerCase().replace(/\s+/g, '-')}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="compact-input bg-black/40 text-[10px]"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  </label>
);


/** Interactive 3D force-directed graph using react-force-graph-3d.
 *  Camera auto-fits to the connected subgraph on first render so the
 *  user lands on something usable instead of a dot in the distance.
 *  Appearance controlled via the AppearancePanel side drawer. */
const Graph3DView: React.FC<{
  payload: GraphPayload;
  highlight: string | null;
  appearance: GraphAppearance;
}> = ({ payload, highlight, appearance }) => {
  // Same filter as Genealogy: drop nodes that don't participate in any
  // relation, otherwise 100+ disconnected dots dominate the view.
  const connected = useMemo(() => {
    const involved = new Set<string>();
    const allEdges = payload?.edges ?? [];
    const allNodes = payload?.nodes ?? [];
    allEdges.forEach((e) => {
      involved.add(e.from_id);
      involved.add(e.to_id);
    });
    const nodes = allNodes.filter((n) => involved.has(n.id));
    const idSet = new Set(nodes.map((n) => n.id));
    const edges = allEdges.filter(
      (e) => idSet.has(e.from_id) && idSet.has(e.to_id),
    );
    return { nodes, edges };
  }, [payload]);

  // Graphrag-workbench-style search: when the query is non-empty, nodes
  // whose name/prompt/model don't substring-match are visually muted
  // (gray, low alpha) and their incident edges are dimmed. Empty query
  // disables the filter. Matching is case-insensitive.
  //
  // The needle is debounced (~150ms) so per-keystroke typing doesn't
  // re-mount Three.js node groups via the `data` useMemo below — on
  // larger graphs that mid-typing churn is what causes the search input
  // to feel sluggish. Empty query clears immediately so the user sees
  // the unfiltered graph as soon as they hit backspace through the box.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchNeedle, setSearchNeedle] = useState('');
  useEffect(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    if (!trimmed) {
      setSearchNeedle('');
      return;
    }
    const handle = window.setTimeout(() => setSearchNeedle(trimmed), 150);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);
  const matchSet = useMemo(() => {
    if (!searchNeedle) return null;
    const out = new Set<string>();
    for (const n of connected.nodes) {
      const haystack = `${n.title ?? ''} ${n.id} ${n.source ?? ''} ${n.model ?? ''}`.toLowerCase();
      if (haystack.includes(searchNeedle)) out.add(n.id);
    }
    return out;
  }, [searchNeedle, connected.nodes]);

  const data = useMemo(
    () => ({
      nodes: connected.nodes.map((n) => {
        const isMatch = matchSet === null || matchSet.has(n.id);
        const baseColor = n.id === highlight ? '#fbbf24' : pickNodeColor(n);
        return {
          id: n.id,
          name: n.title ?? n.id,
          title: n.title ?? '',
          source: n.source ?? '',
          model: n.model ?? '',
          val: (4 + Math.log10(1 + (n.duration_sec ?? 1)) * 6) * appearance.nodeSizeScale,
          color: isMatch ? baseColor : '#2a2336',
          // expose match flag so labelHtml / future hover hooks can read it
          __searchDim: !isMatch,
        };
      }),
      links: connected.edges.map((e) => {
        const isMatch =
          matchSet === null || (matchSet.has(e.from_id) && matchSet.has(e.to_id));
        const baseColor = EDGE_COLOR_BY_KIND[e.kind] ?? '#a78bfa';
        return {
          source: e.from_id,
          target: e.to_id,
          kind: e.kind,
          color: isMatch ? baseColor : '#1c1828',
          __searchDim: !isMatch,
        };
      }),
    }),
    [connected, highlight, appearance.nodeSizeScale, matchSet],
  );
  // react-force-graph mutates these node objects in place with x/y/z during
  // layout; the flight loop reads them through this ref for the cluster center.
  const dataRef = useRef(data);
  dataRef.current = data;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  // Hover state. Stored as state so the useEffect below can run a
  // Three.js scene traversal to dim per-node meshes on each hover
  // change. Data useMemo intentionally does NOT depend on hoveredId,
  // so changing hover doesn't restart the force layout — only the
  // link callbacks and the mesh-dim effect run.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const forceHoverIntentRef = useRef<number | null>(null);
  const clearForceHoverIntent = useCallback(() => {
    if (forceHoverIntentRef.current != null) {
      window.clearTimeout(forceHoverIntentRef.current);
      forceHoverIntentRef.current = null;
    }
  }, []);
  const handleNodeHover = useCallback((node: { id?: string } | null) => {
    clearForceHoverIntent();
    const nextId = node?.id ?? null;
    if (!nextId) {
      setHoveredId(null);
      return;
    }
    forceHoverIntentRef.current = window.setTimeout(() => {
      setHoveredId(nextId);
      forceHoverIntentRef.current = null;
    }, LINEAGE_HOVER_INTENT_MS);
  }, [clearForceHoverIntent]);
  useEffect(() => () => clearForceHoverIntent(), [clearForceHoverIntent]);

  // Click-to-select drives the node-details slide-out panel on the
  // right edge of the graph container. null = no selection (panel
  // hidden).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const handleNodeClick = (node: { id?: string } | null) => {
    if (!node?.id) return;
    setSelectedId((cur) => (cur === node.id ? null : node.id ?? null));
  };

  // Spaceship flight state. `flyRef` exposes imperative jumps to the Home/FTL
  // buttons; `centroidRef` is the settled cluster center (set on engine stop);
  // `streakRef` holds the lazily-built hyperspace streak mesh (disposed on
  // unmount); `farFromHome` toggles the prominent "return" affordance.
  const flyRef = useRef<{ flyHome: () => void; flyForward: () => void }>({ flyHome: () => {}, flyForward: () => {} });
  const centroidRef = useRef<{ x: number; y: number; z: number; radius: number } | null>(null);
  const streakRef = useRef<unknown>(null);
  const vignetteRef = useRef<HTMLDivElement>(null);
  const [farFromHome, setFarFromHome] = useState(false);

  // Right-click on a graph node opens the shared ContextMenu primitive
  // (plan step 3d rollout to graph nodes). Actions are navigation +
  // routing — "go to / open / send" — kept distinct from the per-entry
  // library row menu which has analysis / stems / midi processing
  // actions. Re-using react-force-graph's onNodeRightClick which
  // hands us both the node and the underlying DOM MouseEvent.
  const nodeMenu = useContextMenu<{ nodeId: string; nodeName: string }>();
  const handleNodeRightClick = (
    node: { id?: string; name?: string } | null,
    event: MouseEvent,
  ) => {
    if (!node?.id) return;
    event.preventDefault();
    nodeMenu.open(event, {
      nodeId: node.id,
      nodeName: node.name ?? node.id,
    });
  };
  // Neighbor adjacency for the mesh-dim effect below. Rebuilt only
  // when data changes — cheap for small graphs.
  // Directed adjacency (parent → child) for the lineage hover. Built from the
  // connected edges so a hover can walk N generations up and down.
  const dirAdj = useMemo(() => {
    const childrenOf: Record<string, string[]> = {};
    const parentsOf: Record<string, string[]> = {};
    for (const e of connected.edges) {
      (childrenOf[e.from_id] = childrenOf[e.from_id] || []).push(e.to_id);
      (parentsOf[e.to_id] = parentsOf[e.to_id] || []).push(e.from_id);
    }
    return { childrenOf, parentsOf };
  }, [connected]);

  const lineage = useMemo(
    () => computeLineage(hoveredId, dirAdj.parentsOf, dirAdj.childrenOf),
    [hoveredId, dirAdj],
  );

  // Node-mesh dimming on hover. Walks the Three.js scene; each node
  // group has been tagged with userData.nodeId by nodeThreeObject, and
  // its materials carry userData.baseOpacity. When a node is hovered,
  // non-neighbor groups drop to baseOpacity * 0.15; everything snaps
  // back to baseOpacity when the cursor leaves.
  useEffect(() => {
    if (appearance.renderMode !== '3d') return;
    type SceneLike = { traverse: (cb: (obj: unknown) => void) => void };
    type MeshLike = {
      isMesh?: boolean;
      material?: { opacity?: number; userData?: { baseOpacity?: number } };
      parent?: { userData?: { nodeId?: string } };
    };
    // Ease each mesh's opacity toward its lineage target (no flash). Runs a
    // rAF until everything settles, then stops; a hover change re-runs the
    // effect and restarts the tween toward the new targets.
    let raf = 0;
    const apply = () => {
      const ref = fgRef.current as { scene?: () => unknown } | null;
      const scene = ref?.scene?.() as SceneLike | undefined;
      if (!scene || typeof scene.traverse !== 'function') { raf = requestAnimationFrame(apply); return; }
      let animating = false;
      scene.traverse((obj: unknown) => {
        const m = obj as MeshLike;
        if (!m.isMesh || !m.material) return;
        const base = m.material.userData?.baseOpacity;
        if (typeof base !== 'number') return;
        const ownerId = m.parent?.userData?.nodeId;
        if (!ownerId) return;
        const target = !hoveredId ? base : base * lineageOpacity(lineage.has(ownerId));
        const cur = m.material.opacity ?? base;
        const diff = target - cur;
        if (Math.abs(diff) < 0.004) { m.material.opacity = target; return; }
        m.material.opacity = cur + diff * 0.028;
        animating = true;
      });
      raf = animating ? requestAnimationFrame(apply) : 0;
    };
    raf = requestAnimationFrame(apply);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [hoveredId, lineage, appearance.renderMode, data]);

  // Fit-to-view at three checkpoints so we catch both early- and late-
  // settling force layouts. Without this the camera lingers at its
  // default position and the user sees one disconnected dot far off
  // in z-space.
  //
  // Tighter padding (was 80 → 12) so the cluster fills the viewport.
  // d3Force tweaks pull nodes closer: weaker repulsive charge (was
  // ~-300 default → -90) and shorter link distance (was ~30 default →
  // 18) trade out-of-cluster breathing room for in-cluster density.
  useEffect(() => {
    const ref = fgRef.current as {
      d3Force?: (forceName: string) => {
        strength?: (n: number) => void;
        distance?: (n: number | ((l: unknown) => number)) => void;
      } | null;
    } | null;
    if (ref?.d3Force) {
      ref.d3Force('charge')?.strength?.(appearance.charge);
      ref.d3Force('link')?.distance?.(appearance.linkDistance);
    }
    const timeouts = [350, 1200, 2500].map((ms) =>
      setTimeout(() => {
        const r = fgRef.current as {
          zoomToFit?: (ms: number, pad: number) => void;
          centerAt?: (x: number, y: number, ms: number) => void;
        } | null;
        if (r?.zoomToFit) r.zoomToFit(600, 12);
        if (r?.centerAt) r.centerAt(0, 0, 600);
      }, ms),
    );
    return () => timeouts.forEach(clearTimeout);
  }, [data, appearance.renderMode, appearance.vizPreset, appearance.charge, appearance.linkDistance]);

  // Cluster tint: when ON (and 3D), add a translucent halo sphere
  // centered on each per-source centroid so the user can see source-
  // grouping at a glance. Recomputed after a settle delay AND on every
  // engine stop event (see `onEngineStop` on ForceGraph3D below) so the
  // halos re-anchor after the user drags nodes around or after a
  // relayout. Toggling OFF or unmounting removes the spheres.
  const rebuildClusterHalos = useCallback(async () => {
    if (appearance.renderMode !== '3d') return;
    if (!appearance.clusterColoring) return;
    const THREE = threeRef.current ?? (await import('three'));
    threeRef.current = THREE;
    const ref = fgRef.current as { scene?: () => unknown } | null;
    const scene = (ref?.scene?.() ?? null) as
      | (import('three').Object3D & {
          getObjectByName?: (n: string) => import('three').Object3D | undefined;
          remove?: (o: import('three').Object3D) => void;
          add?: (o: import('three').Object3D) => void;
        })
      | null;
    if (!scene?.add) return;
    const prior = scene.getObjectByName?.('__lineage_clusters__');
    if (prior) scene.remove?.(prior);

    // react-force-graph stores resolved positions on the node objects
    // themselves (x/y/z). After settle they're populated.
    type PositionedNode = {
      id?: string;
      source?: string;
      x?: number;
      y?: number;
      z?: number;
    };
    const positions: PositionedNode[] = (
      data.nodes as unknown as PositionedNode[]
    ).filter((n) => typeof n.x === 'number' && typeof n.y === 'number');
    if (positions.length === 0) return;

    const groups = new Map<string, PositionedNode[]>();
    for (const n of positions) {
      const src = n.source || 'other';
      if (!groups.has(src)) groups.set(src, []);
      groups.get(src)!.push(n);
    }

    const group = new THREE.Group();
    group.name = '__lineage_clusters__';
    for (const [source, members] of groups) {
      if (members.length < 2) continue;
      let cx = 0,
        cy = 0,
        cz = 0;
      for (const m of members) {
        cx += m.x ?? 0;
        cy += m.y ?? 0;
        cz += m.z ?? 0;
      }
      cx /= members.length;
      cy /= members.length;
      cz /= members.length;
      let maxR = 0;
      for (const m of members) {
        const dx = (m.x ?? 0) - cx;
        const dy = (m.y ?? 0) - cy;
        const dz = (m.z ?? 0) - cz;
        maxR = Math.max(maxR, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      const radius = Math.max(20, maxR * 1.15);
      const tintHex = CLUSTER_TINT_BY_SOURCE[source] ?? '#7c3aed';
      const geo = new THREE.SphereGeometry(radius, 24, 16);
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(tintHex),
        transparent: true,
        opacity: 0.07,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      mat.userData.baseOpacity = 0.07;
      const sphere = new THREE.Mesh(geo, mat);
      sphere.position.set(cx, cy, cz);
      group.add(sphere);
    }
    scene.add(group);
  }, [appearance.clusterColoring, appearance.renderMode, data]);

  useEffect(() => {
    if (appearance.renderMode !== '3d') return;
    if (!appearance.clusterColoring) {
      // Just clean any leftover.
      const ref = fgRef.current as { scene?: () => unknown } | null;
      const scene = (ref?.scene?.() ?? null) as
        | (import('three').Object3D & {
            getObjectByName?: (n: string) => import('three').Object3D | undefined;
            remove?: (o: import('three').Object3D) => void;
          })
        | null;
      if (scene) {
        const prior = scene.getObjectByName?.('__lineage_clusters__');
        if (prior) scene.remove?.(prior);
      }
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      void rebuildClusterHalos();
    }, 2800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      const ref = fgRef.current as { scene?: () => unknown } | null;
      const scene = (ref?.scene?.() ?? null) as
        | (import('three').Object3D & {
            getObjectByName?: (n: string) => import('three').Object3D | undefined;
            remove?: (o: import('three').Object3D) => void;
          })
        | null;
      const prior = scene?.getObjectByName?.('__lineage_clusters__');
      if (prior && scene?.remove) scene.remove(prior);
    };
  }, [appearance.clusterColoring, appearance.renderMode, rebuildClusterHalos]);

  // Inject a starfield + ambient/point lights into the underlying
  // Three.js scene once it exists. Used by every 3D preset, so the
  // graph never looks like it's floating in a black void.
  //
  // Wrapped in a deferred handle so the heavy 1500-point geometry build
  // doesn't block the React commit phase — that pile-on is what triggers
  // "[Violation] 'message' handler took Xms" on initial modal open.
  useEffect(() => {
    if (appearance.renderMode !== '3d') return;
    let teardown: (() => void) | null = null;
    let cancelled = false;
    type IdleCb = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    const schedule = (fn: () => void) => {
      if (typeof ric === 'function') ric(fn, { timeout: 500 });
      else setTimeout(fn, 0);
    };
    schedule(() => {
      if (cancelled) return;
      const setup = setupStarfield();
      if (setup) teardown = setup;
    });
    return () => {
      cancelled = true;
      teardown?.();
    };

    function setupStarfield(): (() => void) | null {
    const THREE = threeRef.current;
    const ref = fgRef.current as { scene?: () => unknown } | null;
    if (!THREE || !ref?.scene) return null;
    const scene = ref.scene() as import('three').Scene;
    if (!scene) return null;

    // Wipe any prior starfield from a previous mount.
    const prior = scene.getObjectByName('__lineage_stars__');
    if (prior) scene.remove(prior);
    const priorLight = scene.getObjectByName('__lineage_ambient__');
    if (priorLight) scene.remove(priorLight);

    const starsGeo = new THREE.BufferGeometry();
    const STAR_COUNT = 1500;
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);
    const palette = [
      new THREE.Color('#a78bfa'),
      new THREE.Color('#60a5fa'),
      new THREE.Color('#34d399'),
      new THREE.Color('#f472b6'),
      new THREE.Color('#fbbf24'),
      new THREE.Color('#ffffff'),
    ];
    for (let i = 0; i < STAR_COUNT; i += 1) {
      // Sphere of radius 1200 around origin — far enough that nodes
      // never visually overlap the starfield.
      const r = 800 + Math.random() * 800;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      const c = palette[Math.floor(Math.random() * palette.length)];
      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    starsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starsGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const starsMat = new THREE.PointsMaterial({
      size: 1.8,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      sizeAttenuation: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(starsGeo, starsMat);
    stars.name = '__lineage_stars__';
    scene.add(stars);

    // Soft ambient + a colored point light so emissive haloes pop a
    // little even when the camera is far away.
    const ambient = new THREE.AmbientLight(0x9580ff, 0.55);
    ambient.name = '__lineage_ambient__';
    scene.add(ambient);

    return () => {
      scene.remove(stars);
      scene.remove(ambient);
      starsGeo.dispose();
      starsMat.dispose();
    };
    }
  }, [appearance.renderMode, appearance.vizPreset, data]);

  // Tron-grid preset: lay a glowing ground GridHelper under the nodes,
  // injected straight into the Three.js scene (like the starfield) and
  // removed whenever any other preset is active.
  useEffect(() => {
    if (appearance.renderMode !== '3d') return;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    const removeExisting = () => {
      const ref = fgRef.current as { scene?: () => unknown } | null;
      const scene = (ref?.scene?.() ?? null) as import('three').Scene | null;
      const prior = scene?.getObjectByName('__lineage_grid__');
      if (prior && scene) scene.remove(prior);
    };
    const run = async () => {
      const THREE = threeRef.current ?? (await import('three'));
      threeRef.current = THREE;
      if (cancelled) return;
      const ref = fgRef.current as { scene?: () => unknown } | null;
      const scene = (ref?.scene?.() ?? null) as import('three').Scene | null;
      if (!scene) return;
      removeExisting();
      if (appearance.vizPreset !== 'tron-grid') return;
      const grid = new THREE.GridHelper(1400, 70, 0x22d3ee, 0x0e7490);
      grid.name = '__lineage_grid__';
      const mat = grid.material as import('three').Material & {
        opacity?: number;
        transparent?: boolean;
      };
      mat.transparent = true;
      mat.opacity = 0.22;
      grid.position.y = -140;
      scene.add(grid);
      teardown = () => {
        scene.remove(grid);
        grid.geometry.dispose();
      };
    };
    const t = setTimeout(() => void run(), 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
      teardown?.();
      removeExisting();
    };
  }, [appearance.renderMode, appearance.vizPreset, data]);

  // Selection "handle": scale the selected node's group up so both the
  // click target and the visual selection read clearly. Walks the scene
  // like the hover-dim effect; resets every group to 1 when nothing is
  // selected. (Node groups carry userData.nodeId from nodeThreeObject.)
  useEffect(() => {
    if (appearance.renderMode !== '3d') return;
    const ref = fgRef.current as { scene?: () => unknown } | null;
    const scene = (ref?.scene?.() ?? null) as {
      traverse?: (cb: (o: unknown) => void) => void;
    } | null;
    if (!scene?.traverse) return;
    type GroupLike = {
      userData?: { nodeId?: string };
      scale?: { setScalar?: (n: number) => void };
    };
    scene.traverse((obj: unknown) => {
      const g = obj as GroupLike;
      const id = g.userData?.nodeId;
      if (!id || !g.scale?.setScalar) return;
      g.scale.setScalar(id === selectedId ? 1.8 : 1);
    });
  }, [selectedId, appearance.renderMode, data]);

  // Spaceship flight (3D). A single rAF loop integrates a velocity from the
  // held keys (W/S forward, A/D strafe, Q/E up-down, arrows too) with ease-in
  // acceleration and exponential drag, so holding a key accelerates and
  // releasing coasts then smoothly stops to a hover. Shift = afterburner. F
  // (or the FTL button) fires a hyperspace jump with a star-streak; the Home
  // button FTLs back to the cluster. Ignored while typing in the search box.
  useEffect(() => {
    if (appearance.renderMode !== '3d') return;
    const FLY = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
    const keys = new Set<string>();
    let raf = 0;
    let last = 0;
    let vx = 0, vy = 0, vz = 0;     // world-space velocity
    let ftlHeld = false;            // F held → continuous warp
    let ftlPulseUntil = 0;          // tap / FTL button → brief warp window (rAF-clock ms)
    let ftlVis = 0;                 // 0..1 warp visual (streak + vignette)
    let homeTween: null | { t: number; dur: number; px: number; py: number; pz: number; tx: number; ty: number; tz: number; mx: number; my: number; mz: number; lx: number; ly: number; lz: number } = null;
    let wasFar = false;
    let frame = 0;

    type FgApi = {
      camera?: () => import('three').PerspectiveCamera;
      controls?: () => { target?: import('three').Vector3; update?: () => void } | null;
      scene?: () => import('three').Scene;
    };
    const getCtx = () => {
      const THREE = threeRef.current;
      const ref = fgRef.current as FgApi | null;
      if (!THREE || !ref?.camera) return null;
      return { THREE, cam: ref.camera(), controls: ref.controls?.() ?? null, scene: ref.scene?.() ?? null };
    };

    // Hyperspace streaks: additive near-white LineSegments ringing the flight
    // axis, scaled along z with the warp intensity.
    const ensureStreak = (THREE: typeof import('three'), scene: import('three').Scene) => {
      if (streakRef.current) return streakRef.current as import('three').LineSegments;
      const N = 600;
      const arr = new Float32Array(N * 6);
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + (i % 11);
        const r = 10 + ((i * 53) % 260);
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        const z = -((i * 37) % 700);
        arr[i * 6] = x; arr[i * 6 + 1] = y; arr[i * 6 + 2] = z;
        arr[i * 6 + 3] = x; arr[i * 6 + 4] = y; arr[i * 6 + 5] = z + 6;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const seg = new THREE.LineSegments(geo, mat);
      seg.frustumCulled = false;
      scene.add(seg);
      streakRef.current = seg;
      return seg;
    };

    // FTL forward = a hefty velocity impulse (a tap launches you far). Holding F
    // keeps `ftlHeld` true so the loop keeps thrusting at warp speed.
    const impulse = () => {
      const ctx = getCtx();
      if (!ctx) return;
      const f = new ctx.THREE.Vector3();
      ctx.cam.getWorldDirection(f);
      vx += f.x * 4200; vy += f.y * 4200; vz += f.z * 4200;
    };
    const flyForward = () => { impulse(); ftlPulseUntil = last + 800; };
    const flyHome = () => {
      const ctx = getCtx();
      const c = centroidRef.current;
      if (!ctx || !c) return;
      const d = Math.max(180, c.radius * 2.4);
      homeTween = {
        t: 0, dur: 1.3,
        px: ctx.cam.position.x, py: ctx.cam.position.y, pz: ctx.cam.position.z,
        tx: c.x + d * 0.3, ty: c.y + d * 0.25, tz: c.z + d,
        mx: ctx.controls?.target?.x ?? c.x, my: ctx.controls?.target?.y ?? c.y, mz: ctx.controls?.target?.z ?? c.z,
        lx: c.x, ly: c.y, lz: c.z,
      };
      vx = vy = vz = 0;
    };
    flyRef.current = { flyHome, flyForward };

    const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
      last = t;
      // Idle-gate: when there's no flight input, residual motion, or warp active
      // (and the cluster centroid is already known), skip the entire per-frame
      // flight/centroid/warp computation. The rAF is already re-queued above, so
      // an idle graph costs ~nothing instead of walking every node + running
      // camera math each frame — the main continuous CPU cost of the 3D view.
      const moving =
        keys.size > 0 || ftlHeld || t < ftlPulseUntil || !!homeTween ||
        Math.hypot(vx, vy, vz) >= 0.06 || ftlVis >= 0.01;
      if (!moving && centroidRef.current) return;
      const ctx = getCtx();
      if (!ctx) return;
      const { THREE, cam, controls, scene } = ctx;

      // Refresh cluster center/radius from the engine's live node positions
      // (react-force-graph mutates these objects in place), robust to
      // engine-stop timing, so Home + the far affordance work.
      frame += 1;
      if (!centroidRef.current || frame % 45 === 0) {
        const ns = dataRef.current.nodes as unknown as Array<{ x?: number; y?: number; z?: number }>;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const p of ns) {
          if (typeof p.x !== 'number') continue;
          sx += p.x; sy += p.y ?? 0; sz += p.z ?? 0; cnt += 1;
        }
        if (cnt >= 2) {
          const cx = sx / cnt, cy = sy / cnt, cz = sz / cnt;
          let rad = 0;
          for (const p of ns) {
            if (typeof p.x !== 'number') continue;
            rad = Math.max(rad, Math.hypot(p.x - cx, (p.y ?? 0) - cy, (p.z ?? 0) - cz));
          }
          centroidRef.current = { x: cx, y: cy, z: cz, radius: rad || 120 };
        }
      }

      // Warp visuals (streak + radial motion-blur vignette), eased so they fade
      // in/out smoothly whether warping via hold-F, a tap, or the Home jump.
      const warp = ftlHeld || t < ftlPulseUntil;
      const ftlActive = warp || !!homeTween;
      ftlVis += ((ftlActive ? 1 : 0) - ftlVis) * (ftlActive ? 0.16 : 0.07);
      if (scene && ftlVis > 0.01) {
        const seg = ensureStreak(THREE, scene);
        (seg.material as import('three').LineBasicMaterial).opacity = 0.95 * ftlVis;
        seg.position.copy(cam.position);
        const fdir = new THREE.Vector3();
        cam.getWorldDirection(fdir);
        seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fdir.multiplyScalar(-1));
        seg.scale.set(1, 1, 1 + ftlVis * 60);
      } else if (streakRef.current) {
        ((streakRef.current as import('three').LineSegments).material as import('three').LineBasicMaterial).opacity = 0;
      }
      if (vignetteRef.current) vignetteRef.current.style.opacity = String(Math.min(1, ftlVis));

      // Home warp: eased precise move to the cluster framing.
      if (homeTween) {
        homeTween.t += dt;
        const p = Math.min(1, homeTween.t / homeTween.dur);
        const e = easeInOut(p);
        cam.position.set(homeTween.px + (homeTween.tx - homeTween.px) * e, homeTween.py + (homeTween.ty - homeTween.py) * e, homeTween.pz + (homeTween.tz - homeTween.pz) * e);
        if (controls?.target) {
          controls.target.set(homeTween.mx + (homeTween.lx - homeTween.mx) * e, homeTween.my + (homeTween.ly - homeTween.my) * e, homeTween.mz + (homeTween.lz - homeTween.mz) * e);
          controls.update?.();
        }
        if (p >= 1) homeTween = null;
        return;
      }

      // Velocity flight (+ FTL forward thrust while warping).
      const boost = keys.has('shift');
      const accelMag = boost ? 1100 : 420;
      let maxSpeed = boost ? 1600 : 560;
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize();
      const up = cam.up;
      let ax = 0, ay = 0, az = 0;
      const add = (v: import('three').Vector3, s: number) => { ax += v.x * s; ay += v.y * s; az += v.z * s; };
      if (keys.has('w') || keys.has('arrowup')) add(fwd, 1);
      if (keys.has('s') || keys.has('arrowdown')) add(fwd, -1);
      if (keys.has('d') || keys.has('arrowright')) add(right, 1);
      if (keys.has('a') || keys.has('arrowleft')) add(right, -1);
      if (keys.has('e')) add(up, 1);
      if (keys.has('q')) add(up, -1);
      const aLen = Math.hypot(ax, ay, az);
      if (aLen > 0) { ax = (ax / aLen) * accelMag; ay = (ay / aLen) * accelMag; az = (az / aLen) * accelMag; }
      if (warp) { ax += fwd.x * 9000; ay += fwd.y * 9000; az += fwd.z * 9000; maxSpeed = 9000; }
      vx += ax * dt; vy += ay * dt; vz += az * dt;
      const sp0 = Math.hypot(vx, vy, vz);
      // Light drag while warping/fast (carry the boost far); coast-to-stop when
      // slow and idle.
      const fast = warp || sp0 > 700;
      const damp = Math.pow(fast ? 0.86 : (aLen > 0 ? 0.45 : 0.05), dt);
      vx *= damp; vy *= damp; vz *= damp;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > maxSpeed) { const f = maxSpeed / sp; vx *= f; vy *= f; vz *= f; }
      if (sp > 0.06) {
        cam.position.x += vx * dt; cam.position.y += vy * dt; cam.position.z += vz * dt;
        if (controls?.target) {
          controls.target.x += vx * dt; controls.target.y += vy * dt; controls.target.z += vz * dt;
          controls.update?.();
        }
      }

      // Far affordance: the normal fit distance is ~2.5× the cluster radius, so
      // "lost" means much farther, or flown past so the cluster is behind you.
      const c = centroidRef.current;
      if (c) {
        const dx = c.x - cam.position.x, dy = c.y - cam.position.y, dz = c.z - cam.position.z;
        const dist = Math.hypot(dx, dy, dz) || 1;
        const cos = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / dist; // 1 = dead ahead, <0 = behind
        const lost = dist > c.radius * 5 || (cos < 0 && dist > c.radius * 2.5);
        const back = dist < c.radius * 4 && cos > 0.2;
        const far = wasFar ? !back : lost;
        if (far !== wasFar) { wasFar = far; setFarFromHome(far); }
      }
    };
    raf = requestAnimationFrame(loop);

    const onDown = (ev: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const k = ev.key.toLowerCase();
      if (k === 'f') { ev.preventDefault(); if (!ftlHeld) { ftlHeld = true; impulse(); } return; }
      if (k === 'shift') { keys.add('shift'); return; }
      if (FLY.has(k)) { keys.add(k); ev.preventDefault(); }
    };
    const onUp = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase();
      if (k === 'f') ftlHeld = false;
      else keys.delete(k);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      if (vignetteRef.current) vignetteRef.current.style.opacity = '0';
      flyRef.current = { flyHome: () => {}, flyForward: () => {} };
    };
  }, [appearance.renderMode]);

  // Dispose the streak mesh on unmount (three objects must be freed manually).
  useEffect(() => () => {
    const seg = streakRef.current as { geometry?: { dispose?: () => void }; material?: { dispose?: () => void }; parent?: { remove?: (o: unknown) => void } } | null;
    if (!seg) return;
    seg.parent?.remove?.(seg);
    seg.geometry?.dispose?.();
    seg.material?.dispose?.();
    streakRef.current = null;
  }, []);

  if (connected.nodes.length === 0) {
    return (
      <p className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-500 italic px-12 text-center">
        No relationships yet. Generate a Chimera, separate stems, or convert
        a track to MIDI to start populating the graph.
      </p>
    );
  }

  const bgColor = BG_COLORS[appearance.background];

  const labelHtml = (n: { name: string; source: string; model: string }) =>
    `<div style="font-family: monospace; font-size: 11px; padding: 6px 8px; background: rgba(12,8,24,0.95); border: 1px solid rgba(168,85,247,0.5); border-radius: 4px; max-width: 280px; word-wrap: break-word; overflow-wrap: anywhere; white-space: normal; line-height: 1.3;">
        <div style="color: #e5e5e5; font-weight: 700; word-wrap: break-word;">${escapeHtml(n.name)}</div>
        <div style="color: #a3a3a3; font-size: 10px;">${escapeHtml(n.source)} · ${escapeHtml(n.model)}</div>
      </div>`;

  // Build a Three.js mesh per node based on the chosen shape +
  // wireframe flag. Lazy-imports three only when the 3D mode is on
  // so 2D users don't pay the bundle cost.
  const buildNodeObject = useMemo(() => {
    let THREE: typeof import('three') | null = null;
    return async (
      node: { color?: string; val?: number },
    ): Promise<unknown> => {
      if (!THREE) {
        THREE = await import('three');
      }
      const t = THREE;
      const size = Math.cbrt(node.val ?? 4);
      let geometry: import('three').BufferGeometry;
      switch (appearance.nodeShape) {
        case 'cube':
          geometry = new t.BoxGeometry(size, size, size);
          break;
        case 'octahedron':
          geometry = new t.OctahedronGeometry(size * 0.85);
          break;
        case 'tetrahedron':
          geometry = new t.TetrahedronGeometry(size);
          break;
        case 'icosahedron':
          geometry = new t.IcosahedronGeometry(size * 0.85);
          break;
        case 'torus':
          geometry = new t.TorusGeometry(size * 0.7, size * 0.25, 8, 16);
          break;
        case 'sphere':
        default:
          geometry = new t.SphereGeometry(size, 12, 12);
          break;
      }
      const color = new t.Color(node.color ?? '#a78bfa');
      const material = new t.MeshBasicMaterial({
        color,
        wireframe: appearance.wireframe,
        transparent: true,
        opacity: appearance.wireframe ? 0.95 : 0.9,
      });
      const mesh = new t.Mesh(geometry, material);
      return mesh;
    };
    // Re-build when shape OR wireframe toggle changes.
  }, [appearance.nodeShape, appearance.wireframe]);

  // Synchronous wrapper: react-force-graph calls nodeThreeObject
  // synchronously, so we cache the lazy-import promise + render with
  // a placeholder until three is loaded. In practice three loads in
  // <100ms once the user opens the 3D tab.
  const threeRef = useRef<typeof import('three') | null>(null);
  useEffect(() => {
    if (appearance.renderMode !== '3d') return;
    void import('three').then((mod) => {
      threeRef.current = mod;
    });
  }, [appearance.renderMode]);

  const nodeThreeObject = (node: { id?: string; color?: string; val?: number }): unknown => {
    void buildNodeObject;
    const THREE = threeRef.current;
    if (!THREE) return undefined; // first frame: fall through to default sphere
    const size = Math.cbrt(node.val ?? 4);
    let geometry: import('three').BufferGeometry;
    switch (appearance.nodeShape) {
      case 'cube':
        geometry = new THREE.BoxGeometry(size, size, size);
        break;
      case 'octahedron':
        geometry = new THREE.OctahedronGeometry(size * 0.85);
        break;
      case 'tetrahedron':
        geometry = new THREE.TetrahedronGeometry(size);
        break;
      case 'icosahedron':
        geometry = new THREE.IcosahedronGeometry(size * 0.85);
        break;
      case 'torus':
        geometry = new THREE.TorusGeometry(size * 0.7, size * 0.25, 8, 16);
        break;
      case 'sphere':
      default:
        geometry = new THREE.SphereGeometry(size, 16, 16);
        break;
    }
    const colorHex = node.color ?? '#a78bfa';
    const baseColor = new THREE.Color(colorHex);
    // Build a Group so we can stack a wireframe halo + inner solid for
    // the glossy "neon" look the codepens go for.
    const group = new THREE.Group();
    // Tag the group with the node id so the hover-dim effect (which
    // traverses the scene) can find which child meshes belong to which
    // graph node. Each material also carries userData.baseOpacity so
    // the dim/restore math knows the un-dimmed target value.
    group.userData.nodeId = node.id;
    if (appearance.wireframe) {
      const wireMat = new THREE.MeshBasicMaterial({
        color: baseColor,
        wireframe: true,
        transparent: true,
        opacity: 0.95,
      });
      wireMat.userData.baseOpacity = 0.95;
      group.add(new THREE.Mesh(geometry, wireMat));
    } else {
      // Solid inner core + slightly larger translucent "halo" that
      // approximates a glow without needing a postprocessing pass.
      const innerMat = new THREE.MeshBasicMaterial({
        color: baseColor,
        transparent: true,
        opacity: 0.95,
      });
      innerMat.userData.baseOpacity = 0.95;
      group.add(new THREE.Mesh(geometry, innerMat));
      const haloGeo = geometry.clone();
      haloGeo.scale(1.45, 1.45, 1.45);
      const haloMat = new THREE.MeshBasicMaterial({
        color: baseColor,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      haloMat.userData.baseOpacity = 0.22;
      group.add(new THREE.Mesh(haloGeo, haloMat));
    }
    return group;
  };

  return (
    <div className="absolute inset-0" style={{ background: bgColor }}>
      {appearance.renderMode === '3d' ? (
        <ForceGraph3D
          ref={fgRef}
          graphData={data}
          nodeAutoColorBy="source"
          nodeRelSize={7}
          backgroundColor={bgColor}
          showNavInfo={false}
          controlType={appearance.controlType}
          onNodeHover={handleNodeHover}
          onNodeClick={handleNodeClick}
          onNodeRightClick={handleNodeRightClick}
          linkColor={(l: { color?: string; source?: { id?: string } | string; target?: { id?: string } | string }) => {
            if (!hoveredId) return l.color ?? '#a78bfa';
            const srcId = typeof l.source === 'object' ? l.source?.id : l.source;
            const tgtId = typeof l.target === 'object' ? l.target?.id : l.target;
            const onPath = lineage.has(srcId ?? '') && lineage.has(tgtId ?? '');
            return onPath ? (l.color ?? '#a78bfa') : '#1c1828';
          }}
          linkOpacity={appearance.linkOpacity}
          linkWidth={(l: { source?: { id?: string } | string; target?: { id?: string } | string }) => {
            if (!hoveredId) return appearance.linkWidth;
            const srcId = typeof l.source === 'object' ? l.source?.id : l.source;
            const tgtId = typeof l.target === 'object' ? l.target?.id : l.target;
            const onPath = lineage.has(srcId ?? '') && lineage.has(tgtId ?? '');
            return onPath ? appearance.linkWidth * 2.2 : appearance.linkWidth * 0.4;
          }}
          linkCurvature={appearance.edgeCurve}
          linkDirectionalArrowLength={5}
          linkDirectionalArrowRelPos={0.92}
          linkDirectionalArrowColor={(l: { color?: string }) => l.color ?? '#a78bfa'}
          linkDirectionalParticles={appearance.particles ? 2 : 0}
          linkDirectionalParticleWidth={1.5}
          linkDirectionalParticleSpeed={appearance.particleSpeed}
          nodeThreeObject={nodeThreeObject}
          nodeLabel={labelHtml}
          onEngineStop={() => {
            // Re-anchor cluster halos around the new settled positions.
            // The callback short-circuits if cluster coloring is off, so
            // this is a no-op cost when the user isn't using the tint.
            void rebuildClusterHalos();
          }}
        />
      ) : (
        <ForceGraph2D
          ref={fgRef}
          graphData={data}
          nodeRelSize={7}
          backgroundColor={bgColor}
          // Node drag is on by default in ForceGraph2D — being explicit
          // here so a refactor doesn't silently disable it. Each node is
          // grabbable; the force layout updates around it in real time.
          enableNodeDrag={true}
          enablePanInteraction={true}
          enableZoomInteraction={true}
          onNodeHover={handleNodeHover}
          onNodeClick={handleNodeClick}
          onNodeRightClick={handleNodeRightClick}
          linkColor={(l: { color?: string; source?: { id?: string } | string; target?: { id?: string } | string }) => {
            if (!hoveredId) return l.color ?? '#a78bfa';
            const srcId = typeof l.source === 'object' ? l.source?.id : l.source;
            const tgtId = typeof l.target === 'object' ? l.target?.id : l.target;
            const onPath = lineage.has(srcId ?? '') && lineage.has(tgtId ?? '');
            return onPath ? (l.color ?? '#a78bfa') : '#1c1828';
          }}
          linkLineDash={() => null}
          linkWidth={(l: { source?: { id?: string } | string; target?: { id?: string } | string }) => {
            if (!hoveredId) return appearance.linkWidth;
            const srcId = typeof l.source === 'object' ? l.source?.id : l.source;
            const tgtId = typeof l.target === 'object' ? l.target?.id : l.target;
            const onPath = lineage.has(srcId ?? '') && lineage.has(tgtId ?? '');
            return onPath ? appearance.linkWidth * 2.2 : appearance.linkWidth * 0.4;
          }}
          linkCurvature={appearance.edgeCurve}
          linkDirectionalArrowLength={6}
          linkDirectionalArrowRelPos={1}
          linkDirectionalArrowColor={(l: { color?: string }) => l.color ?? '#a78bfa'}
          linkDirectionalParticles={appearance.particles ? 2 : 0}
          linkDirectionalParticleWidth={2}
          linkDirectionalParticleSpeed={appearance.particleSpeed}
          nodeCanvasObjectMode={() =>
            appearance.labelMode === 'always' ? 'after' : undefined
          }
          nodeCanvasObject={(node: { x: number; y: number; name: string; color: string; val: number }, ctx: CanvasRenderingContext2D, globalScale: number) => {
            if (appearance.labelMode !== 'always') return;
            const label = node.name;
            const fontSize = 11 / globalScale;
            ctx.font = `${fontSize}px ui-monospace, monospace`;
            const textWidth = ctx.measureText(label).width;
            const padding = 4 / globalScale;
            ctx.fillStyle = 'rgba(12,8,24,0.85)';
            ctx.fillRect(
              node.x - textWidth / 2 - padding,
              node.y + node.val + 2 / globalScale,
              textWidth + padding * 2,
              fontSize + padding,
            );
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#e5e5e5';
            ctx.fillText(label, node.x, node.y + node.val + 2 / globalScale + padding / 2);
          }}
          nodeLabel={labelHtml}
        />
      )}
      {/* Search overlay — sits above the graph canvas, fixed top-left.
          Typing filters nodes/edges by dimming non-matching ones; empty
          query restores everything. Inspired by graphrag-workbench's
          query box. */}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-2">
        <input
          id="lineage-graph-search"
          name="lineage-graph-search"
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search graph…"
          className="bg-black/60 backdrop-blur-sm border border-purple-500/30 rounded px-2 py-1 text-[10px] font-mono text-zinc-200 placeholder-zinc-500 w-44 focus:outline-none focus:border-purple-400/60"
        />
        {matchSet !== null && (
          <span className="text-[9px] font-mono text-purple-300/80 px-1.5 py-0.5 bg-purple-500/10 border border-purple-500/20 rounded">
            {matchSet.size} / {connected.nodes.length}
          </span>
        )}
        {appearance.renderMode === '3d' && (
          <>
            <button
              onClick={() => flyRef.current.flyForward()}
              title="FTL jump forward (F)"
              className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider px-2 py-1 rounded bg-black/60 backdrop-blur-sm border border-cyan-500/30 text-cyan-200 hover:border-cyan-400/60 hover:bg-cyan-500/10"
            >
              <Rocket className="w-2.5 h-2.5" /> FTL
            </button>
            <button
              onClick={() => flyRef.current.flyHome()}
              title="FTL back to the cluster"
              className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider px-2 py-1 rounded bg-black/60 backdrop-blur-sm border border-purple-500/30 text-purple-200 hover:border-purple-400/60 hover:bg-purple-500/10"
            >
              <Home className="w-2.5 h-2.5" /> Home
            </button>
          </>
        )}
      </div>

      {/* Radial motion-blur vignette during FTL warp — perimeter blurs +
          glows, the center stays clear. Opacity is driven each frame from the
          warp intensity by the flight loop (via vignetteRef). */}
      {appearance.renderMode === '3d' && (
        <div
          ref={vignetteRef}
          className="absolute inset-0 z-30 pointer-events-none"
          style={{
            opacity: 0,
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            maskImage: 'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.6) 62%, black 100%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.6) 62%, black 100%)',
            background: 'radial-gradient(ellipse at center, transparent 42%, rgba(150,180,255,0.10) 80%, rgba(200,220,255,0.18) 100%)',
          }}
        />
      )}

      {/* Far-from-cluster affordance: a prominent FTL-home button when the
          camera has drifted well outside the node cloud. */}
      {appearance.renderMode === '3d' && farFromHome && (
        <button
          onClick={() => flyRef.current.flyHome()}
          title="FTL back to the cluster"
          className="absolute bottom-10 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3.5 py-2 rounded-full bg-purple-600/30 backdrop-blur-sm border border-purple-400/60 text-purple-100 text-[11px] font-mono uppercase tracking-wider shadow-xl animate-pulse hover:bg-purple-600/50 hover:animate-none"
        >
          <Home className="w-3.5 h-3.5" /> Return to cluster
        </button>
      )}
      <NodeInspector
        nodeId={selectedId}
        nodes={connected.nodes}
        edges={connected.edges}
        edgeColor={(k) => EDGE_COLOR_BY_KIND[k] ?? '#71717a'}
        onClose={() => setSelectedId(null)}
      />
      <div className="absolute bottom-0 left-0 right-0 z-10 px-3 pt-1 pb-px text-[9px] font-mono text-zinc-500 bg-linear-to-t from-black/70 to-transparent pointer-events-none">
        {appearance.renderMode === '3d'
          ? 'click-drag rotate · wheel zoom · WASD/arrows fly — hold to accelerate, release to coast (Q/E up-down, ⇧ afterburner) · F = FTL jump · Home button warps back · click node for details'
          : 'click-drag pan · wheel zoom · click node for details · right-click node for actions'}
        {' · '}{connected.nodes.length} connected nodes · {connected.edges.length} relationships
      </div>

      {/* Right-click context menu for graph nodes (plan step 3d). */}
      {(() => {
        const payload = nodeMenu.payload;
        if (!payload) return null;
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            label: 'Inspect (open details panel)',
            icon: <Sliders className="w-3 h-3" />,
            onSelect: () => setSelectedId(payload.nodeId),
          },
          {
            type: 'item',
            label: 'Center camera here',
            icon: <Crosshair className="w-3 h-3" />,
            hint: appearance.renderMode === '3d' ? '3D' : '2D',
            onSelect: () => {
              type PositionedNode = { x?: number; y?: number; z?: number };
              const node = (data.nodes as unknown as Array<PositionedNode & { id?: string }>).find(
                (n) => n.id === payload.nodeId,
              );
              const x = node?.x ?? 0;
              const y = node?.y ?? 0;
              const z = node?.z ?? 0;
              const r = fgRef.current as {
                centerAt?: (x: number, y: number, ms: number) => void;
                cameraPosition?: (
                  pos: { x: number; y: number; z: number },
                  lookAt?: { x: number; y: number; z: number },
                  ms?: number,
                ) => void;
              } | null;
              if (appearance.renderMode === '3d' && r?.cameraPosition) {
                // Pull camera to a point offset along +z from the node so
                // the user sees the node from a sensible distance.
                const dist = 120;
                const nx = x + dist * 0.6;
                const ny = y + dist * 0.4;
                const nz = z + dist;
                r.cameraPosition({ x: nx, y: ny, z: nz }, { x, y, z }, 800);
              } else if (r?.centerAt) {
                r.centerAt(x, y, 800);
              }
            },
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Copy node ID',
            icon: <Copy className="w-3 h-3" />,
            hint: payload.nodeId.slice(0, 8),
            onSelect: () => {
              void navigator.clipboard?.writeText(payload.nodeId).catch(() => {
                /* clipboard unavailable; silent */
              });
            },
          },
          {
            type: 'item',
            label: 'Open in Library',
            icon: <LibraryIcon className="w-3 h-3" />,
            hint: 'reveal row',
            onSelect: () => {
              // Open the right-side library panel and dispatch a custom
              // event the LibraryView listens for to scroll-to + select
              // the named entry. Falls back to opening the panel only
              // if the listener isn't installed.
              window.dispatchEvent(
                new CustomEvent('thedaw:set-left-panel', {
                  detail: { open: false },
                }),
              );
              window.dispatchEvent(
                new CustomEvent('thedaw:reveal-library-entry', {
                  detail: { entryId: payload.nodeId },
                }),
              );
            },
          },
          {
            type: 'item',
            label: 'Download bundle',
            icon: <Package className="w-3 h-3" />,
            hint: '.zip',
            onSelect: () => {
              const a = document.createElement('a');
              a.href = `/api/library/${payload.nodeId}/bundle`;
              a.download = '';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            },
          },
          {
            type: 'item',
            label: 'Open lineage rooted here',
            icon: <GitMerge className="w-3 h-3" />,
            hint: 'modal',
            onSelect: () => {
              // Fire a custom event the rest of the app listens for to
              // open a fresh LineageModal rooted at this node. Self-
              // contained so this Graph3DView doesn't need a setter
              // prop threaded down.
              window.dispatchEvent(
                new CustomEvent('thedaw:open-lineage', {
                  detail: { entryId: payload.nodeId },
                }),
              );
            },
          },
        ];
        return (
          <ContextMenu
            position={nodeMenu.position}
            onClose={nodeMenu.close}
            items={items}
            title={`Node · ${payload.nodeName.slice(0, 40)}${payload.nodeName.length > 40 ? '…' : ''}`}
            minWidth="14rem"
          />
        );
      })()}
    </div>
  );
};

function pickNodeColor(n: GraphNode): string {
  switch (n.source) {
    case 'generate':
      return '#a78bfa';
    case 'import':
      return '#60a5fa';
    case 'studio':
      return '#34d399';
    case undefined:
    case null:
      return '#71717a';
    default:
      return '#fb923c';
  }
}


function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

