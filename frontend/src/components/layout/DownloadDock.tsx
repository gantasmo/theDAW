/**
 * DownloadDock — floating bottom-right model download manager.
 *
 * Appears only while/after downloads happen (returns null when there are no
 * jobs). Collapsed it is a compact pill (active count + summed speed, or a
 * "done" badge). Expanded it shows one row per model with a live progress bar,
 * speed, size, file counter, and destination, plus an actionable error block
 * for failed downloads.
 *
 * The store owns all state; this component is purely a view + a few buttons.
 */
import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useDownloadStore } from '../../state/downloadStore';
import { classifyDownloadError, type DownloadJob } from '../../lib/modelDownloadClient';
import { formatBytes } from '../../lib/storageClient';

/** Bytes/sec → human rate (B/s · KB/s · MB/s · GB/s). */
const formatSpeed = (bytesPerSec: number): string => {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  const units = ['KB/s', 'MB/s', 'GB/s'];
  let v = bytesPerSec;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
};

const isActive = (job: DownloadJob): boolean =>
  job.status === 'queued' || job.status === 'downloading';

// Default resting spot: bottom-right, but lifted high enough (bottom-28 = 7rem)
// to clear the collapsed ShellBottomDock strip so the dock isn't clipped.
const DEFAULT_POS_CLASS = 'bottom-28 right-4';

export const DownloadDock: React.FC = () => {
  const jobs = useDownloadStore((s) => s.jobs);
  const expanded = useDownloadStore((s) => s.expanded);
  const setExpanded = useDownloadStore((s) => s.setExpanded);
  const clear = useDownloadStore((s) => s.clear);

  // Manual position once the user drags. null = default anchored (bottom-right).
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const dragRef = React.useRef<{
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  // Drag from any handle; clamps the dock inside the viewport. A move under
  // 3px is treated as a click (so the collapsed pill still expands on tap).
  const startDrag = React.useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const root = (e.currentTarget as HTMLElement).closest('[data-dock-root]') as HTMLElement | null;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    dragRef.current = {
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved) {
        if (Math.abs(ev.clientX - d.startX) < 3 && Math.abs(ev.clientY - d.startY) < 3) return;
        d.moved = true;
      }
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      const x = Math.max(4, Math.min(ev.clientX - d.dx, window.innerWidth - w - 4));
      const y = Math.max(4, Math.min(ev.clientY - d.dy, window.innerHeight - h - 4));
      setPos({ x, y });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.setTimeout(() => {
        dragRef.current = null;
      }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  if (jobs.length === 0) return null;

  const activeJobs = jobs.filter(isActive);
  const totalSpeed = activeJobs.reduce((sum, job) => {
    const file = job.files[job.current_file];
    return sum + (file?.speed ?? 0);
  }, 0);

  const posClass = pos ? 'fixed z-50' : `fixed z-50 ${DEFAULT_POS_CLASS}`;
  const posStyle = pos ? { left: pos.x, top: pos.y } : undefined;

  // ── Collapsed: a single draggable pill. ─────────────────────────────────
  if (!expanded) {
    const label =
      activeJobs.length > 0
        ? `${activeJobs.length} downloading · ${formatSpeed(totalSpeed)}`
        : 'Downloads';
    return (
      <button
        type="button"
        data-dock-root
        onPointerDown={startDrag}
        onClick={() => {
          if (!dragRef.current?.moved) setExpanded(true);
        }}
        aria-label="Expand downloads (drag to move)"
        style={posStyle}
        className={`${posClass} inline-flex items-center gap-1.5 rounded-lg border border-purple-500/40 bg-[#0a080f]/95 px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-widest text-purple-200 shadow-[0_0_16px_rgba(168,85,247,0.35)] backdrop-blur-md hover:bg-purple-500/15 hover:text-white transition-colors cursor-grab active:cursor-grabbing touch-none select-none`}
      >
        {activeJobs.length > 0 ? (
          <Loader2 className="w-3 h-3 animate-spin shrink-0" />
        ) : (
          <CheckCircle2 className="w-3 h-3 text-emerald-300 shrink-0" />
        )}
        <span className="truncate">{label}</span>
        {activeJobs.length === 0 && <span className="text-emerald-300">✓</span>}
      </button>
    );
  }

  // ── Expanded: draggable header + scrollable job stack. ──────────────────
  return (
    <div
      data-dock-root
      style={posStyle}
      className={`${posClass} w-96 max-w-[92vw] rounded-lg border border-purple-500/30 bg-[#0a080f]/95 shadow-[0_0_24px_rgba(0,0,0,0.6)] backdrop-blur-md overflow-hidden`}
    >
      <div
        onPointerDown={startDrag}
        className="flex items-center gap-2 px-2.5 py-2 border-b border-white/5 bg-linear-to-r from-purple-900/25 to-purple-900/10 cursor-grab active:cursor-grabbing touch-none select-none"
      >
        <Download className="w-3.5 h-3.5 text-purple-300 shrink-0" />
        <span className="text-[10px] font-black uppercase tracking-widest text-purple-200">Downloads</span>
        <span className="text-[8px] font-mono text-zinc-500">
          {activeJobs.length > 0 ? `${activeJobs.length} active · ${formatSpeed(totalSpeed)}` : `${jobs.length} total`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void clear()}
            aria-label="Clear finished downloads"
            title="Clear finished / errored downloads"
            className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-zinc-500 hover:bg-white/5 hover:text-zinc-200 transition-colors"
          >
            <Trash2 className="w-2.5 h-2.5" />
            Clear
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setExpanded(false)}
            aria-label="Collapse downloads"
            title="Collapse"
            className="p-1 rounded text-zinc-500 hover:bg-white/5 hover:text-white transition-colors"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="max-h-80 overflow-y-auto flex flex-col divide-y divide-white/5">
        {jobs.map((job) => (
          <DownloadRow key={job.id} job={job} />
        ))}
      </div>
    </div>
  );
};

const DownloadRow: React.FC<{ job: DownloadJob }> = ({ job }) => {
  const file = job.files[job.current_file];
  const fileCount = job.files.length;
  const bytesDone = file?.bytes_done ?? 0;
  const bytesTotal = file?.bytes_total ?? 0;
  const pct = bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : 0;
  const isError = job.status === 'error';
  const isDone = job.status === 'done';

  return (
    <div className={`px-2.5 py-2 ${isError ? 'bg-rose-500/5' : ''}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {job.status === 'downloading' || job.status === 'queued' ? (
          <Loader2 className="w-3 h-3 text-purple-300 animate-spin shrink-0" />
        ) : isDone ? (
          <CheckCircle2 className="w-3 h-3 text-emerald-300 shrink-0" />
        ) : (
          <AlertCircle className="w-3 h-3 text-rose-300 shrink-0" />
        )}
        <span className="text-[10px] font-bold text-zinc-100 truncate" title={job.label}>{job.label}</span>
        {fileCount > 0 && (
          <span className="ml-auto shrink-0 text-[8px] font-mono text-zinc-500 tabular-nums">
            file {Math.min(job.current_file + 1, fileCount)} of {fileCount}
          </span>
        )}
      </div>

      {isError ? (
        <DownloadError detail={job.error_detail ?? ''} repoId={job.error_repo_id ?? undefined} />
      ) : (
        <>
          {file?.filename && (
            <div className="text-[8px] font-mono text-zinc-500 truncate mb-1" title={file.filename}>
              {file.filename}
            </div>
          )}
          <div
            role="progressbar"
            aria-label={`${job.label} download progress`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full rounded-full bg-white/5 overflow-hidden"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${isDone ? 'bg-emerald-400' : 'bg-purple-400'}`}
              style={{ width: `${isDone ? 100 : pct}%` }}
            />
          </div>
          <div className="flex items-center gap-2 mt-1 text-[8px] font-mono text-zinc-500 tabular-nums">
            <span>{formatBytes(bytesDone)} / {formatBytes(bytesTotal)}</span>
            {job.status === 'downloading' && <span className="text-purple-300">{formatSpeed(file?.speed ?? 0)}</span>}
            {isDone && <span className="text-emerald-300">done</span>}
            {job.dest_dir && (
              <span className="ml-auto truncate text-zinc-600" title={job.dest_dir}>{job.dest_dir}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
};

const DownloadError: React.FC<{ detail: string; repoId?: string }> = ({ detail, repoId }) => {
  const info = classifyDownloadError(detail, repoId);
  return (
    <div className="rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1.5">
      <div className="text-[9px] font-black uppercase tracking-widest text-rose-300">{info.headline}</div>
      <p className="mt-0.5 text-[8px] leading-relaxed text-rose-200/80">{info.fix}</p>
      {info.links && info.links.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {info.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[8px] font-mono text-rose-300 hover:text-rose-100 transition-colors"
            >
              <ExternalLink className="w-2.5 h-2.5" /> {link.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
};

export default DownloadDock;
