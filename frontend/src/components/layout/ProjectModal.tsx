import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FolderOpen,
  Layers,
  Loader2,
  Package,
  Save,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useProjectStore } from '../../state/projectStore';
import { PathInput } from '../ui/PathInput';
import { TASMO_FILTER } from '../../lib/fileFilters';

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}> = ({ active, onClick, icon: Icon, label }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border text-[9px] font-black uppercase tracking-widest transition-colors ${
      active
        ? 'border-sky-500/50 bg-sky-500/15 text-sky-100'
        : 'border-white/5 text-zinc-500 hover:text-zinc-200 hover:bg-white/3'
    }`}
  >
    <Icon className="w-3 h-3" />
    {label}
  </button>
);

export const ProjectModal: React.FC = () => {
  const {
    isOpen,
    tab,
    busy,
    error,
    recent,
    projectName,
    tempo,
    embedAudio,
    savePath,
    pendingTracks,
    sourceDaw,
    lastSaved,
    openPath,
    loaded,
  } = useProjectStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      tab: s.tab,
      busy: s.busy,
      error: s.error,
      recent: s.recent,
      projectName: s.projectName,
      tempo: s.tempo,
      embedAudio: s.embedAudio,
      savePath: s.savePath,
      pendingTracks: s.pendingTracks,
      sourceDaw: s.sourceDaw,
      lastSaved: s.lastSaved,
      openPath: s.openPath,
      loaded: s.loaded,
    })),
  );
  const close = useProjectStore((s) => s.close);
  const setTab = useProjectStore((s) => s.setTab);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const setTempo = useProjectStore((s) => s.setTempo);
  const setEmbedAudio = useProjectStore((s) => s.setEmbedAudio);
  const setSavePath = useProjectStore((s) => s.setSavePath);
  const setOpenPath = useProjectStore((s) => s.setOpenPath);
  const save = useProjectStore((s) => s.save);
  const loadPath = useProjectStore((s) => s.loadPath);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div className="relative bg-[#0c0a14] border border-sky-500/30 rounded-lg w-120 max-h-[82vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/5 shrink-0">
          <Package className="w-3.5 h-3.5 text-sky-300 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-sky-200">
            Project (.tasmo)
          </span>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="ml-auto p-1 text-zinc-500 hover:text-white rounded hover:bg-white/5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1.5 px-4 pt-3 shrink-0">
          <TabButton active={tab === 'save'} onClick={() => setTab('save')} icon={Save} label="Save" />
          <TabButton active={tab === 'open'} onClick={() => setTab('open')} icon={FolderOpen} label="Open" />
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-3">
          {error && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
              <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
              <span className="text-[9px] font-mono text-red-200">{error}</span>
            </div>
          )}

          {tab === 'save' ? (
            <>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="project-name"
                  className="text-[9px] font-mono uppercase tracking-wider text-zinc-400"
                >
                  Project name
                </label>
                <input
                  id="project-name"
                  name="project_name"
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 focus:border-sky-500/50 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="project-tempo"
                    className="text-[9px] font-mono uppercase tracking-wider text-zinc-400"
                  >
                    Tempo (BPM)
                  </label>
                  <input
                    id="project-tempo"
                    name="project_tempo"
                    type="number"
                    step="0.1"
                    value={tempo}
                    onChange={(e) => setTempo(parseFloat(e.target.value))}
                    className="compact-input w-24"
                  />
                </div>
                <label
                  htmlFor="project-embed"
                  className="flex items-center gap-1.5 mt-4 cursor-pointer select-none"
                >
                  <input
                    id="project-embed"
                    name="project_embed"
                    type="checkbox"
                    checked={embedAudio}
                    onChange={(e) => setEmbedAudio(e.target.checked)}
                    className="accent-sky-500"
                  />
                  <span className="text-[9px] font-mono text-zinc-300">
                    Embed audio (portable, larger file)
                  </span>
                </label>
              </div>

              <PathInput
                id="project-save-path"
                name="project_save_path"
                label="Save to"
                kind="file"
                fileFilter={TASMO_FILTER}
                value={savePath}
                onChange={setSavePath}
                placeholder="C:\\path\\to\\song.tasmo"
                description=".tasmo extension is added automatically if you omit it."
              />

              <div className="text-[9px] font-mono text-zinc-500">
                Captures {pendingTracks.length} track(s)
                {sourceDaw ? ` from ${sourceDaw}` : ''}.
              </div>

              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !savePath.trim()}
                className="btn-primary inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Save project
              </button>

              {lastSaved && (
                <div className="flex items-start gap-1.5 bg-emerald-500/5 border border-emerald-500/15 rounded px-2 py-1.5">
                  <CheckCircle2 className="w-3 h-3 text-emerald-300 shrink-0 mt-px" />
                  <span className="text-[9px] font-mono text-emerald-200 break-all">
                    Saved ({lastSaved.manifest.audio_mode}) — {lastSaved.path}
                  </span>
                </div>
              )}
            </>
          ) : (
            <>
              <PathInput
                id="project-open-path"
                name="project_open_path"
                label="Open .tasmo"
                kind="file"
                fileFilter={TASMO_FILTER}
                value={openPath}
                onChange={setOpenPath}
                onEnter={() => void loadPath()}
                placeholder="C:\\path\\to\\song.tasmo"
              />
              <button
                type="button"
                onClick={() => void loadPath()}
                disabled={busy || !openPath.trim()}
                className="btn-primary inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderOpen className="w-3 h-3" />}
                Open project
              </button>

              {/* Recent */}
              <div className="flex flex-col gap-1">
                <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">
                  Recent
                </span>
                {recent.length === 0 ? (
                  <span className="text-[9px] text-zinc-600 italic">No recent projects.</span>
                ) : (
                  <div className="border border-white/5 rounded divide-y divide-white/5 max-h-32 overflow-y-auto">
                    {recent.map((r) => (
                      <button
                        key={r.path}
                        type="button"
                        onClick={() => void loadPath(r.path)}
                        className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-white/4 transition-colors"
                      >
                        <Clock className="w-3 h-3 text-zinc-600 shrink-0" />
                        <span className="flex-1 min-w-0 text-[9px] font-mono text-zinc-300 truncate">
                          {r.name}
                        </span>
                        <span className="text-[8px] font-mono text-zinc-700 truncate max-w-50">
                          {r.path}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Loaded preview */}
              {loaded && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-300">
                    <Layers className="w-3.5 h-3.5 text-sky-300" />
                    <span className="font-bold text-zinc-100">{loaded.project.project_name}</span>
                    <span className="text-zinc-600">
                      {loaded.project.tempo} BPM · {loaded.manifest.audio_mode}
                    </span>
                  </div>
                  <div className="border border-white/5 rounded max-h-48 overflow-y-auto divide-y divide-white/5">
                    {loaded.project.tracks.length === 0 ? (
                      <p className="px-2 py-2 text-[9px] text-zinc-600 italic">No tracks.</p>
                    ) : (
                      loaded.project.tracks.map((t, i) => (
                        <div key={i} className="flex items-center gap-2 px-2 py-1">
                          <span className="mono-tag shrink-0">{t.type}</span>
                          <span className="flex-1 min-w-0 text-[9px] font-mono text-zinc-300 truncate">
                            {t.name}
                          </span>
                          <span className="text-[8px] font-mono text-zinc-600 shrink-0">
                            {t.clips.length} clip
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
