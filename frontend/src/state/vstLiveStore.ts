/**
 * vstLiveStore — the live state of every hosted `vst3` chain entry.
 *
 * One record per `ChainEntry.id`: what its native host session is doing, what
 * the plugin reported, and how much latency the live path therefore has. Two
 * very different consumers read it:
 *
 *  - The FX row (components/audio/FxRack) shows the status badge, the latency
 *    in ms, the xrun counter and the retry control.
 *  - Plugin-delay compensation reads `vstLiveLatencySec` through
 *    `chainLatencyReport`, so the mixer's alignment follows `ready` and
 *    `latency` events without anyone polling the audio graph.
 *
 * THE RULE THAT MATTERS: latency is 0 in every state but `live`. A number
 * reported while the worklet is still passing dry signal through would move
 * every other track in the project to compensate for a plugin that is not in
 * the path. The samples are remembered across a drop (a reconnect onto the same
 * plugin should not have to re-learn them) but they are not DECLARED until the
 * session says it is live again.
 *
 * Deliberately dependency-free apart from zustand: `lib/rackEffects.ts` reads
 * this module, and rackEffects is what `state/effectChainStore.ts` builds on,
 * so importing either from here would close an import cycle.
 *
 * Units: `*Samples` are sample frames at `sampleRate`; the `*Sec` helpers are
 * seconds. Nothing here is in milliseconds — the UI does that conversion.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/** What a `vst3` entry's live session is doing. */
export type VstLiveStatus =
  /** No session: the entry is bypassed, new, or the host was never asked. */
  | 'off'
  /** A session is opening (spawn + `hello`/`ready` round trip). */
  | 'starting'
  /** The worklet is in the path and the plugin is processing. */
  | 'live'
  /** The session failed or the socket dropped; the node passes dry signal. */
  | 'error'
  /** No host binary on this machine — render-only, with the reason. */
  | 'unavailable';

/**
 * Whether the running plugin actually holds the settings the entry has saved
 * for it.
 *
 *  - `live`      — it does. Either the entry had no saved state (so the
 *                  plugin's defaults ARE its state), or the saved state came
 *                  from THIS host and was restored at spawn.
 *  - `state-rejected` — the entry HAD a saved state, it was sent, and the HOST
 *                  said it could not restore it (`state_compat: false`, a
 *                  `ready` warning about the state, or a `warning`/`error`
 *                  after `set_state`). The plugin is therefore running at its
 *                  DEFAULTS. This is the ONLY way a plugin ends up off its
 *                  saved settings: a pedalboard-written blob restores here
 *                  exactly like one of ours — the two encodings are the same
 *                  container, and the bit-order bug that made them look
 *                  incompatible is fixed and verified. Never silently
 *                  resolved: the row says so, with the host's own reason, and
 *                  capturing a live state flips it back to `live`.
 */
export type VstStateOrigin = 'live' | 'state-rejected';

/** The plugin's own identity, as the host reports it in `ready`. */
export interface VstLivePlugin {
  name: string;
  vendor: string;
  version: string;
  category: string;
  identifier: string;
  format: string;
}

/** Everything known about one entry's session. */
export interface VstLiveEntryState {
  status: VstLiveStatus;
  /** Why it is not live. Present only for `error` / `unavailable`. */
  reason?: string;
  /** The plugin's own reported latency, in sample frames. */
  pluginLatencySamples: number;
  /** The worklet bridge's fixed cost: `blockSize * (bufferBlocks + 1)`. */
  bridgeLatencySamples: number;
  /** Context sample rate the two figures above are expressed in. */
  sampleRate: number;
  /** Quanta the jitter buffer had to silence, since the session opened. */
  xruns: number;
  plugin?: VstLivePlugin;
  /** The plugin has an editor view to open. */
  hasEditor: boolean;
  /** The mixer could not compensate this much latency (it exceeds the comp
   *  delay ceiling), so the alignment is approximate. Set by liveMixer. */
  clamped: boolean;
  /** The plugin's editor window is open on this session. */
  editorOpen: boolean;
  /** The open editor's size in physical px, as the host last reported it; null
   *  while the editor is closed or before the host has said. */
  editorSize: { w: number; h: number } | null;
  /** The box the app asked the host to open the editor in, physical px, until
   *  the host's acknowledgement of that request has been seen. See
   *  `setEditorOpen`. */
  editorRequest: { w: number; h: number } | null;
  /** Whether the plugin holds the entry's saved settings, or started at its
   *  defaults because the host could not restore them. */
  stateOrigin: VstStateOrigin;
  /** Why the host could not restore the saved state, in its own words. Present
   *  only while `stateOrigin` is `state-rejected`. */
  stateReason?: string;
}

/** What the backend says about the host binary (`GET /api/vst/live/host`). */
export interface VstLiveHostState {
  /** `null` = not probed yet. UNKNOWN IS NOT "NO": a node opened before the
   *  probe answers proceeds optimistically and falls back if it was wrong. */
  available: boolean | null;
  reason?: string;
  path?: string;
  version?: string;
}

const EMPTY: VstLiveEntryState = {
  status: 'off',
  pluginLatencySamples: 0,
  bridgeLatencySamples: 0,
  sampleRate: 0,
  xruns: 0,
  hasEditor: false,
  clamped: false,
  editorOpen: false,
  editorSize: null,
  editorRequest: null,
  // Nothing saved, nothing to mismatch: defaults are this entry's state.
  stateOrigin: 'live',
};

export interface VstLiveReady {
  plugin: VstLivePlugin;
  pluginLatencySamples: number;
  bridgeLatencySamples: number;
  sampleRate: number;
  hasEditor: boolean;
}

interface VstLiveState {
  entries: Record<string, VstLiveEntryState>;
  host: VstLiveHostState;
  setHost: (host: VstLiveHostState) => void;
  /** Move an entry to `status`. `reason` is cleared for the healthy states, so
   *  a row that recovers never shows the failure it recovered from. */
  setStatus: (entryId: string, status: VstLiveStatus, reason?: string) => void;
  setReady: (entryId: string, ready: VstLiveReady) => void;
  /** The plugin reported a new latency (`restartComponent(kLatencyChanged)`). */
  setLatency: (entryId: string, pluginLatencySamples: number) => void;
  addXruns: (entryId: string, count: number) => void;
  /** The host's word on the editor window: open or closed, and the size the
   *  plugin's view has now. A closed editor has no size. */
  setEditorOpen: (entryId: string, open: boolean, size?: { w: number; h: number }) => void;
  /** Note the box an `open_editor` request asks for (null for a floating
   *  editor). A new request forgets the size of the editor before it. */
  setEditorRequest: (entryId: string, request: { w: number; h: number } | null) => void;
  /** Record whether the running plugin holds the entry's saved settings. Set by
   *  the session registry when it spawns (from the state's origin) and cleared
   *  back to `live` by the capture path once a live state lands on the entry. */
  setStateOrigin: (entryId: string, origin: VstStateOrigin, reason?: string) => void;
  setClamped: (entryId: string, clamped: boolean) => void;
  clearEntry: (entryId: string) => void;
  /** Forget every session (project close). The host probe result is kept —
   *  whether the binary exists is a fact about the machine, not the project. */
  clearAll: () => void;
}

const nonNegative = (v: number, field: string): number => {
  if (!Number.isFinite(v) || v < 0) {
    throw new RangeError(`vstLiveStore: ${field} must be a finite number >= 0, got ${v}`);
  }
  return v;
};

/** Merge a patch onto one entry, seeding from `EMPTY` when it is new. */
const patch = (
  entries: Record<string, VstLiveEntryState>,
  entryId: string,
  next: Partial<VstLiveEntryState>,
): Record<string, VstLiveEntryState> => ({
  ...entries,
  [entryId]: { ...(entries[entryId] ?? EMPTY), ...next },
});

// `subscribeWithSelector` is what lets a consumer (vstLiveNode) subscribe to
// one entry's status instead of waking up for every entry in the store.
export const useVstLiveStore = create<VstLiveState>()(
  subscribeWithSelector((set) => ({
    entries: {},
    host: { available: null },

    setHost: (host) => set({ host: { ...host, reason: host.available ? undefined : host.reason } }),

    setStatus: (entryId, status, reason) =>
      set((s) => ({
        entries: patch(s.entries, entryId, {
          status,
          reason: status === 'error' || status === 'unavailable' ? reason : undefined,
        }),
      })),

    setReady: (entryId, ready) =>
      set((s) => ({
        entries: patch(s.entries, entryId, {
          status: 'live',
          reason: undefined,
          plugin: ready.plugin,
          pluginLatencySamples: nonNegative(ready.pluginLatencySamples, 'pluginLatencySamples'),
          bridgeLatencySamples: nonNegative(ready.bridgeLatencySamples, 'bridgeLatencySamples'),
          sampleRate: nonNegative(ready.sampleRate, 'sampleRate'),
          hasEditor: ready.hasEditor,
        }),
      })),

    setLatency: (entryId, pluginLatencySamples) =>
      set((s) => ({
        entries: patch(s.entries, entryId, {
          pluginLatencySamples: nonNegative(pluginLatencySamples, 'pluginLatencySamples'),
        }),
      })),

    addXruns: (entryId, count) =>
      set((s) => ({
        entries: patch(s.entries, entryId, {
          xruns: (s.entries[entryId]?.xruns ?? 0) + nonNegative(count, 'xruns'),
        }),
      })),

    // The host reports the editor twice when it opens: first the size the
    // plugin's view really has, then an acknowledgement of `open_editor` that
    // repeats the box the app asked for. Taken as a size, that second message
    // put the requested box back over the real one, and the window showed the
    // plugin cut to the opening box. So the first report that equals the
    // pending request is the acknowledgement: it is consumed and sizes nothing.
    setEditorOpen: (entryId, open, size) =>
      set((s) => {
        const cur = s.entries[entryId];
        const prev = cur?.editorSize ?? null;
        const request = cur?.editorRequest ?? null;
        if (!open) return { entries: patch(s.entries, entryId, { editorOpen: false, editorSize: null, editorRequest: null }) };
        if (!size || size.w <= 0 || size.h <= 0) return { entries: patch(s.entries, entryId, { editorOpen: true }) };
        if (request && size.w === request.w && size.h === request.h) {
          return { entries: patch(s.entries, entryId, { editorOpen: true, editorRequest: null }) };
        }
        const editorSize = prev && prev.w === size.w && prev.h === size.h ? prev : { w: size.w, h: size.h };
        return { entries: patch(s.entries, entryId, { editorOpen: true, editorSize }) };
      }),

    setEditorRequest: (entryId, request) =>
      set((s) => ({ entries: patch(s.entries, entryId, { editorRequest: request, editorSize: null }) })),

    setStateOrigin: (entryId, origin, reason) =>
      set((s) => ({
        // A reason only ever belongs to a rejection: going back to `live` drops
        // it, so a stale explanation can never outlive the gap it explained.
        entries: patch(s.entries, entryId, {
          stateOrigin: origin,
          stateReason: origin === 'state-rejected' ? reason : undefined,
        }),
      })),

    setClamped: (entryId, clamped) => set((s) => ({ entries: patch(s.entries, entryId, { clamped }) })),

    clearEntry: (entryId) =>
      set((s) => {
        if (!(entryId in s.entries)) return s;
        const next = { ...s.entries };
        delete next[entryId];
        return { entries: next };
      }),

    clearAll: () => set({ entries: {} }),
  })),
);

/** One entry's record, or the neutral `off` record for an id with no session. */
export function vstLiveStatusOf(entryId: string): VstLiveEntryState {
  return useVstLiveStore.getState().entries[entryId] ?? EMPTY;
}

/** Sample frames this entry adds to the LIVE path — plugin plus bridge, and 0
 *  whenever it is not live. Pure over a record, so PDC can be tested. */
export function entryLatencySamples(e: VstLiveEntryState | undefined): number {
  if (!e || e.status !== 'live') return 0;
  return e.pluginLatencySamples + e.bridgeLatencySamples;
}

/** The same figure in seconds; 0 when the sample rate is not known yet. */
export function entryLatencySec(e: VstLiveEntryState | undefined): number {
  const samples = entryLatencySamples(e);
  if (samples === 0 || !e || e.sampleRate <= 0) return 0;
  return samples / e.sampleRate;
}

/**
 * Seconds of latency the live VST session on `entryId` adds — the default seam
 * `chainLatencyReport` uses for `vst3` entries. 0 for every entry that is not
 * live, which is what keeps an inert plugin out of the mixer's alignment.
 */
export function vstLiveLatencySec(entryId: string): number {
  return entryLatencySec(useVstLiveStore.getState().entries[entryId]);
}
