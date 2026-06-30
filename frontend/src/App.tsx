/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shell } from './components/layout/Shell';
import { PlayerFooter } from './components/audio/PlayerFooter';
import { LoadingScreen } from './components/layout/LoadingScreen';
import { GantasmoOrb } from './orb-kit/react/GantasmoOrb';
import { AssistantPanel } from './orb-kit/AssistantPanel';
import { logInfo, logWarn } from './state/logStore';
import { handletheDAWAction } from './orb-kit/actionHandlers';
import { useStatusBarStore } from './state/statusBarStore';
import { useAppUiStore } from './state/appUiStore';
import { useLibraryStore } from './state/libraryStore';
import { useModuleStore } from './state/moduleStore';
import { useLayoutPrefs } from './state/layoutPrefsStore';
import { triggerPianoNoteFromMidi } from './components/audio/PianoRoll';
import { publishMidi } from './state/midiBus';
import { startQuestMidi, stopQuestMidi } from './state/questMidiClient';
import { isMidiMessageIgnored } from './state/midiIgnoreStore';
import { startXrControl, stopXrControl, registerXrControlSource } from './state/xrControlClient';
import { djControlSource } from './state/xrControlDjSource';
import { makeControlSource } from './state/makeControlSource';
import { processControlSource } from './state/processControlSource';
import { swayControlSource, startSwayXrMirror } from './state/swayControlSource';
import { startSwayBus } from './state/swayBus';
import { startSwayRouting } from './state/swayRouting';
import { poseControlSource, startPoseXrMirror } from './state/poseControlSource';
import { startPoseRouting } from './state/poseRouting';
import { startXrViz, stopXrViz } from './state/xrViz';
import { XrBusTester } from './components/dev/XrBusTester';
import { useMidiDevicesStore } from './state/midiDevicesStore';
import { isMidiAudioMuted, useMidiTriggerStore } from './state/midiTriggerStore';

import './orb-kit/styles/gantasmo-orb.css';
import './orb-kit/chat/orb-chat.css';

interface NativeMidiMessageDetail {
  data?: number[];
  input?: string;
}

interface NativeMidiDevicesDetail {
  inputs?: string[];
}

interface NativeMidiStatusDetail {
  message?: string;
}

declare global {
  interface Window {
    __theDAWNativeMidiAvailable?: boolean;
    webkit?: {
      messageHandlers?: {
        nativeMidi?: {
          postMessage: (message: unknown) => void;
        };
      };
    };
  }
}

function triggerOptionalPianoVoice(data: number[]): void {
  const [status, data1, data2] = data;
  if (typeof status !== 'number' || typeof data1 !== 'number' || typeof data2 !== 'number') return;
  const command = status & 0xf0;
  if (command === 0x90 && data2 > 0 && !isMidiAudioMuted()) {
    try {
      triggerPianoNoteFromMidi(data1, data2);
    } catch (err) {
      /* a single failed voice should not silence the whole bus */
      console.error('[midi] note trigger failed:', err);
    }
  }
}

export default function App() {
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
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
  const centerTab = useAppUiStore((s) => s.centerTab);
  const isPerformanceWorkspace = centerTab === 'dj' || centerTab === 'session';

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

  // ── Native CoreMIDI bridge (standalone macOS app) ─────────────────────
  // WKWebView does not expose Web MIDI, so the app wrapper forwards CoreMIDI
  // packets into the page as CustomEvents. Once here, they use the same global
  // MIDI bus as browser Web MIDI, so DJ learn/presets/VJ forwarding all work.
  useEffect(() => {
    const nativeHandler = window.webkit?.messageHandlers?.nativeMidi;
    if (!nativeHandler) return;

    window.__theDAWNativeMidiAvailable = true;

    const onDevices = (event: Event) => {
      const detail = (event as CustomEvent<NativeMidiDevicesDetail>).detail;
      useMidiDevicesStore.getState().setMidiInputs(Array.isArray(detail?.inputs) ? detail.inputs : []);
    };

    const onMidi = (event: Event) => {
      if (!useMidiTriggerStore.getState().enabled) return;
      const detail = (event as CustomEvent<NativeMidiMessageDetail>).detail;
      const data = Array.isArray(detail?.data) ? detail.data : null;
      if (!data || data.length < 2) return;
      if (isMidiMessageIgnored(data)) return;
      publishMidi(data);
      triggerOptionalPianoVoice(data);
    };

    const onStatus = (event: Event) => {
      const detail = (event as CustomEvent<NativeMidiStatusDetail>).detail;
      if (detail?.message) logWarn('midi', detail.message);
    };

    window.addEventListener('thedaw:native-midi-devices', onDevices);
    window.addEventListener('thedaw:native-midi', onMidi);
    window.addEventListener('thedaw:native-midi-status', onStatus);

    try {
      nativeHandler.postMessage({ type: 'ready' });
    } catch {
      /* bridge presence is best-effort; packet events are still accepted */
    }

    return () => {
      window.removeEventListener('thedaw:native-midi-devices', onDevices);
      window.removeEventListener('thedaw:native-midi', onMidi);
      window.removeEventListener('thedaw:native-midi-status', onStatus);
    };
  }, []);

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
      if (!window.__theDAWNativeMidiAvailable) useMidiDevicesStore.getState().setMidiInputs([]);
      return;
    }
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) return;
    let access: MIDIAccess | null = null;
    let cancelled = false;

    const onMidiMessage = (e: MIDIMessageEvent) => {
      if (!e.data) return;
      if (isMidiMessageIgnored(e.data)) return;
      // 1. Republish on the global MIDI bus so every feature
      //    (VJView iframe forwarder, MidiMapper popups in Piano +
      //    Sequence) sees the same stream. Each subscriber decides
      //    what to do with it. ONE Web MIDI listener, many readers.
      publishMidi(e.data);

      // 2. Built-in piano-synth trigger on note-on. Skipped when the
      //    user has muted MIDI audio triggering (VJ performers who
      //    want the controller to drive effects only). The bus
      //    publish above still runs, so visual effects keep reacting.
      triggerOptionalPianoVoice(Array.from(e.data));
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

  // Quest MIDI bridge (loopMIDI-free): when MIDI is on, open the WebSocket to
  // the backend `questmidi` module. It hosts the localhost TCP listener + adb
  // reverse and relays the headset's MIDI onto the same midiBus as hardware
  // controllers, so nothing else needs to change to react to the Quest.
  useEffect(() => {
    if (!midiEnabled) return;
    startQuestMidi();
    // XR control bus (spatialization P0/P1): publish theDAW's control manifest
    // to a theDAW-XR headset and apply inbound control-sets. The DJ source maps
    // DJ_TARGETS to spatial controls with no per-control wiring; it lazy-loads
    // the DJ engine so registering it here does not pull djEngine into boot.
    registerXrControlSource(djControlSource);
    // Sway (Audima): the six expressive dimensions become named 0..1 signals on
    // the same control bus, learned from the device's CCs. Target-agnostic, so
    // they can drive VFX, 3D audio, and MAKE/voice targets once those subscribe.
    registerXrControlSource(swayControlSource);
    const stopSway = startSwayBus();
    const stopSwayMirror = startSwayXrMirror();
    const stopSwayRoute = startSwayRouting();
    // Body-pose source (camera, forwarded from the VJ). Publish its channels on
    // the same bus; the pose values themselves arrive via poseBus regardless of MIDI.
    registerXrControlSource(poseControlSource);
    const stopPoseMirror = startPoseXrMirror();
    // MAKE (Magenta RT2): live generation params as bindable targets, so SWAY and
    // an XR headset can drive generation. Bidirectional like DJ; lazy-loaded.
    registerXrControlSource(makeControlSource);
    // PROCESS (MIX effect chain): drive effect params on the next offline render,
    // including the vocal_processing path. Bidirectional like DJ; lazy-loaded.
    registerXrControlSource(processControlSource);
    startXrControl();
    // Stream the visualization feed (waveform pack) over the same bridge so a
    // theDAW-XR headset can render theDAW's live audio natively.
    startXrViz();
    return () => {
      stopQuestMidi();
      stopSway();
      stopSwayMirror();
      stopSwayRoute();
      stopPoseMirror();
      stopXrControl();
      stopXrViz();
    };
  }, [midiEnabled]);

  // Pose routing is camera-driven (forwarded from the VJ), independent of the
  // Web MIDI gate, so it runs for the app's lifetime.
  useEffect(() => {
    const stop = startPoseRouting();
    return stop;
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
      {!isPerformanceWorkspace && (
        <>
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
          <AssistantPanel
            isOpen={isAssistantOpen}
            onClose={() => setIsAssistantOpen(false)}
            onExecuteAction={handleAssistantAction}
            orbPosition={orbPosition}
          />
        </>
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
