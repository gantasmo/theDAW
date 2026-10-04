// Typed client for the .tasmo project backend (/api/project/*).
import { getJson, postJson, postForm } from './apiJson';
import type { DawProject } from './dawImportClient';
import { dawDeviceToEffectNode } from './dawEffectMap';
import type { SwayBinding, SwayUnattached } from './swayImportResolve';
import type { PerformRoutingSnapshot } from '../state/performRouting';
import type { AudioClip } from '../state/editorStore';
import { DEFAULT_LANES, clampLaneSpan, sanitizeLanes, type NoteExpression, type NoteExpressionPoint, type PianoNote } from '../state/pianoRollStore';
import { normalizeMeterMap, roundUpToBar, sanitizeMeter, sanitizeTuplet, type MeterSegment, type PolyLane } from './meterMap';
import { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { sanitizeBends, type BendShape } from './pitchBend';
import { cleanRollPartRef, playedRollNotes } from './rollClip';
import { rollMarkerToTasmo, tasmoToRollMarkers, type TasmoRollMarker } from './rollMarkers';
import type { RollPartRef } from '../state/pianoRollStore';
import { copyTempoMap, hasTempoChanges, sanitizeRollTempoMap } from './rollTempo';
import type { TempoEvent } from './tempoMap';
import { noteEndStep } from './clipNotes/units';
import { isArticulation } from './articulationMap';
import { sanitizeNoteExpression } from './noteExpression';

// --- Piano-roll meter (mirrors lib/meterMap in the .tasmo JSON shape) ---
/** A time-signature change: the meter from `bar` until the next change. */
export interface TasmoMeterSegment {
  bar: number;
  meter: { num: number; den: number; groups: number[] };
}

/**
 * A polymeter lane; `cycle_steps` null means the lane spans the whole clip.
 * `span_start` / `span_end` (steps; `span_end` null = the clip's end) limit a
 * looping lane to part of the clip, and are written only when it has a span.
 * `meter_map` and `tuplet` only when the lane keeps a time of its own (its
 * meter from its bar 1, and n of its notes in the time of m of the roll's);
 * a file written before lanes had them loads the lane in the roll's time.
 */
export interface TasmoPolyLane {
  id: number;
  name: string;
  cycle_steps: number | null;
  span_start?: number;
  span_end?: number | null;
  meter_map?: TasmoMeterSegment[];
  tuplet?: { n: number; m: number };
}

/** A note's expression as the file carries it: the roll's `NoteExpression`, keys in the file's snake_case. */
export interface TasmoNoteExpression {
  pressure?: number;
  timbre?: number;
  pitch_bend?: number;
  /** The semitones pitch_bend ±1 is worth, when the note names its own. */
  bend_range?: number;
  /** Each dimension's movement inside the note: [ticks from its start, value] pairs. */
  curves?: { pressure?: Array<[number, number]>; timbre?: Array<[number, number]>; pitch_bend?: Array<[number, number]> };
}

/**
 * A piano-roll note as a MIDI clip stores it. `lane` only when the note sits in
 * one. `tick`/`ticks` are the note itself at 960 PPQ (the roll's clock), written
 * while they agree with `step`/`length`, the 16th-step view of them that older
 * readers know. `channel` (1-16) and `expr` only when the note has them. A
 * reader that knows only the first four keys still gets a playable note.
 */
export interface TasmoStepNote {
  note: number;
  step: number;
  length: number;
  velocity: number;
  lane?: number;
  tick?: number;
  ticks?: number;
  channel?: number;
  expr?: TasmoNoteExpression;
  /** The note's articulation (lib/articulationMap), when it has one. */
  articulation?: string;
}

/** A pitch bend point as a piano-roll clip stores it; `shape` only when it is not `linear`. */
export interface TasmoBendPoint {
  step: number;
  value: number;
  shape?: BendShape;
}

/** A lane's pitch bend: the lane id, its range in semitones and its points. */
export interface TasmoLaneBend {
  lane: number;
  range: number;
  points: TasmoBendPoint[];
}

/**
 * One event of a piano-roll clip's tempo map (lib/rollTempo): a quarter-note
 * `beat` from the clip's first step and a `bpm`, `curve` "linear" when it ramps
 * to the next event (left out for a step), or a `fermata` hold instead of a
 * tempo change.
 */
export interface TasmoTempoEvent {
  beat: number;
  bpm: number;
  curve?: 'linear';
  fermata?: { beats: number; stretch: number };
}

// --- Effect chain (mirrors backend tasmo_project.py EffectChainNode/VstPluginState) ---
export interface VstPluginState {
  plugin_path: string;
  plugin_name: string;
  parameters?: Record<string, number>;
  preset_path?: string | null;
  instance_id?: string;
  /** The opaque base64 state the plugin's window or live host captured: the
   *  insert's dialled-in sound. Absent when the plugin was never opened, and
   *  in every file written before it was saved. */
  raw_state?: string | null;
  /** The host that captured `raw_state` ('thedaw' or 'pedalboard'); absent is the default. */
  state_host?: string | null;
}

/** A sidechain key leaving a track or a bus: its signal keys the effect
 *  `entry_id` on the rack of `target` (a track or bus id). Mirrors the backend
 *  `SidechainKey`; the reader drops one that names nothing. */
export interface TasmoSidechainKey {
  target: string;
  entry_id: string;
}

/** A warp anchor as the file carries it: lib/audioWarp's WarpMarker, in the
 *  file's snake_case, both in clip-relative seconds. */
export interface TasmoWarpMarker {
  source_sec: number;
  target_sec: number;
}

export interface EffectChainNode {
  node_type: string; // "vst3" | "audiounit" | "builtin"
  effect_name: string;
  parameters?: Record<string, number>;
  bypass?: boolean;
  vst_state?: VstPluginState | null;
  /** Stable chain-entry id, so controller mappings keyed to this FX slot survive
   *  a save/load round-trip. */
  id?: string;
}

// --- The master chains + the editor's automation lanes, as the FILE carries
// them (backend ChainVst / ChainEntry / AutomationLaneTarget /
// EditorAutomationPoint / EditorAutomationLane) ---

/** The plugin identity on a master-chain entry. Mirrors the store's `VstNode`,
 *  `raw_state` included — that opaque blob IS the dialed-in sound, and it is why
 *  the master chains are not written as the per-track `EffectChainNode`. */
export interface TasmoChainVst {
  plugin_path: string;
  plugin_name: string;
  raw_state?: string | null;
  /** The host that captured `raw_state` ('thedaw' or 'pedalboard'); absent is the default. */
  state_host?: string | null;
}

/**
 * One insert on the MASTER bus, in the store's own `ChainEntry` shape (see
 * `state/effectChainStore.ts`). Both master chains are `ChainEntry[]` live, so
 * the file keeps that shape rather than translating through the interchange
 * node and losing `label` and `raw_state` on the way.
 *
 * Optionality mirrors the backend model, which requires `id` and `effect` and
 * defaults the rest: `id` is load-bearing, because an automation lane targets a
 * chain entry BY id.
 */
export interface TasmoChainEntry {
  id: string;
  effect: string;
  params?: Record<string, number>;
  enabled?: boolean;
  vst?: TasmoChainVst | null;
  label?: string | null;
}

/** What an automation lane writes to; mirrors the store's `AutomationTarget`.
 *  `kind` is "trackVolume" | "trackPan" | "trackFx" | "masterFx" |
 *  "trackMidiCc" | "busFx" (whose `track_id` names the bus) — typed as a
 *  plain string because the file is only as trustworthy as whoever edited it,
 *  and the reader is the strict half. */
export interface TasmoAutomationTarget {
  kind: string;
  track_id?: string | null;
  entry_id?: string | null;
  param_key?: string | null;
}

/** One breakpoint. `curve` shapes the segment that STARTS here, in [-1, 1];
 *  absent (every lane written before curves existed) means linear. */
export interface TasmoAutomationPoint {
  t: number;
  v: number;
  curve?: number | null;
}

/** One automated parameter's lane. The backend REJECTS points that do not
 *  ascend by `t` or that are non-finite, so both sides agree on what a
 *  samplable curve is. An EMPTY lane is valid: that is a lane the user cleared
 *  but did not delete. */
export interface TasmoAutomationLane {
  id: string;
  target: TasmoAutomationTarget;
  points: TasmoAutomationPoint[];
  enabled?: boolean;
}

/** Persisted controller (MIDI-learn) auto-attach for a saved session — the
 *  resolved Sway bindings + unattached list, so reopening re-wires the hardware
 *  to the same targets. Mirrors the frontend SwayResolveResult + source name. */
export interface TasmoControllerMappings {
  source_name: string;
  bindings: SwayBinding[];
  unattached: SwayUnattached[];
}

/**
 * A timeline marker as the FILE carries it (backend `Locator`). `position` is
 * timeline seconds; `color` is carried for files that have one (the editor's
 * `TimelineMarker` has no colour of its own, so it round-trips untouched).
 */
export interface TasmoLocator {
  id: string;
  name: string;
  position: number;
  color?: string | null;
}

/**
 * The transport's cycle region as the FILE carries it (backend `Loop`).
 *
 * `enabled` is separate from the bounds on purpose: the editor keeps the region
 * when the loop is switched off, so flattening the two would reopen a session
 * with the user's region thrown away.
 */
export interface TasmoLoop {
  enabled: boolean;
  start_sec: number;
  end_sec: number;
}

/**
 * A clip's follow action as the FILE carries it (backend `Clip.follow_action`).
 *
 * Deliberately looser than the in-app `FollowAction`: the backend model defaults
 * every field so an older or hand-edited file still validates, and `after`
 * carries all three keys because the in-app type is a union of two forms.
 * `followAction.parseFollowAction` is the strict half — anything this shape can
 * hold but the app cannot act on becomes no rule at all on load.
 */
export interface TasmoFollowAction {
  after: { bars?: number | null; beats?: number | null; plays?: number | null };
  a: string;
  b?: string | null;
  chance?: number;
}

/**
 * One alternate recording of a clip as the FILE carries it (backend `Take`).
 *
 * `audio_file` is stored exactly like the clip's own — `audio/<name>` in an
 * embedded save, an absolute path once the archive has been extracted — so a
 * take's bytes are fetched through the same `/clip-audio` route the clip's are.
 * Optionality mirrors the backend model, which defaults everything but `id`.
 */
export interface TasmoTake {
  id: string;
  name?: string;
  audio_file?: string | null;
  mime_type?: string;
  offset_into_source?: number;
  source_duration?: number;
}

/**
 * One stretch of a comped clip as the FILE carries it (backend `CompRegion`),
 * in CLIP-relative seconds. The list IS the comp: region `i` runs to region
 * `i+1`'s `start_sec` and the last runs to the clip's end. `crossfade_sec` is
 * the fade across this region's LEADING boundary (0 = a butt cut).
 *
 * The backend REJECTS a list that does not ascend or that names a take the clip
 * does not have, so both sides agree on what a playable comp is; `clipComp`'s
 * `normalizeComp` is the reader's half, clamping the rest into the clip box.
 */
export interface TasmoCompRegion {
  start_sec: number;
  take_index: number;
  crossfade_sec?: number;
}

/**
 * The piano roll's own voice: the GM program (0-127) a roll with no linked EDIT
 * clip auditions and bounces with, or null to follow the global instrument
 * picker. The backend's `RollVoice`.
 */
export interface TasmoRollVoice {
  program: number | null;
}

// --- Save payload (built in the frontend, validated by the backend) ---
export interface TasmoClipInput {
  id: string;
  name: string;
  clip_type: string; // "audio" | "midi" | "generated"
  track_id: string;
  start_time?: number;
  end_time?: number;
  audio_file?: string | null;
  /** Carried so MIDI clips survive the round-trip (the backend Clip model keeps
   *  these). The shape is whatever the importer produced; the loader is tolerant.
   *  A piano-roll clip always writes the notes as they sound, lane repeats
   *  written out, so every build opens it (see clipNotesToTasmo). */
  midi_notes?: unknown[] | null;
  /** A piano-roll clip's own notes with their lanes, which the roll loads.
   *  Left out when they are the played notes as written (see clipNotesToTasmo). */
  roll_notes?: TasmoStepNote[] | null;
  loop_start?: number | null;
  loop_end?: number | null;
  /** Per-clip mute; optional so pre-mute payloads stay valid. */
  muted?: boolean;
  /** Linear clip gain (1 = unity) and fade lengths in seconds. Optional for the
   *  same reason: the backend defaults them, so older payloads still validate. */
  gain?: number;
  fade_in?: number;
  fade_out?: number;
  /** Seconds into the source where the clip starts — the trim point. */
  offset_into_source?: number;
  /** Session-view (Perform grid) placement; null on an arrangement clip.
   *  Without these the format could not represent a clip-launch grid, so every
   *  session clip was dropped on save. */
  track_index?: number | null;
  scene_index?: number | null;
  slot_index?: number | null;
  /** The clip's follow action (Session grid), or null when it has none. Written
   *  explicitly rather than omitted so the key is always in the file. */
  follow_action?: TasmoFollowAction | null;
  /** Piano-roll clips: the grid length in steps, the time signatures by bar, the
   *  steps before bar 0 and the polymeter lanes the clip was bounced with. */
  total_steps?: number | null;
  meter_map?: TasmoMeterSegment[] | null;
  pickup_steps?: number | null;
  lanes?: TasmoPolyLane[] | null;
  /** Piano-roll clips: each lane's pitch bend. */
  roll_bends?: TasmoLaneBend[] | null;
  /** Piano-roll clips: the tempo map, written only when the clip changes tempo. */
  tempo_map?: TasmoTempoEvent[] | null;
  /** Piano-roll clips: the ruler's named markers (sections and movements), written only when the clip has some. */
  roll_markers?: TasmoRollMarker[] | null;
  /** Piano-roll clips: the roll part the clip holds (see rollPartToTasmo). */
  roll_part?: TasmoRollPart | null;
  /** Alternate recordings of this clip, one file entry each, and the comp
   *  across them. `active_take_index` names the take the clip's OWN
   *  `audio_file` / `offset_into_source` mirror, so a reader that ignores all
   *  three still gets the clip the user was hearing. Optional: a payload built
   *  before takes existed stays valid (the backend defaults them to None). */
  takes?: TasmoTake[] | null;
  comp?: TasmoCompRegion[] | null;
  active_take_index?: number | null;
  /** MIDI clips: the clip's own GM program (0-127) and the program its
   *  embedded audio was rendered with. Any clip: `source_bpm`, the tempo a MIDI
   *  clip's notes were written at or an audio clip was tagged with. Optional so
   *  a payload built before they were written still validates. */
  instrument_program?: number | null;
  rendered_program?: number | null;
  /** MIDI clips: whether the embedded audio was rendered on the drum channel. */
  rendered_percussion?: boolean;
  /** MIDI clips with embedded audio: the render was out of date when saved
   *  (lib/midiRender renderSigStale), and EDIT made it only because the clip
   *  could not play live (AudioClip renderAuto). Optional for the same reason. */
  render_stale?: boolean;
  render_auto?: boolean;
  /** MIDI clips: the bank select (1-127) the clip's own program is chosen in,
   *  and the bank its embedded audio was rendered in; null for bank 0. */
  instrument_bank?: number | null;
  rendered_bank?: number | null;
  /** The sound bank the clip's program is picked from (lib/bankRegistry);
   *  null or absent is the bundled General MIDI bank, as in every file written
   *  before sound banks. */
  instrument_bank_id?: string | null;
  source_bpm?: number | null;
  /** The tempo the audio plays at after a beat match or a stretch, and the
   *  library entry the clip came from. Optional for the same reason. */
  bpm?: number | null;
  library_entry_id?: string | null;
  /** The clip's time stretch (the rate its source plays at, and 'repitch' or
   *  'offline'), its warp anchors and each fade's shape. Written only where
   *  the clip has them. */
  time_stretch_rate?: number | null;
  stretch_mode?: string | null;
  warp_markers?: TasmoWarpMarker[] | null;
  fade_in_curve?: string | null;
  fade_out_curve?: string | null;
  /** An audio clip's tie to its library song's analysis (lib/clipSongTime);
   *  null or absent in files written before it and on audio with none. */
  song_time?: { entry_id: string; bpm?: number | null; offset_sec?: number; rate?: number } | null;
}

export interface TasmoTrackInput {
  id: string;
  name: string;
  type: string; // "audio" | "midi" | ...
  volume_db?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  color?: string | null;
  clips?: TasmoClipInput[];
  effect_chain?: EffectChainNode[];
  /** Where this track's signal goes: the id of the bus it feeds, or `null` for
   *  the master. Optional so a payload built before routing was written still
   *  validates (the backend defaults it to None). */
  output_routing?: string | null;
  /** Bus id -> linear send gain. */
  send_amounts?: Record<string, number>;
  /** The sidechain keys the track feeds; written only when it feeds one. */
  sidechain_keys?: TasmoSidechainKey[];
  /** The GM program (0-127) this track's MIDI clips play through when a clip
   *  has none of its own. */
  instrument_program?: number | null;
  /** A drum track: its MIDI clips play on the drum channel and the program is the kit. */
  is_percussion?: boolean;
  /** The reverb send (CC 91, 0-127) the track's MIDI channels open with; null leaves the synth's own. */
  synth_reverb_send?: number | null;
  /** The bank select inside `instrument_bank_id` the track's program is
   *  picked in, and that sound bank; null or absent for the bundled bank's
   *  bank 0, as in every file written before sound banks. */
  instrument_bank?: number | null;
  instrument_bank_id?: string | null;
  /** Where the track's live MIDI also goes: an output port by id and name,
   *  the channel, and whether the port gets clock. Null or absent: none. */
  midi_out?: { port_id: string; port_label: string; channel: number; clock: boolean } | null;
  /** The channels notes with per-note expression rotate across; null or absent: the default. */
  mpe_channels?: number | null;
  /** The track plays through its MIDI out port alone; absent in older files. */
  external_only?: boolean;
  /** The track's VST3 instrument slot, with its captured state; absent with none, as in older files. */
  instrument?: TasmoChainEntry | null;
  /** How that instrument is told articulations: 'keyswitch' or 'uacc'; absent is 'keyswitch'. */
  articulation_switch?: string | null;
  /** Arrangement folders: the folder this track sits in (absent = the root),
   *  whether this track is a folder, and whether that folder shows its rows. */
  parent_track_id?: string | null;
  is_folder?: boolean;
  collapsed?: boolean;
}

/**
 * A mix bus. Mirrors `Bus` in backend/modules/project/tasmo_project.py and the
 * frontend's `EditorBus`. `volume` is a LINEAR fader multiplier (1.0 = unity),
 * NOT dB like a track's `volume_db`, and `effect_chain` is the same node shape a
 * track's is. Its place in the flow is `output_routing`, exactly like a track's.
 * The master is never a bus: it is the implied destination of a `null` output.
 *
 * Optionality here tracks the backend model EXACTLY, because this type is the
 * save payload as well as the load result: `name` is required there, so a bus
 * without one must not typecheck into a save that would 400, and `effect_chain`
 * defaults to `[]` and rejects `null`, so the field is omittable but never
 * nullable. Only `output_routing` is nullable, matching `str | None`.
 * `send_amounts` and `sidechain_keys` are the bus's other edges, the same
 * fields a track carries; absent in files written before they were saved.
 */
export interface TasmoBus {
  id: string;
  name: string;
  volume?: number;
  mute?: boolean;
  output_routing?: string | null;
  send_amounts?: Record<string, number>;
  sidechain_keys?: TasmoSidechainKey[];
  effect_chain?: EffectChainNode[];
}

export interface TasmoProjectInput {
  project_name: string;
  tempo?: number;
  time_signature?: number[];
  /** The arrangement's tempo map (beat 0 = timeline second 0, beats in quarter
   *  notes) and meter map (bar 0 = timeline second 0). `tempo` stays the start
   *  tempo and `time_signature` bar 1's meter, so a reader that knows only those
   *  opens the project at its start. Optional: payloads built before the
   *  arrangement had maps still validate. */
  tempo_map?: TasmoTempoEvent[] | null;
  meter_map?: TasmoMeterSegment[] | null;
  sample_rate?: number;
  author?: string;
  tracks?: TasmoTrackInput[];
  /** The project's mix buses; omitted when it has none. */
  buses?: TasmoBus[];
  source_daw?: string | null;
  import_warnings?: string[];
  /** Session-view scene names in row order; empty when there is no grid. */
  scenes?: string[];
  /** Timeline markers in position order; omitted when the project has none. */
  locators?: TasmoLocator[];
  /** The transport's cycle region, or null when the project has none. */
  loop?: TasmoLoop | null;
  /** The master bus's insert rack and its hosted-VST chain, and the EDIT
   *  session's automation lanes. Omitted (backend: None) only by a payload
   *  built before they were written; an EMPTY array is a real statement — this
   *  project has none — and clears on load. */
  master_fx_chain?: TasmoChainEntry[];
  master_vst_chain?: TasmoChainEntry[];
  automation_lanes?: TasmoAutomationLane[];
  source_daw_version?: string | null;
  controller_mappings?: TasmoControllerMappings | null;
  /** Perform-tab scene-launch + modulation routing (see performRouting.ts). */
  perform_routing?: PerformRoutingSnapshot | null;
  /** The piano roll's own voice (pianoRollStore voiceProgram). */
  roll_voice?: TasmoRollVoice;
  /** The project tuning (state/tuningStore tuningToTasmo); null at A = 440 in equal temperament. */
  tuning?: Record<string, unknown> | null;
}

// --- Load result. The backend returns the FULL TasmoProject (model_dump), so
// these mirror the fields the editor import reads; unlisted fields are ignored. ---
export interface TasmoLoadedClip {
  id?: string;
  name: string;
  clip_type: string;
  track_id?: string;
  start_time?: number;
  end_time?: number;
  audio_file: string | null;
  /** The notes as they sound. Absent from every audio clip, and from a
   *  piano-roll clip an earlier build saved with only its roll notes. */
  midi_notes?: Array<Record<string, number>> | null;
  /** A piano-roll clip's own notes with their lanes; absent in .tasmo files
   *  written before the roll had lanes. */
  roll_notes?: TasmoStepNote[] | null;
  /** The clip's own GM program, the program its audio was rendered with, and
   *  its tempo (a MIDI clip's notes, or an audio clip's tag); null or absent in
   *  files written before they were saved, and only as trustworthy as the file. */
  instrument_program?: number | null;
  rendered_program?: number | null;
  /** Whether the clip's audio was rendered on the drum channel; absent in files
   *  written before it was saved. */
  rendered_percussion?: boolean;
  /** Whether the clip's embedded render was out of date when saved, and whether
   *  EDIT made it only because the clip could not play live; absent (false) in
   *  files written before they were saved. */
  render_stale?: boolean;
  render_auto?: boolean;
  /** The bank the clip's own program is chosen in and the bank its audio was
   *  rendered in; null or absent for bank 0 and in files written before them. */
  instrument_bank?: number | null;
  rendered_bank?: number | null;
  /** The sound bank the clip's program is picked from (lib/bankRegistry);
   *  null or absent is the bundled General MIDI bank, as in every file written
   *  before sound banks. */
  instrument_bank_id?: string | null;
  source_bpm?: number | null;
  /** An audio clip's tempo after a beat match or a stretch, and the library
   *  entry it came from; null or absent in files written before they were
   *  saved. */
  bpm?: number | null;
  library_entry_id?: string | null;
  /** An audio clip's tie to its library song's analysis (lib/clipSongTime);
   *  null or absent in files written before it and on audio with none. */
  song_time?: { entry_id: string; bpm?: number | null; offset_sec?: number; rate?: number } | null;
  /** Per-clip mute; absent in .tasmo files written before the field existed. */
  muted?: boolean;
  /** Linear clip gain (1 = unity) and fade lengths in seconds; absent in .tasmo
   *  files written before these fields existed. */
  gain?: number;
  fade_in?: number;
  fade_out?: number;
  /** Seconds into the source where the clip starts — the trim point. */
  offset_into_source?: number;
  /** Loop window in source seconds; loop_end past loop_start makes the clip
   *  SUSTAIN (loop) when launched from the Perform grid. */
  loop_start?: number | null;
  loop_end?: number | null;
  /** Session-view (Perform grid) placement; null on an arrangement clip.
   *  Without these the format could not represent a clip-launch grid, so every
   *  session clip was dropped on save. */
  track_index?: number | null;
  scene_index?: number | null;
  slot_index?: number | null;
  /** The clip's follow action; absent in .tasmo files written before the grid
   *  had one, and only as trustworthy as the file — see parseFollowAction. */
  follow_action?: TasmoFollowAction | null;
  /** Piano-roll grid length and meter; absent in .tasmo files written before
   *  the roll had a meter. */
  total_steps?: number | null;
  meter_map?: TasmoMeterSegment[] | null;
  pickup_steps?: number | null;
  lanes?: TasmoPolyLane[] | null;
  /** Each lane's pitch bend; absent in .tasmo files written before the roll had pitch bend. */
  roll_bends?: TasmoLaneBend[] | null;
  /** The tempo map; absent in .tasmo files written before the roll had one, and on a clip at one tempo. */
  tempo_map?: TasmoTempoEvent[] | null;
  /** The ruler's markers; absent in .tasmo files written before the roll had them, and on a clip with none. */
  roll_markers?: TasmoRollMarker[] | null;
  /** The roll part the clip holds; absent in .tasmo files written before the roll had parts. */
  roll_part?: TasmoRollPart | null;
  /** Alternate recordings, the comp across them, and which take the clip's own
   *  fields mirror; all three absent in .tasmo files written before takes
   *  existed, which is why the loader treats their absence as "not comped"
   *  rather than as damage. */
  takes?: TasmoTake[] | null;
  comp?: TasmoCompRegion[] | null;
  active_take_index?: number | null;
  /** The clip's time stretch, warp anchors and fade shapes; absent in files
   *  written before they were saved, and only as trustworthy as the file (an
   *  importer's warp markers have another shape). */
  time_stretch_rate?: number | null;
  stretch_mode?: string | null;
  warp_markers?: TasmoWarpMarker[] | null;
  fade_in_curve?: string | null;
  fade_out_curve?: string | null;
}

export interface TasmoLoadedTrack {
  id?: string;
  name: string;
  type: string;
  volume_db?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  color?: string | null;
  /** The track's GM program; null or absent in files written before it was saved. */
  instrument_program?: number | null;
  /** A drum track; absent in files written before it was saved, which load melodic. */
  is_percussion?: boolean;
  /** The reverb send (CC 91); absent in files written before it was saved. */
  synth_reverb_send?: number | null;
  /** The bank select inside `instrument_bank_id` the track's program is
   *  picked in, and that sound bank; null or absent for the bundled bank's
   *  bank 0, as in every file written before sound banks. */
  instrument_bank?: number | null;
  instrument_bank_id?: string | null;
  /** Where the track's live MIDI also goes: an output port by id and name,
   *  the channel, and whether the port gets clock. Null or absent: none. */
  midi_out?: { port_id: string; port_label: string; channel: number; clock: boolean } | null;
  /** The channels notes with per-note expression rotate across; null or absent: the default. */
  mpe_channels?: number | null;
  /** The track plays through its MIDI out port alone; absent in older files. */
  external_only?: boolean;
  /** The track's VST3 instrument slot, with its captured state; absent with none, as in older files. */
  instrument?: TasmoChainEntry | null;
  /** How that instrument is told articulations: 'keyswitch' or 'uacc'; absent is 'keyswitch'. */
  articulation_switch?: string | null;
  clips: TasmoLoadedClip[];
  effect_chain?: EffectChainNode[];
  /** The id of the bus this track feeds; `null`/absent = the master. Absent in
   *  .tasmo files written before routing was persisted. */
  output_routing?: string | null;
  /** Bus id -> linear send gain; absent in those same older files. */
  send_amounts?: Record<string, number>;
  /** The sidechain keys the track feeds; absent in files written before they were saved. */
  sidechain_keys?: TasmoSidechainKey[];
  /** Arrangement folders; absent in files written before folders were saved,
   *  which load flat. The reader resets a parent that names no folder. */
  parent_track_id?: string | null;
  is_folder?: boolean;
  collapsed?: boolean;
}

export interface TasmoProjectLoaded {
  project_name: string;
  tempo: number;
  /** Declared so a non-4/4 set does not silently reload as 4/4. */
  time_signature?: number[];
  /** The arrangement's tempo and meter maps; absent (or null) in files written
   *  before them, which open with `tempo` and `time_signature`. */
  tempo_map?: TasmoTempoEvent[] | null;
  meter_map?: TasmoMeterSegment[] | null;
  sample_rate: number;
  source_daw?: string | null;
  source_daw_version?: string | null;
  tracks: TasmoLoadedTrack[];
  /** The project's mix buses; absent in files written before buses existed. */
  buses?: TasmoBus[];
  import_warnings?: string[];
  /** Session-view scene names in row order; empty when there is no grid. */
  scenes?: string[];
  /** Timeline markers; absent in files written before they were persisted. */
  locators?: TasmoLocator[];
  /** The transport's cycle region; absent in those same older files. */
  loop?: TasmoLoop | null;
  /** The master bus's two chains and the editor's automation lanes. Absent (or
   *  null) in files written before they were persisted, which the loader leaves
   *  the live state alone for; an empty array clears it. */
  master_fx_chain?: TasmoChainEntry[] | null;
  master_vst_chain?: TasmoChainEntry[] | null;
  automation_lanes?: TasmoAutomationLane[] | null;
  controller_mappings?: TasmoControllerMappings | null;
  perform_routing?: PerformRoutingSnapshot | null;
  /** The piano roll's own voice. Absent (or null) in files written before it
   *  was saved, which the loader leaves the live roll voice alone for. */
  roll_voice?: TasmoRollVoice | null;
  /** The project tuning; null or absent: A = 440 in equal temperament. */
  tuning?: Record<string, unknown> | null;
}

export interface ProjectManifest {
  format: string;
  format_version: number;
  project_name: string;
  audio_mode: string; // "embedded" | "linked"
  total_tracks: number;
  total_clips?: number;
  sample_rate: number;
  created_at?: string;
  modified_at?: string;
}

export interface RecentItem {
  path: string;
  name: string;
}

/**
 * A roll part as a .tasmo clip saves it (AudioClip `sourceRollPart`): the roll
 * document shared by the clips of every part bounced from one roll, the part's
 * id and place, and its settings. `program` and `channel` are null when the
 * part follows the roll's voice or takes the next free channel. `bank_lsb` is
 * its bank select LSB (CC 32), absent when it sends none. `controls` is the
 * part's controller changes on the roll's clock (960 ticks to the quarter),
 * absent when it has none. `figured_bass` holds the figures under its bass
 * notes and `cantus_firmus` marks the roll's cantus firmus.
 * `vst_instrument` is the VST3 instrument the part plays through, a chain
 * entry in the file's shape with the state its editor captured, and
 * `articulation_switch` how it hears articulations ('uacc'; absent is
 * keyswitch). A file written before any of them opens without it.
 */
export interface TasmoRollPart {
  doc: string;
  id: string;
  order: number;
  name: string;
  program: number | null;
  bank: number;
  bank_lsb?: number;
  channel: number | null;
  color: string;
  mute: boolean;
  solo: boolean;
  instrument_id?: string | null;
  controls?: Array<{ tick: number; controller: number; value: number }>;
  /** The figures under the part's bass notes, by tick on the roll's clock; absent when it has none. */
  figured_bass?: Array<{ tick: number; figure: string }>;
  /** True for the roll's cantus firmus part; absent otherwise. */
  cantus_firmus?: boolean;
  /** The part's notes were timed against audio (RollPartRef `fromAudio`). Absent when they were not. */
  from_audio?: boolean;
  /** The VST3 instrument the part plays through, with its captured state; absent when it has none. */
  vst_instrument?: TasmoChainEntry;
  /** How that instrument hears articulations; absent is keyswitch. */
  articulation_switch?: string;
}

/** A clip's part record in the file shape. */
export const rollPartToTasmo = (ref: RollPartRef): TasmoRollPart => ({
  doc: ref.doc,
  id: ref.id,
  order: ref.order,
  name: ref.name,
  program: ref.program,
  bank: ref.bank,
  ...(ref.bankLsb !== undefined ? { bank_lsb: ref.bankLsb } : {}),
  channel: ref.channel,
  color: ref.color,
  mute: ref.mute,
  solo: ref.solo,
  instrument_id: ref.instrumentId ?? null,
  ...(ref.controls?.length ? { controls: ref.controls.map((c) => ({ tick: c.tick, controller: c.controller, value: c.value })) } : {}),
  ...(ref.figuredBass?.length ? { figured_bass: ref.figuredBass.map((m) => ({ tick: m.tick, figure: m.figure })) } : {}),
  ...(ref.cantusFirmus ? { cantus_firmus: true } : {}),
  ...(ref.fromAudio ? { from_audio: true } : {}),
  ...(ref.vstInstrument?.vst
    ? {
        vst_instrument: {
          id: ref.vstInstrument.id,
          effect: ref.vstInstrument.effect,
          params: { ...ref.vstInstrument.params },
          enabled: ref.vstInstrument.enabled,
          vst: {
            plugin_path: ref.vstInstrument.vst.plugin_path,
            plugin_name: ref.vstInstrument.vst.plugin_name,
            // The state its editor captured, and the host that captured it; absent while it plays its defaults.
            ...(ref.vstInstrument.vst.raw_state ? { raw_state: ref.vstInstrument.vst.raw_state } : {}),
            ...(ref.vstInstrument.vst.state_host ? { state_host: ref.vstInstrument.vst.state_host } : {}),
          },
        },
      }
    : {}),
  ...(ref.articulationSwitch ? { articulation_switch: ref.articulationSwitch } : {}),
});

/** A file's part record as the clip keeps it, or undefined when it has none or it names no document or part. */
export const tasmoRollPart = (raw: unknown, fallback: { name: string; color: string }): RollPartRef | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return cleanRollPartRef(
    {
      ...r,
      instrumentId: r.instrument_id ?? r.instrumentId,
      bankLsb: r.bank_lsb ?? r.bankLsb,
      figuredBass: r.figured_bass ?? r.figuredBass,
      cantusFirmus: r.cantus_firmus ?? r.cantusFirmus,
      fromAudio: r.from_audio ?? r.fromAudio,
      vstInstrument: r.vst_instrument ?? r.vstInstrument,
      articulationSwitch: r.articulation_switch ?? r.articulationSwitch,
    },
    fallback,
  );
};

// --- Piano-roll clip fields <-> .tasmo JSON (pure; tested in projectImport.test.ts) ---
type ClipMeterFields = Pick<
  AudioClip,
  'sourceRollNotes' | 'sourceTotalSteps' | 'sourceMeterMap' | 'sourcePickupSteps' | 'sourceLanes' | 'sourceBends' | 'sourceTempoMap' | 'sourceMarkers'
>;
type TasmoMeterFields = Pick<
  TasmoClipInput,
  'roll_notes' | 'total_steps' | 'meter_map' | 'pickup_steps' | 'lanes' | 'roll_bends' | 'tempo_map' | 'roll_markers'
>;

const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;

/**
 * `ticks` when it is a whole number of at least `min` that is `steps` 16ths to
 * within half a tick, else undefined: a note's stored ticks, kept only while
 * they still agree with the step view written beside them.
 */
export const ticksMatching = (ticks: unknown, steps: unknown, min: number): number | undefined =>
  typeof ticks === 'number' && Number.isInteger(ticks) && ticks >= min && typeof steps === 'number' && Number.isFinite(steps) && Math.abs(ticks - steps * TICKS_PER_STEP) < 0.5
    ? ticks
    : undefined;

/** A note's expression in the file shape, or undefined when it has none. */
const exprToTasmo = (e: NoteExpression | undefined): TasmoNoteExpression | undefined => {
  if (!e) return undefined;
  const out: TasmoNoteExpression = {
    ...(e.pressure !== undefined ? { pressure: e.pressure } : {}),
    ...(e.timbre !== undefined ? { timbre: e.timbre } : {}),
    ...(e.pitchBend !== undefined ? { pitch_bend: e.pitchBend } : {}),
    ...(e.bendRange !== undefined ? { bend_range: e.bendRange } : {}),
  };
  if (e.curves) {
    const pairs = (c: NoteExpressionPoint[] | undefined) => c?.map((p): [number, number] => [p.tick, p.value]);
    const curves = {
      ...(e.curves.pressure ? { pressure: pairs(e.curves.pressure) } : {}),
      ...(e.curves.timbre ? { timbre: pairs(e.curves.timbre) } : {}),
      ...(e.curves.pitchBend ? { pitch_bend: pairs(e.curves.pitchBend) } : {}),
    };
    if (Object.keys(curves).length) out.curves = curves;
  }
  return Object.keys(out).length ? out : undefined;
};

/**
 * A piano-roll note in the .tasmo shape, carrying `lane`, `channel` and `expr`
 * when the note has them.
 *
 * `tick` and `ticks` are written only while each agrees with the step view
 * (within half a tick, the rule the roll's `timingOf` keeps). They keep a
 * triplet edge exact, and a reader that has them never floors a note shorter
 * than a 16th. A helper that rewrites `step` on a copy of a note, as EDIT's
 * quantize does to a clip's played notes, leaves the old `tick` behind; writing
 * it would put the note back where it was before the edit.
 */
export const pianoNoteToTasmo = (n: PianoNote): TasmoStepNote => {
  const tick = ticksMatching(n.tick, n.step, 0);
  const ticks = ticksMatching(n.ticks, n.length, MIN_NOTE_TICKS);
  const expr = exprToTasmo(n.expr);
  return {
    note: n.note,
    step: n.step,
    length: n.length,
    velocity: n.velocity,
    ...(n.lane !== undefined ? { lane: n.lane } : {}),
    ...(tick !== undefined ? { tick } : {}),
    ...(ticks !== undefined ? { ticks } : {}),
    ...(n.channel !== undefined ? { channel: n.channel } : {}),
    ...(expr ? { expr } : {}),
    ...(n.articulation ? { articulation: n.articulation } : {}),
  };
};

/** A piano-roll clip's own notes, grid length and meter in the .tasmo shape. Fields the clip lacks are left out. */
export const clipMeterToTasmo = (c: ClipMeterFields): TasmoMeterFields => ({
  ...(c.sourceRollNotes ? { roll_notes: c.sourceRollNotes.map(pianoNoteToTasmo) } : {}),
  ...(c.sourceTotalSteps !== undefined ? { total_steps: c.sourceTotalSteps } : {}),
  ...(c.sourceMeterMap
    ? { meter_map: c.sourceMeterMap.map((s) => ({ bar: s.bar, meter: { num: s.meter.num, den: s.meter.den, groups: [...s.meter.groups] } })) }
    : {}),
  ...(c.sourcePickupSteps !== undefined ? { pickup_steps: c.sourcePickupSteps } : {}),
  ...(c.sourceLanes
    ? {
        lanes: c.sourceLanes.map((l) => ({
          id: l.id,
          name: l.name,
          cycle_steps: l.cycleSteps,
          ...(l.span ? { span_start: l.span.start, span_end: l.span.end } : {}),
          ...(l.meterMap?.length
            ? { meter_map: l.meterMap.map((s) => ({ bar: s.bar, meter: { num: s.meter.num, den: s.meter.den, groups: [...s.meter.groups] } })) }
            : {}),
          ...(l.tuplet ? { tuplet: { n: l.tuplet.n, m: l.tuplet.m } } : {}),
        })),
      }
    : {}),
  ...(c.sourceBends?.length
    ? {
        roll_bends: c.sourceBends.map((b) => ({
          lane: b.lane,
          range: b.range,
          points: b.points.map((p) => ({ step: p.step, value: p.value, ...(p.shape !== 'linear' ? { shape: p.shape } : {}) })),
        })),
      }
    : {}),
  ...(hasTempoChanges(c.sourceTempoMap) ? { tempo_map: (c.sourceTempoMap ?? []).map(tempoEventToTasmo) } : {}),
  ...(c.sourceMarkers?.length ? { roll_markers: c.sourceMarkers.map(rollMarkerToTasmo) } : {}),
});

/** A tempo event in the file shape: `curve` only when it ramps, `fermata` only on a hold. */
export const tempoEventToTasmo = (e: TempoEvent): TasmoTempoEvent => ({
  beat: e.beat,
  bpm: e.bpm,
  ...(e.fermata ? { fermata: { beats: e.fermata.beats, stretch: e.fermata.stretch } } : e.curve === 'linear' ? { curve: 'linear' as const } : {}),
});

const numberAtLeast = (v: unknown, min: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? v : undefined;

const clampUnit = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * The optional per-note fields of a file note, in the roll's shape: `lane` (a
 * whole number 0 or more), `tick` and `ticks` (whole, and only while they agree
 * with the note's `step` / `length` to within half a tick: `ticksMatching`),
 * `channel` (brought into 1-16 and rounded) and `expr` (each dimension clamped
 * to its range). Anything else is left out. Channel and expression follow the
 * roll's own ingest rule (`withTicks` in pianoRollStore). Ticks that disagree
 * with the steps beside them (a hand-edited file) are dropped, so the steps win.
 */
export const tasmoNoteExtras = (n: Record<string, unknown>): Pick<PianoNote, 'lane' | 'tick' | 'ticks' | 'channel' | 'expr' | 'articulation'> => {
  const out: Pick<PianoNote, 'lane' | 'tick' | 'ticks' | 'channel' | 'expr' | 'articulation'> = {};
  if (isArticulation(n.articulation)) out.articulation = n.articulation;
  const { lane, channel } = n;
  const tick = ticksMatching(n.tick, n.step, 0);
  const ticks = ticksMatching(n.ticks, n.length, MIN_NOTE_TICKS);
  if (typeof lane === 'number' && Number.isInteger(lane) && lane >= 0) out.lane = lane;
  if (tick !== undefined) out.tick = tick;
  if (ticks !== undefined) out.ticks = ticks;
  if (typeof channel === 'number' && Number.isFinite(channel)) out.channel = Math.max(1, Math.min(16, Math.round(channel)));
  if (n.expr && typeof n.expr === 'object') {
    const e = n.expr as Record<string, unknown>;
    const c = (e.curves && typeof e.curves === 'object' ? e.curves : {}) as Record<string, unknown>;
    const points = (raw: unknown) => (Array.isArray(raw) ? raw.map((p) => (Array.isArray(p) ? { tick: p[0], value: p[1] } : p)) : undefined);
    // The file's snake_case into the roll's shape, then the roll's own rule (lib/noteExpression).
    const expr = sanitizeNoteExpression({
      pressure: e.pressure,
      timbre: e.timbre,
      pitchBend: e.pitch_bend,
      bendRange: e.bend_range,
      curves: { pressure: points(c.pressure), timbre: points(c.timbre), pitchBend: points(c.pitch_bend) },
    });
    if (expr) out.expr = expr;
  }
  return out;
};

/**
 * The inverse of pianoNoteToTasmo for a list. A note needs a pitch 0-127, a step
 * of 0 or more and a length above 0, or it is left out; velocity clamps to
 * 1-127 (100 when missing), and the optional fields are read by
 * `tasmoNoteExtras`. The file stores no ids, so each note gets
 * `<idPrefix>-<index>`.
 */
export const tasmoNotesToPiano = (raw: readonly unknown[] | null | undefined, idPrefix = 'rn'): PianoNote[] => {
  const out: PianoNote[] = [];
  for (const item of raw ?? []) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    const note = numberAtLeast(n.note, 0);
    const step = numberAtLeast(n.step, 0);
    const length = numberAtLeast(n.length, Number.MIN_VALUE);
    if (note === undefined || note > 127 || step === undefined || length === undefined) continue;
    const velocity = typeof n.velocity === 'number' && Number.isFinite(n.velocity) ? Math.max(1, Math.min(127, n.velocity)) : 100;
    out.push({
      id: `${idPrefix}-${out.length}`,
      note: Math.round(note),
      step,
      length,
      velocity,
      ...tasmoNoteExtras(n),
    });
  }
  return out;
};

/** The inverse of clipMeterToTasmo. A field that is absent, null or malformed stays
 *  undefined, so files written before these fields load as they did. */
export const tasmoMeterToClip = (c: TasmoMeterFields): ClipMeterFields => {
  const out: ClipMeterFields = {};
  const rollNotes = Array.isArray(c.roll_notes) ? tasmoNotesToPiano(c.roll_notes) : [];
  if (rollNotes.length) out.sourceRollNotes = rollNotes;
  const total = numberAtLeast(c.total_steps, 1);
  if (total !== undefined) out.sourceTotalSteps = total;
  if (Array.isArray(c.meter_map) && c.meter_map.length) out.sourceMeterMap = normalizeMeterMap(c.meter_map);
  const pickup = numberAtLeast(c.pickup_steps, 0);
  if (pickup !== undefined) out.sourcePickupSteps = pickup;
  if (Array.isArray(c.lanes) && c.lanes.length) {
    out.sourceLanes = c.lanes
      .filter((l) => l && Number.isInteger(l.id) && l.id >= 0)
      .map((l) => {
        const start = numberAtLeast(l.span_start, 0);
        const span = start === undefined ? null : clampLaneSpan({ start, end: numberAtLeast(l.span_end, 0) ?? null });
        const lane: PolyLane = { id: l.id, name: String(l.name ?? ''), cycleSteps: numberAtLeast(l.cycle_steps, 1) ?? null, ...(span ? { span } : {}) };
        // A lane's own time: a malformed one is dropped (sanitizeLanes checks it again on load).
        if (Array.isArray(l.meter_map) && l.meter_map.length) lane.meterMap = normalizeMeterMap(l.meter_map);
        const tuplet = sanitizeTuplet(l.tuplet);
        if (tuplet) lane.tuplet = tuplet;
        return lane;
      });
  }
  if (Array.isArray(c.roll_bends) && c.roll_bends.length) {
    // The file stores no point ids, so loaded points get `rb<lane>-<index>`.
    const bends = sanitizeBends(
      c.roll_bends
        .filter((b): b is TasmoLaneBend => !!b && typeof b === 'object')
        .map((b) => ({
          lane: b.lane,
          range: b.range,
          points: Array.isArray(b.points)
            ? b.points.map((p, i) => (p && typeof p === 'object' ? { ...p, id: `rb${b.lane}-${i}` } : { step: Number.NaN, value: 0 }))
            : [],
        })),
    );
    if (bends.length) out.sourceBends = bends;
  }
  if (Array.isArray(c.tempo_map) && c.tempo_map.length) {
    // Junk events are dropped and the rest brought into range (sanitizeRollTempoMap);
    // a map with nothing past its start is one tempo, which the clip's source_bpm already says.
    const events = c.tempo_map.filter((e): e is TasmoTempoEvent => !!e && typeof e === 'object');
    const start = events.find((e) => e.beat === 0 && !e.fermata)?.bpm ?? events.find((e) => !e.fermata)?.bpm ?? 120;
    const map = sanitizeRollTempoMap(events, start);
    if (hasTempoChanges(map)) out.sourceTempoMap = copyTempoMap(map);
  }
  // Junk markers are dropped (lib/rollMarkers tasmoToRollMarkers); a clip with none keeps the field unset.
  const markers = tasmoToRollMarkers(c.roll_markers);
  if (markers.length) out.sourceMarkers = markers;
  return out;
};

/** The arrangement's maps in the file shape: every tempo event (the start included) and every meter segment. */
export const projectTimeMapsToTasmo = (
  tempoMap: readonly TempoEvent[],
  meterMap: readonly MeterSegment[],
): { tempo_map: TasmoTempoEvent[]; meter_map: TasmoMeterSegment[] } => ({
  tempo_map: tempoMap.map(tempoEventToTasmo),
  meter_map: meterMap.map((s) => ({ bar: s.bar, meter: { num: s.meter.num, den: s.meter.den, groups: [...s.meter.groups] } })),
});

/**
 * The inverse of projectTimeMapsToTasmo, for a loaded project. A key that is
 * absent, null, empty or all junk stays undefined, so the loader falls back to
 * `tempo` / `time_signature` exactly as it did for files written before maps.
 */
export const tasmoToProjectTimeMaps = (
  p: Pick<TasmoProjectLoaded, 'tempo' | 'tempo_map' | 'meter_map'>,
): { tempoMap?: TempoEvent[]; meterMap?: MeterSegment[] } => {
  const out: { tempoMap?: TempoEvent[]; meterMap?: MeterSegment[] } = {};
  if (Array.isArray(p.tempo_map) && p.tempo_map.length) {
    const events = p.tempo_map.filter((e): e is TasmoTempoEvent => !!e && typeof e === 'object');
    const start = events.find((e) => e.beat === 0 && !e.fermata)?.bpm ?? (Number.isFinite(p.tempo) && p.tempo > 0 ? p.tempo : 120);
    if (events.some((e) => !e.fermata && Number.isFinite(e.bpm) && e.bpm > 0)) out.tempoMap = copyTempoMap(sanitizeRollTempoMap(events, start));
  }
  if (Array.isArray(p.meter_map) && p.meter_map.length) {
    const segs = p.meter_map.filter((m): m is TasmoMeterSegment => !!m && typeof m === 'object');
    if (segs.some((m) => sanitizeMeter(m.meter) !== null && Number.isFinite(m.bar))) out.meterMap = normalizeMeterMap(segs);
  }
  return out;
};

/** The grid length a piano-roll clip plays over: its own, else the end of
 *  `notes` rounded up to a bar line of its meter map (4/4 when it has none). */
export const clipTotalSteps = (meter: ClipMeterFields, notes: readonly PianoNote[]): number =>
  meter.sourceTotalSteps ?? roundUpToBar(meter.sourceMeterMap ?? [], noteEndStep(notes, 1), meter.sourcePickupSteps ?? 0);

/**
 * A piano-roll clip's played notes rebuilt from its roll notes: unrolled across
 * its lanes over its grid length, lane ids dropped. It is `playedRollNotes`, the
 * call a bounce writes `sourcePianoRoll` with, so a clip saved with only its
 * roll notes reloads playing what it played. [] when there are no roll notes.
 */
export const playedNotesFromRoll = (meter: ClipMeterFields): PianoNote[] => {
  const own = meter.sourceRollNotes ?? [];
  if (!own.length) return [];
  const lanes = sanitizeLanes(meter.sourceLanes?.length ? meter.sourceLanes : DEFAULT_LANES);
  return playedRollNotes(own, lanes, clipTotalSteps(meter, own));
};

/** What a note sounds like, as one comparable string; ids and ticks left out. */
const soundingKey = (n: PianoNote): string =>
  `${n.note}|${n.step}|${n.length}|${n.velocity}|${n.lane ?? ''}|${n.channel ?? ''}|` +
  `${n.expr?.pressure ?? ''}|${n.expr?.timbre ?? ''}|${n.expr?.pitchBend ?? ''}|${n.expr?.bendRange ?? ''}|${n.expr?.curves ? JSON.stringify(n.expr.curves) : ''}|${n.articulation ?? ''}`;

/** Whether two note lists sound the same, in any order. */
const sameSounding = (a: readonly PianoNote[], b: readonly PianoNote[]): boolean => {
  if (a.length !== b.length) return false;
  const ka = a.map(soundingKey).sort();
  const kb = b.map(soundingKey).sort();
  return ka.every((k, i) => k === kb[i]);
};

/**
 * A piano-roll clip's notes, grid length and meter in the .tasmo shape. Every
 * build reads `midi_notes`, the notes as the clip plays them, so they are
 * always written: a build that predates `roll_notes` opens any roll clip as a
 * MIDI clip playing what it played. Two cases, checked on the file shape
 * through the reader's own mapper, so each approves only what a reload really
 * reproduces:
 *
 * 1. The roll notes play exactly as written (no note in a lane, no lane bend):
 *    they are the played notes, so only `midi_notes` is written, and this build
 *    loads the clip the way it loads any clip without roll notes
 *    (`clipRollLoad` then opens the roll on the played notes).
 * 2. Anything else (a looping lane, a lane bend, played notes edited apart from
 *    the roll notes as EDIT's note tools do) writes `roll_notes` beside them,
 *    so the roll reopens on its own notes and lanes. A clip with roll notes and
 *    no played notes writes the roll notes unrolled across its lanes
 *    (`playedNotesFromRoll`, the call the bounce used) as its `midi_notes`.
 */
export const clipNotesToTasmo = (
  c: ClipMeterFields & Pick<AudioClip, 'sourcePianoRoll'>,
): TasmoMeterFields & Pick<TasmoClipInput, 'midi_notes'> => {
  const meter = clipMeterToTasmo(c);
  const reloaded = meter.roll_notes?.length ? tasmoMeterToClip(meter) : undefined;
  const played = c.sourcePianoRoll ?? (reloaded ? playedNotesFromRoll(reloaded) : undefined);
  const midiNotes = played ? played.map(pianoNoteToTasmo) : null;
  if (
    played?.length &&
    reloaded?.sourceRollNotes?.length &&
    !reloaded.sourceBends?.length &&
    sameSounding(reloaded.sourceRollNotes, played)
  ) {
    const { roll_notes: _once, ...rest } = meter;
    return { ...rest, midi_notes: midiNotes };
  }
  return { ...meter, midi_notes: midiNotes };
};

/** A GM program from a file: a whole number 0-127, else undefined. */
export const gmProgramOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 127 ? v : undefined;

/** A bank select from a file or a clip: a whole number 1-127, else 0 (the General MIDI set). */
export const bankSelectOf = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 127 ? v : 0;

/** A clip's own tempo from a file: a positive finite `source_bpm`, else
 *  undefined (a file written before source_bpm existed, or a clip with none). */
export const tasmoOwnBpm = (c: Pick<TasmoLoadedClip, 'source_bpm'>): number | undefined =>
  typeof c.source_bpm === 'number' && Number.isFinite(c.source_bpm) && c.source_bpm > 0 ? c.source_bpm : undefined;

/** The tempo a MIDI clip's notes were written at: its own `source_bpm` when the
 *  file has a usable one, else the project tempo. */
export const tasmoClipBpm = (c: Pick<TasmoLoadedClip, 'source_bpm'>, projectBpm: number): number =>
  tasmoOwnBpm(c) ?? projectBpm;

export const projectApi = {
  save: (project: TasmoProjectInput, path: string, embed_audio: boolean) =>
    postJson<{ status: string; path: string; manifest: ProjectManifest }>('/api/project/save', {
      project,
      path,
      embed_audio,
    }),
  /** Save the live session, embedding each clip's audio bytes (the editor's
   *  clips are in-memory blobs with no on-disk path, so plain /save can't link
   *  them). Each clip's audio_file must be ``audio/<file.name>``. */
  saveSession: (
    project: TasmoProjectInput,
    path: string,
    files: Array<{ name: string; blob: Blob }>,
  ) => {
    const form = new FormData();
    // A FILE part, not a text field: the backend's form parser holds a text
    // part to 1 MB, which about 9,000 notes filled, and the save failed.
    form.append('project', new Blob([JSON.stringify(project)], { type: 'application/json' }), 'project.json');
    form.append('path', path);
    for (const f of files) form.append('files', f.blob, f.name);
    return postForm<{ status: string; path: string; manifest: ProjectManifest }>(
      '/api/project/save-session',
      form,
    );
  },
  load: (path: string) =>
    postJson<{ project: TasmoProjectLoaded; manifest: ProjectManifest }>('/api/project/load', {
      path,
    }),
  info: (path: string) =>
    getJson<ProjectManifest>(`/api/project/info?path=${encodeURIComponent(path)}`),
  recent: () => getJson<RecentItem[]>('/api/project/recent'),
  defaultDir: () => getJson<{ path: string }>('/api/project/default-dir'),
  /** URL that streams a clip's on-disk audio file (for loading a project into
   *  the editor). The path is an absolute local path from the loaded project. */
  clipAudioUrl: (path: string) => `/api/project/clip-audio?path=${encodeURIComponent(path)}`,
  listAudio: (path: string) =>
    getJson<{ files: string[] }>(`/api/project/list-audio?path=${encodeURIComponent(path)}`),
};

// Build a .tasmo save payload from an imported DAW project.
let _seq = 0;
const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${_seq++}`;

/** Whether a file's clip sits in a grid cell rather than on the arrangement. */
const isGridClip = (c: Pick<TasmoLoadedClip, 'scene_index' | 'slot_index'>): boolean =>
  c.scene_index != null || c.slot_index != null;

/**
 * A PERFORM track's inserts in the file shape.
 *
 * A track opened from a .tasmo writes the file's own chain: PERFORM builds one
 * device per insert (lib/tasmoToSession) and edits none of them, and mapping
 * them back through dawDeviceToEffectNode would match an insert's name against
 * the rack, turning an effect an older import stored under a studio catalog id
 * ("compression", "reverb_delay") into the rack effect it resembles, enabled.
 * A DAW import's devices, the devices PERFORM put after the file's own, and a
 * chain shorter than the file's, are mapped (VST3 -> real, creative FX ->
 * rack, EQ/comp/reverb -> preserved), in order.
 */
function trackInsertsToTasmo(t: DawProject['tracks'][number]): EffectChainNode[] {
  const devices = t.devices ?? [];
  const own = t.tasmo?.effect_chain;
  // PERFORM changes a chain in two ways, and both keep the file's inserts in
  // place: a slot is bypassed (the device's own flag), and an effect or a
  // plugin is put on the END of the list. So the file's nodes are written as
  // they were, each with its device's bypass, and only the devices past them
  // are mapped.
  if (own && own.length <= devices.length) {
    const kept = own.map((n, i) => {
      const d = devices[i];
      let node = !!n.bypass === !!d.bypass ? n : { ...n, bypass: !!d.bypass };
      // A plugin whose window was opened in PERFORM holds a newer state than
      // the file's node (state/performVstState keeps it on the device).
      if (node.vst_state && d.raw_state && d.raw_state !== node.vst_state.raw_state) {
        node = {
          ...node,
          vst_state: { ...node.vst_state, raw_state: d.raw_state, ...(d.state_host ? { state_host: d.state_host } : {}) },
        };
      }
      return node;
    });
    if (own.length === devices.length) return kept.every((n, i) => n === own[i]) ? own : kept;
    return [...kept, ...devices.slice(own.length).map(dawDeviceToEffectNode)];
  }
  return devices.map(dawDeviceToEffectNode);
}

/**
 * The save payload for the project PERFORM holds.
 *
 * A DAW import is written from its parsed fields, with fresh ids. A project
 * PERFORM opened from a .tasmo (lib/tasmoToSession) keeps the file's own
 * project, track and clip records (`tasmo`), and each is written back with the
 * grid's own fields over it: the grid shows a track's name, fader, pan, mute,
 * solo, colour and inserts, and a clip's place, window, loop and follow action,
 * and nothing else. So the track ids, instruments and routing, each clip's id,
 * gain, fades, tempo, library entry, notes, render and takes, the insert ids
 * and plugin states, and the tempo and meter maps come back as they were
 * opened.
 */
export function dawProjectToTasmo(d: DawProject): TasmoProjectInput {
  const tracks: TasmoTrackInput[] = d.tracks.map((t) => {
    const trackId = t.tasmo?.id || uid('t');
    return {
      ...t.tasmo,
      id: trackId,
      name: t.name,
      type: t.tasmo?.type || (t.type === 'midi' ? 'midi' : 'audio'),
      volume_db: t.volume_db,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      // Session (Perform grid) clips are saved ALONGSIDE arrangement clips and
      // told apart by their scene indices — they used to be filtered out here,
      // which silently discarded the entire clip-launch grid on save. The EDIT
      // timeline filters session clips out on LOAD instead, which is where that
      // belongs.
      clips: (t.clips ?? []).map((c): TasmoClipInput => {
        const src = c.tasmo;
        // The Perform tab lays an arrangement-only track's clips out in scene
        // rows (tasmoToSession.ts). That layout is the grid's reading of the
        // file, not a placement anyone made: written back, it moved every clip
        // off the arrangement and the file reopened with an empty EDIT.
        const place = src && !isGridClip(src) ? src : c;
        return {
          ...src,
          id: src?.id || uid('c'),
          name: c.name,
          // Per-clip type: a clip with notes is MIDI even on an "audio" track.
          clip_type: src?.clip_type || (c.midi_notes && c.midi_notes.length ? 'midi' : 'audio'),
          track_id: trackId,
          start_time: c.start_time,
          end_time: c.end_time,
          // The grid holds no file for a MIDI clip (it plays the notes), so the
          // clip's saved render comes from the file's own clip.
          audio_file: c.file_path ?? src?.audio_file ?? null,
          // The file's own notes, in steps and ticks with their lanes and
          // expression. The grid holds them converted to seconds for playback.
          midi_notes: src ? src.midi_notes ?? null : c.midi_notes ?? null,
          loop_start: c.loop_start ?? null,
          loop_end: c.loop_end ?? null,
          // The trim point: without it a trimmed clip reopens playing its
          // source from the top.
          offset_into_source: c.offset_into_source ?? 0,
          // Carry the grid placement so the Perform tab can be restored exactly
          // rather than rebuilt from arrangement clips.
          track_index: place.track_index ?? null,
          scene_index: place.scene_index ?? null,
          slot_index: place.slot_index ?? null,
          // The other half of what a session grid is: where a clip sits, and what
          // it does when it finishes. Placement without the rule reopened a saved
          // set with every column playing one clip forever.
          follow_action: c.followAction ?? null,
          // A cell's own voice, so a save from PERFORM reopens it on its program.
          ...(typeof c.instrument_program === 'number' ? { instrument_program: c.instrument_program } : {}),
          ...(c.instrument_bank ? { instrument_bank: c.instrument_bank } : {}),
          ...(c.instrument_bank_id ? { instrument_bank_id: c.instrument_bank_id } : {}),
        };
      }),
      effect_chain: trackInsertsToTasmo(t),
      color: t.color ?? null,
      // The column's voice, so a save from PERFORM reopens every MIDI cell on it
      // with the program, bank and drum channel it had.
      ...(typeof t.instrument_program === 'number' ? { instrument_program: t.instrument_program } : {}),
      ...(t.instrument_bank ? { instrument_bank: t.instrument_bank } : {}),
      ...(t.instrument_bank_id ? { instrument_bank_id: t.instrument_bank_id } : {}),
      ...(t.is_percussion ? { is_percussion: true } : {}),
    };
  });
  return {
    ...d.tasmo,
    project_name: d.name,
    tempo: d.tempo,
    time_signature: Array.isArray(d.time_signature) ? d.time_signature.slice(0, 2) : [4, 4],
    sample_rate: d.sample_rate,
    source_daw: d.tasmo ? d.tasmo.source_daw ?? null : d.source_daw,
    import_warnings: d.tasmo ? d.tasmo.import_warnings ?? [] : d.warnings,
    // Scene names in row order, so a saved Perform grid reloads with the
    // user's own scene names instead of a generic "Scene 1..N" ladder.
    scenes: d.scenes ?? [],
    // TasmoProject has had locators and source_daw_version all along; nothing
    // wrote them, so markers vanished on first save and schema-drift bugs were
    // undiagnosable after the fact. A .tasmo keeps its own markers, ids and all.
    locators: d.tasmo
      ? d.tasmo.locators ?? []
      : (d.locators ?? []).map((l) => ({ id: uid('loc'), name: l.name, position: l.position, color: l.color ?? null })),
    source_daw_version: d.tasmo ? d.tasmo.source_daw_version ?? null : d.source_version || null,
    tracks,
  };
}
