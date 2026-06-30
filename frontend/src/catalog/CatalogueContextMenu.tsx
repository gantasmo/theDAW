import React, { useEffect, useState } from 'react';
import {
  Play, Scissors, Layers, Wand2, PenLine, Download, Trash2, Star, Shuffle, Cloud, Repeat, ChevronLeft,
} from 'lucide-react';
import type { LibraryEntry } from '../state/libraryEntry';
import { useLibraryStore } from '../state/libraryStore';
import {
  sendAudioToEditor,
  sendAudioToInit,
  sendAudioToInpaint,
  type SendableAudio,
} from '../lib/sendToTargets';
import { sunoActions } from '../suno/sunoActions';
import { HoverTip } from '../components/ui/Tooltip';
import { playCatalogueEntry } from './CatalogueList';
import { loadConvertFormats, formatsForKind, convertLibraryEntry } from '../convert/convertClient';
import type { ConvertFormat } from '../convert/convertClient';

export interface CatalogueContextMenuState {
  x: number;
  y: number;
  entry: LibraryEntry;
}

interface Props {
  menu: CatalogueContextMenuState;
  onClose: () => void;
}

const Item: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** CHANGED: optional HoverTip copy explaining the action (Advanced pattern). */
  tip?: string;
}> = ({ icon: Icon, label, onClick, danger, tip }) => {
  const btn = (
    <button
      className={`w-full text-left px-3 py-1.5 flex items-center gap-1.5 hover:bg-purple-500/15 ${danger ? 'text-red-300 hover:bg-red-500/15!' : 'text-zinc-200'}`}
      onClick={onClick}
    >
      <Icon className="w-3 h-3" /> {label}
    </button>
  );
  // HoverTip's root is an inline-flex <span>; force it (and its button child) to
  // span the full menu width so the tooltip doesn't shrink the row.
  return tip
    ? <div className="w-full [&>span]:w-full">{<HoverTip text={tip}>{btn}</HoverTip>}</div>
    : btn;
};

/**
 * CatalogueContextMenu — right-click row actions, all bound to the existing
 * library store + the shared `sendToTargets` helpers. Suno cover/mashup items
 * are gated to Suno-origin entries (`model === 'suno'`).
 */
export const CatalogueContextMenu: React.FC<Props> = ({ menu, onClose }) => {
  const { entry } = menu;
  const removeEntry = useLibraryStore((s) => s.removeEntry);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const getAudioUrl = useLibraryStore((s) => s.getAudioUrl);
  const fetchAudioBlob = useLibraryStore((s) => s.fetchAudioBlob);

  // Two-stage "Convert to…" — stays inside this menu (the root div stops click
  // propagation, so switching to the format list doesn't dismiss the menu).
  const [view, setView] = useState<'root' | 'convert'>('root');
  const [formats, setFormats] = useState<ConvertFormat[] | null>(null);
  const [convertMsg, setConvertMsg] = useState<string | null>(null);

  const openConvert = () => {
    setView('convert');
    if (formats === null) {
      // Catalogue entries are audio tracks; offer the audio source-kind targets.
      loadConvertFormats()
        .then((cat) => setFormats(formatsForKind(cat, 'audio')))
        .catch(() => setFormats([]));
    }
  };

  const doConvert = (f: ConvertFormat) => {
    setConvertMsg(`Converting to ${f.label}…`);
    convertLibraryEntry(entry.id, f, entry.title)
      .then(() => onClose())
      .catch((e) => setConvertMsg(`Convert failed: ${e instanceof Error ? e.message : String(e)}`));
  };

  // Dismiss on outside click / Esc / blur.
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, { capture: true });
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close, { capture: true } as EventListenerOptions);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // A SendableAudio that lazily fetches this entry's bytes via the library store.
  const sendable: SendableAudio = {
    label: entry.title,
    mimeType: entry.mimeType || 'audio/wav',
    fetcher: () => fetchAudioBlob(entry),
  };

  const run = (fn: () => void | Promise<unknown>) => () => { void fn(); onClose(); };

  const download = () => {
    const a = document.createElement('a');
    a.href = getAudioUrl(entry);
    a.download = entry.audioFilename || entry.title;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const del = () => {
    if (window.confirm(`Delete "${entry.title}"? This cannot be undone.`)) {
      void removeEntry(entry.id);
    }
  };

  return (
    <div
      className="fixed z-200 min-w-52 bg-[#0a080f] border border-purple-500/40 rounded shadow-[0_8px_24px_rgba(0,0,0,0.6)] py-1 text-[10px] font-mono"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 py-1.5 text-[8px] uppercase tracking-widest text-zinc-600 border-b border-white/5 mb-0.5 truncate">
        {view === 'convert' ? `Convert · ${entry.title}` : entry.title}
      </div>

      {view === 'convert' ? (
        <>
          <button
            className="w-full text-left px-3 py-1.5 flex items-center gap-1.5 text-zinc-400 hover:bg-purple-500/15 hover:text-zinc-100"
            onClick={() => { setView('root'); setConvertMsg(null); }}
          >
            <ChevronLeft className="w-3 h-3" /> Back
          </button>
          <div className="border-t border-white/5 my-0.5" />
          {formats === null ? (
            <div className="px-3 py-1.5 text-zinc-500">Loading formats…</div>
          ) : formats.length === 0 ? (
            <div className="px-3 py-1.5 text-zinc-500">No conversions available</div>
          ) : (
            formats.map((f) => (
              <button
                key={f.id}
                className="w-full text-left px-3 py-1.5 flex items-center gap-1.5 text-zinc-200 hover:bg-purple-500/15"
                onClick={() => doConvert(f)}
              >
                <Repeat className="w-3 h-3" /> {f.label}
              </button>
            ))
          )}
          {convertMsg && (
            <div className="px-3 py-1 text-[9px] text-amber-300/90 border-t border-white/5 mt-0.5">{convertMsg}</div>
          )}
        </>
      ) : (
      <>
      <Item icon={Play} label="Play" tip="Play this track through the global player." onClick={run(() => playCatalogueEntry(entry))} />
      <Item icon={Scissors} label="Send to Editor (append)" tip="Append this audio to the tail of the first editor track." onClick={run(() => sendAudioToEditor(sendable, 'editor-first-track'))} />
      <Item icon={Layers} label="Send to Editor (new track)" tip="Add this audio as a brand-new track in the editor." onClick={run(() => sendAudioToEditor(sendable, 'editor-new-track'))} />
      <Item icon={Wand2} label="Send to Init audio" tip="Load this audio into the generator's Init (audio-to-audio) slot." onClick={run(() => sendAudioToInit(sendable))} />
      <Item icon={PenLine} label="Send to Inpaint" tip="Load this audio into the generator's Inpaint slot to regenerate a region." onClick={run(() => sendAudioToInpaint(sendable))} />

      {/* Suno-only: a Suno clip can seed a Suno cover/mashup. */}
      {sunoActions.canUseAsSunoSource(entry) && (
        <>
          <div className="border-t border-white/5 my-0.5" />
          <Item icon={Cloud} label="Suno: Cover" tip="Use this Suno clip as the source for a Suno cover. (Suno tracks only.)" onClick={run(() => sunoActions.sendToCover(entry))} />
          <Item icon={Shuffle} label="Suno: Mashup" tip="Use this Suno clip as the base for a Suno mashup. (Suno tracks only.)" onClick={run(() => sunoActions.sendToMashup(entry))} />
        </>
      )}

      <div className="border-t border-white/5 my-0.5" />
      <Item icon={Star} label={entry.favorite ? 'Unfavorite' : 'Favorite'} tip={entry.favorite ? 'Remove from favorites.' : 'Mark as a favorite (star).'} onClick={run(() => toggleFavorite(entry.id))} />
      <Item icon={Download} label="Download" tip="Download the original audio file to your computer." onClick={run(download)} />
      <Item icon={Repeat} label="Convert to…" tip="Convert this track to another format (WAV, MP3, FLAC, OGG…) via FFmpeg and download it." onClick={openConvert} />
      <div className="border-t border-white/5 my-0.5" />
      <Item icon={Trash2} label="Delete" tip="Permanently delete this entry from the library. Cannot be undone." onClick={run(del)} danger />
      </>
      )}
    </div>
  );
};
