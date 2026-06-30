# Where We Stand

A working status and roadmap for theDAW, kept for shared reference between Daniel
and Claude. It is the fast answer to "what is built, what is in flight, what is
next." For how a shipped feature actually works, use `docs/USER_GUIDE.md`; this
file tracks state, not behavior.

Last updated: 2026-06-28.

Status tags: **SHIPPED** = merged to `main`. **BUILT** = on a branch, not merged.
**PENDING** = designed or queued, not built. **OPEN BUG**. **BLOCKED** = waiting
on an external gate (hardware, a decision, disk).

---

## 0. Latest: VST3 hosting, DAW import, .tasmo projects, .gan plugins (BUILT)

On `feat/sway-pose-control`, **BUILT** (not yet merged to `main`):

- **VST3 hosting** (`backend/modules/vst/`) via [pedalboard](https://github.com/spotify/pedalboard):
  scans the standard VST3 folders, lists built-in effects, and processes audio. VSTs
  appear in the MIX effects browser/chain and process through `/api/vst/process-file`.
- **DAW import** (`backend/modules/dawimport/`): parsers for Ableton `.als`, Reaper
  `.rpp`, FL Studio `.flp`, Audacity, Audition, Bitwig, and Resolume, plus Logic /
  Cubase / Pro Tools export hints. Surfaced by a header **DAW Import** modal.
- **.tasmo projects** (`backend/modules/project/`): save/load whole sessions as a
  ZIP + MsgPack bundle with optional round-trip audio embedding. Header **Project** modal.
- **.gan web-plugins** (`backend/modules/plugin/`): a portable pseudo-VST format
  (ZIP + manifest + web assets), an importer for VST Foundry exports, and a sidecar
  packager. All `.gan`s are GANTASMO-attributed. Right-click a plugin to reveal its
  `.gan` in the OS file manager.
- **The Owl**: the HRTF spatializer's front-end, rebuilt over the "the OWL" artwork in
  the MIX Effect Stage footprint. 4 SLIDE sliders (azimuth/elevation/distance/depth),
  centre knob (rate), 12 mode buttons, the real Kaoss + spatial-room canvases driving
  the live rack. Packaged as a sidecar `data/plugins/the-owl.gan`.
- **EDIT LAYOUT** moved to the global top header (one flag drives design mode across
  MIX/DJ/TRAIN). MIX play/pause/stop transport on the input/output rows. EDIT VSTs via
  a master-bus freeze (Live / Frozen toggle).
- **Dev backend launch fix**: electron now spawns the backend with the venv Python in
  dev (was `uv run`, which fails when uv's cache is unavailable and left no backend on
  :8600 — every `/api` call then read as 500 through Vite's proxy).

PENDING: native JUCE/iPlug2 WebView VST3/CLAP shell (the "loads in a third-party DAW"
path); MIX styling pass to match DJ; effect thumbnails as per-effect visualizer images.

---

## 1. EDIT tab: performance FX, instruments, automation

The EDIT timeline grew a full performance and automation layer this cycle. All of
the following is **SHIPPED** (merged via PRs #38-#42):

- **Psychoacoustic insert FX rack**, master bus and per track, baked into COMMIT
  EDIT through the same node factories used live: Headphone Crossfeed, Phantom
  Bass, Stereo Widener, Aural Exciter, HRTF Spatializer, Loudness Contour.
- **Spatializer** with twelve motion modes, including onset-driven **Teleport**
  and the live **Autopilot** choreographer (analysis-driven 3D motion).
- **Metamorph** granular identity-bleed morph (donor A rebuilt out of host B's
  grains), live and render-to-clip.
- **Performance FX**: OWL-Pad XY pad, Gater, Bitcrush, Ring Mod, and the MPC-style
  **Chop** (stutter / beat-repeat / shuffle, AudioWorklet).
- **Instruments**: per-clip and per-track GM instrument override, live MIDI
  timeline playback through the SpessaSynth soundfont engine (bundled `gm.sf3`),
  and the procedural voice banks (psychoacoustic, formant Talk-Box, glitch-hop).
- **Automation (Phase E, slices 1-2)**: lane model + WRITE mode; recording track
  volume/pan and any FX param (OWL-Pad, spatializer, filters) by riding the control
  while playing; sample-accurate native vol/pan envelope scheduling plus a ~40 Hz
  FX-param lookahead writer; read-only lane curves drawn over each track.

**PENDING in EDIT:**
- Automation **E4-full**: draw / drag / delete breakpoints, and the fader/pad
  visually following automation during playback (today the audio follows, the
  knob does not move).
- Automation **E5**: bake lanes into the COMMIT EDIT offline render so exports
  carry the moves (native params via the offline `AudioParam` timeline, FX params
  via pre-scheduled `updateParams`).
- Chop polish: a program dropdown instead of the 0/1/2 slider, and a momentary
  "hold to chop" trigger. Gater tempo-sync (it is free-running Hz today).
- Live verification of the chop and glitch worklets by ear is still wanted.

## 2. Library, stems, MIDI, notation

- **SHIPPED**: stems and MIDI as first-class library rows (play, favorite,
  delete, route) in their own sub-tabs; audio-to-MIDI conversion; the soundfont
  and GM instrument picker.
- **SHIPPED notation (phases 1-3, 6, 7)**: the artifact layer, MusicXML / ABC /
  guitar tabs (alphaTab), arrangements (lead-sheet / piano / simplified /
  band-score), and prompt inference from a score. Sheet music export is ABC /
  PDF / SVG (PDF and SVG need MuseScore present).
- Note on "auto scoring": there is no direct optical-music-recognition path from
  audio to a score. Audio becomes a score by first converting to MIDI
  (`basic_pitch` / piano transcription), then rendering the MIDI to MusicXML /
  tabs / arrangements. Documented in USER_GUIDE section 33.
- **PENDING notation**: Phase 4 (MT3 transcription), Phase 5 (OMR), Phase 8
  (notation-reactive visuals).

## 3. DJ tab

- **SHIPPED (D1-D7)**: two decks with beatmatch sync, key-lock, live stems with
  per-stem faders, FX + limiter, hot cues, cue/headphone via `setSinkId`, DJ
  MIDI-learn, automix, a sampler bank, a side-list staging lane, and DJ folder ->
  playlist add.
- **PENDING**: D7 four-deck mode (a larger refactor), D8, deck persistence, and
  true real-time stems (today stems are pre-separated). The shipped UI is
  two-deck only.

## 4. VJ tab

- **SHIPPED**: the VJ app runs as an embedded module with auto-spawn; the
  Resolume-style clip-grid layout; a native OS folder picker for export; the
  video/media library backing VJ cues; and several live camera sources
  (microphone, MIDI, phone on the LAN, device camera, screen/window capture,
  cymatics, and the Quest sources below).
- **SHIPPED broadcast signaling**: a WebRTC signaling module for a live
  watch-link of the VJ output.
- **PENDING**: the VJ UI punchlist (banks-as-rows, wheel scroll, drag
  Library->banks, footer play/pause reflecting real playback); a Resolume-modeled
  visual pass on the media library; the GO-LIVE broadcaster front end plus a
  DJ-audio host->iframe hop and a TURN relay for public watch-links.

## 5. XR / Quest integrations

These are the headset features. All **SHIPPED** to `main`, with the headset-side
pieces living in theDAW XR (the GANTASMO-MIDI Unity project). The point of the design is that
none of them need Quest Link (PC tethering) or Meta Quest Developer Hub casting;
they ride plain ADB (USB or wireless) with auto-started relays.

- **delinQuest**: streams the Quest's video into the VJ as a live source over a
  scrcpy relay, decoded in the browser with WebCodecs. 16:9 or side-by-side 3D.
- **queststitch**: streams only the clean stitched passthrough (the real-world
  composite) into the VJ as a separate "STITCH" source, via a Unity MediaCodec
  H.264 encoder and a backend TCP-to-WebSocket bridge.
- **Quest MIDI bridge** (QuestMidiBridge): two-way MIDI between the headset and
  the DAW over an ADB-reversed TCP socket. The `questmidi` backend module
  republishes it on the global MIDI bus with no loopMIDI needed; loopMIDI is the
  fallback for a non-theDAW WebMIDI DAW.
- **Hand-tracked control of theDAW**: a floating 3D MIDI surface (faders, knobs,
  buttons, crossfader) plus hand microgestures emit MIDI over the bridge onto the
  global MIDI bus, MIDI-learnable across DJ / VJ / MAKE / EDIT. The surface layout
  is data-driven and editable in VR.
- Documented in USER_GUIDE section 34.

- **OPEN BUG**: delinQuest is flaky on the main stream.
- **PENDING / BLOCKED (Quest colocation)**: co-located multiplayer for the
  QuestMIDI scene, driven by a one-click setup wizard (shared anchors + Meta
  Colocation Discovery + NGO over a LAN-direct transport), is built and wired in
  the editor but not headset-verified (BLOCKED on charging the second headset;
  needs Enhanced Spatial Services and a verified dev account). Plan:
  `docs/plans/2026-06-18-quest-colocation-plan.md`.
- **PENDING (Quest/Unity)**: MR free-roam (suppress Guardian + scene-mesh
  collider), hand-pose-to-MIDI (only microgestures exist today), an in-VR
  "add source" menu, and a scene optimization wizard.
- **PENDING (two-PC live set)**: two machines, both feeds mixable through the VJ
  or autoplay; needs the broadcast module's host / multi-input / audio-in rework.

## 6. Generation, models, setup

- **SHIPPED**: the MAKE model dropdown with SA3 <-> Magenta GPU auto-swap; the
  Settings -> Models panel (local checkpoints, no-download guarantee, Browse to
  register a checkpoint, generate-config, Locations, HF cache breakdown); and the
  manual model-placement guide (USER_GUIDE section 21.2: folder tree, download
  links, where T5Gemma lives, the real `sidecars/magenta-rt2-nvidia/Setup-MRT2.bat`
  path).
- **PENDING (Magenta RT2)**: vendor the model as a submodule, extend the sidecar
  to notes + audio-style conditioning, and finish the full frontend set. The
  backend module and the Generate-tab text-to-music path are shipped.
- **OPEN BUG / BLOCKED**: medium-model load can access-violate under commit-limit
  pressure when both disks are near full. Fix is to free disk + pagefile, or an
  approved streaming loader. The backend lazy-loads and parks models in RAM as a
  mitigation.

## 7. Infrastructure and maintenance

- **PENDING**: the 2026-06-10 codebase audit (124 findings) has judge rulings
  that are not yet applied.
- **PENDING**: zero-terminal onboarding remainder (an in-app surface for the
  MRT2 setup beyond the SETUP pill, and setup-script tests).
- **ONGOING**: RAG / doc maintenance. Doc edits are approval-based; this file and
  the current doc pass were explicitly requested.

## 8. Documentation and RAG

- The user-facing reference is `docs/USER_GUIDE.md`, indexed into the in-app
  assistant's RAG (`backend/rag.py` `DOC_PATHS`). The feature-to-doc coverage
  report lives at `docs/reports/feature-doc-coverage-report.md` and is
  regenerated by the pre-commit docs hook from `scripts/screenshots/specs.ts`.
- This pass added: this status file; USER_GUIDE section 34 (Quest / XR); an
  expanded section 10 (VJ camera sources, broadcast watch-link, autopilot visual
  effects); and a notation-pipeline clarification in section 33.
- Recently documented (earlier this cycle): the EDIT FX rack / spatializer /
  Metamorph (sections 7.7-7.10), first-class stems and MIDI (13.12), the
  soundfont and voice instrument picker (15.8), and manual model placement (21.2).

## 9. Branch map

`main` holds everything shipped. Recent feature branches (merged): 
`feat/library-stems-midi-first-class` (#38), `feat/edit-clip-instrument` (#39),
`feat/edit-kaoss-pad` (#40, #41, the OWL-Pad / glitch / chop / voices stack), and
`feat/edit-automation` (#42, automation slices 1-2). Older merged work covers the
VJ build, the model/storage panel, the MIX overhaul, the playlist suggester, the
Magenta RT2 integration, the SLIDE controller, and the Quest MIDI bridge.

## 10. Immediate next steps (suggested order)

1. Automation E4-full (lane editing + fader-follows-automation), then E5 (bake
   into COMMIT EDIT). Finishes Phase E.
2. Chop and Gater polish (program dropdown, momentary trigger, tempo-sync).
3. Live-verify the chop / glitch worklets and the full automation pass by ear.
4. The VJ UI punchlist and the GO-LIVE broadcaster, toward the two-PC live set.
5. Headset-verify the Quest colocation once the second headset is charged.
