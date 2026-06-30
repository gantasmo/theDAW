# akvj3d -> general volumetric-video engine: roadmap

Status: living plan. Created 2026-06-24 from a multi-agent brainstorm. Not in RAG.

## The thesis

`AkvjCloudRenderer` (the VJ app, `src/akvj/AkvjCloudRenderer.ts`) does not care where
`rayX / rayY / depth / color` come from. It unprojects `pos = (rayX, -rayY, 1) * depth`
in a vertex shader, then applies the style behaviours (drift / evaporate / swirl /
scatter / wireframe) with `bass/mid/high/volume` already wired in. So the move is to
**stop treating depth as a sensor feature and start treating it as a texture any source
can produce**. Decouple the renderer from the Kinect and every video, webcam, screen
capture, or phone frame can drive it.

## What already shipped (this session)

- Native Kinect path: pyk4a sidecar (depth16 + depth-aligned colour over the AKV1
  WebSocket) -> `AkvjCloudRenderer` point cloud. Backend relay table-chunk aware,
  idempotent `/start`, verbose sidecar status, viewer connects direct to the backend
  (the dev proxy drops `/api` WS upgrades).
- Style system + behaviours: POINTS, DUST, FLOW, SWIRL (vortex), SCATTER (beat
  explosion), NEONVOX (voxel evaporation), WIRE (Battlezone green wireframe via
  `LineSegments`, gap-collapsed), ELECTRIC, FERRO, CHROME (fixed, controlled metal),
  CONFETTI. Camera spin slider (0 = frozen face-on). Audio reactivity through all of it.

## The headline next unlock: depth-ify any video (no depth camera)

Run a monocular depth model (Depth-Anything-V2) in the browser via transformers.js +
WebGPU, in a Web Worker, on ANY source frame, synthesize a depth texture, build a
one-time pinhole ray-table (`rayX = (u-0.5)*tanHalfFov*aspect`, `rayY = (v-0.5)*tanHalfFov`),
and feed the EXISTING renderer. Every clip in the library becomes a live, re-shadeable,
audio-reactive point cloud with zero new shader code.

Hard requirements (non-negotiable):
- Inference runs OFF the main thread (Web Worker) at reduced resolution (256-384px) and
  ~10-15fps, DECOUPLED from the 60fps render loop (GPU-upscale the depth texture), or the
  deck stutters.
- Temporally smooth the depth (EMA) because Depth-Anything output is RELATIVE/affine and
  flickers frame-to-frame. It is a stylized look, never a measurement.
- Pin the model id + transformers.js API from the LIVE HuggingFace / library source of
  truth, never from memory (CLAUDE.md hard rule).

Reuse: `useDepthCloud.ts` builds a synthesized pinhole ray-table once, then per frame maps
the model's normalized depth into the pseudo-mm range and calls the SAME
`AkvjCloudRenderer.setXYTable` / `pushFrame`. Add `cameraSource='depthcloud'` to the VJ
`types.ts` union + `useMedia`. The same STYLE selector + spin slider apply for free.

## Volcap transport on web/mobile

1. ENCODE: backend export bakes an akvj3d capture into ONE ordinary `.mp4` with Depthkit
   "Combined Per Pixel" layout (colour one half, HUE-encoded depth the other) + a sidecar
   JSON carrying the ray-table / intrinsics + near/far. Use the UCL/Hwang periodic
   triangle/sawtooth hue depth encoding (NOT naive hi/lo byte split, which H.264 DCT +
   4:2:0 chroma subsampling destroys); clamp near/far tight.
2. PLAY: replace the per-frame `createImageBitmap` + CPU `mm->m` DataTexture rebuild with a
   WebCodecs `VideoDecoder` feeding `VideoFrame` straight to a GPU texture (demux via
   mp4box.js). Hardware-decoded H.264/HEVC/AV1, near-zero CPU, 30-60fps at 1080p. Vertex
   shader unchanged. This is the single biggest "lower video overhead" win.
3. SPLAT tier: load `.splat/.ply/.ksplat` via a FOSS WebGL viewer (antimatter15/splat,
   mkkellogg GaussianSplats3D) now; WebGPU/TSL radix-sort compute upgrade later. Baked
   photoreal captures into the same VJ rack via `captureStream()`.

Budgets: live clouds 100-150k points mobile / 300-600k desktop; baked splats <3M mobile /
<5M desktop. WebGPU on iOS 26 / Chrome Android 12+; keep a WebGL2 + decimation fallback.
Remote viewers via the existing WebRTC broadcast module (depth+color mp4 as a normal track,
reconstructed on-device).

## ASCILINE (D:\StableAudio\ASCILINE)

Luminance-to-glyph video engine (FastAPI + OpenCV + Canvas2D). NOT line-art (gap to close).
Genuinely reusable piece: its adaptive frame codec (`codec.py`/`codec.js`: RAW/ZLIB/DELTA
conditional-replenishment, keyframe every 48, ~375x on static content; char plane exact,
colour plane lossy). License: MIT + anti-advertisement clause -> vendor with attribution,
port only the algorithm/palette/codec, never the slow Canvas2D `fillText` path.

Folds in three ways:
1. GPU ASCII source/effect: port `AsciiMapper.convert` to a GLSL pass with the 93-char ramp
   as a glyph-atlas texture; add `cameraSource='asciiline'` + an `asciiMode` token mirroring
   `akvjMode`. Re-renders any upstream texture as live typography at full framerate.
2. Depth-aware ASCII: pick the glyph by `depthMeters` instead of luminance (near = dense
   `@#%`, far = sparse `.` space) for a self-shading volumetric ASCII portrait; drive glyph
   font-size from depth + bass (the "dynamic font-size" idea). LOD: fall back to dots when
   glyph quads go sub-pixel.
3. Transport: adopt the codec for VJ thumbnails, watch-link/questcast feeds, weak devices.

## Audio-reactivity (depth-native, mostly 2-3 uniform tweaks)

Already: `gl_PointSize *= 0.7+bass*0.6`, displacement `*= 0.15+volume*0.85`, ferro spike
scales with bass, frag brightness `*= 0.85+high*0.6`. Extend with: bass depth-push
(breathing cloud, scale depth by `1+bass*k`), beat-triggered scatter/evaporate (bass-onset
derivative spikes displacement ~200ms), spectral color (bass->R mid->G high->B), beat-synced
decimation (drop/restore density on transients), high-band glyph jitter (ASCII), mid->hue
rotation.

## Recommended roadmap (each shippable, smallest valuable first)

- P0 Audio-reactivity pack (shader-only). MOSTLY DONE this session (scatter/evaporate/
  wireframe-flicker + reactivity); remaining: bass depth-push + spectral RGB mode + per-style
  intensity control.
- P1 Depth-ify any clip (monocular depth). THE HEADLINE, no hardware. `useDepthCloud.ts` +
  reuse `AkvjCloudRenderer`; Depth-Anything-V2-small via transformers.js WebGPU worker,
  EMA-smoothed, synth pinhole ray-table, `cameraSource='depthcloud'`.
- P2 Wireframe (DONE) + depth-edge line-art (Sobel/DoG on the DEPTH buffer -> contour glyphs).
- P3 WebCodecs depth+color playback + backend depth-in-video `.mp4` export.
- P4 ASCILINE GPU source + dynamic-font-size; adopt its codec as a low-overhead transport.
- P5 Mobile + remote volcap: stream depth+color mp4 to phones over WebRTC; accept phone-as-
  source over AKV1 (ARKit/ARCore or on-device monocular) with intrinsics added to the header.
- P6 Splat fidelity tier + WebGPU/TSL compute port of `AkvjCloudRenderer` (toward ~1M points).

## Coming up (kinda soon) — priority queue

The running upcoming-features queue layered on top of the P-phases above. ASCII keeps
its slot; everything else is sequenced smallest-valuable-first, with one hard dependency
(the Show Designer mapping matrix lands before or with FaceViz/Sway so those plug in as
sources rather than needing a retrofit).

1. ASCII source (P4 above): ASCILINE GPU glyph source, depth-driven glyph density,
   dynamic font size, audio-reactive.
2. SPECTRA-RIDER VJ cameraSource: port the 3D audio spectrogram-terrain visualizer in as a
   framework-free three.js source like cymatics, plus the `getAudioSpectrum` 128-bin audio
   seam it needs. Lowest dependency, immediate visible win. See the Show Designer plan.
3. VSTs (re-added after the earlier deferral): host VST/CLAP audio plugins in the MIX /
   FX chain. A licensing and hosting-approach pass is needed before building.
4. Show Designer mapping matrix (foundation): one source-to-target grid that subsumes the
   separate DJ and VJ MIDI mapping. Lands before FaceViz/Sway. See the Show Designer plan.
5. Skeletal tracking with segmentation and AR: MediaPipe pose plus body segmentation /
   masking to cut the performer out of the webcam, then composite AR layers and drive
   particles and clouds from the skeleton. Delivered together with the FaceViz module.
6. FaceViz module integration: fold the gantasmo INFINIGHTCapture / FaceViz gesture-mocap
   app into theDAW (absorb, in-process). Now consumes the matrix as a control source.
7. Sway controller integration: ingest the Audima Sway expressive motion MIDI controller
   as a control source on the matrix and route its six dimensions across DJ, VJ, akvj, FX, XR.
8. Presets + per-song bindings + pads: genre presets, bindings saved per song and recalled
   on load, and FX-rack/toggle pads for mid-song changes, layered over the matrix.
9. Vocal suite (capture + MIDI home): absorb vocal2midi-architect as one in-browser YIN
   capture engine landing in the piano roll / channel rack / SpessaSynth.
10. Vocal suite (generation): Gemini metadata/cleanup server-side, the Architect agent onto
    the control bus, and vocal-to-inpainting through the already-wired inpaint contract.
11. Vocal suite (performance): vocalize-an-effect (beatbox timbre drives an FX) and
    beat-for-a-section. The trickiest, genuinely new code, last of the vocal items.
12. SPECTRA VR (Route A, in-VJ WebXR), gated on item 2 being confirmed live. Route B
    (theDAW-XR Unity HLSL) held as the polished-show follow-up.
13. SoulX singer sidecar: the singing-voice endpoint of the vocal suite, its own multi-phase
    build (see `docs/guides/theDAW_SoulX_Singer_Integration_Guide.md`).

Design for items 4-8 + 9-12 is in `docs/plans/2026-06-24-show-matrix-vocal-spectra.md`;
items 5-7 also in `docs/plans/2026-06-24-faceviz-sway-skeletal-integration.md`.

## Risks (honest)

- Monocular depth is relative/affine + flickery; needs EMA + near/far remap; stylized look only.
- GPU contention: transformers.js inference + three.js cloud + the effect rack share one GPU;
  inference MUST be a reduced-res worker decoupled from the render loop.
- Depth-in-video accuracy: chroma subsampling + DCT quantize hue-encoded depth; needs the UCL
  periodic encoding + tight near/far; HEVC 4:4:4/10-bit helps but Chromium HEVC decode is
  platform-gated; validate decoded depth error empirically.
- "Lower overhead" is true ONLY for the stylized point-cloud/ASCII looks; for flat playback,
  depth+color+reconstruction costs MORE than good H.264. Frame the UI as a "stylized
  low-overhead source", not "compress all video".
- ASCILINE is third-party MIT + anti-ad clause: attribute, do not silently absorb, do not
  copy the Canvas2D renderer.
- Do NOT pin transformers.js / ORT-Web / three.js / the Depth-Anything model id from memory;
  fetch the live source of truth first. Every new VJ control needs valid labels/ARIA. None of
  this is verified until the user sees it live (headless build/tsc do not count).
