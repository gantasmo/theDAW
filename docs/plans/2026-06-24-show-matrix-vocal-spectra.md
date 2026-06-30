# Show Designer matrix + Vocal suite + SPECTRA-RIDER + presets/pads: integration plan

Status: living plan. Created 2026-06-24 from a grounded multi-agent design pass (two
grounding agents reading the vocal2midi-architect and SPECTRA-RIDER repos and confirming
theDAW seams, four design lenses, one synthesis). Not in RAG. Design only; nothing built.

Companion to `docs/plans/2026-06-24-faceviz-sway-skeletal-integration.md`. The unified
matrix here is the surface the FaceViz `poseControlSource` and Sway `swayControlSource`
plug into rather than wire bespoke, so the two plans interlock.

## Decisions locked (2026-06-24, user)

- "CV" means COMPUTER VISION (the pose / skeletal / facial tracking already in the
  FaceViz / INFINIGHT module), not control-voltage. The FaceViz CV source and the vocal
  source are two inputs to the same mapping matrix; a gesture and a voice can co-drive the
  same target.
- The unified mapping matrix is the centerpiece and subsumes the separate DJ and VJ
  MIDI-mapping surfaces into one source-to-target grid with genre presets, per-song
  bindings, and mid-song FX/toggle pads.
- SPECTRA-RIDER comes in as a VJ cameraSource first, then a VR path once the source is
  confirmed live. Headset VR is in scope (immersive-vr works because the scene is synthetic).
- ASCII keeps its slot; VSTs stay queued after ASCII.

## The unifying insight (most of this is reuse, not new control plane)

theDAW already has both halves of the matrix, unjoined:

- Source half: `XrControlSource {area, buildEntries(), apply(id, value)}` in
  `frontend/src/state/xrControlClient.ts`. `xrControlDjSource.ts` already wraps a target
  catalogue into a source with zero per-control code. The FaceViz/Sway plan registers
  `poseControlSource` and `swayControlSource` through this same call.
- Target half: `BindableTarget {id, label, group, kind, min, max, step, unit, invoke}` in
  `frontend/src/components/surface/widgetTypes.ts`. `DJ_TARGETS` (`bindableTargets.ts`) is
  the only instance today, each a concrete live setter.
- Transport: the `/api/xr/control` relay already routes by id prefix. It stays the wire.

So the Show Designer is one canonical normalized data model, a fan-out binding engine, one
matrix UI, and a preset layer over the registries that exist. The three MIDI-learn stores
(`controllerMapStore` position-based, `djControlMap` action-based, `learnedProfilesStore`
capture-based) become the learn backing store for one `MidiDeviceSource`, not parallel systems.

## Plan W: the Show Designer mapping matrix

Effort XL, high impact. Land incrementally or it stalls.

Data model (new `frontend/src/state/showMatrix/`):
- `ControlSource {id, label, area, channels[], subscribe(cb(channelId, value|'trigger'))}`
  and `ControlChannel {id, label, group, kind: 'continuous'|'trigger'}`. This is exactly
  what `poseControlSource` / `swayControlSource` already emit (`pose.leftPinch`, `sway.strike`
  as 0..1 entries). A `MidiDeviceSource` adapter reads `midiBus` and emits one channel per
  learned control.
- Target shape is `BindableTarget` verbatim. Generalize off DJ by generating sibling
  catalogues from registries that exist: `VJ_TARGETS` from `midiParams.ts MIDI_PARAMS`
  (invoke routes through `controlSyncBus`/`sa3Bridge`), `FX_TARGETS` from `rackEffects.ts`
  `RackParamDescriptor`s plus a per-effect `ChainEntry` enable toggle (the FX pad), and
  `MAKE_TARGETS` from `makeTargets.ts` (the same file the FaceViz/Sway plan B7 calls for).
- `Binding {sourceId, channelId, targetId, curve?{invert, min, max, gamma}}`. The binding
  engine subscribes the channel, applies the curve, scales 0..1 into `[min,max]` reusing
  `scaleCcValue`/`scaleAudioValue` (`midiParams.ts`) and `toNative` (`controlSyncBus.ts`),
  and calls `target.invoke`. One channel may fan out to many targets (a Sculpt sweep driving
  a VJ tiling and an FX mix at once), which neither learn store can express today. Reuse the
  `controlSyncBus` `applying` echo-guard.

Steps M0-M9: define the model, build the source registry (mirrors the `sources` Map in
`xrControlClient`), wrap the three learn stores into one `MidiDeviceSource` (honoring the
master MIDI gate, default OFF), generalize targets, write the fan-out binding engine, adopt
the FaceViz/Sway sources through one thin `XrControlSource -> ControlChannel` adapter, build
`MatrixView.tsx` (rows = source channels grouped by source, columns = target groups, cell =
binding + per-cell LEARN, auto-populated from the manifest), and register the matrix's
aggregated manifest back onto the XR bus so every binding is reachable from a headset for free.

Accessibility (HARD RULE 3): native `<select>` pickers with id+name+`<label htmlFor>`; the
grid is `role=grid` with `aria-rowindex`/`aria-colindex`; cells and LEARN chips are custom
controls (never wrapped in `<label>`) carrying `aria-label` naming both axes; learning cells
expose `aria-live`; pads use `role=button` with `aria-pressed` (latch) / `aria-label`
(momentary). Tailwind v4 class forms only.

## Plan V: the Vocal suite

Effort L, high impact. One capture engine, four destinations.

Capture spine (new `frontend/src/lib/vocalToMidi.ts`): port ONLY the math from vocal2midi
`utils/audioProcessing.ts` (the from-scratch YIN `detectPitch`, `frequencyToMidi`,
`cleanupNotes` with 2-semitone hysteresis and the RMS-gated sensitivity curve), emitting
theDAW `RenderNote {midi, startSec, durationSec, velocity}` (a 1:1 rename from `NoteEvent`).
Reimplement the live frame loop as an `AudioWorkletNode` processor rather than vocal2midi's
deprecated main-thread `ScriptProcessorNode`. Return `VocalCapture {notes, onsets,
rmsEnvelope, pitchContour}`, where onsets and RMS come from the EXISTING
`frontend/src/lib/audioAnalysis.ts` (`detectOnsets`, `rms`, `downmixMono`). YIN is monophonic,
so the beatbox / effect / beat paths read the onset and RMS stream, never the YIN note list.

The shipped vocal2midi transcription is fully LOCAL in-browser DSP, not Gemini. The
`docs/progress-report.md` describing Gemini-makes-notes is a discarded experiment; the shipped
code reverted to local YIN. Port the YIN path, not the report.

Destination 1, the MIDI home: `VocalCapture.notes` feed `pianoRollStore`
(`pianoNotesToMidiNotes`) as an `editorStore` piano-roll clip, play through `soundfontEngine`
(SpessaSynth + the GM picker), export via `lib/midiWrite.ts notesToSmf`, and save as
first-class v5 stems+MIDI library items. The vocal2midi `midiSynth.ts` (dead
soundfont-player/oscillator-force), its canvas `PianoRoll.tsx`, the hand-rolled SMF binary,
and the no-RPN pitch-bend exporter are all dropped.

Gemini roles run server-side through `backend/assistant_routes.py`, never bundled
`VITE_GEMINI_API_KEYS` (a key/quota leak baked into the client). The three roles are metadata
(BPM / time-sig / instrument / sound-profile id), basic cleanup, and an 8192-budget Smart
Cleanup. Preserve the `gemini-3-flash-preview` id and thinking-budget params per HARD RULE 1.

The "Architect" agent's six tools (config / notes / playback) are exposed as TARGETS via
`registerXrControlSource`, so natural language, MIDI, and gesture sources all reach the same
actions through one bus. Keep the natural-language role; drop the standalone orb shell and its
browser key rotator.

Destination 2, vocal to INPAINTING: render `VocalCapture.notes` to a guide WAV
(`renderNotesToBlob` / SpessaSynth) and feed it into the already-wired inpaint contract.
`backend/server.py generate` already accepts `inpaint_audio` + `mask_start`/`mask_end`;
`generateStore.ts` already builds the FormData and `editorStore` `InpaintSelection` plus
`WaveformEditor.tsx` already select the region. So hum-to-inpaint is mostly wiring. The
Magenta alternative reuses the same notes through `buildMagentaFormData` (it already appends a
notes event list) for a section continuation.

Destination 3, vocal + CV to "vocalize an effect" and "beat for a section": on the onset / RMS
/ pitch stream, map a beatboxed timbre fingerprint to the nearest `rackEffects.ts` effect and
drive its params live via `setParams`, with `effectChainStore` `ChainEntry` toggles as the
manual pads. A FaceViz gesture (the CV input on the same matrix) can co-modulate the effect.
"Beat for a section" feeds onsets plus tempo (Gemini BPM or a small ported tap-tempo util) into
a triggered SpessaSynth GM-percussion pattern (deterministic default) or a Magenta RT beat
behind the existing reverse-swap guard. The timbre-to-effect matcher and the section-beat
trigger are the only genuinely new code in the suite.

SoulX is a downstream singing endpoint, not part of capture. The
`docs/guides/theDAW_SoulX_Singer_Integration_Guide.md` already in the tree scopes a separate
lazy `backend/modules/soulx_singer/` sidecar. The chain is VOCAL capture -> piano-roll clip ->
`notesToSmf` -> SoulX `midi2meta` -> SVS render. The vocal suite supplies SoulX's note/timing
metadata; SoulX synthesis stays its own build.

## Plan S: SPECTRA-RIDER as a VJ cameraSource + VR

Effort L, high impact. Drop R3F; port to a framework-free three.js class.

De-JSX to `GANTASMO-LIVE-VJ/src/spectra/SpectraRenderer.ts` modeled 1:1 on
`cymatics/CymaticsRenderer.ts` (build / animate / dispose, `getLevels`-driven, three/addons
`EffectComposer` + `UnrealBloomPass`, fixed offscreen size, `captureStream(30)` via a
`useSpectra.ts` hook mirroring `useCymatics.ts`). The `<mesh>`/`<shaderMaterial>` declarations
become `new THREE.*`; `useFrame` bodies become one `animate()`; the inline GLSL extracts into
`spectra/*-shader.ts`. The five camera modes (Canyon Flight, Dynamic Orbit, Bird's Eye, Deep
Horizon, Free Flight) port as plain math on a `PerspectiveCamera` switched by `this.mode`,
defaulting to a hands-off Auto-Pan so the source runs without keyboard focus. R3F must be fully
removed so a second three instance and a competing render loop never enter the VJ's three 0.184.

The load-bearing seam is audio. SPECTRA-RIDER's look IS a frequency spectrogram, but the VJ
and host bridge carry only four collapsed bands. `useAudioAnalyzer.ts` already runs
`getByteFrequencyData` on a 128-bin AnalyserNode, so add a sibling `getAudioSpectrum():
Uint8Array | null`, and add an optional 128-byte spectrogram-column field to
`sa3Bridge.ts ExternalAudioLevels` so the SA3 host (whose cymatics analyser already runs
`getByteFrequencyData`) can forward real detail. `SpectraRenderer` runs SPECTRA-RIDER's exact
mel-mapping over that buffer, falling back to the four bands. Without this the terrain collapses
to four flat plateaus, so the spectrum getter ships with the source, not later.

UI: a SPECTRA chip + sub-panel in `VJControls.tsx` mirroring the cymatics TogglePad row (five
camera-mode pads, Auto-Pan, a theme dropdown with a real label, and the akvj-style slider rack
for sensitivity / smoothing / noise-gate / height / energy-impact), plus new `VJState` fields.
Wire the source through the same six-edit cameraSource pattern as cymatics/akvj3d.

VR: unlike the AR-over-webcam cases, SPECTRA-RIDER is a synthetic scene, so it runs in
immersive-vr. Route A (recommended first): a minimal in-VJ WebXR session on the same
`SpectraRenderer` (`renderer.xr.enabled`, a VRButton, `setAnimationLoop`), with the camera
pinned to a fixed vantage so the headset pose owns the look. Route B (held as the polished-show
path): re-implement the terrain shader in HLSL inside theDAW-XR Unity, fed the same spectrogram
column over the `/api/xr/control` + QuestMIDI relay for passthrough, hand-tracking, and
colocation. VR is gated on the cameraSource being confirmed live.

## Plan P: presets + per-song bindings + pads

Effort L. Three persistence tiers over one binding table.

- PRESET tier: `presetStore.ts` (zustand+persist, cloning the `setlistStore.ts` idiom).
  `MappingPreset {id, name, genre?, bindings, fx: ChainEntry[], vjLook?, pads}`. FX state
  snapshots reuse `effectChainStore.ChainEntry[]` verbatim. Genre presets seed from the
  absorbed vocal2midi `GENRE_PROFILES` / `SOUND_PROFILES` CC maps so a "techno" or "ambient"
  preset arrives pre-wired.
- PER-SONG tier: per-song bindings must NOT ride the library PATCH, because the backend
  `USER_MUTABLE_FIELDS` whitelist (`store.py`) drops unknown fields. Use a `songBindingStore.ts`
  keyed by library entry id (the orphan-tolerant pattern `setlistStore` already uses), storing
  only the DIFF against the active preset so a preset edit still flows to songs that did not
  override that target.
- Composition: `resolveActiveBindings(entryId)` = preset base, then per-song overrides win per
  targetId, then live pads apply transiently and never persist. A latch pad reverts to the
  composed base, not the bare preset.
- PADS: a `PadAction` tagged union over the named moves (launch/toggle an FX `ChainEntry`
  snapshot, mute/solo a stem, swap a VJ look, fire any `BindableTarget`). A surface pad and a
  matrix pad are one record; pads learn through the same loop.
- Auto-recall on track load through the existing now-playing signal, with explicit-edit
  precedence so recall never clobbers an in-progress edit (the vocal2midi genre-auto-overwrite
  bug is the precedent).

## Where these slot into the "coming up" queue

Smallest-valuable-first, respecting the one hard dependency (the matrix foundation should land
before or with FaceViz/Sway so those sources plug in as channels rather than needing a retrofit):

1. ASCII (ASCILINE GPU glyph source) -- unchanged head of the list.
2. SPECTRA-RIDER VJ cameraSource (+ the `getAudioSpectrum` / sa3Bridge column). Lowest
   dependency, immediate visible win.
3. VSTs -- unchanged, stays after ASCII.
4. Unified mapping matrix FOUNDATION (M0-M4: model + source registry + MidiDeviceSource + one
   target catalogue + binding engine). Lands before FaceViz/Sway.
5. Skeletal tracking + segmentation + AR.
6. FaceViz module (now consumes the matrix as a ControlSource).
7. Sway controller (consumes the matrix).
8. Presets + per-song + pads (layers over the matrix; genre seeds from item 9's vocal2midi data).
9. Vocal suite destination 1 (capture engine + piano-roll landing + library item).
10. Vocal: Gemini server-side + Architect-on-bus + vocal-to-inpainting.
11. Vocal: vocalize-an-effect + beat-for-section (the trickiest, genuinely new code, last).
12. SPECTRA VR Route A (gated on item 2 signed off live); Route B held as a later show item.
13. SoulX singer sidecar (its own multi-phase build; downstream of the vocal suite).

## Risks

- GPU/CPU contention: SPECTRA's terrain + walls + particles + Bloom on top of the VJ's chain,
  plus a per-frame YIN worklet, plus a possible Magenta RT model swap. Needs render-scale tiers,
  density sliders, and the reverse-swap guard.
- Cloud dependency: vocal transcription is fully local (works offline); only Gemini metadata /
  cleanup / Architect degrade without network. Route Gemini through the backend, never bundled keys.
- Inpaint fidelity is unproven (monophonic guide); open whether note/timing metadata can also be
  passed as explicit region conditioning into the DiT.
- Do not pin model/library versions from memory (HARD RULE 1): the `gemini-3-flash-preview` id and
  thinking budgets are current; the backend catalog is the source of truth.
- Licensing: confirm vocal2midi (incl. MusyngKite GM samples, already replaced by SpessaSynth +
  bundled GM SF3), SPECTRA-RIDER's three/R3F stack, and SoulX before absorbing.
- a11y on the dense matrix grid is the hardest surface in the batch; do not regress HARD RULE 3.
- Visual work needs the user's eyes; tsc/build/lint/unseen screenshots never count.
- Scope creep: the matrix touches DJ, VJ (separate repo), FX, MAKE, the library schema, and XR.
  Pick one canonical binding shape and land incrementally.
- Preset/per-song clobber: recall must not overwrite a hand-tweaked binding; needs explicit-edit
  precedence + confirm.

## Open questions for the user

- CV is resolved (computer vision). Remaining:
- Fan-out conflict policy: when two sources bind one target, last-writer-wins or a priority order?
- Per-song persistence: localStorage keyed by entry id (no backend change, not synced) or a
  backend bindings column (approval-gated migration, gives sync/export)?
- Vocalize-an-effect: should a beatboxed timbre PICK one effect (classifier) or DRIVE several
  params of an active effect (continuous)? The matcher design differs.
- Beat-for-section default: deterministic GM-percussion (no model swap) or Magenta RT (richer,
  GPU-swappy mid-show)?
- SPECTRA VR: ship Route A (in-VJ WebXR), or invest in Route B (theDAW-XR Unity HLSL)? Is
  colocated multi-headset VR in scope here?
- Does the unified matrix fully replace the existing DJ MIDI-learn panel and VJ MidiPanel, or do
  those remain as per-area shortcuts writing into the same store?
- SoulX: assume the sidecar exists, or ship a stub handoff until its own build lands?
