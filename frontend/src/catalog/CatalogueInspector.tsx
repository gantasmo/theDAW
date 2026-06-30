import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Star, ThumbsUp, ThumbsDown, Activity, GitBranch, Cloud, Shuffle, Mic2,
} from 'lucide-react';
import type { LibraryEntry } from '../state/libraryEntry';
import { useLibraryStore } from '../state/libraryStore';
import { logError } from '../state/logStore';
import { buildSpectrogramFormData } from '../state/spectrogramRequest';
import { sunoActions } from '../suno/sunoActions';
import { HoverTip, InfoTip } from '../components/ui/Tooltip';
import { formatDuration, formatDate, formatSize } from './catalogFormat';
import { CatalogueProviderBadge } from './CatalogueProviderBadge';
import { CatalogueLineage } from './CatalogueLineage';
import { inferProvider } from './catalogProviders';
import { deriveLyrics, deriveStyle } from './catalogSearch';

interface Props {
  entry: LibraryEntry;
}

/** The four spectrogram kinds returned by POST /api/spectrogram. */
type SpecKind = 'mel' | 'stft' | 'chromagram' | 'cqt';
const SPEC_TABS: Array<{ key: SpecKind; label: string }> = [
  { key: 'mel', label: 'MEL' },
  { key: 'stft', label: 'STFT' },
  { key: 'chromagram', label: 'CHROMA' },
  { key: 'cqt', label: 'CQT' },
];
type Spectrograms = Record<SpecKind, string>;

// CHANGED: InfoTip copy for the inspector sections (Advanced-page click-to-pin
// pattern). `\n` for blank lines, `•` for bullets.
const ANALYSIS_INFO = `Computed audio analysis attached to this track.\n\nEvery key the backend stored is shown — e.g.:\n• BPM / tempo, musical key\n• loudness / RMS, peak\n• spectral + timbre features\n\nThese are read straight from the library record; nothing is recomputed here.`;
const EMBEDDED_INFO = `Tags embedded INSIDE the audio file itself (ID3 / iTunes / Vorbis comments), surfaced by the import pipeline.\n\nExamples: artist, album, year, comment, encoder. Every embedded key is listed verbatim.`;
const SPECTROGRAM_INFO = `On-demand visual frequency analysis. Click GENERATE to fetch the bytes and render four views:\n\n• MEL — mel-scaled spectrogram (perceptual)\n• STFT — raw short-time Fourier transform\n• CHROMA — pitch-class energy (great for key/harmony)\n• CQT — constant-Q transform (log-frequency)\n\nFetched only when you ask, so opening the inspector stays fast.`;
const LINEAGE_INFO = `How this track relates to others — modeled on the Suno remaster/ancestry view.\n\n• The ANCESTOR CHAIN (root → this track) up the parent edges.\n• Direct CHILDREN (derivatives spawned from it).\n• SIBLINGS (other children of the same parent).\n\nClick any related track to inspect it. “Open in graph” jumps to the 3D lineage view.`;

/** One label/value metadata row. */
const Field: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-2 text-[9px] font-mono py-0.5">
    <span className="text-zinc-600 uppercase tracking-wider">{label}</span>
    <span className="text-zinc-300 truncate text-right">{value}</span>
  </div>
);

/** Read the optional loose blobs an entry may carry. */
const analysisOf = (e: LibraryEntry): Record<string, unknown> | undefined =>
  (e as unknown as { analysis?: Record<string, unknown> }).analysis;
const embeddedTagsOf = (e: LibraryEntry): Record<string, unknown> | undefined =>
  (e as unknown as { embeddedTags?: Record<string, unknown> }).embeddedTags;

/**
 * Render any analysis / embedded-tag value as readable text. Scalars print as-is;
 * arrays join with ", "; nested objects JSON-stringify (so we never leak a bare
 * "[object Object]" into the metadata grid).
 * CHANGED: added so EVERY analysis/embeddedTags key renders meaningfully,
 * including object/array values, per the inspector "render all keys" requirement.
 */
const renderValue = (v: unknown): string => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => renderValue(x)).join(', ');
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
};

/** Convert a Blob to a base64 string (no data: prefix) for the spectrogram API. */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * CatalogueInspector — the ROBUST METADATA VIEWER (slide-in right panel).
 *
 * Reads everything from the existing library entry (single source of truth)
 * and persists tag/notes/favorite/rating edits straight back via the library
 * store's `updateEntry` / `toggleFavorite` / `setRating`. Renders:
 *   Core params · Prompt + Negative · Analysis (every key/value) · Embedded
 *   tags · Tags editor · Notes editor · favorite/rating · on-demand
 *   spectrogram (MEL/STFT/CHROMA/CQT) · embedded lineage viewer. For Suno
 *   tracks it also surfaces derived lyrics/style and Suno cover/mashup actions.
 */
export const CatalogueInspector: React.FC<Props> = ({ entry }) => {
  const updateEntry = useLibraryStore((s) => s.updateEntry);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const setRating = useLibraryStore((s) => s.setRating);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const fetchAudioBlob = useLibraryStore((s) => s.fetchAudioBlob);

  const [tagDraft, setTagDraft] = useState('');
  // CHANGED: notes are now an editable local DRAFT that commits on blur, instead
  // of firing a network PATCH on every keystroke (the old code called
  // updateEntry per character, hammering /api/library and lagging the input).
  const [notesDraft, setNotesDraft] = useState(entry.notes);
  const [specTab, setSpecTab] = useState<SpecKind>('mel');
  const [specs, setSpecs] = useState<Spectrograms | null>(null);
  const [specLoading, setSpecLoading] = useState(false);
  const [specError, setSpecError] = useState<string | null>(null);

  // Reset transient state when the inspected entry changes.
  // CHANGED: track whether the textarea is focused so we don't overwrite a
  // mid-edit draft when an external library.refresh() updates entry.notes.
  const notesFocused = useRef(false);
  useEffect(() => {
    setSpecs(null);
    setSpecError(null);
    setSpecTab('mel');
    setTagDraft('');
    // Only sync the draft from the server if the user isn't actively typing.
    if (!notesFocused.current) setNotesDraft(entry.notes);
  }, [entry.id, entry.notes]);

  // Commit the notes draft (on blur / unmount) only if it actually changed.
  const commitNotes = () => {
    if (notesDraft !== entry.notes) void updateEntry(entry.id, { notes: notesDraft });
  };

  const provider = inferProvider(entry);
  const isSuno = entry.model === 'suno';

  const analysis = analysisOf(entry);
  const analysisEntries = useMemo(
    () => (analysis ? Object.entries(analysis).filter(([, v]) => v != null) : []),
    [analysis],
  );
  const embedded = embeddedTagsOf(entry);
  const embeddedEntries = useMemo(
    () => (embedded ? Object.entries(embedded).filter(([, v]) => v != null) : []),
    [embedded],
  );

  const lyrics = isSuno ? deriveLyrics(entry) : '';
  const style = isSuno ? deriveStyle(entry) : '';

  const addTag = () => {
    const t = tagDraft.trim();
    if (!t || entry.tags.includes(t)) { setTagDraft(''); return; }
    void updateEntry(entry.id, { tags: [...entry.tags, t] });
    setTagDraft('');
  };
  const removeTag = (t: string) =>
    void updateEntry(entry.id, { tags: entry.tags.filter((x) => x !== t) });

  const loadSpectrogram = async () => {
    if (specLoading) return;
    setSpecLoading(true);
    setSpecError(null);
    try {
      const blob = await fetchAudioBlob(entry);
      const audioBase64 = await blobToBase64(blob);
      const form = buildSpectrogramFormData({ audioBase64, mimeType: entry.mimeType || 'audio/wav' });
      const res = await fetch('/api/spectrogram', { method: 'POST', body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Spectrograms;
      setSpecs(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSpecError(msg);
      logError('catalogue', `Spectrogram failed for "${entry.title}": ${msg}`);
    } finally {
      setSpecLoading(false);
    }
  };

  const activeSpec = specs?.[specTab] ?? '';

  return (
    <div className="w-85 shrink-0 h-full border-l border-white/10 bg-[#0a080f] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/2">
        <span className="mono-label text-[10px]! truncate pr-2">{entry.title}</span>
        <button
          onClick={() => setSelectedEntry(null)}
          className="p-1 hover:bg-white/10 rounded shrink-0"
          title="Close"
        >
          <X className="w-3.5 h-3.5 text-zinc-500" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar p-3 flex flex-col gap-3">
        {/* Favorite / rating + provider */}
        <div className="flex items-center gap-2">
          <HoverTip text={entry.favorite ? 'Remove from favorites.' : 'Mark as a favorite (star).'}>
            <button onClick={() => void toggleFavorite(entry.id)} className="p-1.5 rounded hover:bg-white/10">
              <Star className={`w-3.5 h-3.5 ${entry.favorite ? 'text-yellow-500 fill-current' : 'text-zinc-600'}`} />
            </button>
          </HoverTip>
          <HoverTip text="Like — toggle a thumbs-up rating on this track.">
            <button onClick={() => void setRating(entry.id, entry.rating === 'like' ? null : 'like')} className="p-1.5 rounded hover:bg-white/10">
              <ThumbsUp className={`w-3.5 h-3.5 ${entry.rating === 'like' ? 'text-emerald-400 fill-current' : 'text-zinc-600'}`} />
            </button>
          </HoverTip>
          <HoverTip text="Dislike — toggle a thumbs-down rating on this track.">
            <button onClick={() => void setRating(entry.id, entry.rating === 'dislike' ? null : 'dislike')} className="p-1.5 rounded hover:bg-white/10">
              <ThumbsDown className={`w-3.5 h-3.5 ${entry.rating === 'dislike' ? 'text-red-400 fill-current' : 'text-zinc-600'}`} />
            </button>
          </HoverTip>
          <div className="flex-1" />
          <CatalogueProviderBadge provider={provider} />
        </div>

        {/* Suno-only derive actions */}
        {sunoActions.canUseAsSunoSource(entry) && (
          <div className="flex items-center gap-1.5">
            <HoverTip text="Send this Suno clip to the Suno panel as a COVER source. (Suno tracks only.)">
              <button
                className="mono-tag flex-1 bg-purple-500/10! text-purple-300! border-purple-500/30! flex items-center justify-center gap-1"
                onClick={() => sunoActions.sendToCover(entry)}
              >
                <Cloud className="w-2.5 h-2.5" /> Cover
              </button>
            </HoverTip>
            <HoverTip text="Send this Suno clip to the Suno panel as a MASHUP base. (Suno tracks only.)">
              <button
                className="mono-tag flex-1 bg-purple-500/10! text-purple-300! border-purple-500/30! flex items-center justify-center gap-1"
                onClick={() => sunoActions.sendToMashup(entry)}
              >
                <Shuffle className="w-2.5 h-2.5" /> Mashup
              </button>
            </HoverTip>
          </div>
        )}

        {/* Core info */}
        <div className="flex flex-col">
          <Field label="Model" value={entry.model || '—'} />
          <Field label="Provider" value={provider} />
          <Field label="Duration" value={formatDuration(entry.duration)} />
          <Field label="Seed" value={entry.seed} />
          <Field label="Steps" value={entry.steps} />
          <Field label="CFG" value={entry.cfg} />
          <Field label="Format" value={(entry.mimeType || '').replace('audio/', '').toUpperCase() || '—'} />
          <Field label="Size" value={formatSize(entry.fileSizeBytes)} />
          <Field label="Source" value={entry.source} />
          <Field label="Created" value={formatDate(entry.timestamp)} />
          {/* Play analytics — already tracked per entry (persistent counter +
              last-played stamp), just never surfaced in this inspector. */}
          <Field label="Plays" value={entry.playCount ?? 0} />
          <Field
            label="Last played"
            value={entry.lastPlayedAt ? formatDate(new Date(entry.lastPlayedAt * 1000).toISOString()) : '—'}
          />
          <Field label="ID" value={<span className="text-[8px]">{entry.id.slice(0, 16)}…</span>} />
        </div>

        {/* Prompt */}
        {entry.prompt && (
          <div className="flex flex-col gap-1">
            <span className="mono-label text-[9px]!">PROMPT</span>
            <p className="text-[9px] font-mono text-zinc-400 leading-relaxed bg-black/30 rounded p-2 wrap-break-word">
              {entry.prompt}
            </p>
          </div>
        )}
        {entry.negativePrompt && (
          <div className="flex flex-col gap-1">
            <span className="mono-label text-[9px]! text-red-400/70!">NEGATIVE</span>
            <p className="text-[9px] font-mono text-zinc-500 leading-relaxed bg-black/30 rounded p-2 wrap-break-word">
              {entry.negativePrompt}
            </p>
          </div>
        )}

        {/* Suno lyrics / style (derived, best-effort) */}
        {isSuno && (style || lyrics) && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <Mic2 className="w-3 h-3 text-orange-400" />
              <span className="mono-label text-[9px]!">SUNO</span>
            </div>
            {style && <Field label="Style" value={style} />}
            {lyrics && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">Lyrics</span>
                <p className="text-[9px] font-mono text-zinc-400 leading-relaxed bg-black/30 rounded p-2 wrap-break-word whitespace-pre-wrap max-h-40 overflow-y-auto no-scrollbar">
                  {lyrics}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Analysis (render every key/value) */}
        {analysisEntries.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <Activity className="w-3 h-3 text-purple-400" />
              <span className="mono-label text-[9px]!">ANALYSIS</span>
              <InfoTip title="Analysis" body={ANALYSIS_INFO} />
            </div>
            <div className="flex flex-col bg-black/20 rounded p-1.5">
              {analysisEntries.map(([k, v]) => (
                <Field key={k} label={k.replace(/_/g, ' ')} value={renderValue(v)} />
              ))}
            </div>
          </div>
        )}

        {/* Embedded tags (render every key/value) */}
        {embeddedEntries.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="mono-label text-[9px]!">EMBEDDED TAGS</span>
              <InfoTip title="Embedded Tags" body={EMBEDDED_INFO} />
            </div>
            <div className="flex flex-col bg-black/20 rounded p-1.5">
              {embeddedEntries.map(([k, v]) => (
                <Field key={k} label={k.replace(/_/g, ' ')} value={renderValue(v)} />
              ))}
            </div>
          </div>
        )}

        {/* Spectrogram (fetch on demand) */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Activity className="w-3 h-3 text-purple-400" />
              <span className="mono-label text-[9px]!">SPECTROGRAM</span>
              <InfoTip title="Spectrogram" body={SPECTROGRAM_INFO} />
            </div>
            {!specs && (
              <HoverTip text="Fetch the audio and render MEL / STFT / CHROMA / CQT spectrograms (on demand).">
                <button
                  className="mono-tag bg-purple-600/20! text-purple-300! border-purple-500/40!"
                  onClick={() => void loadSpectrogram()}
                  disabled={specLoading}
                >
                  {specLoading ? 'ANALYZING…' : 'GENERATE'}
                </button>
              </HoverTip>
            )}
          </div>
          {specError && <span className="text-[8px] font-mono text-red-400/70">{specError}</span>}
          {specs && (
            <>
              <div className="flex gap-1">
                {SPEC_TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setSpecTab(t.key)}
                    className={`mono-tag flex-1 ${specTab === t.key ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-500!'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="aspect-10/3 bg-black/40 rounded flex items-center justify-center overflow-hidden">
                {activeSpec
                  ? <img src={`data:image/png;base64,${activeSpec}`} alt={`${specTab} spectrogram`} className="w-full h-full object-cover" />
                  : <span className="text-[8px] font-mono text-zinc-700">No {specTab.toUpperCase()} image</span>}
              </div>
            </>
          )}
        </div>

        {/* Lineage */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <GitBranch className="w-3 h-3 text-cyan-400" />
            <span className="mono-label text-[9px]!">LINEAGE</span>
            <InfoTip title="Lineage" body={LINEAGE_INFO} />
          </div>
          <div className="bg-black/20 rounded">
            <CatalogueLineage entry={entry} />
          </div>
        </div>

        {/* Tags editor */}
        <div className="flex flex-col gap-1">
          <span className="mono-label text-[9px]!">TAGS</span>
          <div className="flex flex-wrap gap-1">
            {entry.tags.map((t) => (
              <button key={t} className="mono-tag bg-white/5! text-zinc-300!" onClick={() => removeTag(t)} title="Remove tag">
                {t} <X className="w-2 h-2 inline" />
              </button>
            ))}
          </div>
          <input
            name="catalog-add-tag"
            className="compact-input w-full"
            placeholder="ADD TAG + ENTER"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }}
          />
        </div>

        {/* Notes editor */}
        <div className="flex flex-col gap-1">
          <span className="mono-label text-[9px]!">NOTES</span>
          <textarea
            name="catalog-notes"
            className="compact-input w-full min-h-16 resize-y"
            placeholder="Notes…"
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onFocus={() => { notesFocused.current = true; }}
            onBlur={() => { notesFocused.current = false; commitNotes(); }}
          />
        </div>
      </div>
    </div>
  );
};
