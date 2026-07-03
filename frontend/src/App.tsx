/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shell } from './components/layout/Shell';
import { PlayerFooter } from './components/audio/PlayerFooter';
import { LoadingScreen } from './components/layout/LoadingScreen';
import { GantasmoOrb } from './orb-kit/react/GantasmoOrb';
// The assistant panel pulls in react-markdown + @google/genai; keep it out of
// the first-paint bundle by lazy-loading it and only mounting it once the user
// first opens the orb chat (see `assistantMounted` below).
const AssistantPanel = lazy(() => import('./orb-kit/AssistantPanel'));
import { logInfo, logWarn } from './state/logStore';
import { handletheDAWAction } from './orb-kit/actionHandlers';
import { useStatusBarStore } from './state/statusBarStore';
import { useLibraryStore } from './state/libraryStore';
import { useModuleStore } from './state/moduleStore';
import { useLayoutPrefs } from './state/layoutPrefsStore';
import { triggerPianoNoteFromMidi } from './lib/pianoTrigger';
import { publishMidi } from './state/midiBus';
import { startQuestMidi, stopQuestMidi } from './state/questMidiClient';
import { startXrControl, stopXrControl, registerXrControlSource } from './state/xrControlClient';
import { djControlSource } from './state/xrControlDjSource';
import { makeControlSource } from './state/makeControlSource';
import { processControlSource } from './state/processControlSource';
import { liveFxControlSource } from './state/liveFxControlSource';
import { swayControlSource, startSwayXrMirror } from './state/swayControlSource';
import { startSwayBus } from './state/swayBus';
import { startSwayRouting } from './state/swayRouting';
import { startSwaySurface, swaySurfaceConsumes } from './state/swaySurface';
import { startSwayImportDriver } from './state/swayImportStore';
import { useSwaySurfaceStore } from './state/swaySurfaceStore';
import { detectProfileFromNames, AUDIMA_SWAY_ID } from './state/controllerProfiles';
import { poseControlSource, startPoseXrMirror } from './state/poseControlSource';
import { startPoseRouting } from './state/poseRouting';
import { startXrViz, stopXrViz } from './state/xrViz';
import { XrBusTester } from './components/dev/XrBusTester';
import { useMidiDevicesStore } from './state/midiDevicesStore';
import { isMidiAudioMuted, useMidiTriggerStore } from './state/midiTriggerStore';
import { useGanStore } from './state/ganStore';
import { useProjectStore } from './state/projectStore';
import { useAppUiStore } from './state/appUiStore';

import './orb-kit/styles/gantasmo-orb.css';
import './orb-kit/chat/orb-chat.css';

export default function App() {
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  // Defer the assistant chunk (react-markdown + @google/genai) until the user
  // first opens the orb chat; once mounted it stays mounted so chat history
  // survives a close/reopen (the panel keeps its messages in local state).
  const [assistantMounted, setAssistantMounted] = useState(false);
  const [orbPosition, setOrbPosition] = useState(() => ({
    x: typeof window !== 'undefined' ? window.innerWidth - 80 : 900,
    y: 500,
  }));
  const [skipped, setSkipped] = useState(false);
  // The boot cinematic forms over ~7s after its assets load. Hold the screen at
  // least that long so it plays in full even when the backend binds in under a
  // second, then hand off once the backend is also ready (it stays as long as
  // the backend takes). This is the cinematic's real runtime, not a delay.
  // The boot cinematic reports when its formation has fully resolved (via
  // onComplete); the screen then holds until the backend is also ready. A safety
  // timeout guarantees handoff even if the cinematic stalls (e.g. an asset never
  // loads), so the app can never hang on the boot screen.
  // A `?nocinematic` query param (used by the screenshot/capture harness) skips
  // the boot cinematic, so captures don't sit through its ~7s runtime and it
  // never appears in the shots.
  const [cinematicDone, setCinematicDone] = useState(
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('nocinematic'),
  );
  useEffect(() => {
    const t = setTimeout(() => setCinematicDone(true), 20000);
    return () => clearTimeout(t);
  }, []);

  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  const refreshHealth  = useStatusBarStore((s) => s.refreshHealth);

  // Health polling lives here so it runs during the loading screen.
  // Exponential backoff: 1s → 2s → 4s → 8s → 16s until ready, then 30s steady.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let retryDelay = 1000;

    const poll = async () => {
      if (cancelled) return;
      await refreshHealth();
      if (cancelled) return;
      const ready = useStatusBarStore.getState().isBackendReady;
      retryDelay = ready ? 30000 : Math.min(retryDelay * 2, 16000);
      timer = setTimeout(() => void poll(), retryDelay);
    };

    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refreshHealth]);

  // Populate the library store the moment the backend port is bound — so the
  // right-side Library / DJ source panels are filled on startup, not only when
  // the Library tab is first opened. Idle-scheduled so it doesn't pile onto
  // first paint; load() is guarded by loaded/loading, so the Library tab
  // mounting later won't double-fetch.
  useEffect(() => {
    if (!isBackendReady) return;
    const lib = useLibraryStore.getState();
    if (lib.loaded || lib.loading) return;
    type IdleCb = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    if (typeof ric === 'function') ric(() => void useLibraryStore.getState().load(), { timeout: 1500 });
    else setTimeout(() => void useLibraryStore.getState().load(), 0);
  }, [isBackendReady]);

  // Preload the backend module catalog the moment the backend is ready, so the
  // Settings modal reads a cached list instead of fetching on open (which used
  // to fail transiently during a (re)start and look like all modules vanished).
  useEffect(() => {
    if (!isBackendReady) return;
    void useModuleStore.getState().load();
  }, [isBackendReady]);

  useEffect(() => {
    logInfo('system', 'theDAW UI initialized');
  }, []);

  // Mount the lazy assistant panel the first time it's opened, then leave it
  // mounted (its `isOpen` prop drives show/hide, so state is preserved).
  useEffect(() => {
    if (isAssistantOpen) setAssistantMounted(true);
  }, [isAssistantOpen]);

  // App-wide TEXT size: publish the persisted scale as the `--text-scale` CSS
  // variable. index.css multiplies every font-size utility by it (font-size
  // ONLY — layout, padding, icons, gaps are untouched). 1.0 = native (no
  // change). Clamped in the store so it can't reach an unusable extreme.
  const uiScale = useLayoutPrefs((s) => s.uiScale);
  useEffect(() => {
    // CHANGED: text-only — drop any legacy page-zoom and drive the font var.
    document.documentElement.style.removeProperty('zoom');
    document.documentElement.style.setProperty('--text-scale', String(uiScale));
  }, [uiScale]);

  // ── Global Web MIDI listener ───────────────────────────────────
  // Any connected MIDI controller's note-on messages trigger the
  // synthesizer voice exposed by PianoRoll (triggerPianoNoteFromMidi).
  // Velocity is preserved 0-127. note-off events stop nothing —
  // the synth voice has its own envelope that naturally decays.
  // Hot-plug aware via MIDIAccess.onstatechange.
  const midiEnabled = useMidiTriggerStore((s) => s.enabled);
  useEffect(() => {
    // Gated behind the master MIDI toggle: until the user turns MIDI on
    // we never call requestMIDIAccess(), so Chrome's permission prompt +
    // Web MIDI deprecation notice only appear on explicit opt-in.
    if (!midiEnabled) {
      useMidiDevicesStore.getState().setMidiInputs([]);
      return;
    }
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) return;
    let access: MIDIAccess | null = null;
    let cancelled = false;

    const onMidiMessage = (e: MIDIMessageEvent) => {
      if (!e.data) return;
      // 1. Republish on the global MIDI bus so every feature
      //    (VJView iframe forwarder, MidiMapper popups in Piano +
      //    Sequence) sees the same stream. Each subscriber decides
      //    what to do with it. ONE Web MIDI listener, many readers.
      publishMidi(e.data);

      // 2. Built-in piano-synth trigger on note-on. Skipped when the
      //    user has muted MIDI audio triggering (VJ performers who
      //    want the controller to drive effects only). The bus
      //    publish above still runs, so visual effects keep reacting.
      const [status, data1, data2] = e.data;
      const command = status & 0xf0;
      if (command === 0x90 && data2 > 0 && !isMidiAudioMuted() && !swaySurfaceConsumes(e.data)) {
        try {
          triggerPianoNoteFromMidi(data1, data2);
        } catch (err) {
          /* a single failed voice should not silence the whole bus */
          console.error('[midi] note trigger failed:', err);
        }
      }
    };

    const attach = (a: MIDIAccess) => {
      const names: string[] = [];
      a.inputs.forEach((input) => {
        input.onmidimessage = onMidiMessage;
        names.push(input.name ?? 'unnamed');
      });
      // Publish the connected device names so the SLIDE/DJ controller pickers
      // can auto-detect a profile by name (and show what's plugged in).
      useMidiDevicesStore.getState().setMidiInputs(names);
    };

    // Pass an explicit MIDIOptions ({ sysex: false }) — we don't need SysEx for
    // note/CC input. NOTE: Chrome still logs a platform DEPRECATION notice
    // ("Web MIDI will ask a permission to use even if the sysex is not
    // specified") — that's Chrome moving to always-prompt (milestone 82), not
    // something our call can suppress. Correct usage; the notice is unavoidable.
    (navigator as Navigator & { requestMIDIAccess: (opts?: { sysex?: boolean }) => Promise<MIDIAccess> })
      .requestMIDIAccess({ sysex: false })
      .then((a) => {
        if (cancelled) return;
        access = a;
        attach(a);
        const count = a.inputs.size;
        if (count > 0) {
          const names: string[] = [];
          a.inputs.forEach((i) => names.push(i.name ?? 'unnamed'));
          logInfo('midi', `Web MIDI ready — ${count} input${count === 1 ? '' : 's'}: ${names.join(', ')}`);
        } else {
          logInfo('midi', 'Web MIDI ready — no inputs connected');
        }
        a.onstatechange = () => {
          if (cancelled || !access) return;
          attach(access);
        };
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        logWarn('midi', `Web MIDI unavailable: ${e instanceof Error ? e.message : String(e)}`);
      });

    return () => {
      cancelled = true;
      if (access) {
        access.inputs.forEach((input) => {
          input.onmidimessage = null;
        });
        access.onstatechange = null;
      }
    };
  }, [midiEnabled]);

  // Auto-enable the Sway DAW-control mirror when the Audima Sway is the detected
  // controller — until the user manually toggles it, after which their choice
  // sticks (autoEnable is a no-op once touched).
  const midiInputNames = useMidiDevicesStore((s) => s.inputs);
  useEffect(() => {
    if (!midiInputNames.length) return;
    if (detectProfileFromNames(midiInputNames)?.id === AUDIMA_SWAY_ID) {
      useSwaySurfaceStore.getState().autoEnable();
    }
  }, [midiInputNames]);

  // Quest MIDI bridge (loopMIDI-free): when MIDI is on, open the WebSocket to
  // the backend `questmidi` module. It hosts the localhost TCP listener + adb
  // reverse and relays the headset's MIDI onto the same midiBus as hardware
  // controllers, so nothing else needs to change to react to the Quest.
  // XR control bus (spatialization P0/P1 + Foundry bindings): publish theDAW's
  // control manifest and apply inbound control-sets. UNCONDITIONAL — the bus is
  // a cheap local WebSocket and its consumers are not MIDI-specific: the
  // VST-Foundry builder binds canvas controls to these targets regardless of
  // whether a MIDI device is enabled. Registration is passive (sources
  // lazy-load their engines on first buildEntries/apply), so this adds nothing
  // to boot beyond the socket.
  useEffect(() => {
    // DJ source maps DJ_TARGETS to spatial controls with no per-control wiring.
    registerXrControlSource(djControlSource);
    // Sway (Audima): six expressive dimensions as named 0..1 signals.
    registerXrControlSource(swayControlSource);
    // Body-pose source (camera, forwarded from the VJ); pose values arrive via
    // poseBus regardless of MIDI.
    registerXrControlSource(poseControlSource);
    // MAKE (Magenta RT2): live generation params as bindable targets.
    registerXrControlSource(makeControlSource);
    // PROCESS (MIX effect chain): drive effect params on the next offline render.
    registerXrControlSource(processControlSource);
    // LIVE (master FX): always-available, non-destructive sound shaping on the
    // player output — the VST-Foundry demo-mode bind-test surface.
    registerXrControlSource(liveFxControlSource);
    startXrControl();
    return () => {
      stopXrControl();
    };
  }, []);

  // MIDI-specific bridges stay gated: Quest MIDI, the sway CC bus + mirrors,
  // pose mirror, and the XR visualization feed.
  useEffect(() => {
    if (!midiEnabled) return;
    startQuestMidi();
    const stopSway = startSwayBus();
    const stopSwayMirror = startSwayXrMirror();
    const stopSwayRoute = startSwayRouting();
    // Audima Sway DAW-control mirror: when its mode is on, the device's
    // faders/knobs/pads/play drive theDAW's mixer + transport + pads (the
    // handler no-ops while the mode is off, so it is safe to leave running).
    const stopSwaySurface = startSwaySurface();
    // Imported-project controller auto-attach: drive the imported tracks/effects
    // from the mappings the source DAW project defined (no-ops with no bindings).
    const stopSwayImport = startSwayImportDriver();
    // Body-pose mirror only — the pose source itself is registered
    // unconditionally in the XR-bus effect above (do not re-register here).
    const stopPoseMirror = startPoseXrMirror();
    // Stream the visualization feed (waveform pack) over the same bridge so a
    // theDAW-XR headset can render theDAW's live audio natively.
    startXrViz();
    return () => {
      stopQuestMidi();
      stopSway();
      stopSwayMirror();
      stopSwayRoute();
      stopSwaySurface();
      stopSwayImport();
      stopPoseMirror();
      stopXrViz();
    };
  }, [midiEnabled]);

  // Pose routing is camera-driven (forwarded from the VJ), independent of the
  // Web MIDI gate, so it runs for the app's lifetime.
  useEffect(() => {
    const stop = startPoseRouting();
    return stop;
  }, []);

  // OS file associations (desktop): a double-clicked .tasmo / .gan is delivered
  // by the Electron main process; route it to the right opener and show MIX.
  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: { onOpenFile?: (cb: (filePath: string) => void) => () => void };
    }).electronAPI;
    if (!api?.onOpenFile) return;
    return api.onOpenFile((filePath) => {
      const lower = filePath.toLowerCase();
      if (lower.endsWith('.gan')) {
        void useGanStore.getState().openPath(filePath);
        useAppUiStore.getState().setCenterTab('mix');
      } else if (lower.endsWith('.tasmo')) {
        void useProjectStore.getState().loadPath(filePath);
        useAppUiStore.getState().setCenterTab('mix');
      }
    });
  }, []);

  const handleAssistantAction = useCallback((action: { type: string; payload?: any }) => {
    const result = handletheDAWAction(action);
    logInfo('assistant', `Action: ${action.type} → ${result}`);
  }, []);

  // The loading screen is gated purely on real backend readiness — it lifts the
  // instant the backend port is bound, never on a cosmetic timer. `skipped` is
  // the manual "continue without backend" escape (offered after a real wait).
  const showLoading = (!isBackendReady || !cinematicDone) && !skipped;

  return (
    <>
      {/* Main app always mounts so state initializes, but polls are gated on isBackendReady */}
      <Shell />
      <PlayerFooter />
      <GantasmoOrb
        isActive={isAssistantOpen}
        onToggle={() => setIsAssistantOpen(prev => !prev)}
        onPositionChange={setOrbPosition}
        // Bottom-left corner, pulled DOWN to overlap the footer (where the
        // music-note icon used to be). v3 key so it resets there once.
        defaultPosition={{ x: 12, y: typeof window !== 'undefined' ? window.innerHeight - 92 : 500 }}
        persistenceKey="thedaw-orb-pos-v3"
      />
      {assistantMounted && (
        <Suspense fallback={null}>
          <AssistantPanel
            isOpen={isAssistantOpen}
            onClose={() => setIsAssistantOpen(false)}
            onExecuteAction={handleAssistantAction}
            orbPosition={orbPosition}
          />
        </Suspense>
      )}

      {/* Dev-only: simulated XR controller to drive the control bus without a
          headset. Stripped from production builds. */}
      {import.meta.env.DEV && <XrBusTester />}

      {/* Loading screen overlays everything until backend is ready */}
      <AnimatePresence>
        {showLoading && (
          <motion.div
            key="loading"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="fixed inset-0 z-200"
          >
            <LoadingScreen onSkip={() => setSkipped(true)} onComplete={() => setCinematicDone(true)} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}


