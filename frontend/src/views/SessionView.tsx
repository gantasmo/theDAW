import React from 'react';
import { AlertCircle, AlertTriangle, FolderInput, Info, Layers, Loader2, PanelRight, Save, Scissors, SlidersHorizontal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDawImportStore } from '../state/dawImportStore';
import { useProjectStore } from '../state/projectStore';
import { DAW_LABELS } from '../lib/dawImportClient';
import { dawProjectToTasmo, type RecentItem } from '../lib/projectClient';
import { capturePerformRouting, autoRoutePerformFromProject, usePerformRoutingStore } from '../state/performRouting';
import { SESSION_IMPORT_FILTER } from '../lib/fileFilters';
import { PathInput } from '../components/ui/PathInput';
import { DawSessionGrid } from '../components/session/DawSessionGrid';
import { PerformRoutingPanel } from '../components/session/PerformRoutingPanel';
import { PerformRail } from '../components/session/PerformRail';
import { PerformVstWindow } from '../components/session/PerformVstWindow';
import { usePerformRailStore } from '../state/performRailStore';
import { InfiNightCredit } from '../components/ui/Credit';
import { importDawProjectToEditor } from '../lib/dawProjectToEditor';

export const SessionView: React.FC = () => {
  const { sourcePath, detected, project, hint, busy, error } = useDawImportStore(
    useShallow((s) => ({
      sourcePath: s.sourcePath,
      detected: s.detected,
      project: s.project,
      hint: s.hint,
      busy: s.busy,
      error: s.error,
    })),
  );
  const setSourcePath = useDawImportStore((s) => s.setSourcePath);
  const detectAndImport = useDawImportStore((s) => s.detectAndImport);
  const loadTasmoAsSession = useDawImportStore((s) => s.loadTasmoAsSession);
  const openProject = useProjectStore((s) => s.open);
  const recent = useProjectStore((s) => s.recent);
  const refreshRecent = useProjectStore((s) => s.refreshRecent);
  const [timelineBusy, setTimelineBusy] = React.useState(false);
  const [showRouting, setShowRouting] = React.useState(false);
  const railOpen = usePerformRailStore((s) => s.open);
  const [recentOpen, setRecentOpen] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(-1);
  const blurCloseTimer = React.useRef<number | null>(null);
  const recentVisible = recentOpen && recent.length > 0;

  // A refresh can shrink the list while the dropdown is open; keep the active
  // option (and aria-activedescendant) pointing at a rendered row.
  React.useEffect(() => {
    setActiveIdx((i) => Math.min(i, recent.length - 1));
  }, [recent.length]);

  // A .tasmo opens directly in the grid; any DAW project file goes through detect+import.
  const importSource = () => {
    if (sourcePath.trim().toLowerCase().endsWith('.tasmo')) void loadTasmoAsSession();
    else void detectAndImport();
  };

  const openRecent = () => {
    // A pending blur-close from a quick blur/refocus would otherwise close the
    // dropdown right after this open.
    if (blurCloseTimer.current !== null) {
      window.clearTimeout(blurCloseTimer.current);
      blurCloseTimer.current = null;
    }
    setRecentOpen(true);
    setActiveIdx(-1);
    void refreshRecent();
  };

  const closeRecent = () => {
    setRecentOpen(false);
    setActiveIdx(-1);
  };

  // Delayed so an option's onClick lands before the dropdown unmounts.
  const scheduleCloseRecent = () => {
    if (blurCloseTimer.current !== null) window.clearTimeout(blurCloseTimer.current);
    blurCloseTimer.current = window.setTimeout(() => {
      blurCloseTimer.current = null;
      closeRecent();
    }, 150);
  };

  // Mirrors ProjectModal's one-click UX: picking a recent entry imports it
  // immediately. setSourcePath commits synchronously, so detectAndImport reads
  // the freshly set path from the store.
  const pickRecent = (r: RecentItem) => {
    // Match the Import button's guard so a pick cannot start a second import
    // while one is in flight.
    if (busy) return;
    setSourcePath(r.path);
    closeRecent();
    if (r.path.toLowerCase().endsWith('.tasmo')) void loadTasmoAsSession(r.path);
    else void detectAndImport();
  };

  const onPathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!recentOpen) {
        setRecentOpen(true);
        void refreshRecent();
      }
      setActiveIdx((i) => Math.min(i + 1, recent.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Escape') {
      closeRecent();
    } else if (e.key === 'Enter' && recentVisible && activeIdx >= 0 && recent[activeIdx]) {
      e.preventDefault();
      pickRecent(recent[activeIdx]);
    }
  };

  const saveAsTasmo = () => {
    if (!project) return;
    openProject('save', { ...dawProjectToTasmo(project), perform_routing: capturePerformRouting() });
  };

  const editInTimeline = async () => {
    if (!project) return;
    setTimelineBusy(true);
    try {
      await importDawProjectToEditor(project);
    } finally {
      setTimelineBusy(false);
    }
  };

  // Automatic routing. A set built FOR the Sway carries its MIDI-learn
  // mappings in the project file; loading it should make the hardware work
  // with zero setup. Mixer mappings become direct CC routes on the Perform
  // mix, and dim-named mappings seed the Sway dimension bindings. Replaced
  // wholesale per project; cleared on unload.
  const setCcMods = usePerformRoutingStore((st) => st.setCcMods);
  React.useEffect(() => {
    if (!project) {
      setCcMods([]);
      return;
    }
    // A .tasmo restores its own saved routes via hydrate() BEFORE this effect
    // runs; the auto-router's derived (usually empty) set must not wipe them.
    if (usePerformRoutingStore.getState().ccModsHydrated) {
      if (usePerformRoutingStore.getState().ccMods.length > 0) setShowRouting(true);
      return;
    }
    const { ccMods, seededDims } = autoRoutePerformFromProject(project);
    setCcMods(ccMods);
    // Surface what just happened: a set with its own Sway mappings opens with
    // the routing strip visible, so "it works" is also "you can see why".
    // Seeded dims count too — a .swayproj import carries ONLY dim/CC layout.
    if (ccMods.length > 0 || seededDims > 0) setShowRouting(true);
  }, [project, setCcMods]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#0b0b10]">
      <div data-tour="perform-header" className="shrink-0 border-b border-white/10 bg-[#111118] px-3 py-2 flex items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-emerald-300 shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] font-black uppercase tracking-widest text-zinc-100">
              Perform
            </div>
            <div className="text-[8px] font-mono text-zinc-500 truncate">
              {project ? `${project.name} · ${project.tempo} BPM` : 'No project loaded'}
            </div>
          </div>
        </div>
        <div className="relative flex-1 min-w-0 flex items-center gap-2">
          <PathInput
            id="session-import-path"
            name="session_import_path"
            label="Open"
            kind="file"
            pickKind="tasmo"
            inline
            fileFilter={SESSION_IMPORT_FILTER}
            value={sourcePath}
            onChange={setSourcePath}
            onEnter={importSource}
            onPicked={(picked) => {
              if (busy) return;
              if (picked.trim().toLowerCase().endsWith('.tasmo')) void loadTasmoAsSession(picked);
              else void detectAndImport();
            }}
            onFocus={openRecent}
            onClick={openRecent}
            onBlur={scheduleCloseRecent}
            onKeyDown={onPathKeyDown}
            role="combobox"
            ariaExpanded={recentVisible}
            ariaControls={recentVisible ? 'session-recent-listbox' : undefined}
            ariaAutocomplete="list"
            ariaActiveDescendant={activeIdx >= 0 ? `session-recent-opt-${activeIdx}` : undefined}
            placeholder=".als / .swayproj / .tasmo / any project"
            className="flex-1 min-w-0"
          />
          {/* ONE Open control: the field's browse picker. A picked file imports
              immediately (onPicked), typing + Enter imports, a recent row
              imports — there is no separate Import button to click after. */}
          {busy && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-purple-300" aria-label="Importing…" />}
          {recentVisible && (
            <div
              id="session-recent-listbox"
              role="listbox"
              aria-label="Recent projects"
              className="absolute left-0 right-0 top-full mt-1 z-50 max-h-56 overflow-y-auto rounded border border-white/10 bg-black/90 shadow-xl"
            >
              {recent.map((r, i) => (
                <button
                  key={r.path}
                  type="button"
                  role="option"
                  id={`session-recent-opt-${i}`}
                  aria-selected={i === activeIdx}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickRecent(r)}
                  className={`w-full text-left px-2 py-1.5 border-b border-white/5 last:border-0 hover:bg-purple-500/15 ${
                    i === activeIdx ? 'bg-purple-500/10 text-purple-200' : 'text-zinc-200'
                  }`}
                >
                  <span className="block truncate text-[10px] font-mono">{r.name}</span>
                  <span className="block truncate text-[8px] text-zinc-500">{r.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {/* Compact status badges — one icon each, detail on mouse-over. */}
          {project && detected && (
            <span
              className="h-7 px-1.5 inline-flex items-center rounded border border-sky-400/25 bg-sky-400/5 text-[8px] font-black uppercase tracking-widest text-sky-200 cursor-help"
              title={`Detected ${DAW_LABELS[detected.daw] ?? detected.daw}${hint ? ` — ${hint.limitation}` : ''}`}
            >
              {(DAW_LABELS[detected.daw] ?? detected.daw).split(/\s+/).map((w) => w[0]).join('').slice(0, 2)}
            </span>
          )}
          {project && (project.warnings.length > 0 || project.missing_files.length > 0) && (
            <span
              className="h-7 px-1.5 inline-flex items-center gap-1 rounded border border-amber-400/25 bg-amber-400/5 text-[9px] font-mono text-amber-200 cursor-help"
              title={[
                ...project.warnings,
                ...(project.missing_files.length
                  ? [`${project.missing_files.length} sample(s) missing — those clips will not play:`,
                     ...project.missing_files.slice(0, 20),
                     ...(project.missing_files.length > 20 ? [`…and ${project.missing_files.length - 20} more`] : [])]
                  : []),
              ].join('\n')}
            >
              <AlertTriangle className="w-3 h-3" />
              {project.warnings.length + (project.missing_files.length ? 1 : 0)}
            </span>
          )}
          {project && (
            <span className="h-7 px-1.5 inline-flex items-center text-[8px] font-mono text-zinc-500 cursor-help" title={`${project.scenes.length} scenes × ${project.tracks.length} tracks`}>
              {project.scenes.length}×{project.tracks.length}
            </span>
          )}
          {project && (
            <>
              <button
                type="button"
                onClick={() => usePerformRailStore.getState().setOpen(!railOpen)}
                aria-pressed={railOpen}
                aria-label="Routes and parameters rail"
                className={`h-7 w-7 inline-flex items-center justify-center rounded border ${
                  railOpen
                    ? 'border-emerald-400/40 text-emerald-100 bg-emerald-400/10'
                    : 'border-white/10 text-zinc-300 hover:text-white hover:bg-white/5'
                }`}
                title="Routes & Params — the route list and live effect parameters, in a rail on the right"
              >
                <PanelRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setShowRouting((v) => !v)}
                aria-pressed={showRouting}
                aria-label="Sway routing"
                className={`h-7 w-7 inline-flex items-center justify-center rounded border ${
                  showRouting
                    ? 'border-fuchsia-400/40 text-fuchsia-100 bg-fuchsia-400/10'
                    : 'border-white/10 text-zinc-300 hover:text-white hover:bg-white/5'
                }`}
                title="Sway routing — auto-routed from the project; click to view or edit"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={saveAsTasmo}
                aria-label="Save as .tasmo"
                className="h-7 w-7 inline-flex items-center justify-center rounded border border-white/10 text-zinc-300 hover:text-white hover:bg-white/5"
                title="Save — writes this session (with its routing) as a .tasmo"
              >
                <Save className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void editInTimeline()}
                disabled={timelineBusy}
                aria-label="Edit in timeline"
                className="h-7 w-7 inline-flex items-center justify-center rounded border border-emerald-400/30 text-emerald-100 hover:text-white hover:bg-emerald-400/10 disabled:opacity-45"
                title="Edit — load this project into the editable timeline"
              >
                {timelineBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Scissors className="w-3.5 h-3.5" />}
              </button>
            </>
          )}
          {/* Credit, one icon: hover for the line, the links live in its popover. */}
          <span className="relative group/credit h-7 w-7 inline-flex items-center justify-center rounded border border-white/10 text-zinc-500 hover:text-zinc-200">
            <Info className="w-3.5 h-3.5" aria-label="Perform adapted from InfiNight's fork of theDAW" />
            <span className="pointer-events-auto absolute right-0 top-full z-50 mt-1 hidden w-max max-w-xs rounded border border-white/10 bg-black/95 p-2 shadow-xl group-hover/credit:block">
              <InfiNightCredit feature="Perform" />
            </span>
          </span>
        </div>
      </div>

      {/* Errors only. Detection, format hints, warnings and missing samples all
          moved into the header badges (mouse-over for detail) — an import that
          WORKS no longer costs rows of chrome. */}
      {error && (
        <div className="shrink-0 px-3 py-1.5 flex items-center gap-2 text-[9px] font-mono text-red-200 bg-black/15 border-b border-white/5">
          <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
          {error}
        </div>
      )}

      {project && showRouting && (
        <div className="shrink-0 border-b border-white/5 bg-[#0d0d13]">
          <PerformRoutingPanel project={project} />
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0 p-2">
          {/* DawSessionGrid is keyed on project identity: it holds a decoded-buffer
              cache and per-track refs that are NOT cleared between imports, so
              without a remount a second import inherits the first one's audio. */}
          {project ? (
            <DawSessionGrid
              key={`${project.source_daw}:${project.name}:${project.tracks.length}`}
              project={project}
              fill
            />
          ) : (
            <div className="h-full rounded border border-dashed border-white/10 bg-black/15 grid place-items-center">
              <div className="flex flex-col items-center gap-2 text-center">
                <FolderInput className="w-7 h-7 text-zinc-600" />
                <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                  No Project Loaded
                </div>
              </div>
            </div>
          )}
        </div>
        {/* Right rail — the route list (formerly a chip wall above the grid)
            and live effect parameters. Collapsible, expandable, resizable. */}
        {project && <PerformRail project={project} />}
      </div>

      {/* The window a track's hosted plugin opens its own editor in. */}
      <PerformVstWindow />

    </div>
  );
};
