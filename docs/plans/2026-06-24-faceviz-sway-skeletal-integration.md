# FaceViz + Sway + skeletal/segmentation/AR: integration plan

Status: living plan. Created 2026-06-24 from a grounded multi-agent brainstorm
(two grounding agents reading the real theDAW/VJ seams + verifying MediaPipe and
browser AR from live docs, three brainstorm lenses, one synthesis pass). Not in RAG.

## Decisions locked (2026-06-24, user)

- ABSORB FaceViz in-process as the VJ `gesturecam` source. FaceViz stops being the primary
  surface. gantasmo/INFINIGHTCapture-theDAW-module is a FORK of upstream
  morganlavery/INFINIGHTCapture, so any FaceViz-side change lands on the gantasmo fork and the
  user opens a PR upstream if Morgan wants it. The absorb itself moves code INTO the VJ, so most
  changes land in VJ + theDAW.
- Wire the gesture/pose control data into DJ controls (DJ_TARGETS) AS WELL AS VJ params: FaceViz
  becomes a hands-free DJ controller, not only a visual source. One poseControlSource feeds both.
- Headset AR is IN SCOPE and first-class (Plan C C4 markerless + C8 Quest path), not deferred.
- Push convention: VJ changes go to the `gantasmo` remote (gantasmo/VJ-9000; its origin push is
  disabled); theDAW changes go to origin (gantasmo/theDAW); never Stability-AI; never push without
  the explicit word in the moment and the user's live eyes on the visual work first.

## What these are

- FaceViz = gantasmo/INFINIGHTCapture-theDAW-module ("by DJ INFINIGHT"). A standalone
  React + Vite + Electron app. MediaPipe Tasks Vision HandLandmarker (2 hands x 21
  landmarks) + PoseLandmarker (33-point lite) feed a gesture engine, which drives a
  Canvas2D compositor (fire / melt / warp / bloom + a skeleton rig) and a Syphon (macOS)
  / Spout (Windows) texture-share output. Its own named weaknesses: the output path is a
  Canvas2D `getImageData` readback at 30fps (slow), the gestures collapse to five coarse
  booleans, and the product of the app is a flat texture rather than control data.
- Sway = Audima Labs "Sway", an expressive motion MIDI controller. Sixteen onboard
  sensors resolve to six dimensions (Strike / Sway / Pulse / Glide / Press / Sculpt),
  over USB-C plus hardware MIDI IN/OUT. It is class-compliant, so theDAW's MIDI subsystem
  already enumerates it with no driver work. Hardware also has 8 encoders, a 3.2-inch
  OLED, performance pads, and a motion-reactive RGB LED grid.
- New ask = skeletal/pose tracking with body segmentation/masking and AR. This is the
  same lineage as FaceViz, so it folds into one initiative.

## The unifying insight

Two existing pieces collapse all three of these into "wire to a seam we already have":

1. One control bus. `registerXrControlSource({area, buildEntries, apply})`
   (`frontend/src/state/xrControlClient.ts`) over the transport-only relay at
   `backend/modules/xrcontrol/router.py` already lets a namespace publish self-describing
   control entries and receive `control-set` values routed by id prefix. DJ is already
   wired this way via `DJ_TARGETS` (`frontend/src/state/bindableTargets.ts`). FaceViz
   gestures, Sway dimensions, and pose/face landmarks all become routable signals by
   registering one source each, with no per-control plumbing.
2. One source-agnostic renderer. `AkvjCloudRenderer.ts` (the VJ app) unprojects
   `pos = (rayX, -rayY, 1) * depth` in a vertex shader and applies 14 styles + bloom +
   audio reactivity. It does not care where depth and color originate. Two producers
   already prove it (`useAkvj3d` parsing Kinect AKV1 frames, `useDepthCloud` running
   Depth-Anything-V2 in a WebGPU worker). A segmented body or a sparse skeleton becomes
   a cloud by feeding the same `setXYTable` + `pushFrame` contract, inheriting every
   style and the audio reactivity for free.

So the strategy is: emit control data onto the existing manifest, and feed pixels into
the existing renderer. Almost nothing here needs new transport or new shaders.

## Plan A: FaceViz integration

Path decision: port the FaceViz trackers into the VJ in-process as a new `gesturecam`
cameraSource. Reject the Spout/Syphon bridge and the nested-module-iframe.

Justification (verified against code): the VJ is the consumer, so Spout/Syphon only exist
to cross an app boundary that disappears in-process. Receiving Spout needs an Electron-main
native addon and a GPU-to-CPU readback that reintroduces exactly FaceViz's `getImageData`
bottleneck, and it is Windows-only. A module iframe spawns a third nested browser GPU
context with no shared renderer. In-process reuses the existing off-thread worker pattern
and the cloud renderer, cross-platform, with zero transport and zero native code.

Steps:

- A0. Decouple first, no pixels. `gestureEngine.ts buildTrackedHand` already computes
  `openness`, `pinch`, `velocity`, `centroid`, `wrist` per hand, then `analyzeMotion`
  discards them into five booleans. Lift the continuous scalars before the boolean
  reduction.
- A1. Register a `poseControlSource` (area `pose`) modeled on `xrControlDjSource.ts`,
  exposing the continuous scalars as manifest entries (`pose.leftPinch`, `pose.rightOpenness`,
  `pose.handX`, `pose.bodyY`). Register beside `djControlSource` in theDAW `App.tsx`. A
  pinch now drives a filter cutoff or a clip launch through the same bus DJ uses.
- A2. Add `@mediapipe/tasks-vision` as a VJ dependency (it ships in the FaceViz clone, not
  yet in the VJ). Pull model versions from the live Google AI Edge model table, never from
  memory.
- A3. Create `src/akvj/gestureWorker.ts` mirroring `depthWorker.ts`: off-thread, reduced-res
  inference decoupled from the 60fps render loop, running HandLandmarker + PoseLandmarker
  on the GPU delegate.
- A4. Register the `gesturecam` cameraSource through the six known seams (the `types.ts`
  union AND the `useMedia.ts` signature default, the generative-source guard, the genStream
  ternary, a new positional stream param appended after `depthCloudStream`, the effect dep
  array, the `App.tsx` hook + standalone-preview block, and a `VJControls.tsx` SOURCE chip +
  status panel).
- A5. Write `src/useGestureCam.ts`: run the worker, composite the performer over generated
  visuals in a WebGL fragment shader, `captureStream(30)` the result. The composite never
  leaves the GPU, which is the FaceViz fix.
- A6. Optional add-on: add FaceLandmarker (`outputFaceBlendshapes:true`) in the same worker,
  exposing a curated subset of the 52 blendshapes (jawOpen, browInnerUp, mouthSmile) as extra
  `pose.*` entries, off by default, smoothed before driving audible params.
- A-fallback. If FaceViz must remain a separate app or run on a second PC, do not chase
  Spout/Syphon input. Replace its `outputTargets.ts` sender with an AKV1-framed depth+color
  emitter pointed at `backendWsBase() + '/api/akvj/ws/source'` (the akvj relay is
  frame-agnostic). One caveat: a single akvj source at a time, so this evicts the Kinect
  sidecar.

## Plan B: Sway integration

The Sway is already enumerated as class-compliant MIDI, so the work is destinations, not
transport. The master Web MIDI gate defaults OFF, so nothing sees the Sway until the user
enables MIDI. Never hardcode the Sway's CC numbers (firmware-configurable, no MIDI 1.0
layout query); bind every dimension by learn.

Steps:

- B1. Add one Row to `controllerProfiles.ts` for the Sway (`match=['sway','audima']`) with a
  bespoke sections layout that labels the six dimensions plus 8 encoders and the pads. The
  labels are physical layout only; the dims still bind by learn.
- B2. Build a small `swayBus` that reads the six learned CCs off the shared `midiBus` and
  normalizes each to 0..1.
- B3. Register a `swayControlSource` (area `sway`) with six entries
  (`sway.strike` ... `sway.sculpt`) fed by `swayBus`. The dims are now first-class routable
  signals on the same bus DJ uses, converging with the FaceViz gesture signals so a pinch and
  a Sculpt sweep can drive the same target.
- B4. Novel target 1, akvj cloud: a `sa3-vj/sway-params` branch in `sa3Bridge.ts` calls the
  renderer's `setParams` / `setStyle`. Map Sway to spin, Pulse to wind, Press to density,
  Glide to distance, Strike to a bloom/size transient, Sculpt to a style crossfade across
  `AKVJ_STYLES` (needs a small interp layer since `setStyle` is a discrete key).
- B5. Novel target 2, VJ FX + clip grid: learn each dim onto a `midiParams.ts MIDI_PARAMS`
  entry (one entry yields MIDI-mappable + crossfader-routable + audio-reactive at once).
  Suggested map: Press to feedback, Pulse to glitch, Sway to the CAM/MEM crossfader, Glide to
  hue, Sculpt to tiling, Strike to strobe. Clip launch on Strike uses note-on pads via DJ-style
  action learn.
- B6. Novel target 3, Spatializer 3D placement: map three dims through the exported
  `azElToXYZ` into a live Spatializer (`rackEffects.ts`): Sway to azimuth, Pulse to elevation,
  Glide to distance, via click-free `setParams`. Two-handed motion physically places a stem in
  3D space.
- B7. Novel target 4, MAKE/Magenta: register a second source (area `make`) wrapping concrete
  generation setters (`makeTargets.ts` modeled on `DJ_TARGETS`). Map Press to guidance, Glide
  to duration, Pulse to Magenta density/temperature, Sculpt to a prompt-A/B blend, Strike to
  trigger a generate. Honest limit: SA3 text-to-audio is request-time, so only Magenta RT gives
  true continuous live response.
- B8. Sway page UI: a view in `SlidePanel.tsx` with six live meters (from `swayBus`) and a
  routing matrix of destination pickers populated from `buildManifest()`. Every select needs a
  stable id+name+associated label and valid ARIA; custom dropdowns need aria-expanded /
  aria-haspopup. Tailwind v4 class forms only.
- B9. MIDI-OUT feedback (deferred behind a capability flag): theDAW keeps no MIDIOutput today.
  A `midiOutBus` could pulse the Sway's RGB grid on the DJ beat phase and color decks. OLED
  text needs SysEx, which the app deliberately avoids, so it forces a sysex opt-in and a second
  permission, plus an IN-to-OUT echo guard. The Sway's exact LED/OLED protocol is vendor-specific
  and not in-repo, so this is reverse-engineered without Audima's MIDI implementation chart.

## Plan C: skeletal tracking + segmentation/masking + AR

All inference runs off-thread at reduced res mirroring `depthWorker.ts`, reusing the
`sa3-vj/visibility` iframe park. Use a standalone ImageSegmenter (GPU) for the matte and
PoseLandmarker (GPU) for landmarks only, because PoseLandmarker's own segmentation mask
returns blank under the GPU delegate on web (MediaPipe issue #4757, still open).

Steps:

- C1. Matte as a renderer INPUT, not a new source. `segmentWorker.ts` runs ImageSegmenter
  (GPU, `outputCategoryMask:true`); `useBodyMatte.ts` returns a per-frame `WebGLTexture` mask
  via `MPMask.getAsWebGLTexture()` (stays on-GPU). A fragment pass composites performer RGB
  times mask over whatever cameraSource is active, keying out background. On-GPU green-screen
  with no chroma key. Never call `getAsFloat32Array` / `getAsUint8Array` in the hot path; call
  `mask.close()` each frame.
- C2. Sparse skeleton cloud, cheapest reuse first. Sample N points along each bone from the 33
  PoseLandmarker joints, pack X/Y into a one-time ray table (`setXYTable`) and per-frame depth
  into Uint16 mm (`pushFrame`). The performer renders as a glowing particle stick-figure in any
  style, audio-reactive, with zero new shader code.
- C3. Fuller body cloud. Clone `useDepthCloud.ts` to `useBodyCloud.ts`. After the depth worker
  returns `depthU16`, multiply each sample by the segmentation mask read ONCE at the ~8fps
  inference grid res (320 wide), zeroing background so the renderer culls it. Register a `pose`
  cameraSource through the six seams. Add temporal EMA/feather for edge shimmer.
- C4. Markerless AR overlay, no headset. `useArOverlay.ts`: getUserMedia, PoseLandmarker per
  frame, place three.js content (fingertip emitters, a chest cymatics ring, wrist wind affectors)
  at landmark positions mapped to camera-plane world coords, render over the mirrored video,
  `captureStream(30)`. Use the C1 matte as an occlusion gate. Do NOT implement as WebXR
  immersive-ar (unsupported on desktop browsers, absent in Firefox/Safari). The real cost is
  authoring the three.js scene, not the plumbing.
- C5. Pose to control data. The shared area `pose` source (same as A1) publishes pose world
  landmarks and FaceLandmarker blendshapes as 0..1 entries, bindable to DJ/VJ/MAKE and mappable
  onto `MIDI_PARAMS`. Update entry values in place; do not rebuild the manifest per frame.
- C6. Pose to 3D audio. Map a wrist/torso centroid through `azElToXYZ` into a live Spatializer
  (setParams for continuous, scheduleTeleport for beat-locked jumps).
- C7. Hero matting (optional QUALITY toggle). `matteWorker.ts` cloning `depthWorker.ts` runs
  transformers.js `pipeline('background-removal', ...)` on WebGPU with WASM fallback for clean
  hair/edge alpha, for hero/low-fps shots only. License gate: briaai/RMBG-1.4 has a
  non-commercial/commercial split; prefer an Apache/MIT model or MediaPipe for commercial use.
- C8. Headset path (separate effort). Stream the C3 masked body depth+color as AKV1 frames over
  the akvj relay and add a Quest-side consumer in theDAW-XR rendering on a transparent
  immersive-ar background. Quest Browser exposes no raw RGB passthrough, so only the
  already-segmented cloud crosses; one akvj source at a time means this evicts the Kinect sidecar
  unless a second relay or a source-id multiplex is added.

## Wild cross-tool combinations (the mind-blowing stuff)

Each ties to a real seam from the plans above, so they are buildable, not hand-waving.

- Conduct the generator. Sway Sculpt and FaceLandmarker expression drive Magenta RT live
  (density / temperature / prompt-A-B blend) while the performer's own segmented body is the
  visual via the body cloud. The body is both the controller and the picture. Seams: B7 makeTargets
  + B3 swayControlSource + C3 body cloud.
- You are the instrument and the visual. Pose drives audio (Spatializer + FX setParams) and the
  cloud that is literally your silhouette; a pinch fires a stem. Seams: C5 pose source + C6 spatial
  audio + C3 cloud + DJ live stems.
- Dancer as volumetric broadcast. The segmented body depth cloud is sent over the existing WebRTC
  broadcast/watch-link module to remote viewers, reconstructed on-device, so a remote audience sees
  a live volumetric performer. Seams: C3 body cloud + the broadcast module.
- Gesture-as-stem-mixer. Hands-up and openness map to DJ live-stem faders; body position pans each
  stem in 3D via the Spatializer. The DJ mixes with the whole body. Seams: A1/C5 pose source + DJ
  stems + B6/C6 spatializer.
- Two-performer colocation jam. One performer on Sway, one on FaceViz pose, both feeding the same VJ
  manifest; Quest colocation puts them in a shared AR space. Seams: B3 + A1 over the manifest +
  theDAW-XR colocation.
- Self-shading ASCII portrait. When the ASCII source lands (roadmap P4), render the body cloud as
  depth-driven glyphs: near is dense, far is sparse, font size tracks bass. The performer becomes a
  living volumetric ASCII figure. Seams: C3 body cloud + the ASCILINE source.

## Recommended build order (smallest valuable first)

1. `poseControlSource` (area `pose`) over the manifest. Smallest valuable unit, fixes the
   flat-texture weakness with no pixels, shared foundation for FaceViz + skeletal + Sway.
2. `swayControlSource` (area `sway`) + `swayBus` + the Sway controller profile. Pure reuse, makes
   the six dims routable immediately.
3. Sparse skeleton cloud into the renderer. S effort, zero new shaders, first visible skeletal win.
4. Sway to Spatializer 3D placement (azElToXYZ). S effort, intuitive payoff.
5. Sway to akvj cloud params (sa3Bridge branch). Headline novel destination; depends on 2.
6. On-GPU body matte compositor input. Unlocks green-screen and gates the fuller cloud.
7. Body-masked depth cloud (`pose` cameraSource). Depends on 6.
8. `gesturecam` cameraSource (FaceViz port in-process). L effort; reuses the worker from 3/7.
9. FaceLandmarker blendshapes + gesture/Sway to live FX rack setParams.
10. Markerless pose-AR overlay (`pose-ar`). L; three.js scene authoring is the real cost.
11. Sway to MAKE/Magenta `make` source. Needs new generation setters; only Magenta RT is truly live.
12. Sway page UI in SlidePanel. After enough destinations exist to populate the matrix; a11y-heavy.
13. Hero matting worker. Optional QUALITY toggle, license-gated.
14. Headset body-cloud over the akvj relay to theDAW-XR. L; Unity consumer + relay multiplex.
15. MIDI-OUT feedback to the Sway LED/OLED. Deferred; vendor protocol not in-repo.

## Risks

- GPU contention from stacking MediaPipe trackers + ImageSegmenter + the depth worker + the cloud
  renderer inside one iframe. Keep inference off-thread at reduced res, reuse the visibility park,
  share one WebGL context, and gate so depth + live matte + hero matte never run concurrently.
- The readback trap. `MPMask.getAsFloat32Array/getAsUint8Array` are the same GPU-to-CPU readback that
  is FaceViz's bottleneck. Stay on `getAsWebGLTexture` in the hot path; the one allowed `getAsUint8Array`
  (the body-cloud mask multiply) must stay at inference res.
- PoseLandmarker GPU segmentation mask is blank on web (issue #4757); use a standalone ImageSegmenter
  for the matte.
- Segmentation flicker at edges and on fast motion; 2-class selfie is body-only. Add temporal feather;
  use hair-aware matting only at low fps.
- The cameraSource union is duplicated (types.ts AND the useMedia.ts signature default), and a new
  stream param must be appended in exact positional order after `depthCloudStream` and added to the
  effect dep array, or the stream silently never binds.
- Spout/Syphon are platform-locked and input-hostile to the web; bridge over the frame-agnostic akvj
  relay instead.
- Do not pin model/library versions from memory (HARD RULE 1). Pull MediaPipe versions from the live
  Google AI Edge table; do not downgrade `@huggingface/transformers` or `@mediapipe/tasks-vision`.
- Licensing: MediaPipe Tasks models are Google AI Edge assets (Apache-friendly); briaai/RMBG-1.4 has a
  non-commercial/commercial split. Confirm FaceViz and Sway-software licensing permit absorbing or
  redistributing.
- Accessibility (HARD RULE 3): every new select, toggle, and SOURCE pad needs a real label + valid
  ARIA; never wrap a non-native control in `<label>`.
- Visual work needs the user's live eyes; tsc/vite build/lint/unseen screenshots do not count.
- MIDI master gate defaults OFF; never hardcode the Sway CC numbers; bind by learn.
- The akvj relay holds one source at a time; a body-cloud or external source evicts the Kinect sidecar.
  Connect VJ-to-backend WebSockets directly to :8600 via `backendWsBase()`.

## Open questions for the user (remaining after 2026-06-24 decisions)

- Sway MIDI implementation chart: is Audima's chart available for the LED/OLED feedback path, or is it
  purely reverse-engineered? Is a physical Sway on hand to learn the six CCs and verify routing live?
  (User: getting back on the MIDI chart.)
- Commercial-use posture: does theDAW ship as a product (forcing an Apache/MIT/MediaPipe-only matting
  choice), or is non-commercial acceptable for hero matting?
- Pose-AR look: who authors the three.js AR scene content? That authoring, not the plumbing, is the cost.
- MAKE/Magenta: which generation params are genuinely live-pushable today vs request-time only, and what
  are the prompt-A/B blend semantics before Sculpt can drive them?
