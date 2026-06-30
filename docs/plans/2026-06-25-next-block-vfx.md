# Next block: generative VFX sources + body control + sung voice

Status: living plan. Created 2026-06-25 from a grounded multi-agent design pass
(five grounding agents reading the live VJ + theDAW + source repos, three brainstorm
lenses, one synthesis). Not in RAG. Design only; nothing built. Reordered per the
user: Sway lands before skeletal/INFINIGHT.

Scope: an ASCII source, a generic GLSL shader source seeded by yotta, the Sway
controller, skeletal/INFINIGHT body tracking, and the SoulX singing sidecar. The
SPECTRA source is already built and is awaiting the user's eyes, so it is out of
scope here. Companions: `2026-06-24-show-matrix-vocal-spectra.md`,
`2026-06-24-faceviz-sway-skeletal-integration.md`, `2026-06-24-akvj-volcap-roadmap.md`.

## 1. yotta / generic GLSL shader source -- the design

yotta (`D:\StableAudio\yotta`, MIT, Matthias Hurrle / atzedent) is a fullscreen
WebGL2 fragment-shader raymarcher using atzedent's uniform convention (time,
resolution, move, touch, pointerCount, zoom, wheel, startRandom, daytime), with
`wheel.y` scrubbing a Catmull-Rom camera spline. That uniform convention is shared
across a large library of atzedent shadertoys, so the leveraged move is a generic
loader, with yotta as its first entry. The VJ port drops the live-code editor and
pointer steering, then follows the camera-source pattern the VJ already proves with
Cymatics and Spectra: a framework-free renderer class draws to an offscreen canvas,
a React hook owns the lifecycle and `captureStream(30)`, and VJControls exposes the
chip plus a settings sub-panel.

- Renderer stays a raw WebGL2 single quad like yotta's own `Renderer`, so
  performance matches the original and the existing `performanceMode` lever covers
  heavy raymarchers.
- Audio reactivity injected each frame from `getAudioLevels`: `u_bass`, `u_mid`,
  `u_high`, `u_volume`. The 256-bin `u_spectrum` from `getAudioSpectrum` (already
  added for SPECTRA) is a deferred v2 lever and stays out of scope this block.
- Auto-advancing `wheel.y` and `time` replace the dropped mouse interaction, so the
  source runs hands-off.
- A `test()` compile method validates the fragment source at load and routes a
  failure to the existing camera error banner, so a bad shader never renders silent
  black.
- yotta's MIT attribution (Matthias Hurrle) lives in code comments plus an
  attribution surface, which also clears the latent Cymatics/Spectra attribution debt.
- Build single-yotta-first to prove the pipe end to end, then generalize to a source
  string loaded from library entries once the uniform plumbing and compile-error path
  are sound.

The six VJ cameraSource seams:
- `GANTASMO-LIVE-VJ/src/types.ts` -- add `'shader'` to the cameraSource union plus
  `shaderUrl` / `shaderLibraryId` / `shaderAudio` fields in `DEFAULT_VJ_STATE`.
- `GANTASMO-LIVE-VJ/src/useMedia.ts` -- add `'shader'` to the generative-source
  guard, a positional `shaderStream` param after `spectraStream`, a genStream
  ternary branch, and the effect dep-array entry.
- `GANTASMO-LIVE-VJ/src/App.tsx` -- add the `useShader` hook after `useSpectra`,
  pass `getAudioLevels` plus `shaderUrl`, inject `shaderFeed.stream` into `useMedia`,
  add a SourcePreview block.
- `GANTASMO-LIVE-VJ/src/components/VJControls.tsx` -- add the SHADER chip plus a
  sub-panel with a library/URL picker and audio-reactivity controls, each
  ARIA-labelled, Tailwind v4 forms only.
- `GANTASMO-LIVE-VJ/src/shader/ShaderRenderer.ts` -- new raw WebGL2 class on yotta's
  Renderer pattern: `constructor(canvas, getAudioLevels, shaderSource, opts)`,
  `updateShader()`, `test()`, `render(time)`, `dispose()`.
- `GANTASMO-LIVE-VJ/src/useShader.ts` -- new hook on the useCymatics/useSpectra
  lifecycle: fresh canvas on enable, instantiate, `captureStream(30)`, dispose plus
  stop tracks on cleanup.

## 2. Sequenced build order (reordered: Sway before skeletal)

Control-bus note: the XR control bus (`registerXrControlSource` in
`frontend/src/state/xrControlClient.ts`, routed by the `/api/xr/control` relay) already
exists and `djControlSource` already publishes on it. So Sway and pose can register as
working sources on the EXISTING bus now. The unified Show Designer matrix is the later
UI that subsumes DJ and VJ mapping into one grid; it is an enhancement, not a hard gate
for getting Sway or pose live. Confirm that call when Sway is built.

1. **ASCII source (ASCILINE port, head slot).** State: ASCILINE is readable at
   `D:\StableAudio\ASCILINE`; the VJ camera-source pattern is proven; no asciiline
   implementation exists. First step (no code): read `AsciiMapper.convert`
   (`ascii_video_player2.py` ~lines 129-181) and write a luminance-to-glyph GLSL
   porting spec (pseudocode, reference palette, BGR-to-RGB, ramp-bin quantization).
   The port's correctness depends on capturing the original semantics exactly. Effort:
   L. Dependencies: ASCILINE for the algorithm; CymaticsRenderer as the structural
   template; MIT-plus-anti-advertisement attribution in code comments and ACKNOWLEDGMENTS.

2. **Shader / yotta source.** State: no shader camera source exists; yotta is readable.
   First step: build `ShaderRenderer.ts` as a minimal standalone raw WebGL2 quad
   rendering one yotta fragment source with the four audio-band uniforms and
   auto-advancing `wheel.y`, proven before the six seams are wired. Effort: L.
   Dependencies: WebGL2 baseline; `getAudioLevels` (already wired); yotta MIT
   attribution.

3. **Sway controller ingestion.** State: theDAW's MIDI subsystem and the
   `registerXrControlSource` pattern are complete; no Sway profile, `swayBus`, or
   `swayControlSource` exists; Sway enumerates as class-compliant but unmapped; the Web
   MIDI master gate defaults off. First step: create `swayControlSource.ts` as a copy of
   `xrControlDjSource` (area `sway`, `buildEntries` returns the six dims
   strike/sway/pulse/glide/press/sculpt at 0..1, `apply` routes to a `swayBus`),
   register it in `App.tsx` after `djControlSource`, and add a Sway profile row with
   `match=['sway','audima']`. Effort: M. Dependencies: `learnedProfilesStore` for
   capturing the six firmware-configurable CCs (never hardcode a CC; `swayBus` reads
   learned bindings at runtime); the MIDI gate is off by default. The unified matrix is
   optional here, not required.

4. **Skeletal + INFINIGHT body tracking (poseControlSource first).** State:
   FaceViz/INFINIGHT is a standalone Electron app with MediaPipe HandLandmarker plus
   PoseLandmarker; no local clone in the tree; `@mediapipe/tasks-vision ^0.10.35` is
   already a VJ dependency; the XR bus is production-proven. First step: build
   `poseControlSource` as a structural copy of `xrControlDjSource` (six 0..1 entries
   like armSpan, handHeight), fed by a new off-thread `gestureWorker.ts` running
   PoseLandmarker on the GPU delegate at ~8fps reduced to control scalars. Land the
   control source before any AR pixel output. Effort: L. Dependencies: MediaPipe
   versions verified live against the Google AI Edge table before pinning (HARD RULE 1);
   FaceViz fork license review before any code absorb; the `gesturecam` cameraSource and
   AR overlay come after and need live eyes (HARD RULE 2). MediaPipe issue #4757
   (blank GPU mask) and the `MPMask` readback trap block the segmentation-matte combos,
   not the pose-scalar source.

5. **SoulX singing-voice sidecar.** State: fully spec'd in the integration guide but
   unbuilt; no module directory, router, or worker; the magenta-rt2 sidecar is the
   structural template. First step: scaffold `backend/modules/soulx_singer/module.json`
   (enable=false) plus a stub `router.py` exposing `/health` and `/models` that probe
   the env and checkpoints without spawning a process, establishing the module contract
   and the `midi2meta` handoff boundary. Effort: XL. Dependencies: the vocal-capture
   engine (YIN pitch detection, RenderNote emission, library stem binding) is a separate
   L build that must land first, or SoulX sits headless with no test data; `notesToSmf`
   already exists in `midiWrite.ts`; the magenta job/poll and WSL spawn patterns; model
   downloads at setup; the reverse-swap guard to park SA3 before a render; the mandatory
   metadata-review UI per the guide.

Honest blocking summary: steps 1 and 2 block nothing and can proceed immediately, in
parallel. Step 3 (Sway) and step 4 (pose) ride the existing XR control bus; the unified
matrix UI is a later unifier, not a prerequisite. Step 5 (SoulX) is blocked end-to-end
by the unbuilt vocal-capture engine; its scaffold can land but cannot be tested until
capture exists.

## 3. Top novel cross-tool VFX combinations

1. **Glyph-skin.** The live webcam runs through ImageSegmenter (matte kept on-GPU via
   `getAsWebGLTexture`); the matte gates the ASCII glyph ramp so the performer is
   spelled out in audio-jittering ASCII while the background dissolves. Seams:
   `AsciilineRenderer.ts` (setMatteTexture), `akvj/gestureWorker.ts`, `useAsciiline.ts`.

2. **Skeleton-flown raymarcher.** PoseLandmarker scalars map onto yotta's native
   move/zoom/wheel/touch uniforms (centroid to move, wrist span to zoom, hand height to
   wheel scrub, spine tilt to roll), so any atzedent-convention shader becomes
   body-flyable with no shader rewrite. Seams: `shader/ShaderRenderer.ts`
   (setPoseUniforms), `akvj/gestureWorker.ts`, `useShader.ts`.

3. **Self-sculpting cloud.** The existing depthcloud path makes the performer a point
   cloud via in-browser monocular depth, while the same webcam's HandLandmarker scalars
   drive `AkvjCloudRenderer.setStyle` / `setParams` (pinch flips style, spread drives
   distance, fist collapses density). Seams: `useDepthCloud.ts`, `AkvjCloudRenderer.ts`,
   `akvj/gestureWorker.ts`.

4. **Body as one control event.** `poseControlSource` publishes six pose scalars over
   the `/api/xr/control` relay (transport-only), so one gesture binds to `DJ_TARGETS`
   (filter cutoff, crossfader, FX wet) on theDAW and to shader uniforms on the VJ, heard
   and seen as one event. Seams: `xrControlDjSource.ts`, `xrControlClient.ts`,
   `bindableTargets.ts`.

5. **Markerless AR raiment.** ShaderRenderer renders to an FBO, then a composite pass
   multiplies it by the on-GPU segmentation matte with a sternum-anchored UV from pose,
   so a raymarched texture flows across the dancer and edge-locks to the silhouette as
   on-body AR. Seams: `shader/ShaderRenderer.ts` (two-pass FBO), `akvj/gestureWorker.ts`.

6. **Sway six-dimension shader cockpit.** The six learned Sway dims map onto the
   shader's move/zoom/wheel plus three SDF-shape uniforms exposed in the control
   manifest, so the physical controller hand-flies the raymarcher with no CC hardcoded
   and two-way fader mirroring. Seams: `swayControlSource.ts`, `learnedProfilesStore.ts`,
   `shader/ShaderRenderer.ts`.

7. **Provenance autopilot.** The `sa3-vj/track-meta` channel already forwards model,
   title, source, and isPlaying on every load, so `useShader` derives `shaderLibraryId`
   from a model-plus-title hash and phase-locks wheel/time to track position, giving each
   generated track a reproducible look with no chip press. Seams: `sa3Bridge.ts`
   (subscribeToMeta), `useShader.ts`.

8. **Shader params as headset faders and recallable pads.** Register
   `shaderControlSource` on the XR bus so band gains and library selection surface as
   headset faders with no Unity authoring, and a saved per-song pad recalls
   `shaderLibraryId` plus the four band gains mid-set with the widget following back.
   Seams: `xrControlClient.ts` (publishControlChanged), `shader/ShaderRenderer.ts`.

## 4. Recommended start-here

Build the **shader / yotta source** first: `ShaderRenderer.ts` as the minimal standalone
raw WebGL2 quad rendering one yotta fragment source with the four audio-band uniforms and
auto-advancing `wheel.y`. It has the lowest dependency surface in the block (no control
bus, no MediaPipe worker, no sidecar, no license absorb), it produces an immediate
visible win to put eyes on (an audio-reactive fractal as a VJ source), and its uniform
plumbing, compile-error path, and captureStream lifecycle are the reusable spine that
combos 2, 5, 6, 7, and 8 all build on.

Run in parallel, no code: the **ASCII GLSL porting spec** (step 1, first step only),
since ASCII holds the head slot, the spec is load-bearing for a correct port, and writing
it does not contend with the shader build.

Then **Sway** (step 3), which rides the existing XR control bus and is pure reuse of the
`xrControlDjSource` shape, followed by **poseControlSource** (step 4), which unlocks
combos 2, 3, 4, and 5.
