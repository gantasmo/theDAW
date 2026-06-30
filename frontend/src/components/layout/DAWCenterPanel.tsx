import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useAppUiStore } from '../../state/appUiStore';
import { TabErrorBoundary } from './TabErrorBoundary';
import { SessionView } from '../../views/SessionView';

/**
 * The center workspace — CenterTabBar at the top + the active tab's
 * view filling the rest. The bottom multi-tab panel was extracted to
 * BottomMultiTabPanel.tsx and now lives in the global footer
 * (Shell.tsx) side-by-side with ProcessingLog. Each panel has its
 * own independent height (multiHeight / logHeight in bottomPanelStore)
 * and its own resize handle.
 *
 * Each tab view is code-split (React.lazy) so its JS — and its heavy
 * deps (wavesurfer, the force-graph engine, the chimera/effect stacks,
 * the VJ bridge) — only download when that tab is first opened, not in
 * the initial bundle. Each tab renders inside its OWN Suspense boundary
 * so a not-yet-loaded tab can't blank out a sibling.
 *
 * DJ / VJ persistence: these two tabs host live performance state (a
 * 2-deck mixer + an embedded WebGL VJ iframe). Unmounting them on every
 * tab switch tore down that state and — for VJ — reloaded the whole
 * iframe + GPU pipeline. To make the workspace robust for live use we
 * keep DJ and VJ MOUNTED once first visited ("warmed"), toggling only
 * their CSS visibility. The VJ iframe is told to pause its render loop
 * while hidden (see VJView's sa3-vj/visibility bridge) so a backgrounded
 * VJ tab costs ~0% GPU instead of unmounting + cold-reloading. Their own
 * Suspense boundary means resolving another tab never disturbs them.
 */
const WaveformEditor = lazy(() => import('../audio/WaveformEditor').then((m) => ({ default: m.WaveformEditor })));
const AdvancedView = lazy(() => import('../../views/AdvancedView').then((m) => ({ default: m.AdvancedView })));
const MixView = lazy(() => import('../../views/MixView').then((m) => ({ default: m.MixView })));
const TrainView = lazy(() => import('../../views/TrainView').then((m) => ({ default: m.TrainView })));
const LineageView = lazy(() => import('../library/LineageModal').then((m) => ({ default: m.LineageView })));
const VJView = lazy(() => import('../../views/VJView').then((m) => ({ default: m.VJView })));
const DJView = lazy(() => import('../../views/DJView').then((m) => ({ default: m.DJView })));

const TabFallback: React.FC = () => (
  <div className="absolute inset-0 grid place-items-center">
    <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 animate-pulse">loading…</span>
  </div>
);

export const DAWCenterPanel: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
  const centerTab = useAppUiStore((s) => s.centerTab);

  // Track which heavy live-performance tabs have been opened at least
  // once. We only mount DJ / VJ after first visit (so a user who never
  // touches them pays nothing), then keep them mounted permanently and
  // toggle visibility — preserving deck state + the warm VJ iframe.
  const [warmedTabs, setWarmedTabs] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (centerTab === 'dj' || centerTab === 'vj') {
      setWarmedTabs((prev) => {
        if (prev.has(centerTab)) return prev;
        const next = new Set(prev);
        next.add(centerTab);
        return next;
      });
    }
  }, [centerTab]);

  return (
    <div className="flex-1 h-full flex flex-col pt-1 px-0 pb-0 gap-2 bg-[#0a080f]/40 relative z-0 min-h-0">

      {/* Main workspace — the tab bar now lives in the global header; the active center
          tab takes the whole area. Bottom panel is rendered globally
          in Shell.tsx, no longer inside this card. */}
      <div className="flex-1 min-h-0 hardware-card flex flex-col mx-2 pt-1">
        <div className="flex-1 min-h-0 relative">
          {centerTab === 'train' && (
            <div className="absolute inset-0 overflow-hidden">
              <TabErrorBoundary tabName="Train">
                <Suspense fallback={<TabFallback />}><TrainView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {centerTab === 'make' && (
            <div className="absolute inset-0 overflow-hidden">
              <TabErrorBoundary tabName="Make">
                <Suspense fallback={<TabFallback />}><AdvancedView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {centerTab === 'edit' && (
            <TabErrorBoundary tabName="Edit">
              <Suspense fallback={<TabFallback />}><WaveformEditor onSwitchTab={onSwitchTab} /></Suspense>
            </TabErrorBoundary>
          )}
          {centerTab === 'session' && (
            <div className="absolute inset-0 overflow-hidden">
              <TabErrorBoundary tabName="Session">
                <SessionView />
              </TabErrorBoundary>
            </div>
          )}
          {centerTab === 'mix' && (
            // PROCESS → MIX. The MIX workspace on the Control-Surface editor
            // (MixView): 2 input/output viz rows up top (toggle waveform / live
            // scope, A/B overlay), the effect-chain workflow (rail + library +
            // chain) in the middle, and the effectStage below. Drag-arrangeable
            // in Design Mode like the DJ console.
            <div className="absolute inset-0 overflow-hidden">
              <TabErrorBoundary tabName="Mix">
                <Suspense fallback={<TabFallback />}><MixView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {centerTab === 'learn' && (
            <TabErrorBoundary tabName="Learn">
              <Suspense fallback={<TabFallback />}><LineageView rootEntryId={null} /></Suspense>
            </TabErrorBoundary>
          )}

          {/* DJ + VJ stay mounted once warmed; visibility toggles with
              the active tab so their live state (decks, VJ iframe) is
              preserved across tab switches. Each has its own Suspense so
              loading a different tab never blanks them. */}
          {warmedTabs.has('dj') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'dj' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="DJ">
                <Suspense fallback={<TabFallback />}><DJView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {warmedTabs.has('vj') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'vj' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="VJ">
                <Suspense fallback={<TabFallback />}><VJView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
