import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileMusic, Guitar, LayoutGrid, Loader2, Maximize2, Minus, Music2, Plus, RefreshCw } from 'lucide-react';
import { useLibraryStore } from '../../state/libraryStore';
import { logError, logInfo } from '../../state/logStore';
import {
  convertMidiToMusicXml,
  exportArtifact,
  getNotationCapabilities,
  listNotationArtifacts,
  makeArrangement,
  makeTabs,
  notationArtifactUrl,
  notationPackUrl,
  type NotationArtifact,
  type NotationCapabilities,
} from '../../lib/notationClient';
import type { AlphaTabApi } from '@coderline/alphatab';

const DEFAULT_TUNINGS = [
  'guitar-standard',
  'guitar-drop-d',
  'guitar-7-string',
  'bass-standard',
  'bass-5-string',
];

const DEFAULT_STYLES = ['lead-sheet', 'piano-reduction', 'simplified', 'band-score'];

export const ScoreView: React.FC = () => {
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const entries = useLibraryStore((s) => s.entries);
  const entry = useMemo(
    () => entries.find((candidate) => candidate.id === selectedEntryId) ?? null,
    [entries, selectedEntryId],
  );
  const [artifacts, setArtifacts] = useState<NotationArtifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [caps, setCaps] = useState<NotationCapabilities | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [makingTabs, setMakingTabs] = useState(false);
  const [tabInstrument, setTabInstrument] = useState('guitar');
  const [tabTuning, setTabTuning] = useState('guitar-standard');
  const [tabCapo, setTabCapo] = useState(0);
  const [tabDifficulty, setTabDifficulty] = useState('medium');
  const [arrangeStyle, setArrangeStyle] = useState('piano-reduction');
  const [arranging, setArranging] = useState(false);
  // The global artist/composer name now lives in Settings (notation.artist); the
  // sheet preview reads it directly when rendering.

  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const musicXmlArtifacts = artifacts.filter((artifact) => artifact.kind === 'musicxml');
  const midiArtifacts = artifacts.filter((artifact) => artifact.kind === 'midi');
  const tabTunings = caps?.tab_tunings ?? DEFAULT_TUNINGS;
  const arrangementStyles = caps?.arrangement_styles ?? DEFAULT_STYLES;
  const exportFormats = selectedArtifact?.kind === 'musicxml'
    ? (caps?.musescore ? ['abc', 'pdf', 'svg'] : ['abc'])
    : [];

  const loadArtifacts = async () => {
    if (!selectedEntryId) return;
    setLoading(true);
    try {
      const next = await listNotationArtifacts(selectedEntryId);
      setArtifacts(next);
      setSelectedArtifactId((prev) => (
        prev && next.some((artifact) => artifact.id === prev)
          ? prev
          : (next.find((artifact) => artifact.kind === 'musicxml') ?? next[0] ?? null)?.id ?? null
      ));
    } catch (e) {
      logError('score', `Could not load notation artifacts: ${e instanceof Error ? e.message : String(e)}`);
      setArtifacts([]);
      setSelectedArtifactId(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadArtifacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntryId]);

  useEffect(() => {
    let cancelled = false;
    void getNotationCapabilities()
      .then((next) => { if (!cancelled) setCaps(next); })
      .catch(() => { if (!cancelled) setCaps(null); });
    return () => { cancelled = true; };
  }, []);

  const makeSheetFromFirstMidi = async () => {
    if (!selectedEntryId) return;
    const firstMidi = midiArtifacts[0];
    if (!firstMidi) {
      logError('score', 'No MIDI artifact found yet. Run Convert to MIDI first.');
      return;
    }
    const legacyMidiId = (() => {
      try {
        const meta = JSON.parse(firstMidi.metadata_json || '{}') as { legacy_midi_id?: string };
        return meta.legacy_midi_id || firstMidi.source_ref || firstMidi.id.replace(/__artifact_midi$/, '');
      } catch {
        return firstMidi.source_ref || firstMidi.id.replace(/__artifact_midi$/, '');
      }
    })();
    setConverting(true);
    try {
      const artifact = await convertMidiToMusicXml(selectedEntryId, legacyMidiId);
      logInfo('score', `Created MusicXML score from ${legacyMidiId}`);
      await loadArtifacts();
      if (artifact?.id) setSelectedArtifactId(artifact.id);
    } catch (e) {
      logError('score', `Sheet conversion failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConverting(false);
    }
  };

  const exportSelectedAs = async (format: string) => {
    if (!selectedEntryId || !selectedArtifact || selectedArtifact.kind !== 'musicxml') return;
    setExporting(format);
    try {
      const artifact = await exportArtifact(selectedEntryId, selectedArtifact.id, format);
      logInfo('score', `Exported ${format.toUpperCase()} from ${selectedArtifact.id}`);
      await loadArtifacts();
      if (artifact?.id) setSelectedArtifactId(artifact.id);
    } catch (e) {
      logError('score', `${format.toUpperCase()} export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
    }
  };

  const makeTabsFromFirstMidi = async () => {
    if (!selectedEntryId) return;
    const firstMidi = midiArtifacts[0];
    if (!firstMidi) {
      logError('score', 'No MIDI artifact found yet. Run Convert to MIDI first.');
      return;
    }
    setMakingTabs(true);
    try {
      const artifact = await makeTabs(selectedEntryId, {
        source_artifact_id: firstMidi.id,
        instrument: tabInstrument,
        tuning_name: tabTuning,
        capo: tabCapo,
        difficulty: tabDifficulty,
      });
      logInfo('score', `Arranged ${tabInstrument} tab (${tabTuning}) from ${firstMidi.id}`);
      await loadArtifacts();
      if (artifact?.id) setSelectedArtifactId(artifact.id);
    } catch (e) {
      logError('score', `Tab generation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMakingTabs(false);
    }
  };

  const onInstrumentChange = (value: string) => {
    setTabInstrument(value);
    setTabTuning(value === 'bass' ? 'bass-standard' : 'guitar-standard');
  };

  const makeArrangementFromMidis = async () => {
    if (!selectedEntryId) return;
    if (midiArtifacts.length === 0) {
      logError('score', 'No MIDI artifact found yet. Run Convert to MIDI first.');
      return;
    }
    setArranging(true);
    try {
      const req = arrangeStyle === 'band-score'
        ? { style: arrangeStyle, source_artifact_ids: midiArtifacts.map((m) => m.id) }
        : { style: arrangeStyle, source_artifact_id: midiArtifacts[0].id };
      const artifact = await makeArrangement(selectedEntryId, req);
      logInfo('score', `Arranged ${arrangeStyle} from ${midiArtifacts.length} MIDI artifact(s)`);
      await loadArtifacts();
      if (artifact?.id) setSelectedArtifactId(artifact.id);
    } catch (e) {
      logError('score', `Arrangement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setArranging(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex bg-[#07050a] text-zinc-200">
      <div className="w-64 shrink-0 border-r border-white/5 flex flex-col min-h-0 bg-black/30">
        <div className="p-2 border-b border-white/5 flex items-center gap-2">
          <FileMusic className="w-4 h-4 text-emerald-300" />
          <div className="min-w-0">
            <div className="text-[10px] font-black uppercase tracking-widest text-emerald-200">Score</div>
            <div className="text-[8px] font-mono text-zinc-500 truncate">{entry?.title ?? 'Select a library track'}</div>
          </div>
          <button
            className="ml-auto p-1 rounded border border-white/10 text-zinc-400 hover:text-zinc-100"
            onClick={() => void loadArtifacts()}
            disabled={!selectedEntryId || loading}
            title="Refresh notation artifacts"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </button>
        </div>

        <div className="p-2 border-b border-white/5 flex gap-1">
          <button
            className="btn-ghost text-[8px] py-1 flex-1 flex items-center justify-center gap-1 disabled:opacity-40"
            onClick={() => void makeSheetFromFirstMidi()}
            disabled={!selectedEntryId || converting || midiArtifacts.length === 0}
            title={midiArtifacts.length === 0 ? 'Run Convert to MIDI first' : 'Convert the first MIDI artifact to MusicXML'}
          >
            {converting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Music2 className="w-3 h-3 text-emerald-300" />}
            MAKE SHEET
          </button>
        </div>

        <div className="p-2 border-b border-white/5 space-y-1.5">
          <div className="flex items-center gap-1">
            <Guitar className="w-3 h-3 text-pink-300" />
            <span className="text-[8px] font-black uppercase tracking-widest text-pink-200">Tabs</span>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <select
              id="score-tab-instrument"
              name="score-tab-instrument"
              aria-label="Tab instrument"
              className="form-select text-[8px] px-1 py-1"
              value={tabInstrument}
              onChange={(e) => onInstrumentChange(e.target.value)}
            >
              <option value="guitar">Guitar</option>
              <option value="bass">Bass</option>
            </select>
            <select
              id="score-tab-difficulty"
              name="score-tab-difficulty"
              aria-label="Tab difficulty"
              className="form-select text-[8px] px-1 py-1"
              value={tabDifficulty}
              onChange={(e) => setTabDifficulty(e.target.value)}
            >
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <select
              id="score-tab-tuning"
              name="score-tab-tuning"
              aria-label="Tab tuning"
              className="form-select text-[8px] px-1 py-1"
              value={tabTuning}
              onChange={(e) => setTabTuning(e.target.value)}
            >
              {tabTunings.map((tuning) => (
                <option key={tuning} value={tuning}>{tuning}</option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              <label htmlFor="score-tab-capo" className="text-[8px] font-mono text-zinc-500 shrink-0">Capo</label>
              <input
                id="score-tab-capo"
                name="score-tab-capo"
                type="number"
                min={0}
                max={12}
                aria-label="Capo fret"
                className="w-full form-select text-[8px] px-1 py-1"
                value={tabCapo}
                onChange={(e) => setTabCapo(Math.max(0, Math.min(12, Number(e.target.value) || 0)))}
              />
            </div>
          </div>
          <button
            className="btn-ghost text-[8px] py-1 w-full flex items-center justify-center gap-1 disabled:opacity-40"
            onClick={() => void makeTabsFromFirstMidi()}
            disabled={!selectedEntryId || makingTabs || midiArtifacts.length === 0}
            title={midiArtifacts.length === 0 ? 'Run Convert to MIDI first' : 'Arrange the first MIDI artifact into tablature'}
          >
            {makingTabs ? <Loader2 className="w-3 h-3 animate-spin" /> : <Guitar className="w-3 h-3 text-pink-300" />}
            MAKE TABS
          </button>
        </div>

        <div className="p-2 border-b border-white/5 space-y-1.5">
          <div className="flex items-center gap-1">
            <LayoutGrid className="w-3 h-3 text-sky-300" />
            <span className="text-[8px] font-black uppercase tracking-widest text-sky-200">Arrange</span>
          </div>
          <select
            id="score-arrange-style"
            name="score-arrange-style"
            aria-label="Arrangement style"
            className="w-full form-select text-[8px] px-1 py-1"
            value={arrangeStyle}
            onChange={(e) => setArrangeStyle(e.target.value)}
          >
            {arrangementStyles.map((style) => (
              <option key={style} value={style}>{style}</option>
            ))}
          </select>
          <button
            className="btn-ghost text-[8px] py-1 w-full flex items-center justify-center gap-1 disabled:opacity-40"
            onClick={() => void makeArrangementFromMidis()}
            disabled={!selectedEntryId || arranging || midiArtifacts.length === 0}
            title={midiArtifacts.length === 0
              ? 'Run Convert to MIDI first'
              : (arrangeStyle === 'band-score' ? 'Arrange all MIDI stems into a band score' : 'Arrange the first MIDI artifact')}
          >
            {arranging ? <Loader2 className="w-3 h-3 animate-spin" /> : <LayoutGrid className="w-3 h-3 text-sky-300" />}
            ARRANGE
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {artifacts.map((artifact) => {
            const active = artifact.id === selectedArtifactId;
            return (
              <button
                key={artifact.id}
                onClick={() => setSelectedArtifactId(artifact.id)}
                className={`w-full text-left rounded border px-2 py-1.5 transition-colors ${
                  active
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                    : 'border-white/5 bg-black/20 text-zinc-400 hover:text-zinc-100 hover:border-white/15'
                }`}
              >
                <div className="text-[9px] font-black uppercase tracking-widest">{artifact.kind}</div>
                <div className="text-[8px] font-mono truncate opacity-70">{artifact.engine || 'artifact'}</div>
              </button>
            );
          })}
          {!loading && artifacts.length === 0 && (
            <div className="text-[9px] font-mono text-zinc-600 leading-relaxed p-3 border border-dashed border-white/10 rounded">
              No notation artifacts yet. Right-click a track → Convert to MIDI, then use MAKE SHEET.
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div className="h-8 shrink-0 border-b border-white/5 bg-black/30 flex items-center gap-2 px-2">
          <span className="text-[9px] font-mono text-zinc-500 truncate flex-1">
            {selectedArtifact ? `${selectedArtifact.kind} · ${selectedArtifact.id}` : 'No artifact selected'}
          </span>
          {exportFormats.map((fmt) => (
            <button
              key={fmt}
              className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40"
              onClick={() => void exportSelectedAs(fmt)}
              disabled={exporting !== null}
              title={`Export ${fmt.toUpperCase()} from this score`}
            >
              {exporting === fmt ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {fmt.toUpperCase()}
            </button>
          ))}
          {selectedArtifact && (
            <a
              className="btn-ghost text-[8px] py-1 flex items-center gap-1"
              href={
                selectedArtifact.kind === 'musicxml'
                  ? notationPackUrl(selectedArtifact.id)
                  : notationArtifactUrl(selectedArtifact.id)
              }
              download
              title={
                selectedArtifact.kind === 'musicxml'
                  ? 'Download MusicXML + PDF (PDF needs MuseScore)'
                  : 'Download this artifact'
              }
            >
              <Download className="w-3 h-3" /> DOWNLOAD
            </a>
          )}
        </div>
        <div className="flex-1 min-h-0 bg-[#0b0810]">
          {selectedArtifact?.kind === 'musicxml' ? (
            <MusicXmlPreview artifact={selectedArtifact} />
          ) : selectedArtifact?.kind === 'alphatex' ? (
            <TabPreview artifact={selectedArtifact} />
          ) : selectedArtifact ? (
            <div className="h-full grid place-items-center text-[10px] font-mono text-zinc-500">
              {selectedArtifact.kind.toUpperCase()} artifact selected. Download or send it to MIDI/Score tools.
            </div>
          ) : (
            <div className="h-full grid place-items-center text-[10px] font-mono text-zinc-600">
              Select a score artifact to preview.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.12;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Ctrl/Cmd + scrollwheel zoom on the sheet. A native non-passive listener
 *  is required so the gesture can preventDefault (React's onWheel is passive).
 *  Plain wheel keeps scrolling the page so long scores stay navigable. */
function useWheelZoom(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  onZoomDelta: (factor: number) => void,
) {
  const cb = useRef(onZoomDelta);
  cb.current = onZoomDelta;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      cb.current(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [scrollRef]);
}

const ZoomControls: React.FC<{
  zoom: number;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
}> = ({ zoom, onIn, onOut, onReset }) => (
  <div className="absolute bottom-2 right-2 z-10 flex items-center gap-0.5 rounded-md border border-purple-500/40 bg-[#0a080f]/95 px-1 py-0.5 shadow-lg backdrop-blur-sm">
    <button
      className="p-1 rounded text-purple-200 hover:bg-purple-500/20 disabled:opacity-40"
      onClick={onOut}
      disabled={zoom <= ZOOM_MIN + 0.001}
      title="Zoom out (Ctrl + scroll)"
      aria-label="Zoom out"
    >
      <Minus className="w-3 h-3" />
    </button>
    <button
      className="min-w-9 text-center text-[9px] font-mono text-purple-200 hover:text-white px-0.5"
      onClick={onReset}
      title="Reset zoom"
      aria-label="Reset zoom to 100%"
    >
      {Math.round(zoom * 100)}%
    </button>
    <button
      className="p-1 rounded text-purple-200 hover:bg-purple-500/20 disabled:opacity-40"
      onClick={onIn}
      disabled={zoom >= ZOOM_MAX - 0.001}
      title="Zoom in (Ctrl + scroll)"
      aria-label="Zoom in"
    >
      <Plus className="w-3 h-3" />
    </button>
    <button
      className="p-1 rounded text-purple-200 hover:bg-purple-500/20"
      onClick={onReset}
      title="Fit / reset zoom"
      aria-label="Fit to width"
    >
      <Maximize2 className="w-3 h-3" />
    </button>
  </div>
);

const A4_RATIO = 297 / 210; // A4 portrait height / width
const PAGE_GAP = 24; // px between side-by-side pages (matches gap-6)

// Media + symbolic extensions that must never show up in a sheet title.
const TITLE_EXT_RE =
  /\.(wav|mp3|flac|ogg|oga|m4a|aac|aif|aiff|opus|wma|alac|mp4|mov|webm|mkv|m4v|avi|mid|midi|musicxml|xml)$/i;

/** Sanitize a title for engraving: drop a trailing media extension and treat
 *  music21's "Music21 Fragment" / "Music21" placeholders as empty. */
const cleanTitleText = (raw: string): string => {
  const t = (raw || '').trim().replace(TITLE_EXT_RE, '').trim();
  return /^music21( fragment)?$/i.test(t) ? '' : t;
};

/** Word-wrap a long title by inserting newlines (OSMD splits labels on \n and
 *  centers each line) so a long song name lays out across the page instead of
 *  running off the side. Never truncates; hard-breaks a single oversized word. */
const wrapTitle = (t: string, budget: number): string => {
  if (t.length <= budget) return t;
  const lines: string[] = [];
  let cur = '';
  for (const w of t.split(/\s+/)) {
    let word = w;
    if (cur && (cur + ' ' + word).length > budget) {
      lines.push(cur);
      cur = '';
    }
    cur = cur ? cur + ' ' + word : word;
    while (cur.length > budget) {
      lines.push(cur.slice(0, budget));
      cur = cur.slice(budget);
      word = cur;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
};

/** Pre-process MusicXML before OSMD renders it so the title block reads like a
 *  real sheet: the SONG name as the centered Title (cleaned of media extensions,
 *  word-wrapped if long), and the ARTIST centered directly beneath it. OSMD maps
 *  <work-title> -> Title and <movement-title> -> Subtitle (confirmed in its
 *  reader), so the song goes in work-title and the artist in movement-title; the
 *  composer credit is disabled in the options so the artist never floats off to
 *  the top-right. Returns the cleaned song title for the running page footer. */
const prepareMusicXml = (
  xml: string,
  pageWidthPx: number,
  artist: string,
): { xml: string; title: string } => {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return { xml, title: '' };
    const root = doc.documentElement;
    const budget = Math.max(16, Math.floor(pageWidthPx / 13));

    const song = cleanTitleText(
      (doc.querySelector('work > work-title')?.textContent ||
        doc.querySelector('movement-title')?.textContent ||
        '').trim(),
    );

    // Title slot (work-title) = wrapped song name.
    let work = doc.querySelector('work');
    if (!work) {
      work = doc.createElement('work');
      root.insertBefore(work, root.firstChild);
    }
    let workTitle = work.querySelector('work-title');
    if (!workTitle) {
      workTitle = doc.createElement('work-title');
      work.appendChild(workTitle);
    }
    workTitle.textContent = song ? wrapTitle(song, budget) : '';

    // Subtitle slot (movement-title) = artist, centered under the title.
    let movement = doc.querySelector('movement-title');
    if (!movement) {
      movement = doc.createElement('movement-title');
      if (work.nextSibling) root.insertBefore(movement, work.nextSibling);
      else root.appendChild(movement);
    }
    movement.textContent = artist || '';

    // Drop music21's placeholder credit-words so they don't print.
    for (const cw of Array.from(doc.querySelectorAll('credit-words'))) {
      if (/^music21( fragment)?$/i.test((cw.textContent || '').trim())) cw.textContent = '';
    }

    return { xml: new XMLSerializer().serializeToString(doc), title: song };
  } catch {
    return { xml, title: '' };
  }
};

/** Engraving rules that make OSMD output look like sheet music from a book:
 *  smaller text (the default title/labels are oversized for a fitted A4 page),
 *  tidy page margins so music never runs off the side, and compact, even
 *  system spacing. Applied before render; unknown keys on older builds no-op. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const applySheetEngraving = (rules: any): void => {
  if (!rules) return;
  try {
    rules.SheetTitleHeight = 2.2;
    rules.SheetSubtitleHeight = 1.4;
    rules.SheetComposerHeight = 1.5;
    rules.SheetAuthorHeight = 1.4;
    rules.TitleTopDistance = 5.0;
    rules.TitleBottomDistance = 1.0;
    rules.SpacingBetweenTextLines = 1.0;
    rules.MeasureNumberLabelHeight = 1.0;
    rules.InstrumentLabelTextHeight = 1.4;
    rules.LyricsHeight = 1.5;
    rules.InstantaneousTempoTextHeight = 1.6;
    rules.ContinuousTempoTextHeight = 1.4;
    // Generous page margins, especially top + bottom (the bottom margin also
    // houses the injected running footer + page number).
    rules.PageLeftMargin = 4.0;
    rules.PageRightMargin = 4.0;
    rules.PageTopMargin = 5.5;
    // Tall bottom margin: the music must clear the injected running footer +
    // page number that live in the bottom margin (see decoratePages).
    rules.PageBottomMargin = 14.0;
    rules.MinimumDistanceBetweenSystems = 4.0;
    rules.MinSkyBottomDistBetweenSystems = 2.0;
    rules.StaffDistance = 4.0;
    rules.BetweenStaffDistance = 4.0;
    rules.RenderMeasureNumbersOnlyAtSystemStart = true;
  } catch {
    /* older OSMD builds: ignore unsupported rules */
  }
};

/** Sheet-music preview. Renders the score as real A4 pages laid out left-to-
 *  right (like an open book), engraved by OpenSheetMusicDisplay with proper
 *  margins so nothing runs off the edge. OSMD reads the host's offsetWidth to
 *  size a page, so we feed it a fixed one-page width, render, then flip the
 *  host into a horizontal strip of the resulting page <svg>s. Zooming re-renders
 *  (measures reflow + renumber); the footer ◀ ▶ and arrow keys turn pages by
 *  scrolling one page; the page width tracks the pane height (fit one sheet). */
const MusicXmlPreview: React.FC<{ artifact: NotationArtifact }> = ({ artifact }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const osmdRef = useRef<any>(null);
  const zoomRef = useRef(1);
  const pageWRef = useRef(520);
  const footerTitleRef = useRef('');
  const footerArtistRef = useRef('');
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState('Loading MusicXML renderer…');
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1); // 1-based page currently in view

  const computePageW = (): number => {
    const availH = (scrollRef.current?.clientHeight ?? 600) - 32;
    return Math.round(Math.min(1000, Math.max(360, availH / A4_RATIO)));
  };

  // Add a book-style running footer to each rendered page: "Song - Artist" and
  // the page number, centered in the bottom margin. OSMD has no footer/page-
  // number support, so we inject it into each page wrapper after every render
  // (render() recreates the pages, so this must run each time).
  const decoratePages = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = footerTitleRef.current;
    const a = footerArtistRef.current;
    const running = a ? (t ? `${t} - ${a}` : a) : t;
    const pages = Array.from(host.children).filter(
      (n): n is HTMLElement => n.nodeType === 1,
    );
    pages.forEach((node, idx) => {
      let pageEl = node;
      if (pageEl.tagName.toLowerCase() === 'svg') {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;flex:0 0 auto;background:#fff;';
        pageEl.replaceWith(wrap);
        wrap.appendChild(pageEl);
        pageEl = wrap;
      } else {
        pageEl.style.position = 'relative';
      }
      const w = pageEl.clientWidth || pageWRef.current;
      const fs = Math.max(8, Math.round(w * 0.019));
      let f = pageEl.querySelector(':scope > .score-page-footer') as HTMLElement | null;
      if (!f) {
        f = document.createElement('div');
        f.className = 'score-page-footer';
        pageEl.appendChild(f);
      }
      f.style.cssText =
        `position:absolute;left:0;right:0;bottom:${Math.round(w * 0.022)}px;` +
        `text-align:center;pointer-events:none;color:#555;line-height:1.35;` +
        `font-family:Georgia,'Times New Roman',serif;`;
      f.innerHTML = '';
      if (running) {
        const l1 = document.createElement('div');
        l1.textContent = running;
        l1.style.cssText = `font-size:${fs}px;font-style:italic;`;
        f.appendChild(l1);
      }
      const l2 = document.createElement('div');
      l2.textContent = String(idx + 1);
      l2.style.cssText = `font-size:${fs}px;`;
      f.appendChild(l2);
    });
  }, []);

  // OSMD reads host.offsetWidth at render() to size one page, then we widen the
  // host into a horizontal strip so the page svgs sit side by side.
  const doRender = useCallback(() => {
    const osmd = osmdRef.current;
    const host = hostRef.current;
    if (!osmd || !host) return;
    try {
      host.style.display = 'block';
      host.style.width = `${pageWRef.current}px`;
      osmd.Zoom = zoomRef.current;
      osmd.render();
      host.style.display = 'flex';
      host.style.width = 'max-content';
      const count =
        osmd.GraphicSheet?.MusicPages?.length ||
        host.querySelectorAll('svg').length ||
        1;
      setPageCount(count);
      decoratePages();
    } catch {
      /* render races with reload — ignore */
    }
  }, [decoratePages]);

  const applyZoom = useCallback((next: number) => {
    zoomRef.current = clampZoom(next);
    setZoom(zoomRef.current);
    doRender();
  }, [doRender]);

  const goToPage = useCallback((target: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const stride = pageWRef.current + PAGE_GAP;
    const total = Math.max(1, Math.round(el.scrollWidth / stride));
    const clamped = Math.min(total, Math.max(1, target));
    el.scrollTo({ left: (clamped - 1) * stride, behavior: 'smooth' });
    setPage(clamped);
  }, []);

  useWheelZoom(scrollRef, (factor) => applyZoom(zoomRef.current * factor));

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const host = hostRef.current;
      if (!host) return;
      host.innerHTML = '';
      try {
        const [{ OpenSheetMusicDisplay }, res, settingsRes] = await Promise.all([
          import('opensheetmusicdisplay'),
          fetch(notationArtifactUrl(artifact.id)),
          fetch('/api/settings').catch(() => null),
        ]);
        if (!res.ok) throw new Error(`MusicXML HTTP ${res.status}`);
        const xml = await res.text();
        let artist = 'GANTASMO';
        try {
          if (settingsRes && settingsRes.ok) {
            const s = await settingsRes.json();
            artist = String(s?.notation?.artist ?? '').trim() || 'GANTASMO';
          }
        } catch {
          /* settings unavailable — fall back to the GANTASMO floor */
        }
        if (cancelled) return;
        const osmd = new OpenSheetMusicDisplay(host, {
          backend: 'svg',
          autoResize: false, // we drive width + re-render ourselves
          drawTitle: true,
          drawSubtitle: true, // the artist, centered under the title
          drawComposer: false, // artist is the subtitle; no top-right credit
          pageFormat: 'A4_P',
          pageBackgroundColor: '#FFFFFF',
        });
        applySheetEngraving(osmd.EngravingRules);
        // Song as the centered title (wrapped if long), artist as the subtitle
        // under it; capture the song name for the running page footer.
        const prepared = prepareMusicXml(xml, computePageW(), artist);
        footerTitleRef.current = prepared.title;
        footerArtistRef.current = artist;
        await osmd.load(prepared.xml);
        if (cancelled) return;
        osmdRef.current = osmd;
        pageWRef.current = computePageW();
        doRender();
        setStatus('');
        setPage(1);
        if (scrollRef.current) scrollRef.current.scrollLeft = 0;
      } catch (e) {
        if (cancelled) return;
        setStatus(`Preview unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void run();
    return () => {
      cancelled = true;
      osmdRef.current = null;
    };
  }, [artifact.id, doRender]);

  // Track the page in view on horizontal scroll; re-fit page width to the pane
  // when it resizes (so one sheet keeps filling the height).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const stride = pageWRef.current + PAGE_GAP;
      setPage(Math.max(1, Math.round(el.scrollLeft / stride) + 1));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = computePageW();
        if (Math.abs(w - pageWRef.current) > 4) {
          pageWRef.current = w;
          doRender();
        }
      });
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [doRender]);

  // Keyboard paging (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        goToPage(page + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goToPage(page - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, goToPage]);

  const pageLabel = pageCount <= 1 ? '1 page' : `Page ${page} / ${pageCount}`;

  return (
    <div className="relative h-full flex flex-col bg-[#23222a]">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto p-4">
        {status && <div className="p-4 text-xs font-mono text-zinc-300">{status}</div>}
        {/* display/width are driven imperatively in doRender (block+fixed during
            OSMD's offsetWidth read, then flex+max-content for the page strip). */}
        <div
          ref={hostRef}
          className="gap-6 items-start [&>div]:shrink-0 [&>div]:bg-white [&>div]:shadow-2xl [&>div]:rounded-sm [&>svg]:shrink-0 [&>svg]:bg-white [&>svg]:shadow-2xl [&>svg]:rounded-sm"
        />
      </div>
      {/* Footer: page navigation + zoom. */}
      <div className="shrink-0 h-8 border-t border-white/10 bg-[#0a080f] flex items-center justify-center gap-1.5 px-2 text-[10px] font-mono text-zinc-300">
        <button
          onClick={() => goToPage(page - 1)}
          disabled={page <= 1}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
          title="Previous page (←)"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="min-w-24 text-center tabular-nums">{pageLabel}</span>
        <button
          onClick={() => goToPage(page + 1)}
          disabled={page >= pageCount}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
          title="Next page (→)"
          aria-label="Next page"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <span className="mx-1 w-px h-4 bg-white/10" />
        <button
          onClick={() => applyZoom(zoomRef.current / ZOOM_STEP)}
          disabled={zoom <= ZOOM_MIN + 0.001}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
          title="Zoom out (Ctrl + scroll)"
          aria-label="Zoom out"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => applyZoom(1)}
          className="min-w-10 text-center hover:text-white"
          title="Reset zoom"
          aria-label="Reset zoom"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={() => applyZoom(zoomRef.current * ZOOM_STEP)}
          disabled={zoom >= ZOOM_MAX - 0.001}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
          title="Zoom in (Ctrl + scroll)"
          aria-label="Zoom in"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

const TabPreview: React.FC<{ artifact: NotationArtifact }> = ({ artifact }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<AlphaTabApi | null>(null);
  const zoomRef = useRef(1);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState('Loading tab renderer…');

  const applyZoom = useCallback((next: number) => {
    const z = clampZoom(next);
    zoomRef.current = z;
    setZoom(z);
    const api = apiRef.current;
    if (api) {
      try {
        api.settings.display.scale = z;
        api.updateSettings();
        api.render();
      } catch {
        /* render races with reload — ignore */
      }
    }
  }, []);

  useWheelZoom(scrollRef, (factor) => applyZoom(zoomRef.current * factor));

  useEffect(() => {
    let cancelled = false;
    let api: AlphaTabApi | null = null;
    const run = async () => {
      const container = containerRef.current;
      if (!container) return;
      try {
        const [alphaTab, res] = await Promise.all([
          import('@coderline/alphatab'),
          fetch(notationArtifactUrl(artifact.id)),
        ]);
        if (!res.ok) throw new Error(`alphaTex HTTP ${res.status}`);
        const tex = await res.text();
        if (cancelled) return;
        api = new alphaTab.AlphaTabApi(container, {
          player: { enablePlayer: false },
          display: { scale: zoomRef.current },
        });
        apiRef.current = api;
        api.error.on((err) => {
          if (!cancelled) setStatus(`Tab render error: ${err instanceof Error ? err.message : String(err)}`);
        });
        api.renderFinished.on(() => {
          if (!cancelled) setStatus('');
        });
        api.tex(tex);
      } catch (e) {
        if (cancelled) return;
        setStatus(`Tab preview unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void run();
    return () => {
      cancelled = true;
      apiRef.current = null;
      try {
        api?.destroy();
      } catch {
        // ignore teardown errors
      }
    };
  }, [artifact.id]);

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="h-full overflow-auto bg-white text-black">
        {status && <div className="p-4 text-xs font-mono text-zinc-600">{status}</div>}
        <div ref={containerRef} className="min-h-full" />
      </div>
      <ZoomControls
        zoom={zoom}
        onIn={() => applyZoom(zoomRef.current * ZOOM_STEP)}
        onOut={() => applyZoom(zoomRef.current / ZOOM_STEP)}
        onReset={() => applyZoom(1)}
      />
    </div>
  );
};