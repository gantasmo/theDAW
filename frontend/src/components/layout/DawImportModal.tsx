import React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  FileDown,
  FolderInput,
  Layers,
  Loader2,
  PackagePlus,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDawImportStore } from '../../state/dawImportStore';
import { useProjectStore } from '../../state/projectStore';
import { PathInput } from '../ui/PathInput';
import { DAW_LABELS } from '../../lib/dawImportClient';
import { dawProjectToTasmo } from '../../lib/projectClient';
import { DAW_PROJECT_FILTER } from '../../lib/fileFilters';

export const DawImportModal: React.FC = () => {
  const { isOpen, sourcePath, detected, project, hint, busy, error } = useDawImportStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      sourcePath: s.sourcePath,
      detected: s.detected,
      project: s.project,
      hint: s.hint,
      busy: s.busy,
      error: s.error,
    })),
  );
  const close = useDawImportStore((s) => s.close);
  const setSourcePath = useDawImportStore((s) => s.setSourcePath);
  const detectAndImport = useDawImportStore((s) => s.detectAndImport);
  const openProject = useProjectStore((s) => s.open);

  if (!isOpen) return null;

  const saveAsTasmo = () => {
    if (!project) return;
    openProject('save', dawProjectToTasmo(project));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div className="relative bg-[#0c0a14] border border-sky-500/30 rounded-lg w-130 max-h-[82vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/5 shrink-0">
          <FolderInput className="w-3.5 h-3.5 text-sky-300 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-sky-200">
            Import DAW Project
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-3">
          <PathInput
            id="daw-import-path"
            name="daw_import_path"
            label="Project file"
            kind="file"
            fileFilter={DAW_PROJECT_FILTER}
            value={sourcePath}
            onChange={setSourcePath}
            onEnter={() => void detectAndImport()}
            placeholder=".als .RPP .flp .aup3 .sesx .bwproject .avc .logicx"
            description="Ableton, Reaper, FL Studio, Audacity, Audition, Bitwig and Resolume import directly. Logic / Cubase / Pro Tools show an export-to-audio guide."
          />

          <button
            type="button"
            onClick={() => void detectAndImport()}
            disabled={busy || !sourcePath.trim()}
            className="btn-primary inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderInput className="w-3 h-3" />}
            Detect &amp; Import
          </button>

          {error && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
              <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
              <span className="text-[9px] font-mono text-red-200">{error}</span>
            </div>
          )}

          {detected && (
            <div className="text-[9px] font-mono text-zinc-400">
              Detected:{' '}
              <span className="text-sky-200">{DAW_LABELS[detected.daw] ?? detected.daw}</span>{' '}
              <span className="text-zinc-600">(.{detected.format})</span>
            </div>
          )}

          {/* Parsed project preview */}
          {project && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-300">
                <Layers className="w-3.5 h-3.5 text-sky-300" />
                <span className="font-bold text-zinc-100">{project.name}</span>
                <span className="text-zinc-600">
                  {project.tempo} BPM · {project.tracks.length} track(s)
                </span>
              </div>

              {project.warnings.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5 flex flex-col gap-1">
                  {project.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3 h-3 text-amber-300 shrink-0 mt-px" />
                      <span className="text-[8px] font-mono text-amber-100 leading-relaxed">{w}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="border border-white/5 rounded max-h-56 overflow-y-auto divide-y divide-white/5">
                {project.tracks.length === 0 ? (
                  <p className="px-2 py-2 text-[9px] text-zinc-600 italic">No tracks parsed.</p>
                ) : (
                  project.tracks.map((t, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1">
                      <span className="mono-tag shrink-0">{t.type}</span>
                      <span className="flex-1 min-w-0 text-[9px] font-mono text-zinc-300 truncate">
                        {t.name}
                      </span>
                      <span className="text-[8px] font-mono text-zinc-600 shrink-0">
                        {t.clips.length} clip · {t.devices.length} fx
                      </span>
                    </div>
                  ))
                )}
              </div>

              <button
                type="button"
                onClick={saveAsTasmo}
                className="btn-ghost inline-flex items-center justify-center gap-1.5"
              >
                <PackagePlus className="w-3 h-3" />
                Save as .tasmo…
              </button>
            </div>
          )}

          {/* Export-only DAWs */}
          {hint && (
            <div className="bg-white/3 border border-white/10 rounded px-3 py-2 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[9px] font-mono text-zinc-300">
                <FileDown className="w-3 h-3 text-sky-300" />
                <span>{hint.limitation}</span>
              </div>
              <ol className="list-decimal list-inside flex flex-col gap-0.5">
                {hint.recommended_workflow.map((step, i) => (
                  <li key={i} className="text-[8px] font-mono text-zinc-500 leading-relaxed">
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
