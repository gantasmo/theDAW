import React, { useState } from 'react';
import {
  Play,
  Pause,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Volume2,
  RefreshCw,
  Copy,
  Layers,
  Shuffle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useSunoStore } from './sunoStore';
import { sunoApi, type SunoJob, type SunoStatus } from './sunoApi';
import { usePlayerStore } from '../state/playerStore';
import { logError } from '../state/logStore';
import { HoverTip } from '../components/ui/Tooltip';

/**
 * SunoJobList — the right-hand output column. Each completed job can be played
 * through the global player engine (so it shares the visualizer + footer
 * transport) and re-used as a Cover / Mashup base.
 */

const STATUS: Record<SunoStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  submitted: { label: 'Submitted', cls: 'text-blue-300 bg-blue-500/10', icon: <Clock className="w-3 h-3" /> },
  queued: { label: 'Queued', cls: 'text-yellow-300 bg-yellow-500/10', icon: <Clock className="w-3 h-3" /> },
  streaming: { label: 'Streaming', cls: 'text-purple-300 bg-purple-500/10', icon: <Volume2 className="w-3 h-3 animate-pulse" /> },
  complete: { label: 'Complete', cls: 'text-emerald-300 bg-emerald-500/10', icon: <CheckCircle2 className="w-3 h-3" /> },
  error: { label: 'Error', cls: 'text-red-300 bg-red-500/10', icon: <AlertCircle className="w-3 h-3" /> },
};

export const SunoJobList: React.FC = () => {
  const jobs = useSunoStore((s) => s.jobs);
  const prefillCover = useSunoStore((s) => s.prefillCover);
  const prefillMashup = useSunoStore((s) => s.prefillMashup);
  const [expanded, setExpanded] = useState<string | null>(null);

  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const engineIsPlaying = usePlayerStore((s) => s.isPlaying);
  const engineLoad = usePlayerStore((s) => s.load);
  const enginePlay = usePlayerStore((s) => s.play);
  const enginePause = usePlayerStore((s) => s.pause);

  const play = async (job: SunoJob) => {
    // Already the loaded track → just toggle play/pause.
    if (engineEntryId === job.id) {
      if (engineIsPlaying) enginePause();
      else enginePlay();
      return;
    }
    try {
      const blob = await sunoApi.fetchAudioBlob(job.id);
      await engineLoad(blob, { label: job.title || job.id.slice(0, 8), entryId: job.id });
      enginePlay();
    } catch (e) {
      logError('suno', `Play failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const refresh = async (id: string) => {
    try {
      const updated = await sunoApi.poll(id);
      useSunoStore.setState((st) => ({ jobs: st.jobs.map((j) => (j.id === id ? updated : j)) }));
    } catch {
      /* ignore */
    }
  };

  if (jobs.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center opacity-30 italic gap-2 text-[11px]">
        <Volume2 className="w-8 h-8" />
        <p>No Suno generations yet.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar p-2 flex flex-col gap-2">
      {jobs.map((job) => {
        const cfg = STATUS[job.status] ?? STATUS.submitted;
        const hasAudio = (job.status === 'complete' || job.status === 'streaming') && !!job.audio_url;
        const isCurrent = engineEntryId === job.id;
        const open = expanded === job.id;
        return (
          <div key={job.id} className={`hardware-card shrink-0 p-2 ${isCurrent ? 'ring-1 ring-purple-500/50' : ''}`}>
            <div className="flex items-start gap-2">
              <HoverTip text={hasAudio ? 'Play or pause this track in the shared player.' : 'Audio is not ready yet — the job is still generating.'}>
                <button
                  onClick={() => hasAudio && void play(job)}
                  disabled={!hasAudio}
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${hasAudio ? 'bg-purple-500/15 text-purple-300 hover:bg-purple-500/25' : 'bg-white/3 text-zinc-600'}`}
                >
                  {!hasAudio && job.status !== 'error' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : isCurrent && engineIsPlaying ? (
                    <Pause className="w-3.5 h-3.5" />
                  ) : (
                    <Play className="w-3.5 h-3.5 ml-0.5" />
                  )}
                </button>
              </HoverTip>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={`inline-flex items-center gap-1 px-1.5 py-px rounded text-[8px] font-mono uppercase tracking-wider ${cfg.cls}`}>
                    {cfg.icon}
                    {cfg.label}
                  </span>
                  {job.created_at && (
                    <span className="text-[8px] text-zinc-600 font-mono">
                      {new Date(job.created_at).toLocaleTimeString()}
                    </span>
                  )}
                </div>
                <div className="text-[10px] font-bold text-zinc-200 truncate">{job.title || 'Untitled'}</div>
                {job.metadata?.style && (
                  <div className="text-[8px] text-zinc-500 font-mono truncate">{job.metadata.style}</div>
                )}
                {job.error && <div className="text-[9px] text-red-400 mt-0.5">{job.error}</div>}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <HoverTip text="Copy this clip’s id to the clipboard — handy for Cover or Mashup sources.">
                  <button
                    className="p-1 hover:bg-white/10 rounded text-zinc-500"
                    onClick={() => void navigator.clipboard?.writeText(job.id)}
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </HoverTip>
                <HoverTip text="Re-check this job’s status with Suno right now.">
                  <button
                    className="p-1 hover:bg-white/10 rounded text-zinc-500"
                    onClick={() => void refresh(job.id)}
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                </HoverTip>
                <HoverTip text={open ? 'Hide the reuse actions for this clip.' : 'Show actions to reuse this clip as a Cover or Mashup.'}>
                  <button
                    className="p-1 hover:bg-white/10 rounded text-zinc-500"
                    onClick={() => setExpanded(open ? null : job.id)}
                  >
                    {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                </HoverTip>
              </div>
            </div>

            {open && job.status === 'complete' && (
              <div className="mt-2 pt-2 border-t border-white/5 flex items-center gap-1.5 flex-wrap">
                <span className="mono-label text-[8px]!">USE AS:</span>
                <HoverTip text="Load this clip into the Cover form to re-style it.">
                  <button
                    className="mono-tag bg-white/5! text-zinc-300! hover:text-purple-300! flex items-center gap-1"
                    onClick={() => prefillCover(job.id)}
                  >
                    <Layers className="w-2.5 h-2.5" /> Cover
                  </button>
                </HoverTip>
                <HoverTip text="Load this clip as the base of a new Mashup.">
                  <button
                    className="mono-tag bg-white/5! text-zinc-300! hover:text-purple-300! flex items-center gap-1"
                    onClick={() => prefillMashup(job.id)}
                  >
                    <Shuffle className="w-2.5 h-2.5" /> Mashup base
                  </button>
                </HoverTip>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
