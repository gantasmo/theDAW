import React from 'react';
import { AlertCircle, AlertTriangle, FolderInput, Layers, Loader2, PackagePlus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDawImportStore } from '../state/dawImportStore';
import { useProjectStore } from '../state/projectStore';
import { DAW_LABELS } from '../lib/dawImportClient';
import { dawProjectToTasmo } from '../lib/projectClient';
import { DAW_PROJECT_FILTER } from '../lib/fileFilters';
import { PathInput } from '../components/ui/PathInput';
import { DawSessionGrid } from '../components/session/DawSessionGrid';

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
  const openProject = useProjectStore((s) => s.open);

  const saveAsTasmo = () => {
    if (!project) return;
    openProject('save', dawProjectToTasmo(project));
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#0b0b10]">
      <div className="shrink-0 border-b border-white/10 bg-[#111118] px-3 py-2 flex items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-emerald-300 shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] font-black uppercase tracking-widest text-zinc-100">
              Ableton Session
            </div>
            <div className="text-[8px] font-mono text-zinc-500 truncate">
              {project ? `${project.name} · ${project.tempo} BPM` : 'No session loaded'}
            </div>
          </div>
        </div>
        {project && (
          <div className="ml-auto flex items-center gap-2 text-[8px] font-mono text-zinc-500">
            <span>{project.scenes.length} scenes</span>
            <span>{project.tracks.length} tracks</span>
            <button
              type="button"
              onClick={saveAsTasmo}
              className="h-7 px-2 inline-flex items-center gap-1 rounded border border-white/10 text-zinc-300 hover:text-white hover:bg-white/5"
            >
              <PackagePlus className="w-3 h-3" />
              .tasmo
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-b border-white/5 bg-[#0f0f15] px-3 py-2 grid grid-cols-[minmax(260px,1fr)_auto] gap-2 items-end">
        <PathInput
          id="session-import-path"
          name="session_import_path"
          label="Ableton project"
          kind="file"
          fileFilter={DAW_PROJECT_FILTER}
          value={sourcePath}
          onChange={setSourcePath}
          onEnter={() => void detectAndImport()}
          placeholder=".als"
        />
        <button
          type="button"
          onClick={() => void detectAndImport()}
          disabled={busy || !sourcePath.trim()}
          className="btn-primary h-9 inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderInput className="w-3 h-3" />}
          Import
        </button>
      </div>

      {(error || detected || hint || project?.warnings.length) && (
        <div className="shrink-0 px-3 py-2 flex flex-col gap-1.5 bg-black/15 border-b border-white/5">
          {error && (
            <div className="flex items-center gap-2 text-[9px] font-mono text-red-200">
              <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
              {error}
            </div>
          )}
          {detected && (
            <div className="text-[9px] font-mono text-zinc-400">
              Detected <span className="text-sky-200">{DAW_LABELS[detected.daw] ?? detected.daw}</span>
            </div>
          )}
          {hint && (
            <div className="text-[9px] font-mono text-amber-100">
              {hint.limitation}
            </div>
          )}
          {project?.warnings.map((warning, index) => (
            <div key={index} className="flex items-start gap-1.5 text-[8px] font-mono text-amber-100">
              <AlertTriangle className="w-3 h-3 text-amber-300 shrink-0 mt-px" />
              {warning}
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 p-2">
        {project ? (
          <DawSessionGrid project={project} fill />
        ) : (
          <div className="h-full rounded border border-dashed border-white/10 bg-black/15 grid place-items-center">
            <div className="flex flex-col items-center gap-2 text-center">
              <FolderInput className="w-7 h-7 text-zinc-600" />
              <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                No Session Loaded
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
