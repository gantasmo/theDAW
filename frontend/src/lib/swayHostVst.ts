/**
 * swayHostVst: the live VST3 half of the object theDAW hands the SWAY cockpit
 * (`theDAWHost.vst`, put on the cockpit's window with the rest of
 * lib/swayHostFx.ts, and announced by the `vst-live` cap).
 *
 * The cockpit owns its AudioContext and its track graph; a VST3 plugin runs in
 * theDAW's native host process. The cockpit hands over one row of a track's
 * VST3 chain ({ id, path, name, rawState, stateHost }) and gets back a node on
 * ITS context, built by the same factory EDIT uses (vstLive/vstLiveNode):
 * audio passes through until the plugin runs, then goes through the plugin.
 *
 *   - The row id is the plugin's identity. The chain entry is `sway-<rowId>`,
 *     so every rebuild of the cockpit's graph (a reorder, a project save) finds
 *     the same running plugin, and a plugin's window, its captured state and
 *     its latency all name the same row.
 *   - One state format: the row's `rawState` (base64, the whole plugin) plus
 *     `stateHost`. The plugin is spawned with it; whatever the host captures
 *     later (the plugin's window, a save, theDAW closing) comes back through
 *     the row's sink as `state(rawState, 'thedaw')`, through the editor
 *     store's owner registry (registerVstEntryOwner), like a piano-roll part.
 *   - The cockpit's transport reaches every one of its plugins through
 *     `transport(info)`: each entry is put on a transport of its own
 *     (setVstEntryTransport), so EDIT's play, stop and seek never reach it.
 *   - Each running row is held under SWAY_HOLDER, which EDIT's teardown spares:
 *     closing EDIT's project does not stop what the cockpit is playing.
 *
 * The node reports its latency (bridge plus plugin, 0 until live) so the
 * cockpit can delay the dry branch and line its tracks up.
 */
import { createVstLiveNode, setVstEntryTransport, VST_NODE_PARK_MS, type VstTransportInfo } from './vstLive/vstLiveNode';
import { vstSessions, VST_LIVE_GRACE_MS, type VstSessionRegistry } from './vstLive/sessionRegistry';
import { SWAY_HOLDER } from './vstLive/projectSessions';
import { useVstLiveStore, entryLatencySec } from '../state/vstLiveStore';
import { useVstParamStore, vstParamKey } from '../state/vstParamStore';
import { registerVstEntryOwner, useVstEditorStore, captureLiveVstStates } from '../state/vstEditorStore';
import type { ChainEntry, VstStateHost } from '../state/effectChainStore';

/** Every cockpit plugin's chain entry id starts with this. */
export const SWAY_VST_ENTRY_PREFIX = 'sway-';

/** One row of a cockpit track's VST3 chain, as the cockpit stores it. */
export interface SwayHostVstRow {
  id: string;
  path: string;
  name?: string;
  rawState?: string | null;
  stateHost?: string | null;
}

/** What the cockpit hears back about one row. */
export interface SwayHostVstSink {
  /** The host captured the plugin's state (its window, a save, a shutdown). */
  state?: (rawState: string, stateHost: VstStateHost) => void;
  /** The status, the latency or the parameter list changed. */
  change?: () => void;
}

export interface SwayHostVstStatus {
  state: 'idle' | 'starting' | 'live' | 'error' | 'unavailable';
  detail: string | null;
  /** Seconds the live path adds (bridge plus plugin); 0 unless live. */
  latency: number;
}

/** One of the running plugin's own parameters; `value` is normalized 0..1. */
export interface SwayHostVstParam {
  index: number;
  name: string;
  value: number;
  text: string;
  steps: number;
  hidden: boolean;
  readOnly: boolean;
}

export interface SwayHostVstNode {
  input: AudioNode;
  output: AudioNode;
  status: () => SwayHostVstStatus;
  params: () => SwayHostVstParam[];
  setParam: (index: number, value: number) => void;
  openWindow: () => void;
  dispose: () => void;
}

export interface SwayHostVstApi {
  available: () => boolean;
  build: (ctx: BaseAudioContext, row: SwayHostVstRow, sink?: SwayHostVstSink) => SwayHostVstNode | null;
  transport: (info: VstTransportInfo) => void;
  capture: () => Promise<void>;
  forget: (rowId: string) => void;
}

interface RowRecord {
  entry: ChainEntry;
  sink: SwayHostVstSink;
  /** Live nodes the cockpit holds for this row. */
  nodes: number;
}

/** What this module reaches the plugin host through; tests swap it. */
interface SwayVstDeps {
  createNode: typeof createVstLiveNode;
  registry: Pick<VstSessionRegistry, 'hold' | 'unhold' | 'forget' | 'get' | 'markUserParamsChanged'>;
}
const DEFAULT_DEPS: SwayVstDeps = { createNode: createVstLiveNode, registry: vstSessions };
let deps: SwayVstDeps = DEFAULT_DEPS;

/** Test seam: the node factory and the session registry; `null` restores both. */
export function __setSwayVstDepsForTest(next: Partial<SwayVstDeps> | null): void {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
}

const records = new Map<string, RowRecord>();
/** The cockpit's transport as last told, for a row that starts later. */
let cockpitTransport: VstTransportInfo | null = null;

/**
 * How long a row with no node is remembered: past the node's park and the
 * registry's grace, so a rebuild or a reloaded cockpit frame finds the same
 * entry (and the same running plugin). A row nobody built again by then left
 * the project; it is forgotten, and its window closes.
 */
const SWEEP_MS = VST_NODE_PARK_MS + VST_LIVE_GRACE_MS + 1000;
const sweeps = new Map<string, ReturnType<typeof setTimeout>>();

function cancelSweep(entryId: string): void {
  const t = sweeps.get(entryId);
  if (t === undefined) return;
  clearTimeout(t);
  sweeps.delete(entryId);
}

function scheduleSweep(entryId: string): void {
  cancelSweep(entryId);
  sweeps.set(
    entryId,
    setTimeout(() => {
      sweeps.delete(entryId);
      const rec = records.get(entryId);
      if (!rec || rec.nodes > 0) return;
      if (useVstEditorStore.getState().entryId === entryId) useVstEditorStore.getState().close();
      records.delete(entryId);
      setVstEntryTransport(entryId, null);
    }, SWEEP_MS),
  );
}

export const swayVstEntryId = (rowId: string): string => SWAY_VST_ENTRY_PREFIX + rowId;

const stateHostOf = (v: unknown): VstStateHost | undefined => (v === 'thedaw' || v === 'pedalboard' ? v : undefined);

const validRow = (row: unknown): row is SwayHostVstRow => {
  const r = row as SwayHostVstRow | null;
  return !!r && typeof r.id === 'string' && r.id.length > 0 && typeof r.path === 'string' && r.path.length > 0;
};

/**
 * The chain entry for `row`. The same row seen again (a rebuild) keeps the
 * entry it had, with the newest state either side holds: the parameters moved
 * live are on the entry, a captured state is on both.
 */
function entryFor(row: SwayHostVstRow, prev: ChainEntry | undefined): ChainEntry {
  const name = typeof row.name === 'string' ? row.name : '';
  const rawState = typeof row.rawState === 'string' && row.rawState ? row.rawState : undefined;
  if (prev?.vst && prev.vst.plugin_path === row.path) {
    return {
      ...prev,
      label: name || prev.label,
      vst: {
        ...prev.vst,
        plugin_name: name || prev.vst.plugin_name,
        raw_state: rawState ?? prev.vst.raw_state,
        state_host: rawState ? stateHostOf(row.stateHost) ?? prev.vst.state_host : prev.vst.state_host,
      },
    };
  }
  return {
    id: swayVstEntryId(row.id),
    effect: 'vst3',
    params: {},
    enabled: true,
    label: name || undefined,
    vst: { plugin_path: row.path, plugin_name: name, raw_state: rawState, state_host: stateHostOf(row.stateHost) },
  };
}

function statusOf(entryId: string): SwayHostVstStatus {
  const e = useVstLiveStore.getState().entries[entryId];
  if (!e || e.status === 'off') return { state: 'idle', detail: null, latency: 0 };
  return {
    state: e.status,
    detail: e.status === 'error' || e.status === 'unavailable' ? e.reason ?? null : e.stateOrigin === 'state-rejected' ? e.stateReason ?? null : null,
    latency: entryLatencySec(e),
  };
}

function paramsOf(entryId: string): SwayHostVstParam[] {
  const list = useVstParamStore.getState().lists[entryId] ?? [];
  return list.map((p) => ({
    index: p.index,
    name: p.name,
    value: p.value,
    text: p.text,
    steps: p.steps,
    hidden: p.hidden,
    readOnly: p.readOnly,
  }));
}

const tell = (rec: RowRecord | undefined, what: 'change'): void => {
  try {
    rec?.sink[what]?.();
  } catch {
    /* the cockpit's frame is gone; nothing to tell */
  }
};

// Where the editor store writes a state the live host captured for a cockpit
// plugin, and how it knows such a plugin still exists.
export const swayVstOwner = {
  find: (entryId: string): ChainEntry | undefined => records.get(entryId)?.entry,
  setRawState: (entryId: string, rawState: string, stateHost: VstStateHost): void => {
    const rec = records.get(entryId);
    if (!rec?.entry.vst) return;
    rec.entry = { ...rec.entry, vst: { ...rec.entry.vst, raw_state: rawState, state_host: stateHost } };
    try {
      rec.sink.state?.(rawState, stateHost);
    } catch {
      /* the cockpit's frame is gone; the entry keeps the state */
    }
  },
};
registerVstEntryOwner(swayVstOwner);

function build(ctx: BaseAudioContext, row: SwayHostVstRow, sink: SwayHostVstSink = {}): SwayHostVstNode | null {
  if (!validRow(row)) return null;
  const entryId = swayVstEntryId(row.id);
  cancelSweep(entryId);
  const prev = records.get(entryId);
  const rec: RowRecord = { entry: entryFor(row, prev?.entry), sink, nodes: prev?.nodes ?? 0 };
  records.set(entryId, rec);

  // The cockpit's clock, never EDIT's: set before the node exists, so the
  // first transport a plugin hears is the cockpit's.
  setVstEntryTransport(entryId, cockpitTransport ?? { playing: false, positionSamples: 0, tempoBpm: 0, discontinuity: true });
  const inst = deps.createNode(ctx, rec.entry);
  if (!inst) {
    if (rec.nodes === 0) scheduleSweep(entryId);
    return null;
  }
  rec.nodes++;
  if (rec.nodes === 1) void deps.registry.hold(rec.entry, ctx.sampleRate, SWAY_HOLDER).catch(() => {});

  // Status, latency and the parameter list, as the cockpit draws them. The
  // plugin is asked for its parameters once per go-live.
  let lastSig = '';
  let lastLength = -1;
  const notify = (): void => {
    const st = statusOf(entryId);
    const sig = `${st.state}|${st.detail ?? ''}|${st.latency.toFixed(6)}`;
    // A value moving replaces the list object too; only a new or resized list is news.
    const length = useVstParamStore.getState().lists[entryId]?.length ?? -1;
    if (sig === lastSig && length === lastLength) return;
    const wentLive = st.state === 'live' && !lastSig.startsWith('live|');
    lastSig = sig;
    lastLength = length;
    if (wentLive) {
      try {
        deps.registry.get(entryId)?.client.getParams();
      } catch {
        /* a dead socket; the next go-live asks again */
      }
    }
    tell(records.get(entryId), 'change');
  };
  const unsubLive = useVstLiveStore.subscribe(
    (s) => s.entries[entryId],
    () => notify(),
  );
  const unsubParams = useVstParamStore.subscribe((s, before) => {
    if (s.lists[entryId] !== before.lists[entryId]) notify();
  });
  notify();

  let disposed = false;
  return {
    input: inst.input,
    output: inst.output,
    status: () => statusOf(entryId),
    params: () => paramsOf(entryId),
    setParam: (index, value) => {
      if (disposed || !Number.isInteger(index) || index < 0 || !Number.isFinite(value)) return;
      const v = Math.max(0, Math.min(1, value));
      const cur = records.get(entryId);
      if (cur) cur.entry = { ...cur.entry, params: { ...cur.entry.params, [vstParamKey(index)]: v } };
      inst.setParams({ [vstParamKey(index)]: v });
      // A move the user made: the capture that follows is their sound.
      deps.registry.markUserParamsChanged(entryId);
      useVstParamStore.getState().setValue(entryId, index, v);
    },
    openWindow: () => {
      const cur = records.get(entryId);
      if (disposed || !cur) return;
      // The live host's window when the plugin runs (or is starting); the
      // offline copy's only on a machine without the host, whose state then
      // comes back from pedalboard.
      useVstEditorStore.getState().open(cur.entry, (id, rawState) => {
        const owner = records.get(id);
        if (!owner?.entry.vst) return;
        owner.entry = { ...owner.entry, vst: { ...owner.entry.vst, raw_state: rawState, state_host: 'pedalboard' } };
        try {
          owner.sink.state?.(rawState, 'pedalboard');
        } catch {
          /* the cockpit's frame is gone; the entry keeps the state */
        }
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubLive();
      unsubParams();
      inst.dispose();
      const cur = records.get(entryId);
      if (!cur) return;
      cur.nodes = Math.max(0, cur.nodes - 1);
      // The node's own park and grace timers decide when the plugin stops; the
      // hold only kept EDIT's teardown off it.
      if (cur.nodes === 0) {
        deps.registry.unhold(entryId, SWAY_HOLDER);
        scheduleSweep(entryId);
      }
    },
  };
}

function transport(info: VstTransportInfo): void {
  if (!info || typeof info !== 'object') return;
  cockpitTransport = {
    playing: !!info.playing,
    positionSamples: Number.isFinite(info.positionSamples) ? Math.max(0, Math.round(info.positionSamples)) : 0,
    tempoBpm: Number.isFinite(info.tempoBpm) && info.tempoBpm > 0 ? info.tempoBpm : 0,
    discontinuity: !!info.discontinuity,
    ...(Number.isFinite(info.atTime) ? { atTime: info.atTime } : {}),
    ...(Number.isFinite(info.atSec) ? { atSec: info.atSec } : {}),
  };
  for (const entryId of records.keys()) setVstEntryTransport(entryId, cockpitTransport);
}

/** Ask every running plugin for its state now (before the cockpit saves). */
async function capture(): Promise<void> {
  // The editor store's pass asks every live session whose state is behind
  // (moved since its last capture, or with its window open), and routes each
  // answer to its owner: a cockpit row's comes back through its sink.
  await captureLiveVstStates();
}

/** The row left the cockpit's project: stop its plugin and forget it. */
function forget(rowId: string): void {
  if (typeof rowId !== 'string' || !rowId) return;
  const entryId = swayVstEntryId(rowId);
  if (!records.has(entryId)) return;
  cancelSweep(entryId);
  if (useVstEditorStore.getState().entryId === entryId) useVstEditorStore.getState().close();
  records.delete(entryId);
  setVstEntryTransport(entryId, null);
  deps.registry.forget(entryId);
}

/** The cockpit's frame went away: every one of its plugins is let go. */
export function releaseSwayVst(): void {
  for (const entryId of [...records.keys()]) forget(entryId.slice(SWAY_VST_ENTRY_PREFIX.length));
  cockpitTransport = null;
}

export const swayHostVstApi: SwayHostVstApi = {
  available: () => useVstLiveStore.getState().host.available !== false,
  build,
  transport,
  capture,
  forget,
};
