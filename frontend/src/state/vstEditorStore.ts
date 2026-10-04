/**
 * vstEditorStore - the ONE embedded native VST3 editor session, app-wide.
 *
 * The backend sidecar hosts a single editor window, so this store owns which
 * chain entry it is open for and which center tab opened it. open() replicates
 * MIX's original handleEditVst flow: dismiss any other embed, launch the real
 * native editor, then poll for the captured raw_state and hand it to the
 * caller's sink so the dialed-in sound lands on the right chain (MIX chain,
 * EDIT track chain, or EDIT master VST chain). Leaving the tab that opened the
 * embed closes it, so the native window never keeps floating over an unrelated
 * workspace.
 *
 * EMBEDDED vs FLOATING is the user's choice (vstEditorPrefsStore), not a
 * consequence of the runtime: a floating session simply sends no parent window
 * handle, which is what makes the plugin show its own full native window
 * (preset browsers and modal dialogs included) instead of the clipped embed.
 * A plain browser has no handle to send, so it is floating whatever the
 * preference says — `mode` therefore records what the session ACTUALLY got.
 */
import { create } from 'zustand';
import { useAppUiStore, type CenterTab } from './appUiStore';
import { useStatusBarStore } from './statusBarStore';
import { useVstEditorPrefs, type VstEditorMode } from './vstEditorPrefsStore';
import { vstApi, getNativeWindowHandle, setLiveEditorRectRouter, setLiveEditorSizeRouter } from '../lib/vstClient';
import { setVstLiveStateSink, vstSessions, type VstLiveSession } from '../lib/vstLive/sessionRegistry';
import { useVstLiveStore } from './vstLiveStore';
import { beginUndoStep, useEditorStore } from './editorStore';
import {
  useEffectChainStore,
  setVstStateStorageErrorHandler,
  setVstStateLoadListener,
  areVstStatesLoaded,
  isVstStateUnresolved,
  retryVstStateLoad,
  vstStatesLoaded,
} from './effectChainStore';
import type { ChainEntry, VstStateHost, VstStateStorageOp } from './effectChainStore';

/**
 * A place outside the project's racks that holds hosted plugins: the piano
 * roll's parts, each of which can play through a VST3 instrument
 * (state/rollInstruments). This store finds a plugin's entry by its id to write
 * what its live editor captures, and to know the entry still exists; an owner
 * registers here so this module never imports the roll.
 */
export interface VstEntryOwner {
  /** The entry with id `entryId`, when this owner holds it. */
  find(entryId: string): ChainEntry | undefined;
  /** Store a state the live host captured onto the entry. */
  setRawState(entryId: string, rawState: string, stateHost: VstStateHost): void;
}
const entryOwners = new Set<VstEntryOwner>();

/** Register `owner`; returns the unregister. */
export function registerVstEntryOwner(owner: VstEntryOwner): () => void {
  entryOwners.add(owner);
  return () => {
    entryOwners.delete(owner);
  };
}

/** The entry `entryId` in a registered owner, and that owner. */
const ownedEntry = (entryId: string): { owner: VstEntryOwner; entry: ChainEntry } | null => {
  for (const owner of entryOwners) {
    const entry = owner.find(entryId);
    if (entry) return { owner, entry };
  }
  return null;
};

/** A VST entry's human name. `plugin_name` is what the chain stored when the
 *  entry was added; a chain saved before the scanner learned real names (or by
 *  an importer) can carry an empty one, and the plugin's own filename is a far
 *  better answer than the bare format id 'vst3'. */
export function vstEntryName(pluginName: string | null | undefined, pluginPath: string): string {
  if (pluginName) return pluginName;
  const file = pluginPath.split(/[\\/]/).pop() ?? '';
  return file.replace(/\.vst3$/i, '') || 'VST3 plugin';
}

interface VstEditorState {
  /** Chain-entry id the editor session is open for; null = no session. */
  entryId: string | null;
  pluginPath: string | null;
  pluginName: string | null;
  /** Load failure for the current session, shown by VstEmbedHost instead of a
   *  forever "loading...". */
  error: string | null;
  /** The center tab that opened the embed; leaving it closes the session. */
  ownerTab: CenterTab | null;
  /** How the CURRENT session ACTUALLY opened (not merely what was preferred:
   *  without a parent window handle an 'embedded' request still floats).
   *  null = no session. */
  mode: VstEditorMode | null;
  /** Open (or re-open) a VST entry's native GUI. sinkRawState receives the
   *  captured base64 plugin state once the editor commits it. */
  open: (
    entry: ChainEntry,
    sinkRawState: (entryId: string, rawState: string) => void,
    opts?: {
      /** Internal: skip the live-first branch (the fallback after the live host turned out to be unavailable). */
      offlineOnly?: boolean;
      /** Internal: this open already waited for the entry's saved state (and
       *  retried a failed read), so it must not wait again — without it a
       *  read that keeps failing would defer the open forever. */
      stateReady?: boolean;
    },
  ) => void;
  /** Remember `mode` for the session's plugin and relaunch the editor in it.
   *  A LIVE session relaunches straight through openLiveEditor, which closes
   *  the outgoing one itself. Otherwise the relaunch goes through close() +
   *  open(), so open()'s drain captures whatever the outgoing editor commits
   *  and seeds the new one with it — a mode switch never costs the user their
   *  dialed-in state. Records the preference and stops there when nothing is
   *  open, or when the session is already in that mode. */
  setMode: (mode: VstEditorMode) => void;
  close: () => void;
}

/** A launched editor session whose final raw_state has not been captured yet. */
interface SessionRecord {
  gen: number;
  entryId: string;
  pluginPath: string;
  sink: (entryId: string, rawState: string) => void;
}

// Monotonically increasing session generation. Every open() bumps it and each
// poll loop captures the value it started under; a poll whose generation is no
// longer current exits WITHOUT sinking, because the backend keys its result
// file by plugin_path only and the next open() resets that file to 'launching',
// so a stale poll could otherwise attribute one session's raw_state to another
// session's entry. close() deliberately does NOT bump the generation: the
// current session's poll loop must keep running after close so the state the
// sidecar writes when the native window closes still lands on the owning entry.
let sessionGen = 0;

// The most recently launched editor session whose result is still outstanding.
// Kept module-level (not in zustand state) because close() clears the visible
// session record while its poll loop keeps running; the NEXT open() drains this
// record before its own open-editor POST resets the path-keyed result file.
let uncaptured: SessionRecord | null = null;

// The open request behind the visible session: setMode() relaunches the SAME
// entry into the other mode, and the view that owns the toggle (VstEmbedHost)
// has neither the ChainEntry nor the sink to hand back. Module-level for the
// same reason as `uncaptured`: it outlives the state a close() clears.
let currentRequest: { entry: ChainEntry; sink: (entryId: string, rawState: string) => void } | null = null;

// The request behind the currently open LIVE editor: setMode() needs the
// ChainEntry to relaunch it through openLiveEditor (the offline path's
// `currentRequest` is never populated for a live session, since open() never
// falls through to it — see F1b3 / R1 finding 8). Recorded by openLiveEditor
// itself, for the same "outlives close()" reason as `currentRequest`.
interface LiveEditorRequest {
  entry: ChainEntry;
  mode: VstEditorMode;
  /** The last rect VstEmbedHost pushed for this session (physical px), so a
   *  mode relaunch reopens at the size the user left it at rather than
   *  resetting to the small default box every embedded session starts at. */
  rect: { x: number; y: number; w: number; h: number };
}
let currentLiveRequest: LiveEditorRequest | null = null;

/** How long 'Edit GUI' waits for a `starting` live session to become `live`
 *  before it gives up — see `waitForLiveThenOpen`. The backend gives a host 30 s
 *  to load its plugin (`DEFAULT_SPAWN_TIMEOUT` in backend/modules/vst/live_host.py)
 *  and reports the failure itself after that, so the wait outlasts it: a plugin
 *  that takes ten seconds to load opens its window when it is ready. */
export const LIVE_STARTING_WAIT_MS = 35_000;

/** Test seam for `waitForLiveThenOpen`'s bounded wait: real timers by
 *  default, a fake clock in tests (so a test never actually waits 5 s). */
export interface LiveWaitClock {
  schedule: (fn: () => void, ms: number) => number;
  cancel: (handle: number) => void;
}
const realLiveWaitClock: LiveWaitClock = {
  schedule: (fn, ms) => window.setTimeout(fn, ms) as unknown as number,
  cancel: (h) => window.clearTimeout(h as unknown as ReturnType<typeof globalThis.setTimeout>),
};
let liveWaitClock: LiveWaitClock = realLiveWaitClock;
/** Install a fake clock for `waitForLiveThenOpen` (`null` restores real timers). */
export function __setLiveWaitClockForTest(clock: LiveWaitClock | null): void {
  liveWaitClock = clock ?? realLiveWaitClock;
}

/** Test seam: how open()/waitForLiveThenOpen reach a live session. Defaults
 *  to the app's real registry; tests substitute a fake so a test never spawns
 *  a real host process or opens a socket. */
let liveSessionLookup: (entryId: string) => VstLiveSession | undefined = (entryId) => vstSessions.get(entryId);
/** Install a fake live-session source (`null` restores the real registry). */
export function __setLiveSessionLookupForTest(
  lookup: ((entryId: string) => VstLiveSession | undefined) | null,
): void {
  liveSessionLookup = lookup ?? ((entryId) => vstSessions.get(entryId));
}

/** How long a COLD start may take before 'Edit GUI' gives up: the host process has to spawn and
 *  the plugin has to load (a mastering suite takes several seconds), unlike the warm case above. */
export const LIVE_COLD_START_WAIT_MS = 45_000;

/** The registry surface open() needs to START a live session for the editor window. */
export interface LiveSessionHolder {
  /** false = the host is known to be missing here; null = not probed yet; true = available. */
  hostAvailable: () => boolean | null;
  hold: (entry: ChainEntry) => Promise<VstLiveSession | null>;
  unhold: (entryId: string) => void;
}
const EDITOR_HOLDER = 'editor';
const realLiveHolder: LiveSessionHolder = {
  hostAvailable: () => vstSessions.hostAvailable(),
  // The engine's own context: the node that arrives later asks for the same rate, so the
  // session the editor started is the one it reuses (a second rate would mean a second plugin).
  // playerStore is imported lazily: it reads Vite's import.meta.env at module scope, which does
  // not exist under the plain-tsx test runner, and nothing but this real path needs it.
  hold: async (entry) => {
    const { getEngineCtx } = await import('./playerStore');
    return vstSessions.hold(entry, getEngineCtx().sampleRate, EDITOR_HOLDER);
  },
  unhold: (entryId) => vstSessions.unhold(entryId, EDITOR_HOLDER),
};
let liveHolder: LiveSessionHolder = realLiveHolder;
/** Install a fake holder (`null` restores the real registry). */
export function __setLiveHolderForTest(holder: LiveSessionHolder | null): void {
  liveHolder = holder ?? realLiveHolder;
}

/** The entry whose session the editor is holding, so it is given back exactly once. */
let heldEntryId: string | null = null;
const releaseHold = (): void => {
  if (heldEntryId === null) return;
  const id = heldEntryId;
  heldEntryId = null;
  liveHolder.unhold(id);
};

// The "no plugin windows" test switch is enforced BELOW this store, at the two calls that can put
// a window on the screen (lib/vstLive/editorWindowSwitch.ts). open() itself runs unchanged under
// test, which is what lets a browser test prove the app reaches for the LIVE editor.
export { NO_EDITOR_WINDOWS_KEY } from '../lib/vstLive/editorWindowSwitch';

/** The in-flight "wait for `starting` to become `live`" started by open(), if
 *  any: stops its vstLiveStore subscription and cancels its timer. Replaced
 *  (never just abandoned) by a superseding wait or a close(), so a stale wait
 *  can never leave either running after nobody wants it — the cancellation
 *  F1b3 / R1 finding 7 asks for. */
let activeLiveWaitStop: (() => void) | null = null;

/** True for statuses after which the sidecar will not write the result file
 *  again ('none' means no session or file exists for the path at all). */
const isTerminalStatus = (s: string) => s === 'ok' || s === 'error' || s === 'none';

/* ── the LIVE editor ────────────────────────────────────────────────────────
   When a `vst3` entry is being hosted live, "Edit GUI" must open the editor of
   the instance that is MAKING THE SOUND, not a second copy of the plugin in the
   offline sidecar. Two plugins, two states, and the one the user dials in is
   the one they cannot hear — so the live path takes priority whenever it
   exists, and the sidecar path below is what an entry falls back to when this
   machine has no host binary.

   The session outlives the editor (and the editor outlives a chain rebuild), so
   the store owns only the bookkeeping: which entry, the state-capture timer,
   and the rect router that makes `VstEmbedHost`'s existing rect pushes land on
   the live socket. */

/** How often the plugin's state is captured while its editor is open. */
const LIVE_STATE_CAPTURE_MS = 5000;
/** Window a burst of `param` events is coalesced over before one store write. */
const PARAM_COALESCE_MS = 120;

interface LiveEditorRecord {
  entryId: string;
  pluginPath: string;
  session: VstLiveSession;
  stateTimer: number;
  paramTimer: number;
  /** Parameter index -> normalized value, pending a single store write. */
  pendingParams: Map<number, number>;
}

let liveEditor: LiveEditorRecord | null = null;

/**
 * Write parameters the user moved in the plugin's own editor back onto the
 * chain entry, so automation lanes and the project file see what the editor
 * did. Values are the protocol's normalized 0..1 and ride as `p<index>` keys,
 * the same convention `vstLiveNode.setParams` reads.
 *
 * Undo-exempt by construction: these go through the same param setters a knob
 * drag uses, which coalesce into the current step rather than opening one per
 * event — a plugin can emit these at 30 Hz per parameter, and a history entry
 * per tick would make undo useless.
 */
function sinkLiveParams(entryId: string, values: Map<number, number>): void {
  if (values.size === 0) return;
  const merge = (params: Record<string, number>): Record<string, number> => {
    const next = { ...params };
    for (const [index, value] of values) next[`p${index}`] = value;
    return next;
  };

  const mix = useEffectChainStore.getState().chain.find((e) => e.id === entryId);
  if (mix) {
    useEffectChainStore.getState().updateParams(entryId, merge(mix.params));
    return;
  }
  const ed = useEditorStore.getState();
  for (const t of ed.tracks) {
    const e = (t.fxChain ?? []).find((x) => x.id === entryId);
    if (e) {
      ed.updateTrackEffectParams(t.id, entryId, merge(e.params));
      return;
    }
  }
  // A track's instrument slot: its knobs live in the plugin's own state, which
  // the next capture stores; there is no rack param list to merge them into.
  // A roll part's instrument likewise.
  if (ed.tracks.some((t) => t.instrument?.id === entryId) || ownedEntry(entryId)) return;
  for (const b of ed.buses) {
    const e = b.fxChain.find((x) => x.id === entryId);
    if (e) {
      ed.updateBusEffectParams(b.id, entryId, merge(e.params));
      return;
    }
  }
  const master = ed.masterFxChain.find((e) => e.id === entryId);
  if (master) {
    ed.updateMasterEffectParams(entryId, merge(master.params));
    return;
  }
  // The master VST rack used to end the search here, so a knob moved in the
  // plugin's own window while it sat on the master reached nothing at all.
  const masterVst = ed.masterVstChain.find((e) => e.id === entryId);
  if (masterVst) ed.setMasterVstParams(entryId, merge(masterVst.params));
}

/**
 * The user moved a control IN THE PLUGIN'S OWN EDITOR WINDOW — grabbed
 * (`gestureSink`) or dragged (`paramSink`). This is a genuine user gesture,
 * unlike `vstLiveNode.pushParams`'s `stateDirty` marking, which also fires on
 * every chain rebuild and on `relive`/`attachWorklet`'s unconditional
 * re-push. It is the ONLY thing `sinkLiveRawState`'s save-time rejection
 * guard may trust as evidence that a capture on a defaulted plugin is the
 * user's new sound, not merely a respawn nobody has touched yet (T18 fifth
 * audit, CRITICAL 1). Routed through the same session lookup the guard reads,
 * so a test double substituted there is exercised exactly like the registry.
 */
function markUserMovedOnRejectedState(entryId: string): void {
  const session = liveSessionLookup(entryId);
  if (session) session.userMovedOnRejectedState = true;
}

/** Test-only hook: simulate a genuine user gesture in the plugin's own editor
 *  window — what `gestureSink` calls in the real app — without wiring up
 *  `openLiveEditor`'s full window/DOM machinery. The app never calls this. */
export function __simulateLiveEditorGestureForTest(entryId: string): void {
  markUserMovedOnRejectedState(entryId);
}

/**
 * Write a plugin state captured from the LIVE host onto whichever chain entry
 * `entryId` names, stamped `state_host: 'thedaw'`.
 *
 * The origin stamp is the point. A VST3 state blob is not portable between our
 * host and the offline pedalboard renderer (measured), so a blob with no idea
 * where it came from is a blob that cannot be safely replayed anywhere. Every
 * live capture lands here — the editor's 5 s timer, the editor close, the
 * save-time pass, and the state the host writes on its way out — which is also
 * what lets the row stop saying the plugin is running at its defaults.
 *
 * It finds the entry itself, exactly as `sinkLiveParams` does, rather than
 * taking the caller's sink: the caller's sink is the OLD sidecar's, and it has
 * no way to name the host.
 *
 * `masterFxChain` is deliberately not searched: it holds rack effects, and has
 * no VST raw-state setter to write through. A plugin on the master lives in
 * `masterVstChain`.
 */
/** `true` when the raw state was actually written onto the entry; `false`
 *  when there was nothing to write or the rejection guard refused it — the
 *  save-time capture pass (`captureLiveVstStates`) uses this to decide
 *  whether the session's `stateDirty` flag may be cleared (T18 fifth audit,
 *  CRITICAL 1 secondary). */
function sinkLiveRawState(entryId: string, rawState: string): boolean {
  if (!rawState) return false;
  // The running plugin is known NOT to hold this entry's state: the host
  // refused the restore (sessionRegistry records that), or it was spawned with
  // nothing because the state could not be read. What it would hand back is
  // its FACTORY DEFAULTS, and storing those would destroy the saved state —
  // five seconds after the rejection, with no user action at all (T18 fourth
  // audit, CRITICAL 1).
  //
  // `userMovedOnRejectedState` is the other half: once the user has ACTUALLY
  // moved something on the defaulted plugin, the capture is their new sound
  // and IS wanted. `stateDirty` alone cannot answer this — a chain rebuild
  // sets it too (`vstLiveNode.pushParams`, `relive`, `attachWorklet`'s
  // unconditional re-push), which used to unlock this guard on a rejected
  // plugin nobody had touched (T18 fifth audit, CRITICAL 1).
  const row = useVstLiveStore.getState().entries[entryId];
  if (row?.stateOrigin === 'state-rejected' && !liveSessionLookup(entryId)?.userMovedOnRejectedState) return false;
  const flip = () => useVstLiveStore.getState().setStateOrigin(entryId, 'live');

  const mix = useEffectChainStore.getState().chain.find((e) => e.id === entryId);
  if (mix?.vst) {
    // Refused while the entry's saved state is still loading: the plugin is
    // then at its defaults, and the row keeps the user's real state.
    if (useEffectChainStore.getState().setVstRawState(entryId, rawState, 'thedaw')) {
      flip();
      return true;
    }
    return false;
  }
  const ed = useEditorStore.getState();
  for (const t of ed.tracks) {
    const e = (t.fxChain ?? []).find((x) => x.id === entryId);
    if (e?.vst) {
      ed.setTrackVstRawState(t.id, entryId, rawState, 'thedaw');
      flip();
      return true;
    }
    if (t.instrument?.id === entryId && t.instrument.vst) {
      ed.setTrackInstrumentRawState(t.id, rawState, 'thedaw');
      flip();
      return true;
    }
  }
  for (const b of ed.buses) {
    const e = b.fxChain.find((x) => x.id === entryId);
    if (e?.vst) {
      ed.setBusVstRawState(b.id, entryId, rawState, 'thedaw');
      flip();
      return true;
    }
  }
  const master = ed.masterVstChain.find((e) => e.id === entryId);
  if (master?.vst) {
    ed.setMasterVstRawState(entryId, rawState, 'thedaw');
    flip();
    return true;
  }
  // A piano-roll part's instrument, or any other registered owner's plugin.
  const owned = ownedEntry(entryId);
  if (owned?.entry.vst) {
    owned.owner.setRawState(entryId, rawState, 'thedaw');
    flip();
    return true;
  }
  return false;
}

// The registry rescues the state a host writes as it shuts down (the DELETE
// response) and has nowhere to put it — it is keyed by chain entry id and knows
// nothing about chains. This is the module that does, so it installs itself.
setVstLiveStateSink(sinkLiveRawState);

/** Human text for a failed plugin-state store operation, `QuotaExceededError`
 *  named explicitly since it is the expected way a save fails (a browser
 *  storage quota, not a bug). Nothing retries on its own, so no message
 *  promises a retry. */
function describeVstStateStorageError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return 'storage quota exceeded - free up space (clear old projects/cache)';
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** What failed, worded per operation: [status-bar phrase, editor-banner phrase]. */
const STORAGE_FAILURE_WORDING: Record<VstStateStorageOp, [string, string]> = {
  save: ['failed to save plugin state', 'Failed to save plugin state'],
  load: ['could not load saved plugin state', 'Could not load saved plugin state'],
  delete: ['could not delete stored plugin state', 'Could not delete stored plugin state'],
};

/** Entries THIS module marked as running on defaults because their saved
 *  state could not be read — as opposed to a rejection the HOST reported,
 *  which only the host can take back. */
const markedUnreadable = new Set<string>();

/** How long ONE plugin is given to answer a save-time `get_state`. */
export const LIVE_STATE_CAPTURE_TIMEOUT_MS = 750;

/** Seams for `captureLiveVstStates`; the app passes none. */
export interface CaptureLiveVstStatesDeps {
  sessions?: () => VstLiveSession[];
  /** Is this entry's session live, and does it have an editor open? */
  liveRow?: (entryId: string) => { status: string; editorOpen: boolean } | undefined;
  /** Returns whether the state was actually written; a refused write (the
   *  rejection guard) must not clear `stateDirty` below. */
  sink?: (entryId: string, rawState: string) => boolean;
  timeoutMs?: number;
}

/**
 * Ask every live plugin that is AHEAD of its stored state for a fresh one, and
 * write what comes back onto its entry.
 *
 * Called before a project save and before an autosave snapshot. Without it the
 * file records whatever was captured the last time an editor happened to be
 * open: a plugin driven from the FX row's own controls, or left running for an
 * hour with its window closed, would save at a state it left long ago and load
 * back sounding different.
 *
 * Three rules make it safe to sit in front of a save:
 *
 *  - ONLY WHAT IS STALE. A `get_state` parks the host's audio thread, so idle
 *    plugins are not asked at all: a session qualifies when its editor is open
 *    (the user is dialing it now) or a parameter has been pushed since its last
 *    capture (`stateDirty`).
 *  - BOUNDED, AND IN PARALLEL. Each plugin gets `timeoutMs` and they all run at
 *    once, so the save waits about one timeout in total however many plugins
 *    are loaded — not one per plugin. Sequential waits on a 24-plugin project
 *    would stall a save for eighteen seconds.
 *  - A TIMEOUT KEEPS THE PREVIOUS STATE. A plugin that does not answer in time
 *    leaves the entry exactly as it was and logs; it never clears a state or
 *    writes an empty one. The save then records the last known-good settings,
 *    which is strictly better than recording nothing.
 *
 * Never rejects: a save must not fail because a plugin was slow.
 */
export async function captureLiveVstStates(deps: CaptureLiveVstStatesDeps = {}): Promise<void> {
  const sessions = deps.sessions ?? (() => vstSessions.sessions());
  const liveRow = deps.liveRow ?? ((id: string) => useVstLiveStore.getState().entries[id]);
  const sink = deps.sink ?? sinkLiveRawState;
  const timeoutMs = deps.timeoutMs ?? LIVE_STATE_CAPTURE_TIMEOUT_MS;

  const stale = sessions().filter((s) => {
    const row = liveRow(s.entryId);
    if (row?.status !== 'live') return false;
    return row.editorOpen || s.stateDirty;
  });
  if (stale.length === 0) return;

  await Promise.all(
    stale.map(
      (session) =>
        new Promise<void>((resolve) => {
          // The editor's own sink is put back afterwards. Inside the window the
          // only `state` expected is the one asked for here, and routing it
          // through `sink` writes exactly what that sink would have written —
          // so swallowing it costs nothing and avoids a double store write.
          const previous = session.stateSink ?? null;
          let settled = false;
          const finish = (captured: string | null, why = `did not answer within ${timeoutMs} ms`): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            session.stateSink = previous;
            // `resolve()` in a finally: the sink writes the store, and that
            // write can throw (a capture too big for the localStorage quota).
            // Before this, such a throw escaped between clearTimeout and
            // resolve — the promise never settled and every save that awaited
            // this hung for good (T18 re-audit, MAJOR 2).
            try {
              if (captured) {
                // Only clear the flag when the sink actually wrote: a refused
                // capture (the rejection guard) must leave `stateDirty` set so
                // the next `relive`/`attachWorklet` and the next autosave keep
                // trying rather than silently giving up on this session
                // forever (T18 fifth audit, CRITICAL 1 secondary).
                if (sink(session.entryId, captured)) session.stateDirty = false;
              } else {
                console.warn(
                  `[vstLive] ${session.entryId}: plugin ${why} — the previously captured state is ` +
                    'what this save records.',
                );
              }
            } catch (err) {
              console.warn(`[vstLive] ${session.entryId}: storing the captured state failed:`, err);
            } finally {
              resolve();
            }
          };
          const timer = setTimeout(() => finish(null), timeoutMs);
          session.stateSink = (stateB64) => finish(stateB64);
          try {
            session.client.getState();
          } catch {
            // A dead socket is a timeout that has already happened: settle now
            // rather than making the save wait out the full budget for it.
            finish(null, 'could not be reached');
          }
        }),
    ),
  );
}

/** Stop the live editor session's timers and ask the host to close its window. */
function closeLiveEditor(): void {
  const rec = liveEditor;
  if (!rec) return;
  liveEditor = null;
  setLiveEditorRectRouter(null);
  setLiveEditorSizeRouter(null);
  window.clearInterval(rec.stateTimer);
  if (rec.paramTimer) {
    window.clearTimeout(rec.paramTimer);
    sinkLiveParams(rec.entryId, rec.pendingParams);
  }
  // Ask for the state BEFORE closing: the host answers `state` asynchronously,
  // and `stateSink` is deliberately left attached so that answer still lands on
  // the entry after the window is gone. It is replaced, not leaked — the next
  // live editor installs its own.
  rec.session.client.getState();
  rec.session.client.closeEditor();
  useVstLiveStore.getState().setEditorOpen(rec.entryId, false);
}

/**
 * Close a previous session's native editor and wait briefly for its sidecar to
 * write the final state, sinking a captured 'ok' raw_state into the OLD entry.
 * The backend keys the editor result file by plugin_path only, so this must
 * complete BEFORE the next open-editor POST resets that file; otherwise the old
 * sidecar's late write would be attributed to the new session (and the new
 * session's own capture lost). Returns the captured raw_state so a reopen of
 * the same entry can seed the editor with it, or null when the old sidecar is
 * already gone or never commits, in which case it times out silently.
 */
async function drainSession(record: SessionRecord): Promise<string | null> {
  try {
    await vstApi.editorRect(record.pluginPath, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
  } catch {
    return null; // backend unreachable; nothing left to drain
  }
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    try {
      const res = await vstApi.editorResult(record.pluginPath);
      if (isTerminalStatus(res.status)) {
        if (res.status === 'ok' && res.raw_state) {
          // A sidecar opened on a `state-rejected` entry (both reads failed
          // and no live host was available to retry through) starts the
          // plugin at factory defaults; writing that capture through the
          // caller's sink unconditionally would silently overwrite the
          // still-intact stored blob with those defaults. `sinkLiveRawState`
          // carries this same guard for the live path -- mirrored here
          // because the caller's sink stamps `state_host: 'pedalboard'`,
          // which `sinkLiveRawState` cannot do (T18 batch-12 note 2).
          const row = useVstLiveStore.getState().entries[record.entryId];
          if (row?.stateOrigin !== 'state-rejected') {
            record.sink(record.entryId, res.raw_state);
          }
          return res.raw_state;
        }
        return null;
      }
    } catch {
      // Transient fetch failure; keep waiting until the deadline.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
  }
  return null;
}

type SetState = (partial: Partial<VstEditorState>) => void;
type GetState = () => VstEditorState;

/**
 * Open the editor of the plugin instance that is currently processing audio.
 *
 * EMBEDDED vs FLOATING is the user's choice (vstEditorPrefsStore, T27) exactly
 * as it is for the sidecar path, with the same override: embedded needs a
 * native window handle to reparent into, and a plain browser has none — so
 * `mode` records what the session ACTUALLY got, not what was preferred.
 *
 * `open_editor` takes PHYSICAL pixels; the rect here is only the opening size,
 * and `VstEmbedHost` immediately corrects it through `editor_rect` (routed to
 * this session by `setLiveEditorRectRouter`).
 */
async function openLiveEditor(
  entry: ChainEntry,
  session: VstLiveSession,
  set: SetState,
  get: GetState,
): Promise<void> {
  if (!entry.vst) return;
  closeLiveEditor(); // at most one editor session at a time, as before
  const path = entry.vst.plugin_path;
  const name = vstEntryName(entry.vst.plugin_name, path);
  const status = useStatusBarStore.getState();
  // Captured before the await: the user can switch tabs during it, and a
  // session must belong to the tab that started it.
  const ownerTab = useAppUiStore.getState().centerTab;
  const wantFloating = useVstEditorPrefs.getState().modeFor(path) === 'floating';
  const hwnd = wantFloating ? null : await getNativeWindowHandle();
  if (useAppUiStore.getState().centerTab !== ownerTab) return; // nothing would host it

  const dpr = window.devicePixelRatio || 1;
  const embedded = hwnd !== null;
  // A relaunch (setMode toggling embedded<->floating, or a reconnect) reopens
  // at the size the user last had it, rather than resetting to the small
  // default box every embedded session would otherwise start at.
  const priorRect = currentLiveRequest?.entry.id === entry.id ? currentLiveRequest.rect : null;
  const initialRect = {
    x: 0,
    y: 0,
    w: priorRect && priorRect.w > 0 ? priorRect.w : Math.round(480 * dpr),
    h: priorRect && priorRect.h > 0 ? priorRect.h : Math.round(320 * dpr),
  };
  // The host acknowledges this request by repeating its box; the live store
  // needs to know the box to tell that acknowledgement from the editor's size.
  useVstLiveStore.getState().setEditorRequest(entry.id, embedded ? { w: initialRect.w, h: initialRect.h } : null);
  session.client.openEditor(embedded ? { parentHwnd: hwnd, ...initialRect, title: name } : { title: name });
  currentLiveRequest = {
    entry,
    mode: embedded ? 'embedded' : 'floating',
    rect: embedded ? initialRect : { x: 0, y: 0, w: 0, h: 0 },
  };

  const rec: LiveEditorRecord = {
    entryId: entry.id,
    pluginPath: path,
    session,
    stateTimer: 0,
    paramTimer: 0,
    pendingParams: new Map(),
  };

  // The state the plugin is in IS the entry's `vst.raw_state` — but it is OUR
  // host's blob, and the offline renderer cannot load the other host's, so it
  // must be stamped with where it came from. `sinkLiveRawState` finds the entry
  // itself and does that; the caller's `sinkRawState` is the SIDECAR's sink and
  // has no way to name a host, which is exactly why it is not used here.
  session.stateSink = (stateB64) => sinkLiveRawState(entry.id, stateB64);
  // A knob grabbed in the plugin's own window starts a NEW undo step, exactly as a press on one of
  // the app's own sliders does: without the cut, a drag that begins within the coalescing window of
  // some other edit is folded into it, and one Ctrl+Z takes both back.
  session.gestureSink = (_index, begin) => {
    if (begin) beginUndoStep();
    markUserMovedOnRejectedState(entry.id);
  };
  session.paramSink = (index, value) => {
    markUserMovedOnRejectedState(entry.id);
    rec.pendingParams.set(index, value);
    if (rec.paramTimer) return;
    rec.paramTimer = window.setTimeout(() => {
      rec.paramTimer = 0;
      const values = new Map(rec.pendingParams);
      rec.pendingParams.clear();
      sinkLiveParams(rec.entryId, values);
    }, PARAM_COALESCE_MS);
  };
  // Capture while the editor is OPEN, not only when it closes: a floating
  // window can be left open for an hour, and a crash in between would
  // otherwise lose everything the user dialed in.
  rec.stateTimer = window.setInterval(() => session.client.getState(), LIVE_STATE_CAPTURE_MS);
  // `VstEmbedHost` keeps pushing rects the only way it knows; this is what
  // makes them reach the live host instead of the offline sidecar.
  setLiveEditorRectRouter((p, r) => {
    if (p !== path) return false;
    if (r.close) {
      get().close();
      return true;
    }
    if (currentLiveRequest?.entry.id === entry.id) {
      currentLiveRequest.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    session.client.editorRect({
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.w),
      h: Math.round(r.h),
    });
    return true;
  });

  // The embedded editor's size comes from the session too: the host reports it
  // when the editor opens and again whenever the plugin resizes its view.
  setLiveEditorSizeRouter((p) => {
    if (p !== path) return undefined;
    if (!embedded) return null;
    return useVstLiveStore.getState().entries[entry.id]?.editorSize ?? null;
  });

  liveEditor = rec;
  useVstLiveStore.getState().setEditorOpen(entry.id, true);
  set({
    entryId: entry.id,
    pluginPath: path,
    pluginName: name,
    error: null,
    ownerTab,
    mode: embedded ? 'embedded' : 'floating',
  });
  // "processing the signal now" was an unconditional constant — it said so
  // even when the row's own stateOrigin already knew the host had rejected
  // the saved state and the plugin was running at its factory defaults
  // (T18 fourth audit, MINOR 5: the open status line must report the real
  // outcome, not an optimistic one).
  const onDefaults = useVstLiveStore.getState().entries[entry.id]?.stateOrigin === 'state-rejected';
  status.setText(
    embedded
      ? `VST GUI: ${name} embedding... (live)${onDefaults ? ' - running at factory defaults, saved state was rejected' : ''}`
      : `VST GUI: ${name} opened in its own window (live) - ${
          onDefaults
            ? 'running at factory defaults, saved state was rejected'
            : 'it is processing the signal now'
        }`,
  );
}

/**
 * 'Edit GUI' was clicked while this entry's live session is still spawning
 * (hello/ready has not landed). Waiting is not optional: the offline sidecar
 * has no idea a live session exists, so opening it here would start a SECOND
 * copy of the plugin and, the instant its editor captured a state, stamp a
 * `pedalboard` origin onto an entry a live host is about to own — the "two
 * plugins, two states" problem openLiveEditor's banner comment describes,
 * except silent instead of merely wrong (F1b3 / R1 finding 7).
 *
 * Bounded to `LIVE_STARTING_WAIT_MS`: a plugin that never answers must not
 * leave the user staring at "starting..." forever. Cancellable: a superseding
 * open() (this entry retried, or a different one opened) and close() both
 * retire whatever `activeLiveWaitStop` points at before doing anything else.
 */
function waitForLiveThenOpen(
  entry: ChainEntry,
  set: SetState,
  get: GetState,
  opts: { timeoutMs?: number; onUnavailable?: () => void; onGiveUp?: () => void } = {},
): void {
  if (!entry.vst) return;
  activeLiveWaitStop?.(); // a superseding open() retires whatever was waiting before
  const path = entry.vst.plugin_path;
  const name = vstEntryName(entry.vst.plugin_name, path);
  const ownerTab = useAppUiStore.getState().centerTab;
  // Mirrors the offline path's "loading" bookkeeping: VstEmbedHost needs an
  // entryId to key its view off of, and somewhere to show the error below,
  // while nothing is open yet. `mode: null` is the "nothing open yet" value.
  set({ entryId: entry.id, pluginPath: path, pluginName: name, error: null, ownerTab, mode: null });
  useStatusBarStore.getState().setText(`VST GUI: ${name} is starting (live)...`);

  let handle = 0;
  let unsubscribe: () => void = () => {};
  const stop = (): void => {
    unsubscribe();
    liveWaitClock.cancel(handle);
    if (activeLiveWaitStop === stop) activeLiveWaitStop = null;
  };
  const fail = (reason: string): void => {
    stop();
    opts.onGiveUp?.();
    const msg = `${name} ${reason}`;
    useStatusBarStore.getState().setText(`VST GUI FAILED: ${msg}`);
    // Only this wait's own entry — a superseding open() already overwrote it.
    if (get().entryId === entry.id) set({ error: msg });
  };
  unsubscribe = useVstLiveStore.subscribe(
    (s) => s.entries[entry.id]?.status,
    (status) => {
      if (status === 'live') {
        stop();
        const session = liveSessionLookup(entry.id);
        if (session) void openLiveEditor(entry, session, set, get);
        else if (get().entryId === entry.id) set({ error: `${name} started but its session vanished.` });
        return;
      }
      // No live host on this machine after all: the caller falls back to the offline copy.
      if (status === 'unavailable' && opts.onUnavailable) {
        stop();
        opts.onUnavailable();
        return;
      }
      // 'off' / 'error' / 'unavailable': the spawn will not become live.
      if (status !== 'starting') fail(`failed to start${status ? ` (${status})` : ''}.`);
    },
  );
  handle = liveWaitClock.schedule(
    () => fail('is still starting — try again in a moment.'),
    opts.timeoutMs ?? LIVE_STARTING_WAIT_MS,
  );
  activeLiveWaitStop = stop;
}

export const useVstEditorStore = create<VstEditorState>()((set, get) => ({
  entryId: null,
  pluginPath: null,
  pluginName: null,
  error: null,
  ownerTab: null,
  mode: null,

  open: (entry, sinkRawState, opts) => {
    if (!entry.vst) return;
    // A MIX entry's saved state arrives from IndexedDB a moment after startup;
    // until it has, `entry.vst.raw_state` reads as "defaults", and both the
    // live host and the offline sidecar would open the plugin on that. Wait,
    // then open on the entry as it is NOW (with its state), if it still exists.
    // An entry whose read FAILED gets one retry here: a transient read error
    // then costs this open a moment, not the plugin's saved state (which no
    // capture may overwrite while it counts as failed).
    if (!opts?.stateReady && (!areVstStatesLoaded() || isVstStateUnresolved(entry.id))) {
      void vstStatesLoaded
        .then(() => retryVstStateLoad(entry.id))
        .then(() => {
          if (!chainEntryExists(entry.id)) return;
          const fresh = useEffectChainStore.getState().chain.find((e) => e.id === entry.id);
          get().open(fresh ?? entry, sinkRawState, { ...opts, stateReady: true });
        });
      return;
    }
    if (get().entryId === entry.id && !opts?.offlineOnly) return; // already open for this entry
    // A different entry takes over: whatever session the editor was holding goes back.
    if (heldEntryId !== null && heldEntryId !== entry.id) releaseHold();
    // A superseding open() -- this is a DIFFERENT entry than whatever was
    // open (or waiting) before -- must retire any wait already in flight,
    // whichever of the three branches below it takes. Before this, only
    // waitForLiveThenOpen's own entry point and close() retired it, so the
    // 'live' branch and the offline fall-through both left a stale wait
    // running for the entry being superseded (R1 rework finding).
    activeLiveWaitStop?.();
    // A live session owns this plugin: its editor is the one that changes what
    // is being heard, so the sidecar path below is not even considered.
    const session = liveSessionLookup(entry.id);
    const liveStatus = useVstLiveStore.getState().entries[entry.id]?.status;
    if (session && liveStatus === 'live') {
      void openLiveEditor(entry, session, set, get);
      return;
    }
    // A live spawn is under way for this entry: sessionRegistry.open() sets
    // status to 'starting' as the FIRST thing it does, well before the
    // session object itself exists (the HTTP probe, the spawn POST, and the
    // WS connect all still have to happen), so `session` above is commonly
    // still undefined here -- check liveStatus alone, not `session &&
    // liveStatus === 'starting'` (that guard stayed false for the entire
    // spawn phase and fell through to the offline branch anyway, F1b3 / R1
    // finding 7 rework). Opening the offline sidecar now would spin up a
    // SECOND copy of the plugin and, the moment its editor captured a state,
    // stamp a `pedalboard` origin onto an entry a live host is about to own.
    // Wait the spawn out instead of falling through to the sidecar path
    // below -- waitForLiveThenOpen looks the session up itself once status
    // turns 'live'.
    if (liveStatus === 'starting') {
      waitForLiveThenOpen(entry, set, get);
      return;
    }
    // No live session yet -- usually just because the engine has not built this chain (a plugin
    // added with the transport stopped). With a live host on this machine the live instance is
    // THE instance: start it and open ITS window, so the knobs the user turns are the plugin
    // they hear. The node that arrives later reuses the same session. Only a machine without
    // the host (or a page open from another device) falls through to the offline copy below.
    if (!opts?.offlineOnly && liveHolder.hostAvailable() !== false) {
      heldEntryId = entry.id;
      const fallBackToOffline = (): void => {
        releaseHold();
        useStatusBarStore
          .getState()
          .setText('Live plugin host unavailable - editing a separate copy; changes apply when you close the window.');
        get().open(entry, sinkRawState, { offlineOnly: true });
      };
      waitForLiveThenOpen(entry, set, get, {
        timeoutMs: LIVE_COLD_START_WAIT_MS,
        onUnavailable: fallBackToOffline,
        onGiveUp: releaseHold,
      });
      void liveHolder
        .hold(entry)
        .then((held) => {
          // The store row is what the wait above listens to. A null WITHOUT a row change (an
          // entry the registry refuses outright) would leave it waiting out the whole timeout.
          if (held || heldEntryId !== entry.id) return;
          const status = useVstLiveStore.getState().entries[entry.id]?.status;
          if (status === 'live' || status === 'starting') return;
          activeLiveWaitStop?.();
          if (status === 'error') {
            releaseHold();
            if (get().entryId === entry.id) set({ error: `${vstEntryName(entry.vst?.plugin_name, entry.vst?.plugin_path ?? '')} failed to start live.` });
            return;
          }
          fallBackToOffline();
        })
        .catch(() => {
          if (heldEntryId !== entry.id) return;
          activeLiveWaitStop?.();
          fallBackToOffline();
        });
      return;
    }
    const path = entry.vst.plugin_path;
    const name = vstEntryName(entry.vst.plugin_name, path);
    const rawState = entry.vst.raw_state;
    // Remembered so setMode() can relaunch this exact request; set before any
    // await so a mode toggle during the open round-trip still has it.
    currentRequest = { entry, sink: sinkRawState };
    // The user's choice for THIS plugin (per-path override, else the app-wide
    // default). 'floating' sends no parent handle, even in Electron.
    const wantFloating = useVstEditorPrefs.getState().modeFor(path) === 'floating';
    const status = useStatusBarStore.getState();
    // Capture the owning tab BEFORE any await: the user can switch tabs while
    // the open round-trip is in flight, and the session must belong to the tab
    // that started it or be closed when that tab is gone by launch time.
    const ownerTab = useAppUiStore.getState().centerTab;
    // Bump the generation so any previous poll loop retires without sinking;
    // the drain below captures the old session's final state instead.
    const gen = ++sessionGen;
    // Take ownership of the outstanding session (still recorded, or already
    // closed but not yet captured) so its final state drains into ITS entry.
    const prevRecord = uncaptured;
    uncaptured = null;
    // Clear any old session record up front so its embed host unmounts and
    // stops pushing rect updates that would overwrite the drain's close request.
    if (get().entryId) {
      set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null, mode: null });
    }
    const clearEmbed = () => {
      if (get().entryId === entry.id) {
        set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null, mode: null });
      }
    };
    void (async () => {
      // Drain the previous session before open-editor resets the shared result
      // file. When the drained editor belonged to THIS entry (close followed by
      // an immediate reopen), seed the new editor with the just-captured state
      // rather than the snapshot taken before the close.
      let openState = rawState;
      if (prevRecord) {
        const drained = await drainSession(prevRecord);
        if (drained && prevRecord.entryId === entry.id) openState = drained;
      }
      // Embedded: hand the sidecar the host window so it reparents the editor
      // into the owning view. Floating (the user's choice, or a plain browser
      // with no handle to give): no parent, so the plugin owns its window and
      // everything it draws outside the editor stays reachable.
      const hwnd = wantFloating ? null : await getNativeWindowHandle();
      const embed = hwnd
        ? { parentHwnd: hwnd, rect: { x: 0, y: 0, w: 480, h: 320, dpr: window.devicePixelRatio || 1 } }
        : undefined;
      const actualMode: VstEditorMode = embed ? 'embedded' : 'floating';
      try {
        await vstApi.openEditor(path, openState, embed);
        // The user may have switched tabs, or another open() may have
        // superseded this one, while the POST was in flight. A session that no
        // view hosts must be closed (the same editor-rect close the tab
        // subscription uses), not recorded.
        if (gen !== sessionGen || useAppUiStore.getState().centerTab !== ownerTab) {
          void vstApi.editorRect(path, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
          return;
        }
        // Record the session in BOTH modes (embedded and floating) so the
        // same-entry guard above debounces repeat clicks: without a record, a
        // plain browser would spawn a new sidecar process and poll loop on
        // every click of the same entry.
        set({ entryId: entry.id, pluginPath: path, pluginName: name, error: null, ownerTab, mode: actualMode });
        uncaptured = { gen, entryId: entry.id, pluginPath: path, sink: sinkRawState };
        status.setText(embed
          ? `VST GUI: ${name} embedding...`
          : `VST GUI: ${name} opened in its own window - close it to save its settings`);
        const startedAt = performance.now();
        const poll = () => {
          // A newer open() owns the result file now; it drained this session,
          // so exiting without sinking loses nothing.
          if (gen !== sessionGen) return;
          vstApi.editorResult(path)
            .then((res) => {
              if (gen !== sessionGen) return;
              if (res.status === 'ok' && res.raw_state) {
                if (uncaptured?.gen === gen) uncaptured = null;
                // Same `state-rejected` guard as `drainSession` above, for
                // the same reason: an `unreadable` entry opened through the
                // sidecar with no live host available starts at factory
                // defaults, and this capture must not overwrite the stored
                // blob with them (T18 batch-12 note 2).
                // Same `state-rejected` guard as `drainSession` above, for
                // the same reason: an `unreadable` entry opened through the
                // sidecar with no live host available starts at factory
                // defaults, and this capture must not overwrite the stored
                // blob with them (T18 batch-12 note 2).
                const row = useVstLiveStore.getState().entries[entry.id];
                if (row?.stateOrigin !== 'state-rejected') {
                  sinkRawState(entry.id, res.raw_state);
                }
                status.setText(`VST GUI: ${name} settings captured`);
                clearEmbed();
                return;
              }
              if (res.status === 'error') {
                if (uncaptured?.gen === gen) uncaptured = null;
                const msg = res.error || 'editor unavailable';
                status.setText(`VST GUI FAILED: ${msg}`);
                // Keep the host visible (Electron) so the failure is on-screen,
                // not just in the status bar; otherwise there is nothing to clear.
                if (get().entryId === entry.id) set({ error: msg });
                return;
              }
              if (performance.now() - startedAt < 30 * 60 * 1000) window.setTimeout(poll, 1500);
            })
            .catch(() => {
              if (gen === sessionGen && performance.now() - startedAt < 30 * 60 * 1000) window.setTimeout(poll, 1500);
            });
        };
        window.setTimeout(poll, 1500);
      } catch (e) {
        clearEmbed();
        status.setText(`VST GUI FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  },

  setMode: (mode) => {
    if (mode !== 'embedded' && mode !== 'floating') return;
    const { pluginPath, entryId, mode: current } = get();
    if (!pluginPath) return;
    // The preference is recorded first and unconditionally: it must stick even
    // when the relaunch below is skipped (no session, or already in `mode`), so
    // the NEXT open of this plugin honours the choice either way.
    useVstEditorPrefs.getState().setModeForPlugin(pluginPath, mode);
    if (!entryId || current === mode) return;
    // A LIVE editor is open on this entry: relaunch through openLiveEditor
    // directly — it closes the outgoing one itself ("at most one at a time").
    // Before F1b3 only `currentRequest` (the OFFLINE path's request) was
    // checked here, so a live editor never relaunched (R1 finding 8): this
    // branch's own request is recorded by openLiveEditor, not by open().
    if (liveEditor?.entryId === entryId && currentLiveRequest?.entry.id === entryId) {
      void openLiveEditor(currentLiveRequest.entry, liveEditor.session, set, get);
      return;
    }
    const request = currentRequest;
    if (!request || request.entry.id !== entryId) return;
    // Close through the EXISTING path, then reopen. close() leaves this
    // session's poll loop running and its record in `uncaptured`, and open()
    // drains that record before its own launch resets the shared result file —
    // so a state the outgoing editor commits lands on this entry AND seeds the
    // relaunched editor. A floating window the user has not closed yet cannot
    // be dismissed from here (only the embed watcher reads the close request),
    // so that drain times out and the relaunch proceeds with the last state
    // this entry stored; nothing captured is discarded either way.
    get().close();
    get().open(request.entry, request.sink);
  },

  close: () => {
    // A pending "waiting for `starting`" (see waitForLiveThenOpen) must not
    // outlive an explicit close: without this it could still pop the live
    // editor open, or report a timeout error, after the user closed it.
    // Still waiting for a live session: nothing offline was ever opened for it.
    const wasLiveWait = activeLiveWaitStop !== null;
    activeLiveWaitStop?.();
    // The window is going away: the session goes back to whoever else uses it (a node keeps it
    // alive; nobody -> the registry's grace period, then the host exits).
    releaseHold();
    if (liveEditor) {
      closeLiveEditor();
      set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null, mode: null });
      return;
    }
    const { pluginPath } = get();
    // Fire-and-forget: a backend that is down must not become an unhandled rejection here.
    if (pluginPath && !wasLiveWait) {
      void vstApi.editorRect(pluginPath, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true }).catch(() => {});
    }
    // The session's poll loop keeps running on purpose: the sidecar writes the
    // final raw_state when the native window actually closes, and that
    // commit-on-close capture must still reach the owning entry.
    set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null, mode: null });
  },
}));

// Leaving the tab that owns the embed closes it: the editor is a NATIVE OS
// window pinned over the web UI, so without this it would keep floating over
// whatever tab the user switched to.
useAppUiStore.subscribe((state, prevState) => {
  if (state.centerTab === prevState.centerTab) return;
  const s = useVstEditorStore.getState();
  if (s.entryId && s.ownerTab && state.centerTab !== s.ownerTab) s.close();
});

// FE-004: an operation on the IndexedDB plugin-state store failed — a
// captured raw_state that could not be saved (from the sidecar path's poll()
// below, or the live path's sinkLiveRawState above), a saved state that could
// not be loaded at startup, or a stored state that could not be deleted
// (effectChainStore). Previously a save rejection had no listener at all.
// Surfaced two ways: the status bar always gets a line, and the entry's own
// embed gets `error` set when it is the one currently open so VstEmbedHost
// shows it instead of leaving the user to guess why the dialed-in sound did
// not come back.
// The other half of the plugin-state story, installed for the same reason
// (effectChainStore cannot reach the live host without closing the rackEffects
// import cycle):
//
//  - `unreadable`: the saved state could not be read, so whatever the host is
//    running started from NOTHING and is at its factory defaults. The row says
//    so — the same LIVE · DEFAULTS badge a host-rejected state gets — instead
//    of the plugin quietly sounding wrong while its capture is refused every
//    5 s in silence (T18 third audit, MAJOR 2).
//  - `restored`: the state was read after the plugin had already started, so
//    it is SENT to the running session before the refusal latch comes off.
//    Without that the latch came off while the plugin was still at its
//    defaults, and its next capture wrote those over the row that had just
//    been read (T18 third audit, CRITICAL 1).
//
// What `restored` returning true does and does not mean (T18 fourth audit,
// MAJOR 2). It means the state was HANDED OVER — not that the plugin took it.
// The wire has no acknowledgement for `set_state`, and the client's send path
// reports no transport failure, so there is nothing here to check against.
// Asking the plugin for its state back and comparing is not an answer either:
// plugins re-serialize, so a byte comparison would report a mismatch on a
// perfectly restored plugin and refuse its captures for good. What actually
// protects the row when a plugin does NOT take the state is the host saying
// so: `sessionRegistry` records the rejection, and `sinkLiveRawState` above
// refuses to capture a plugin whose row says it is on its defaults until the
// user has moved something on it. A real round-trip belongs with a protocol
// change that adds the acknowledgement, not here.
setVstStateLoadListener({
  unreadable: (entryId, reason) => {
    markedUnreadable.add(entryId);
    useVstLiveStore.getState().setStateOrigin(entryId, 'state-rejected', reason);
    useStatusBarStore
      .getState()
      .setText(`VST GUI: a plugin is running at its factory defaults - ${reason}`);
  },
  restored: (entryId, rawState) => {
    const session = liveSessionLookup(entryId);
    if (!session) {
      markedUnreadable.delete(entryId);
      return true; // nothing is running: the next spawn gets the row
    }
    // Mark BEFORE the send: `sessionRegistry`'s rejection recorders gate on
    // `session.stateSent`, and the host's refusal (or its `ready`/`warning`)
    // can arrive as soon as `setState` is called. A late `restored()` never
    // touches `slot.entry`, so without this the recorders had no way to know
    // this plugin had just been handed a real blob, and a refusal of THIS
    // delivery went unrecorded (T18 sixth audit, CRITICAL 1).
    session.stateSent = true;
    session.client.setState(rawState);
    session.stateDirty = false;
    // Only OUR mark is cleared here. A rejection the HOST reported stands
    // until the host itself says otherwise — we have no way to know the
    // plugin took this state.
    if (markedUnreadable.delete(entryId)) useVstLiveStore.getState().setStateOrigin(entryId, 'live');
    return true;
  },
});

setVstStateStorageErrorHandler((entryId, error, op) => {
  const message = describeVstStateStorageError(error);
  const [line, banner] = STORAGE_FAILURE_WORDING[op];
  const what = entryId === '*' ? line.replace('plugin state', 'plugin states') : line;
  useStatusBarStore.getState().setText(`VST GUI: ${what} - ${message}`);
  if (useVstEditorStore.getState().entryId === entryId) {
    useVstEditorStore.setState({ error: `${banner}: ${message}` });
  }
});

/** Is this chain entry still in the project: the mix chain, a track's rack, or the master VST chain? */
function chainEntryExists(entryId: string): boolean {
  if (useEffectChainStore.getState().chain.some((e) => e.id === entryId)) return true;
  const ed = useEditorStore.getState();
  if (ed.masterVstChain.some((e) => e.id === entryId)) return true;
  if (ed.tracks.some((t) => t.instrument?.id === entryId || (t.fxChain ?? []).some((e) => e.id === entryId))) return true;
  return ownedEntry(entryId) !== null;
}

// A plugin leaves the project by many roads: its row's remove button (Edit or Mix), its track being
// deleted, an undo of the add, a project load. Only one of them knew to close the plugin's window —
// and the window HOLDS the live session, so every other road left a host process and a native
// window outliving the plugin they belong to. Watching the chains themselves covers every road.
const closeEditorOfRemovedEntry = (): void => {
  const s = useVstEditorStore.getState();
  if (s.entryId !== null && !chainEntryExists(s.entryId)) s.close();
};
useEffectChainStore.subscribe((state, prevState) => {
  if (state.chain !== prevState.chain) closeEditorOfRemovedEntry();
});
useEditorStore.subscribe((state, prevState) => {
  if (state.tracks === prevState.tracks && state.masterVstChain === prevState.masterVstChain) return;
  closeEditorOfRemovedEntry();
});

/** A registered owner's entries changed (a roll part lost its instrument, or the part went): close the window of one that is gone. */
export function vstEntryOwnersChanged(): void {
  closeEditorOfRemovedEntry();
}
