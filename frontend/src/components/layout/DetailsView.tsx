import React, { useEffect, useState } from 'react';
import { Database, Tag, Star, Calendar, Clock, Music, Disc, Hash, FileAudio, Layers, Send, Download, Scissors, Activity, Wand2, Loader2 } from 'lucide-react';
import { useLibraryStore, type LibraryEntry } from '../../state/libraryStore';
import { usePlayerStore } from '../../state/playerStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { useGenerateParamsStore } from '../../state/generateParamsStore';
import { logError, logInfo } from '../../state/logStore';

interface AnalysisRow {
  bpm: number | null;
  key: string | null;
  scale: string | null;
  key_confidence: number | null;
  pitch_mean_hz: number | null;
  pitch_std_hz: number | null;
  loudness_lufs: number | null;
  rms_db: number | null;
  bars_estimated: number | null;
  genre: string | null;
  genre_confidence: number | null;
  embedded_tags_json: string | null;
  ffprobe_json: string | null;
  analyzed_at: number | null;
}

interface InferredPrompt {
  prompt_guess: string;
  prompt_confidence: number;
  semantic_tags: string[];
}

const fmtDuration = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0').slice(0, 2)}`;
};

const fmtSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

const fmtDate = (iso: string): string => {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
};

const Row: React.FC<{ icon?: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode; mono?: boolean }> = ({
  icon: Icon,
  label,
  value,
  mono = true,
}) => (
  <div className="flex items-center gap-3 py-1 border-b border-white/4">
    <div className="w-24 flex items-center gap-1.5 shrink-0">
      {Icon && <Icon className="w-2.5 h-2.5 text-zinc-600" />}
      <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">{label}</span>
    </div>
    <span className={`text-[10px] flex-1 min-w-0 truncate ${mono ? 'font-mono text-zinc-200' : 'text-zinc-200'}`}>{value}</span>
  </div>
);

export const DetailsView: React.FC = () => {
  const selectedId = useLibraryStore((s) => s.selectedEntryId);
  const entry: LibraryEntry | undefined = useLibraryStore((s) =>
    s.selectedEntryId ? s.entries.find((e) => e.id === s.selectedEntryId) : undefined,
  );

  const playerLoad = usePlayerStore((s) => s.load);
  const playerPlay = usePlayerStore((s) => s.play);
  const getAudioUrl = useLibraryStore((s) => s.getAudioUrl);
  const fetchAudioBlob = useLibraryStore((s) => s.fetchAudioBlob);

  const [analysis, setAnalysis] = useState<AnalysisRow | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [inferred, setInferred] = useState<InferredPrompt | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);

  useEffect(() => {
    if (!selectedId) {
      setAnalysis(null);
      setInferred(null);
      return;
    }
    let cancelled = false;
    setAnalysisLoading(true);
    setAnalysis(null);
    setInferred(null);
    void fetch(`/api/analysis/${selectedId}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setAnalysis(null);
          return;
        }
        const payload = (await r.json()) as AnalysisRow & { status?: string };
        // The backend returns `{entry_id, status: 'pending'}` instead of
        // a 404 when nothing has analyzed this entry yet — treat that as
        // "not analyzed" so the UI shows the empty hint.
        if (!cancelled) {
          setAnalysis(payload.status === 'pending' ? null : payload);
        }
      })
      .catch(() => {
        if (!cancelled) setAnalysis(null);
      })
      .finally(() => {
        if (!cancelled) setAnalysisLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const handleAuditionInEngine = async () => {
    if (!entry) return;
    const blob = await fetchAudioBlob(entry);
    await playerLoad(blob, { label: entry.title, entryId: entry.id });
    playerPlay();
  };

  const handleSendToNewEditorTrack = async () => {
    if (!entry) return;
    try {
      const editor = useEditorStore.getState();
      const blob = await fetchAudioBlob(entry);
      const { peaks, duration } = await computePeaks(blob, 240);
      const trackId = editor.addTrack({ name: entry.title });
      const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
      const clipId = editor.addClipToTrack({
        trackId,
        label: entry.title,
        audioBlob: blob,
        mimeType: entry.mimeType,
        sourceDuration: duration || entry.duration,
        offsetIntoSource: 0,
        durationSec: duration || entry.duration,
        startSec: 0,
        color: trackColor,
        libraryEntryId: entry.id,
      });
      editor.cachePeaks(clipId, peaks);
    } catch (e) {
      logError('details', `Send to editor failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleDownload = () => {
    if (!entry) return;
    const url = getAudioUrl(entry);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.title;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const inferPrompt = async () => {
    if (!selectedId) return;
    setPromptLoading(true);
    try {
      const res = await fetch(`/api/analysis/${encodeURIComponent(selectedId)}/prompt`);
      if (!res.ok) throw new Error(`prompt inference HTTP ${res.status}`);
      const payload = (await res.json()) as InferredPrompt;
      setInferred(payload);
    } catch (e) {
      logError('details', `Prompt inference failed: ${e instanceof Error ? e.message : String(e)}`);
      setInferred(null);
    } finally {
      setPromptLoading(false);
    }
  };

  const usePromptInMake = () => {
    if (!inferred?.prompt_guess) return;
    useGenerateParamsStore.getState().setField('prompt', inferred.prompt_guess);
    logInfo('details', 'Inferred prompt copied into the MAKE prompt field.');
  };

  if (!selectedId || !entry) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0a080f] text-zinc-700 italic text-[10px] font-mono uppercase tracking-widest">
        Click a track in the LIBRARY to inspect its metadata.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-[#0a080f] p-3">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h3 className="text-[12px] font-bold text-zinc-100 truncate">{entry.title}</h3>
          <p className="text-[9px] font-mono text-zinc-500 truncate">
            {entry.prompt || <em className="text-zinc-700">No prompt</em>}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={handleAuditionInEngine} className="btn-ghost text-[9px] py-1 flex items-center gap-1" title="Load + play in global player">
            <Disc className="w-3 h-3 text-purple-300" /> AUDITION
          </button>
          <button onClick={handleSendToNewEditorTrack} className="btn-ghost text-[9px] py-1 flex items-center gap-1" title="Create a new editor track for this clip">
            <Scissors className="w-3 h-3 text-purple-300" /> TO EDITOR
          </button>
          <button onClick={handleDownload} className="btn-ghost text-[9px] py-1 flex items-center gap-1" title="Download the audio file">
            <Download className="w-3 h-3 text-purple-300" /> DOWNLOAD
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6">
        <div>
          <Row icon={Database} label="Entry ID" value={entry.id} />
          <Row icon={FileAudio} label="Filename" value={entry.title} />
          <Row icon={Music} label="Source" value={entry.source} />
          <Row icon={Layers} label="Model" value={entry.model} />
          <Row icon={Hash} label="Seed" value={entry.seed === -1 ? 'random' : String(entry.seed)} />
          <Row icon={Hash} label="Steps" value={String(entry.steps)} />
          <Row icon={Hash} label="CFG" value={entry.cfg.toFixed(2)} />
          <Row icon={Clock} label="Duration" value={fmtDuration(entry.duration)} />
        </div>
        <div>
          <Row icon={Calendar} label="Created" value={fmtDate(entry.timestamp)} />
          <Row icon={FileAudio} label="MIME" value={entry.mimeType} />
          <Row icon={FileAudio} label="Size" value={fmtSize(entry.fileSizeBytes)} />
          <Row icon={Star} label="Favorite" value={entry.favorite ? 'yes' : 'no'} />
          <Row icon={Star} label="Rating" value={entry.rating ?? '—'} />
          <Row icon={Tag} label="Tags" value={entry.tags.length ? entry.tags.join(', ') : '—'} />
          <Row icon={FileAudio} label="Neg. prompt" value={entry.negativePrompt || '—'} />
          <Row icon={Send} label="Notes" value={entry.notes || '—'} mono={false} />
        </div>
      </div>

      <div className="mt-3 p-2 rounded border border-white/5 bg-black/40">
        <p className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest mb-1">PROMPT</p>
        <p className="text-[11px] text-zinc-200 leading-relaxed">{entry.prompt || <em className="text-zinc-600">No prompt was used for this generation.</em>}</p>
      </div>

      {/* Analysis: BPM / key / pitch / bars / loudness + embedded tags
          + ffprobe summary. Populated automatically on import / generate
          (Settings → Background features). */}
      <div className="mt-3 p-2 rounded border border-emerald-500/25 bg-emerald-500/4">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[8px] font-mono text-emerald-300/80 uppercase tracking-widest flex items-center gap-1.5">
            <Activity className="w-3 h-3" /> ANALYSIS
          </p>
          {analysisLoading && (
            <span className="text-[8px] font-mono text-zinc-600">loading…</span>
          )}
          {!analysisLoading && !analysis && (
            <span className="text-[8px] font-mono text-zinc-600">
              not yet analyzed
            </span>
          )}
        </div>
        {analysis && (
          <div className="grid grid-cols-2 gap-x-6">
            <div>
              <Row label="BPM" value={analysis.bpm != null ? analysis.bpm.toFixed(1) : '—'} />
              <Row label="Key" value={analysis.key ? `${analysis.key} ${analysis.scale ?? ''}`.trim() : '—'} />
              <Row label="Key conf." value={analysis.key_confidence != null ? analysis.key_confidence.toFixed(2) : '—'} />
              <Row label="Bars" value={analysis.bars_estimated != null ? analysis.bars_estimated.toFixed(1) : '—'} />
              <Row label="RMS (dB)" value={analysis.rms_db != null ? analysis.rms_db.toFixed(1) : '—'} />
            </div>
            <div>
              <Row label="Pitch mean" value={analysis.pitch_mean_hz != null ? `${analysis.pitch_mean_hz.toFixed(0)} Hz` : '—'} />
              <Row label="Pitch std" value={analysis.pitch_std_hz != null ? `${analysis.pitch_std_hz.toFixed(0)} Hz` : '—'} />
              <Row label="Loudness" value={analysis.loudness_lufs != null ? `${analysis.loudness_lufs.toFixed(1)} LUFS` : '—'} />
              <Row label="Genre" value={analysis.genre ? `${analysis.genre} (${(analysis.genre_confidence ?? 0).toFixed(2)})` : '—'} />
              <Row label="Analyzed" value={analysis.analyzed_at ? new Date(analysis.analyzed_at * 1000).toLocaleString() : '—'} />
            </div>
          </div>
        )}
        {analysis && analysis.embedded_tags_json && analysis.embedded_tags_json !== '{}' && (
          <details className="mt-2">
            <summary className="text-[8px] font-mono uppercase tracking-widest text-zinc-300 cursor-pointer hover:text-purple-300">
              Embedded tags (ID3 / Vorbis / iTunes)
            </summary>
            <pre className="text-[9px] font-mono text-zinc-400 mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all">
              {safeJsonPretty(analysis.embedded_tags_json)}
            </pre>
          </details>
        )}
        {analysis && analysis.ffprobe_json && analysis.ffprobe_json !== '{}' && (
          <details className="mt-1">
            <summary className="text-[8px] font-mono uppercase tracking-widest text-zinc-300 cursor-pointer hover:text-purple-300">
              ffprobe summary
            </summary>
            <pre className="text-[9px] font-mono text-zinc-400 mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all">
              {safeFfprobeSummary(analysis.ffprobe_json)}
            </pre>
          </details>
        )}
      </div>

      {/* Prompt inference: a Stable Audio-style prompt + semantic tags derived
          from the analysis above (deterministic; folds in embedded genre/mood). */}
      <div className="mt-3 p-2 rounded border border-sky-500/25 bg-sky-500/4">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[8px] font-mono text-sky-300/80 uppercase tracking-widest flex items-center gap-1.5">
            <Wand2 className="w-3 h-3" /> PROMPT INFERENCE
          </p>
          <button
            onClick={() => void inferPrompt()}
            disabled={!selectedId || promptLoading || !analysis}
            className="btn-ghost text-[8px] py-0.5 flex items-center gap-1 disabled:opacity-40"
            title={!analysis ? 'Analyze the track first' : 'Infer a prompt from this track’s analysis'}
          >
            {promptLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3 text-sky-300" />}
            INFER
          </button>
        </div>
        {inferred ? (
          <>
            <p className="text-[11px] text-zinc-200 leading-relaxed">
              {inferred.prompt_guess || <em className="text-zinc-600">No prompt could be inferred.</em>}
            </p>
            <div className="flex items-center justify-between gap-2 mt-1.5">
              <span className="text-[8px] font-mono text-zinc-500">confidence {inferred.prompt_confidence.toFixed(2)}</span>
              <button
                onClick={usePromptInMake}
                disabled={!inferred.prompt_guess}
                className="btn-ghost text-[8px] py-0.5 flex items-center gap-1 disabled:opacity-40"
                title="Copy this prompt into the MAKE prompt field"
              >
                <Send className="w-3 h-3 text-sky-300" /> USE AS PROMPT
              </button>
            </div>
            {inferred.semantic_tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {inferred.semantic_tags.map((t) => (
                  <span key={t} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-zinc-300">{t}</span>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="text-[9px] font-mono text-zinc-600">
            {analysis
              ? 'Click INFER to generate a prompt and tags from this track’s analysis.'
              : 'Analyze the track first, then infer a prompt.'}
          </p>
        )}
      </div>

      {entry.chimeraSources && entry.chimeraSources.length > 0 && (
        <div className="mt-3 p-2 rounded border border-purple-500/30 bg-purple-500/5">
          <p className="text-[8px] font-mono text-purple-300/80 uppercase tracking-widest mb-1">
            CHIMERA SOURCES ({entry.chimeraSources.length})
          </p>
          <ul className="flex flex-col gap-0.5">
            {entry.chimeraSources.map((label, i) => (
              <li key={i} className="text-[10px] font-mono text-zinc-300 flex items-baseline gap-1.5">
                <span className="text-purple-400/70 w-5">{(i + 1).toString().padStart(2, '0')}</span>
                <span className="truncate">{label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};


function safeJsonPretty(jsonText: string): string {
  try {
    return JSON.stringify(JSON.parse(jsonText), null, 2);
  } catch {
    return jsonText;
  }
}


function safeFfprobeSummary(jsonText: string): string {
  try {
    const parsed = JSON.parse(jsonText) as {
      _summary?: Record<string, unknown>;
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };
    if (parsed._summary) {
      return JSON.stringify(parsed._summary, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return jsonText;
  }
}

