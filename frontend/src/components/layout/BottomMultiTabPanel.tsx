/**
 * Bottom multi-tab panel body — Visualize / Piano / Sequence / Details
 * / Media / SLIDE. Mounted above the dock strip when isOpen=true. The strip
 * itself (Shell.tsx ShellBottomDock) handles the open/close toggle,
 * so this component only renders the body shape: a tabs row + the
 * active tab's content. Height is the column's own `multiHeight`
 * from bottomPanelStore — independent of the LOG's `logHeight`.
 */
import React, { useState } from 'react';
import {
  Activity, Info, Piano, Layers, FolderOpen, SlidersVertical, ExternalLink, Maximize2, Minimize2,
  FileMusic, Waves, Brush,
} from 'lucide-react';
import { AdvancedVisualizer } from '../audio/AdvancedVisualizer';
import { StepSequencer } from '../audio/StepSequencer';
import { DetailsView } from './DetailsView';
import { ScoreView } from './ScoreView';
import { MediaBucketView } from './MediaBucketView';
import { SlidePanel } from './SlidePanel';
import { SwayPanel } from './SwayPanel';
import { MidiPanel } from './MidiPanel';
import { DrawPanel } from './DrawPanel';
import { DetachableWindow } from './DetachableWindow';
import { useBottomPanelStore, type BottomPanelTab } from '../../state/bottomPanelStore';
import { useSlideStore } from '../../state/slideStore';

const TAB_DEFS: Array<{ id: BottomPanelTab; label: string; desc: string; icon: React.ComponentType<{ className?: string }>; colorActive: string }> = [
  { id: 'spectral',   label: 'Visualize',  desc: 'Live spectrum + waveform visualizer of the playing audio',                 icon: Activity,   colorActive: 'border-purple-500 text-purple-300' },
  { id: 'midi',       label: 'MIDI',       desc: 'Piano roll: sing in, record or analyze notes, edit them, export MIDI',     icon: Piano,      colorActive: 'border-cyan-500 text-cyan-300' },
  { id: 'step-seq',   label: 'Sequence',   desc: 'Program drum and note patterns step by step on a grid',                    icon: Layers,     colorActive: 'border-cyan-500 text-cyan-300' },
  { id: 'draw',       label: 'DRAW',       desc: 'Draw to play generative music; record it to the library or EDIT',          icon: Brush,      colorActive: 'border-purple-500 text-purple-300' },
  { id: 'score',      label: 'Score',      desc: 'Sheet music + tabs for the selection; convert and arrange notation',       icon: FileMusic,  colorActive: 'border-emerald-500 text-emerald-300' },
  { id: 'details',    label: 'Details',    desc: 'Metadata, prompt and analysis for the selected library item',              icon: Info,       colorActive: 'border-emerald-500 text-emerald-300' },
  { id: 'bucket',     label: 'Media',      desc: 'Drag-and-drop bucket for staging clips and media files',                   icon: FolderOpen, colorActive: 'border-amber-500 text-amber-300' },
  { id: 'slide',      label: 'SLIDE',      desc: 'Control surface: map sliders and pads to parameters',                      icon: SlidersVertical, colorActive: 'border-pink-500 text-pink-300' },
  { id: 'sway',       label: 'SWAY',       desc: 'Pose control: drive music and effects from body movement',                 icon: Waves,      colorActive: 'border-fuchsia-500 text-fuchsia-300' },
];

export const BottomMultiTabPanel: React.FC = () => {
  const activeTab = useBottomPanelStore((s) => s.activeTab);
  const setActiveTab = useBottomPanelStore((s) => s.setActiveTab);
  const multiMaximized = useBottomPanelStore((s) => s.multiMaximized);
  const toggleMultiMaximized = useBottomPanelStore((s) => s.toggleMultiMaximized);
  // SLIDE can detach into its own window (second-monitor performance). The
  // window is opened in the click handler below — browsers block window.open
  // that runs from an effect (outside the gesture), which was the original
  // "pop-out does nothing" bug. Session state only — never auto-reopen on reload.
  const [slideWin, setSlideWin] = useState<Window | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);

  const toggleSlideDetach = () => {
    if (slideWin) {
      setSlideWin(null); // pop back in — unmounting DetachableWindow closes it
      return;
    }
    const w = window.open(
      '',
      'theDAW_SLIDE',
      'width=560,height=860,menubar=no,toolbar=no,location=no,status=no',
    );
    if (!w) {
      setPopupBlocked(true);
      return;
    }
    setPopupBlocked(false);
    setSlideWin(w);
  };

  return (
    <div className="h-full flex flex-col bg-purple-500/2 min-h-0">
      {/* Tabs row. When SLIDE is active its AUDIO/VISUAL content toggle lives
          here (right side) so the panel body gets full height for the lanes. */}
      <div className="flex items-center justify-between border-b border-white/5 shrink-0 bg-black/30">
        <div className="flex overflow-x-auto no-scrollbar">
          {TAB_DEFS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`px-3 py-1.5 flex items-center gap-1.5 border-b-2 text-[9px] uppercase tracking-widest font-black transition-colors whitespace-nowrap ${active ? t.colorActive : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
                title={t.desc}
              >
                <Icon className="w-3 h-3" /> {t.label}
              </button>
            );
          })}
        </div>
        {/* Right cluster — SLIDE-only controls (when active) + the always-on
            maximize toggle so any tab can fill the window. */}
        <div className="flex items-center gap-1 pr-2 shrink-0">
          {activeTab === 'slide' && (
            <>
              <SlideContentToggle />
              <button
                onClick={toggleSlideDetach}
                className={`p-1 rounded border text-[9px] flex items-center gap-1 ${
                  slideWin
                    ? 'border-pink-500/50 bg-pink-500/15 text-pink-200'
                    : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/25'
                }`}
                title={slideWin ? 'Pop SLIDE back into the app' : 'Pop SLIDE out into its own window (second monitor)'}
                aria-label="Detach SLIDE window"
              >
                <ExternalLink className="w-3 h-3" />
              </button>
            </>
          )}
          <button
            onClick={toggleMultiMaximized}
            className={`p-1 rounded border ${
              multiMaximized
                ? 'border-purple-500/50 bg-purple-500/15 text-purple-200'
                : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/25'
            }`}
            title={multiMaximized ? 'Restore panel size' : 'Maximize panel to fill the window'}
            aria-label={multiMaximized ? 'Restore panel' : 'Maximize panel'}
          >
            {multiMaximized ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 relative">
        {activeTab === 'spectral' && (
          <div className="absolute inset-0 p-1">
            <AdvancedVisualizer />
          </div>
        )}
        {activeTab === 'details' && (
          <div className="absolute inset-0">
            <DetailsView />
          </div>
        )}
        {activeTab === 'midi' && (
          <div className="absolute inset-0">
            <MidiPanel />
          </div>
        )}
        {activeTab === 'draw' && (
          <div className="absolute inset-0">
            <DrawPanel />
          </div>
        )}
        {activeTab === 'step-seq' && (
          <div className="absolute inset-0 overflow-y-auto">
            <StepSequencer />
          </div>
        )}
        {activeTab === 'score' && (
          <div className="absolute inset-0">
            <ScoreView />
          </div>
        )}
        {activeTab === 'bucket' && (
          <div className="absolute inset-0">
            <MediaBucketView />
          </div>
        )}
        {activeTab === 'sway' && (
          <div className="absolute inset-0">
            <SwayPanel />
          </div>
        )}
        {activeTab === 'slide' && (
          <div className="absolute inset-0">
            {slideWin ? (
              <>
                <div className="h-full flex flex-col items-center justify-center gap-3 text-pink-200">
                  <ExternalLink className="w-5 h-5" />
                  <span className="text-[10px] font-mono uppercase tracking-widest">
                    SLIDE is in a separate window
                  </span>
                  <button
                    onClick={() => setSlideWin(null)}
                    className="px-3 py-1.5 rounded border border-pink-500/40 bg-pink-500/15 text-pink-200 hover:bg-pink-500/25 text-[9px] font-black uppercase tracking-widest"
                  >
                    Pop back in
                  </button>
                </div>
                <DetachableWindow win={slideWin} title="theDAW — SLIDE" onClose={() => setSlideWin(null)}>
                  <SlidePanel />
                </DetachableWindow>
              </>
            ) : (
              <>
                {popupBlocked && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded border border-amber-500/50 bg-amber-500/15 text-amber-200 text-[9px] font-mono">
                    Pop-up blocked — allow pop-ups for this site, then click the ⤢ button again.
                  </div>
                )}
                <SlidePanel />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * AUDIO / VISUAL content toggle for the SLIDE tab — hoisted into the tab row
 * (per the user's layout) instead of living inside the panel body. Drives
 * slideStore.content; AUDIO is emerald, VISUAL is pink to match the surface.
 */
const SlideContentToggle: React.FC = () => {
  const content = useSlideStore((s) => s.content);
  const setContent = useSlideStore((s) => s.setContent);
  const btn = 'px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.18em] transition-colors';
  return (
    <div className="flex items-center pr-2 shrink-0">
      <div className="flex rounded-md border border-white/10 overflow-hidden">
        <button
          onClick={() => setContent('audio')}
          className={`${btn} ${content === 'audio' ? 'bg-emerald-500/15 text-emerald-200 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.5)]' : 'text-zinc-500 hover:text-zinc-200'}`}
        >
          Audio
        </button>
        <button
          onClick={() => setContent('visual')}
          className={`${btn} ${content === 'visual' ? 'bg-pink-500/15 text-pink-200 shadow-[inset_0_0_0_1px_rgba(236,72,153,0.5)]' : 'text-zinc-500 hover:text-zinc-200'}`}
        >
          Visual
        </button>
      </div>
    </div>
  );
};
