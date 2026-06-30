import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Settings, BookOpen, Smartphone, X, Copy, ExternalLink, ChevronUp, ChevronDown, GripHorizontal, ChevronRight, ChevronLeft, Library, FolderInput, Package, LayoutGrid } from 'lucide-react';
import { LibraryView } from '../../views/LibraryView';
import { DAWCenterPanel } from './DAWCenterPanel';

const CatalogueView = lazy(() => import('../../catalog/CatalogueView').then((m) => ({ default: m.CatalogueView })));
import { CenterTabBar } from './CenterTabBar';
import { LogBody, LogActionButton, LogStripCompactInfo } from './ProcessingLog';
import { BottomMultiTabPanel } from './BottomMultiTabPanel';
import { DocsModal } from './DocsModal';
import { SettingsModal } from './SettingsModal';
import { DawImportModal } from './DawImportModal';
import { ProjectModal } from './ProjectModal';
import { DownloadDock } from './DownloadDock';
import { useAppUiStore } from '../../state/appUiStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import { useDawImportStore } from '../../state/dawImportStore';
import { useProjectStore } from '../../state/projectStore';
import { useEditLayoutStore } from '../../state/editLayoutStore';

const RIGHT_RAIL_MIN = 280;
const RIGHT_RAIL_MAX = 640;

export const Shell: React.FC = () => {
  const setActiveView = useAppUiStore((state) => state.setActiveView);
  const centerTab = useAppUiStore((state) => state.centerTab);
  const setCenterTab = useAppUiStore((state) => state.setCenterTab);
  const isRightPanelOpen = useAppUiStore((state) => state.isRightPanelOpen);
  const setIsRightPanelOpen = useAppUiStore((state) => state.setRightPanelOpen);
  const rightPanelWidth = useAppUiStore((state) => state.rightPanelWidth);
  const setRightPanelWidth = useAppUiStore((state) => state.setRightPanelWidth);
  const isLibraryExpanded = useAppUiStore((state) => state.isLibraryExpanded);
  const setLibraryExpanded = useAppUiStore((state) => state.setLibraryExpanded);
  const docsOpen = useAppUiStore((state) => state.docsOpen);
  const setDocsOpen = useAppUiStore((state) => state.setDocsOpen);
  const openDawImport = useDawImportStore((state) => state.open);
  const openProject = useProjectStore((state) => state.open);
  const editLayoutActive = useEditLayoutStore((state) => state.active);
  const toggleEditLayout = useEditLayoutStore((state) => state.toggle);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const isPerformanceWorkspace = centerTab === 'dj' || centerTab === 'session';
  const showRightRail = isRightPanelOpen && !isPerformanceWorkspace;
  const [shareUrlOverride, setShareUrlOverride] = React.useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('thedaw.shareUrlOverride') ?? '';
  });
  const [copiedShareUrl, setCopiedShareUrl] = React.useState(false);

  // LAN-reachable URL for this app (host:frontend-port), auto-detected
  // from the backend so the QR points phones at a real address instead
  // of localhost. Falls back to window.location.origin when there's no
  // LAN IP (e.g. offline). Mirrors how the VJ tab builds its mobile QR.
  const [lanUrl, setLanUrl] = React.useState('');
  React.useEffect(() => {
    let cancelled = false;
    void fetch('/api/vj/lan-ip')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { lan_ip?: string | null } | null) => {
        if (cancelled || !j?.lan_ip || typeof window === 'undefined') return;
        const port = window.location.port || '5173';
        setLanUrl(`http://${j.lan_ip}:${port}`);
      })
      .catch(() => {
        /* no backend / no LAN — keep the origin fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const detectedShareUrl =
    lanUrl || (typeof window === 'undefined' ? '' : window.location.origin);
  const shareUrl = shareUrlOverride.trim() || detectedShareUrl;
  const qrImageUrl = useMemo(
    () => `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=${encodeURIComponent(shareUrl)}`,
    [shareUrl],
  );

  const updateShareUrlOverride = (value: string) => {
    setShareUrlOverride(value);
    if (typeof window === 'undefined') return;
    if (value.trim()) window.localStorage.setItem('thedaw.shareUrlOverride', value);
    else window.localStorage.removeItem('thedaw.shareUrlOverride');
  };

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedShareUrl(true);
      window.setTimeout(() => setCopiedShareUrl(false), 1400);
    } catch {
      setCopiedShareUrl(false);
    }
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab;
      setActiveView(tab);
    };
    const openDocsHandler = () => setDocsOpen(true);
    const closeDocsHandler = () => setDocsOpen(false);
    // CHANGED: let the Suno panel's "Open Settings" prompt open the modal.
    const openSettingsHandler = () => setSettingsOpen(true);
    window.addEventListener('thedaw:navigate', handler);
    window.addEventListener('thedaw:open-docs', openDocsHandler);
    window.addEventListener('thedaw:close-docs', closeDocsHandler);
    window.addEventListener('thedaw:open-settings', openSettingsHandler);
    return () => {
      window.removeEventListener('thedaw:navigate', handler);
      window.removeEventListener('thedaw:open-docs', openDocsHandler);
      window.removeEventListener('thedaw:close-docs', closeDocsHandler);
      window.removeEventListener('thedaw:open-settings', openSettingsHandler);
    };
  }, [setActiveView, setDocsOpen]);

  // ── Right rail drag-resize. When the Library is open, dragging the
  // rail's left edge widens / narrows the rail. The collapsed-rail
  // state is fixed-width (RIGHT_RAIL_COLLAPSED) and not resizable.
  const [isResizingRail, setIsResizingRail] = useState(false);
  useEffect(() => {
    if (!isResizingRail) return;
    const onMove = (e: MouseEvent) => {
      const next = window.innerWidth - e.clientX;
      const clamped = Math.max(RIGHT_RAIL_MIN, Math.min(RIGHT_RAIL_MAX, next));
      setRightPanelWidth(clamped);
    };
    const onUp = () => setIsResizingRail(false);
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizingRail, setRightPanelWidth]);

  return (
    <div
      className="relative flex flex-col w-full bg-[#07050a] text-[#f5f3ff] overflow-hidden font-sans dense-layout"
      style={{ height: isPerformanceWorkspace ? 'calc(100vh / var(--layout-zoom))' : 'calc((100vh - 5rem) / var(--layout-zoom))' }}
    >
      {/* Combined header + tab bar — logo (left), workspace tabs (center),
          Docs / Mobile / Settings icons (right). G-Search moved to the footer. */}
      <header className="h-11 border-b border-white/5 flex items-center gap-3 px-3 bg-[#0a080f]/80 backdrop-blur-md z-10 shrink-0 relative">
        <a
          href="https://github.com/gantasmo/theDAW"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 relative z-10 select-none shrink-0 group/brand cursor-pointer"
          title="theDAW by GANTASMO — opens github.com/gantasmo/theDAW"
        >
          <BrandLogo />
          <div className="flex flex-col leading-none">
            <span className="text-[13px] font-black tracking-[0.18em] text-zinc-100 group-hover/brand:text-white transition-colors">theDAW</span>
            <span className="text-[8px] font-mono uppercase tracking-[0.3em] text-zinc-500 group-hover/brand:text-purple-300 transition-colors">by GANTASMO</span>
          </div>
        </a>

        {/* Workspace tabs — embedded so they share this row instead of a
            separate strip below. */}
        <CenterTabBar
          activeTab={centerTab}
          onTabChange={setCenterTab}
          embedded
        />

        <div className="flex items-center gap-2.5 shrink-0">
          {/* Icon-only — the hover tooltip (title) names each one. The library
              toggle is the right-edge pull handle (below), not a cluster icon.
              All three carry the colored accent glow. */}
          <TopBarButton
            onClick={toggleEditLayout}
            icon={<LayoutGrid className="w-3.5 h-3.5" />}
            title="Edit Layout — drag controls and panels to move them, drag borders to resize"
            accent="purple"
            active={editLayoutActive}
          />
          <TopBarButton
            onClick={() => openDawImport()}
            icon={<FolderInput className="w-3.5 h-3.5" />}
            title="Import a DAW project (.als / .RPP / .flp / …)"
            accent="sky"
          />
          <TopBarButton
            onClick={() => openProject('save')}
            icon={<Package className="w-3.5 h-3.5" />}
            title="Save or open a .tasmo project"
            accent="sky"
          />
          <TopBarButton
            onClick={() => setDocsOpen(true)}
            icon={<BookOpen className="w-3.5 h-3.5" />}
            title="Open documentation"
            accent="purple"
          />
          <TopBarButton
            onClick={() => setShareOpen(true)}
            icon={<Smartphone className="w-3.5 h-3.5" />}
            title="Open mobile access QR/link"
            accent="emerald"
          />
          <TopBarButton
            onClick={() => setSettingsOpen(true)}
            icon={<Settings className="w-3.5 h-3.5 group-hover:rotate-90 transition-transform duration-500" />}
            title="Settings"
            accent="rose"
          />
        </div>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden relative">
      {/* Main Canvas — hidden when library is expanded to full view. */}
      {!isLibraryExpanded && (
        <main className="flex-1 h-full overflow-hidden flex flex-col relative bg-[#110e1a]/60">
          <DAWCenterPanel onSwitchTab={(tab) => setActiveView(tab)} />
        </main>
      )}

      {/* Library rail — ONLY mounts when isRightPanelOpen. The
          ProcessingLog is NOT inside this rail (it's the global
          bottom strip below) — user explicitly flagged that the log
          must stay anchored regardless of library state. */}
      {showRightRail && (
        <aside
          className={`h-full min-h-0 flex flex-col bg-[#0a080f] border-l border-purple-500/20 shadow-[inset_1px_0_0_rgba(168,85,247,0.08)] z-20 relative ${isLibraryExpanded ? 'flex-1' : 'shrink-0'}`}
          style={isLibraryExpanded ? undefined : {
            width: rightPanelWidth,
            transition: isResizingRail ? 'none' : 'width 220ms cubic-bezier(.2,.7,.2,1)',
          }}
        >
          {/* Resize handle — only in compact mode. */}
          {!isLibraryExpanded && (
            <div
              className="absolute top-0 bottom-0 -left-1 w-2 cursor-col-resize z-30 group"
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingRail(true);
              }}
            >
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-white/10 group-hover:bg-purple-500/50 rounded-full transition-colors" />
            </div>
          )}

          <div className="flex-1 overflow-hidden relative min-h-0">
            {isLibraryExpanded ? (
              <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 animate-pulse">loading…</span></div>}>
                <CatalogueView onCollapse={() => setLibraryExpanded(false)} />
              </Suspense>
            ) : (
              <LibraryView onSwitchTab={(tab: string) => setActiveView(tab)} onExpand={() => setLibraryExpanded(true)} />
            )}
          </div>
        </aside>
      )}

      </div>

      {/* Global bottom dock — BottomMultiTabPanel (left, flex-1) and
          ProcessingLog (right, width = rightPanelWidth) live
          side-by-side at the bottom of the app. INDEPENDENT of the
          library panel state. Each column has its OWN height +
          collapse toggle + resize handle (multiHeight / logHeight in
          bottomPanelStore) — expanding or resizing one does NOT
          affect the other. */}
      {!isPerformanceWorkspace && <ShellBottomDock />}

      {/* Library pull handle — root-level so it floats ABOVE every panel (bottom
          dock, log, maximized panels) and is never clipped by the work area's
          overflow. Vertically centered on the right edge. Click toggles the
          library; resize stays on the panel's inner edge. */}
      {!isPerformanceWorkspace && (
        <button
          type="button"
          onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
          title={`${isRightPanelOpen ? 'Collapse' : 'Expand'} library`}
          aria-label={`${isRightPanelOpen ? 'Collapse' : 'Expand'} library`}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-50 group flex flex-col items-center justify-center gap-1.5 h-24 w-7 rounded-l-lg border border-r-0 border-purple-400/60 bg-purple-500/20 text-purple-100 shadow-[0_0_16px_rgba(168,85,247,0.45)] hover:w-8 hover:text-white hover:border-purple-300/80 hover:bg-purple-500/35 hover:shadow-[0_0_22px_rgba(168,85,247,0.65)] transition-all"
        >
          <Library className="w-4 h-4" />
          {isRightPanelOpen ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      )}
      <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} />
      {shareOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setShareOpen(false)} />
          <div className="relative w-[min(420px,92vw)] bg-[#0c0a14] border border-emerald-500/30 rounded-lg shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-linear-to-r from-emerald-900/25 to-purple-900/15">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-emerald-300" />
                <div className="flex flex-col leading-tight">
                  <span className="text-[11px] font-black uppercase tracking-widest text-emerald-200">Mobile Access</span>
                  <span className="text-[8px] font-mono uppercase tracking-wider text-emerald-300/60">QR + tunnel-friendly link</span>
                </div>
              </div>
              <button onClick={() => setShareOpen(false)} className="p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5" title="Close">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="p-4 flex flex-col gap-4">
              <div className="flex justify-center">
                <div className="p-3 rounded-lg bg-white shadow-[0_0_24px_rgba(16,185,129,0.16)]">
                  <img src={qrImageUrl} alt="theDAW mobile access QR code" className="w-55 h-55" />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="shell-share-url" className="text-[9px] font-black uppercase tracking-widest text-zinc-400">Share URL</label>
                <div className="flex gap-2">
                  <input
                    id="shell-share-url"
                    type="text"
                    name="shell-share-url"
                    value={shareUrl}
                    readOnly
                    className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 outline-none"
                  />
                  <button
                    onClick={() => void copyShareUrl()}
                    className="px-2 py-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5"
                    title="Copy share URL"
                  >
                    <Copy className="w-3 h-3" /> {copiedShareUrl ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <a href={shareUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[9px] font-mono text-emerald-300/75 hover:text-emerald-200 transition-colors">
                  <ExternalLink className="w-2.5 h-2.5" /> Open link in new tab
                </a>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="shell-share-url-override" className="text-[9px] font-black uppercase tracking-widest text-zinc-400">External URL override</label>
                <input
                  id="shell-share-url-override"
                  type="url"
                  name="shell-share-url-override"
                  value={shareUrlOverride}
                  onChange={(e) => updateShareUrlOverride(e.target.value)}
                  placeholder="Paste Cloudflare tunnel URL, e.g. https://name.trycloudflare.com"
                  className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-500/50 transition-colors"
                />
                <p className="text-[9px] leading-relaxed text-zinc-500">
                  By default this uses <span className="font-mono text-zinc-400">{detectedShareUrl}</span>. Paste a Cloudflare Tunnel or other public URL here when your phone is not on the same network.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DawImportModal />
      <ProjectModal />
      {/* Floating model-download manager — fixed bottom-right, self-hiding when
          there are no downloads. Mounted once at the app root so it floats over
          every view. */}
      <DownloadDock />
    </div>
  );
};

/**
 * Global bottom dock.
 *
 * Layout (always one horizontal strip at the bottom):
 *
 *   ┌─────────── canvas / main ────────────┬│┬── log body ──────┐
 *   │                                       ││                   │
 *   │  (multi body if isBottomOpen)         ││ (log body if      │
 *   │                                       ││  isLogOpen)       │
 *   ├───────────────────────────────────────┼─────────┬─────────┤
 *   │   ^   multi toggle  (flex-1)          │ ^ LOG …│ CREATE  │  <- the strip
 *   └───────────────────────────────────────┴─────────┴─────────┘
 *                                            ←──── logWidth ─────→
 *                                            ← 40% ─→← 60% ──────→
 *
 * - The dock body has ONE shared height (multiHeight) via a single vertical
 *   handle, so the LOG can never grow taller than the dock and push into the
 *   center work area; LOG content scrolls internally instead.
 * - The LOG has its OWN width (logWidth) with a horizontal handle at its left
 *   edge (the `│` above). Dragging it also nudges the library rail above so
 *   they stay aligned — one-way: the rail's own handle never changes logWidth.
 * - The strip is fixed-height and always visible. The left `^` collapses the
 *   multi-tab body; the LOG's `^` collapses the LOG body.
 * - The CREATE / PROCESS / TRAIN action button stays pinned in the right 60%
 *   of the LOG strip section so the user's most-used affordance never moves.
 */
const STRIP_HEIGHT = 36;
const DOCK_MIN_HEIGHT = 60;
const DOCK_MAX_FRACTION = 0.85;
// CREATE / PROCESS / TRAIN action button — a FIXED width so it never grows when
// the LOG is drag-resized (the LOG header takes all the slack instead).
const ACTION_WIDTH = 180;
const LOG_MIN_WIDTH = 220;
const LOG_MAX_WIDTH = 720;

const ShellBottomDock: React.FC = () => {
  const multiHeight = useBottomPanelStore((s) => s.multiHeight);
  const setMultiHeight = useBottomPanelStore((s) => s.setMultiHeight);
  const logWidth = useBottomPanelStore((s) => s.logWidth);
  const setLogWidth = useBottomPanelStore((s) => s.setLogWidth);
  const isBottomOpen = useBottomPanelStore((s) => s.isOpen);
  const setBottomOpen = useBottomPanelStore((s) => s.setOpen);
  const isLogOpen = useBottomPanelStore((s) => s.isLogOpen);
  const setLogOpen = useBottomPanelStore((s) => s.setLogOpen);
  const multiMaximized = useBottomPanelStore((s) => s.multiMaximized);

  // Dock-body height — shared by the multi-tab panel (in-flow) and the floating
  // LOG overlay. Maximized fills the work area. The height MUST be computed in
  // the same zoom-aware space as the .dense-layout root (height =
  // calc((100vh - 5rem) / var(--layout-zoom))); a raw `100vh` calc here ignores
  // --layout-zoom and, at zoom > 1, overflows the root's overflow-hidden so the
  // dock's own bottom (e.g. the Score viewer's page/zoom controls) is clipped.
  // Reserve 5rem inside the root for the header (h-11) + the always-on strip.
  const bodyHeight = multiMaximized
    ? 'calc((100vh - 5rem) / var(--layout-zoom) - 5rem)'
    : `${multiHeight}px`;
  // The LOG strip section auto-fits its content (the telemetry readouts + the
  // fixed action button). Mirror its measured width into logWidth so the LOG
  // body directly below it stays column-aligned (opens to the same left edge).
  const logSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logSectionRef.current;
    if (!el) return;
    const sync = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setLogWidth(w);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [setLogWidth]);

  return (
    <div className="relative shrink-0 flex flex-col z-30 pointer-events-none">
      {/* Multi-tab body — in-flow; the global bottom panel legitimately lifts the
          work area. The LOG no longer shares this row (it floats, below). */}
      {isBottomOpen && (
        <div
          className="relative shrink-0 bg-[#0a080f] overflow-hidden shadow-[0_-1px_0_rgba(168,85,247,0.08)] pointer-events-auto"
          style={{ height: bodyHeight }}
        >
          {!multiMaximized && (
            <ColumnResizeHandle
              currentHeight={multiHeight}
              onSet={setMultiHeight}
              title="Drag to resize the bottom dock"
            />
          )}
          <div className="absolute inset-x-0 top-0 h-px bg-purple-500/20 pointer-events-none" />
          <BottomMultiTabPanel />
        </div>
      )}

      {/* LOG body — FLOATING overlay: anchored just above the strip, right-aligned,
          only logWidth wide. It autofits under the right panel and floats over the
          bottom-right of the work area instead of pushing the whole UI up. */}
      {isLogOpen && (
        <div
          className="absolute right-0 z-40 pointer-events-auto bg-[#0a080f] overflow-hidden border-l border-purple-500/15 shadow-[-2px_-2px_12px_rgba(0,0,0,0.5)]"
          style={{ bottom: STRIP_HEIGHT, width: logWidth, height: bodyHeight }}
        >
          {!multiMaximized && (
            <ColumnResizeHandle
              currentHeight={multiHeight}
              onSet={setMultiHeight}
              title="Drag to resize the log height"
            />
          )}
          <div className="absolute inset-x-0 top-0 h-px bg-purple-500/20 pointer-events-none" />
          <LogBody />
        </div>
      )}

      {/* Single horizontal strip — always visible. `relative` anchors the
          viewport-centred expand chevron. */}
      <div className="relative shrink-0 flex items-stretch pointer-events-auto" style={{ height: STRIP_HEIGHT }}>

        {/* Multi-tab toggle — flex-1 clickable area (the chevron is centred
            separately, below, so it lines up with PLAY / DJ / the mirror line). */}
        <button
          type="button"
          onClick={() => setBottomOpen(!isBottomOpen)}
          className="min-w-0 flex-1 bg-[#0a080f] hover:bg-purple-500/8 transition-colors border-t border-r border-purple-500/15 shadow-[0_-1px_0_rgba(168,85,247,0.08)]"
          title={isBottomOpen ? 'Collapse bottom panel' : 'Expand bottom panel'}
          aria-label={isBottomOpen ? 'Collapse bottom panel' : 'Expand bottom panel'}
        />

        {/* Expand chevron — centred on the viewport so it lines up with the PLAY
            button, the DJ tab, and the layout-editor mirror line. pointer-events
            pass through to the toggle button behind it. */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          {isBottomOpen
            ? <ChevronDown className="w-3.5 h-3.5 text-purple-300" />
            : <ChevronUp className="w-3.5 h-3.5 text-purple-300" />
          }
        </div>

        {/* LOG strip section — CONTENT width: auto-fits the CPU/GPU/TEMP/VRAM/RAM
            readouts (its measured width drives logWidth). The action button is a
            FIXED width and never grows with the LOG. */}
        <div ref={logSectionRef} className="shrink-0 bg-[#0a080f] flex items-stretch border-t border-purple-500/15 shadow-[0_-1px_0_rgba(168,85,247,0.08)]">
          {/* LOG header — natural width so every readout shows in full. */}
          <button
            type="button"
            onClick={() => setLogOpen(!isLogOpen)}
            className="flex items-center gap-1.5 px-2 group hover:bg-purple-500/8 transition-colors border-r border-purple-500/15 shrink-0"
            title={isLogOpen ? 'Collapse log' : 'Expand log'}
            aria-label={isLogOpen ? 'Collapse log' : 'Expand log'}
          >
            {isLogOpen
              ? <ChevronDown className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors shrink-0" />
              : <ChevronUp className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors shrink-0" />
            }
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-200 shrink-0">LOG</span>
            {/* Live CPU · GPU · TEMP · VRAM · RAM — shown in full (the section sizes to fit). */}
            <span className="shrink-0"><LogStripCompactInfo /></span>
          </button>
          {/* Action button (CREATE / PROCESS / TRAIN) — fixed width. */}
          <div className="flex items-stretch shrink-0" style={{ width: ACTION_WIDTH }}>
            <LogActionButton />
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Per-column resize handle. Lives at the TOP edge of the column it
 * controls. Dragging up grows that column only; the other column is
 * untouched. Clamped to [DOCK_MIN_HEIGHT, viewport * DOCK_MAX_FRACTION].
 */
interface ColumnResizeHandleProps {
  currentHeight: number;
  onSet: (h: number) => void;
  title: string;
}
const ColumnResizeHandle: React.FC<ColumnResizeHandleProps> = ({ currentHeight, onSet, title }) => {
  const [dragging, setDragging] = useState(false);
  const startY = React.useRef(0);
  const startH = React.useRef(currentHeight);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dy = startY.current - e.clientY; // up = positive
      const max = Math.floor(window.innerHeight * DOCK_MAX_FRACTION);
      const clamped = Math.max(DOCK_MIN_HEIGHT, Math.min(max, startH.current + dy));
      onSet(clamped);
    };
    const onUp = () => setDragging(false);
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onSet]);

  return (
    <>
      {/* While dragging, a full-window overlay sits ABOVE the center iframe
          (VJ) so the iframe can't swallow mousemove/mouseup — that swallow was
          what left the resize "stuck" as if the mouse never released. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-row-resize" />}
      <div
        className="absolute inset-x-0 top-0 h-1.5 -mt-0.5 cursor-row-resize flex items-center justify-center group z-40"
        onMouseDown={(e) => {
          e.preventDefault();
          startY.current = e.clientY;
          startH.current = currentHeight;
          setDragging(true);
        }}
        title={title}
      >
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 group-hover:bg-purple-500/40 transition-colors" />
        <GripHorizontal className="w-3.5 h-3.5 text-zinc-700 group-hover:text-purple-300 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </>
  );
};

/**
 * Brand logo — references the SAME SVG that index.html wires up as
 * the browser-tab favicon (frontend/public/favicon.svg). Browser
 * caches it after the first paint so the header logo, the tab icon,
 * and any other site reference all stay byte-identical with no
 * inline duplication. The file is too detailed (2723×2723 viewBox,
 * ~40KB) to inline cheaply, hence the <img> reference.
 */
const BrandLogo: React.FC = () => (
  <img
    src="/favicon.svg?v=4"
    alt="theDAW logo"
    className="w-7 h-7 shrink-0 rounded-md shadow-[0_0_12px_rgba(124,58,237,0.35)]"
    draggable={false}
  />
);

/**
 * Shared top-bar button used by the header strip. Unifies the
 * typography + hover/active treatment across Docs / Mobile / Library /
 * Settings. Accent is one of the canonical hues; `active` flips on
 * the filled treatment for toggle-style buttons (Library). Icon-only
 * buttons (no label) get tighter padding.
 */
type TopBarAccent = 'purple' | 'emerald' | 'sky' | 'rose' | 'neutral';

interface TopBarButtonProps {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  label?: string;
  /** Hide the label on viewports narrower than md (matches the
   *  existing Mobile / Library button behaviour). */
  hideLabelBelowMd?: boolean;
  accent?: TopBarAccent;
  active?: boolean;
  /** Trailing element (e.g. ChevronRight on Library). */
  trailing?: React.ReactNode;
}

const ACCENT_CLS: Record<TopBarAccent, { idle: string; idleText: string; active: string }> = {
  purple: {
    idle: 'border-purple-500/30 hover:bg-purple-500/15 shadow-[0_0_10px_rgba(168,85,247,0.3)]',
    idleText: 'text-purple-300 group-hover:text-purple-200',
    active: 'border-purple-500/50 bg-purple-500/15 text-purple-200 shadow-[0_0_12px_rgba(168,85,247,0.45)]',
  },
  emerald: {
    idle: 'border-emerald-500/30 hover:bg-emerald-500/15 shadow-[0_0_10px_rgba(16,185,129,0.3)]',
    idleText: 'text-emerald-300 group-hover:text-emerald-200',
    active: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.45)]',
  },
  sky: {
    idle: 'border-sky-500/30 hover:bg-sky-500/15 shadow-[0_0_10px_rgba(14,165,233,0.3)]',
    idleText: 'text-sky-300 group-hover:text-sky-200',
    active: 'border-sky-500/50 bg-sky-500/15 text-sky-200 shadow-[0_0_12px_rgba(14,165,233,0.45)]',
  },
  rose: {
    idle: 'border-rose-500/30 hover:bg-rose-500/15 shadow-[0_0_10px_rgba(244,63,94,0.3)]',
    idleText: 'text-rose-300 group-hover:text-rose-200',
    active: 'border-rose-500/50 bg-rose-500/15 text-rose-200 shadow-[0_0_12px_rgba(244,63,94,0.45)]',
  },
  neutral: {
    idle: 'border-white/5 hover:bg-white/5',
    idleText: 'text-zinc-500 group-hover:text-zinc-200',
    active: 'border-white/20 bg-white/10 text-zinc-100',
  },
};

const TopBarButton: React.FC<TopBarButtonProps> = ({
  onClick,
  icon,
  title,
  label,
  hideLabelBelowMd = false,
  accent = 'neutral',
  active = false,
  trailing,
}) => {
  const cls = ACCENT_CLS[accent];
  const stateCls = active ? cls.active : `${cls.idle} ${cls.idleText}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`p-1.5 rounded border transition-colors group flex items-center gap-1.5 ${stateCls}`}
    >
      {icon}
      {label && (
        <span
          className={`text-[9px] font-black uppercase tracking-widest pr-1 ${
            hideLabelBelowMd ? 'hidden md:inline' : ''
          }`}
        >
          {label}
        </span>
      )}
      {trailing}
    </button>
  );
};
