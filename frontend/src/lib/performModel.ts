// Shared derivation of the Perform grid's track + scene model, so the grid
// (DawSessionGrid) and the routing panel (PerformRoutingPanel) index scenes and
// tracks identically. Both consume the same DawProject; keeping this in one place
// means a scene number the user assigns in the panel always maps to the same row
// the grid launches.
import type { DawDevice, DawProject, DawTrack } from './dawImportClient';
import type { ChainEntry } from '../state/effectChainStore';
import type { Vst3PluginInfo } from './vstClient';
import { dawDeviceToChainEntry } from './dawEffectMap';
import { getRackEffect } from './rackEffects';

/**
 * The live FX chain of the grid column at `mixIndex`: the track's devices minus
 * its instruments and rack containers, each as a chain entry with the id
 * `perform-<mixIndex>-<i>`. The id is the session registry's key, so one plugin
 * host survives chain rebuilds, and it is what the controller routes and the
 * rail's PARAMS tab address.
 */
export const performChainEntries = (track: DawTrack, mixIndex: number): ChainEntry[] =>
  (track.devices ?? [])
    .filter((d) => !d.is_instrument && !d.is_rack)
    .map((d, i) => dawDeviceToChainEntry(d, `perform-${mixIndex}-${i}`));

/* --- Slots: what a column's chain holds, and what can be put in it ----------
   Every column takes every rack effect and every scanned VST3 plugin. A picked
   effect becomes one more device at the END of the track's own device list, so
   the chain entry ids before it (`perform-<mixIndex>-<i>`) and every controller
   route that addresses them stay where they were, and a save writes it with
   the rest of the track's inserts. */

/** A rack effect as a track device. The device is NAMED by the rack id: that
 *  name is what `resolveLiveEffectId` reads, and an id always resolves to
 *  itself where a display label may match another effect or none. */
export const performRackDevice = (effectId: string): DawDevice => ({
  name: effectId,
  plugin_type: 'builtin',
  parameters: {},
  bypass: false,
});

/** A scanned VST3 plugin as a track device the live host can open. */
export const performVstDevice = (plugin: Pick<Vst3PluginInfo, 'name' | 'path' | 'display_name'>): DawDevice => ({
  name: plugin.display_name || plugin.name,
  plugin_type: 'vst3',
  plugin_path: plugin.path,
  parameters: {},
  bypass: false,
});

/** Put `device` at the end of the track's chain. Returns its chain index, the
 *  `<i>` of its `perform-<mixIndex>-<i>` entry id. */
export function addPerformDevice(track: DawTrack, device: DawDevice): number {
  if (!track.devices) track.devices = [];
  track.devices.push(device);
  return track.devices.filter((d) => !d.is_instrument && !d.is_rack).length - 1;
}

/** One slot of a column's chain, as the rail lists it. */
export interface PerformSlot {
  /** Index into the chain: the `<i>` of the entry id. */
  deviceIndex: number;
  /** The device behind the slot (the track's own object, so a bypass set on
   *  it is the one the chain and a save both read). */
  device: DawDevice;
  entry: ChainEntry;
  /** What the user reads: a rack effect's label, else the device's own name. */
  name: string;
  /** `fx` a rack effect, `vst` a hosted plugin, `inert` a device from another
   *  DAW that maps to neither and passes audio through. */
  kind: 'fx' | 'vst' | 'inert';
}

export const performSlots = (track: DawTrack, mixIndex: number): PerformSlot[] =>
  (track.devices ?? [])
    .filter((d) => !d.is_instrument && !d.is_rack)
    .map((device, deviceIndex) => {
      const entry = dawDeviceToChainEntry(device, `perform-${mixIndex}-${deviceIndex}`);
      const def = getRackEffect(entry.effect);
      const kind = entry.vst ? 'vst' : def ? 'fx' : 'inert';
      // A device named by a rack id (one picked here) reads as the effect's
      // label; an imported device keeps the name its own project gave it.
      const name = getRackEffect(device.name)?.label ?? (device.name || def?.label || entry.effect);
      return { deviceIndex, device, entry, name, kind };
    });

/** One parameter a controller route can drive on a column's chain. */
export interface PerformFxParamOption {
  deviceIndex: number;
  deviceLabel: string;
  effect: string;
  /** A rack parameter's key, or `p<index>` for a hosted plugin's parameter. */
  paramKey: string;
  /** The words the picker shows for the parameter. */
  paramLabel: string;
  min: number;
  max: number;
}

/** The part of a running plugin's parameter list a route needs. */
export interface PerformVstParam {
  index: number;
  name: string;
  hidden?: boolean;
  readOnly?: boolean;
}

/**
 * Every routable parameter of a column's chain: each rack effect's descriptors
 * with their own ranges, and each hosted plugin's parameters as its running
 * host lists them (`vstParams`, keyed by chain entry id), as `p<index>` over
 * 0..1 — the form the grid's controller branch sends to a live plugin.
 */
export function performFxParamOptions(
  track: DawTrack,
  mixIndex: number,
  vstParams: Readonly<Record<string, readonly PerformVstParam[] | undefined>> = {},
): PerformFxParamOption[] {
  const out: PerformFxParamOption[] = [];
  for (const slot of performSlots(track, mixIndex)) {
    if (slot.kind === 'vst') {
      for (const p of vstParams[slot.entry.id] ?? []) {
        if (p.hidden || p.readOnly) continue;
        out.push({
          deviceIndex: slot.deviceIndex,
          deviceLabel: slot.name,
          effect: slot.entry.effect,
          paramKey: `p${p.index}`,
          paramLabel: p.name || `p${p.index}`,
          min: 0,
          max: 1,
        });
      }
      continue;
    }
    const def = getRackEffect(slot.entry.effect);
    if (!def) continue;
    for (const p of def.params) {
      out.push({
        deviceIndex: slot.deviceIndex,
        deviceLabel: slot.name,
        effect: slot.entry.effect,
        paramKey: p.key,
        paramLabel: p.key,
        min: p.min,
        max: p.max,
      });
    }
  }
  return out;
}

/** Audio + MIDI tracks in project order (the columns the grid + mixer render). */
export const performTracks = (project: DawProject): DawTrack[] =>
  project.tracks.filter((track) => track.type === 'audio' || track.type === 'midi');

/** Number of scene rows: the greater of named scenes and the highest clip slot. */
export const performSceneCount = (project: DawProject): number => {
  const tracks = performTracks(project);
  const maxClipScene = tracks.reduce((max, track) => {
    return Math.max(
      max,
      ...track.clips.map((clip) => clip.scene_index ?? clip.slot_index ?? -1),
    );
  }, -1);
  return Math.max(project.scenes.length, maxClipScene + 1);
};

/** Scene display names, one per row, filled with "Scene N" where unnamed. */
export const performScenes = (project: DawProject): string[] => {
  const count = performSceneCount(project);
  // || not ??: Ableton's parser emits an EMPTY STRING for an unnamed scene
  // (ableton.py _parse_scenes uses .get("Value", "")), and ?? only substitutes
  // for null/undefined — so the fallback was unreachable for every Live set and
  // rows rendered as "01 " with a trailing space.
  return Array.from({ length: count }, (_, index) => project.scenes[index] || `Scene ${index + 1}`);
};

/* --- A hosted plugin's captured state --------------------------------------
   A plugin's window (or its live host) hands back an opaque state: the sound
   dialled in. It is kept on the slot's own device, which is what the chain is
   rebuilt from and what a save writes. */

/** The slot behind chain entry id `perform-<mixIndex>-<i>`, when the project has it. */
export function performSlotOfEntry(project: DawProject | null | undefined, entryId: string): PerformSlot | undefined {
  const m = /^perform-(\d+)-(\d+)$/.exec(entryId);
  if (!m || !project) return undefined;
  const mixIndex = Number(m[1]);
  const track = performTracks(project)[mixIndex];
  return track ? performSlots(track, mixIndex)[Number(m[2])] : undefined;
}

/** Keep a captured plugin state on the slot's device. False when the entry is
 *  no hosted plugin of this project, or there is nothing to keep. */
export function storePerformVstState(
  project: DawProject | null | undefined,
  entryId: string,
  rawState: string,
  stateHost: 'thedaw' | 'pedalboard',
): boolean {
  const slot = performSlotOfEntry(project, entryId);
  if (!slot || slot.kind !== 'vst' || !rawState) return false;
  slot.device.raw_state = rawState;
  slot.device.state_host = stateHost;
  return true;
}
