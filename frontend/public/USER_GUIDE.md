<div class="guide-cover">
  <div style="line-height:1; letter-spacing:-0.03em;"><span style="font-size:63px; font-weight:600; color:#a020f0; text-shadow:0 0 24px rgba(160,32,240,0.6);">the</span><span style="font-size:93px; font-weight:900; color:#ffffff; text-shadow:0 0 44px rgba(160,32,240,0.85), 0 0 16px rgba(160,32,240,0.6);">DAW</span></div>
  <div style="font-size:17px; letter-spacing:0.12em; opacity:0.74; font-weight:500; margin-top:1px;">ONE DAW TO RULE THEM ALL</div>
  <div style="font-size:22px; font-weight:800; letter-spacing:0.1em; color:#a855f7; text-shadow:0 0 19px rgba(168,85,247,0.45); margin-top:3px;">by GANTASMO</div>
</div>

theDAW packs most of a music career into one program. It writes original audio from a text prompt, arranges it on a multitrack timeline, masters it through a deep effects chain, splits it into stems, performs it across two beatmatched DJ decks, runs a reactive visual show, transcribes it to sheet music and tablature, and files everything in a searchable library that records how each piece descended from the last. It trains custom models on a collection and answers questions about any of it from a built-in assistant. A separate DAW, audio generator, stem separator, DJ rig, VJ engine, notation editor, sample manager, and model trainer collapse into a single window.

Generation runs on Stable Audio 3, the open generative audio model from Stability AI. A prompt becomes finished stereo, and the same model menu reaches Magenta RealTime 2 for streaming text-to-music and Suno for cloud renders. Chimera fusion folds several clips into one tempo-aligned track, while init signals, inpainting, and LoRA adapters steer a render toward a target.

A track then moves through EDIT for waveform surgery and region inpainting, and MIX for the Edit Tool Stack and Quick Master macros. The DJ workspace runs two decks with beatmatch sync, key-lock, live stems, an FX rack, hot cues, and hands-free automix, and the VJ workspace drives WebGL visuals from the audio, a microphone, MIDI, or a phone on the same network.

Nothing is discarded. The Library keeps every piece on disk with its analysis, stems, and MIDI, and LEARN draws the lineage between pieces as a navigable 3D genealogy. A symbolic-music pipeline turns a track into sheet music, tablature, and multi-instrument arrangements, and reads a finished score back into a prompt. TRAIN fits LoRA adapters and runs autoencoder round-trips, an assistant answers from this guide, and a paste-a-URL importer pulls audio from YouTube, SoundCloud, and Bandcamp.

The **Docs** button in the top bar opens this guide as a modal with a filterable table of contents, a Markdown download, and a print-to-PDF in three styles. Every workspace and the full backend API follow below.

---

## Table of Contents

1. [Repository Anatomy](#1-repository-anatomy)
2. [Architecture](#2-architecture)
3. [Installation](#3-installation)
4. [Launching the Application](#4-launching-the-application)
5. [UI Shell](#5-ui-shell)
6. [MAKE Tab: Audio Generation](#6-make-tab)
7. [EDIT Tab: Waveform Editor](#7-edit-tab)
8. [MIX Tab: Effects and Mastering](#8-mix-tab)
9. [DJ Tab: Performance Mixer](#9-dj-tab)
10. [VJ Tab: Live Visuals](#10-vj-tab)
11. [TRAIN Tab: LoRA and Autoencoder](#11-train-tab)
12. [LEARN Tab: Lineage and Genealogy](#12-learn-tab)
13. [Library](#13-library)
14. [Step Sequencer](#14-step-sequencer)
15. [Piano Roll](#15-piano-roll)
16. [Bottom Panel Tabs](#16-bottom-panel-tabs)
17. [Player Footer](#17-player-footer)
18. [Processing Log](#18-processing-log)
19. [Backend API Reference](#19-backend-api-reference)
20. [Python Pipeline Reference](#20-python-pipeline-reference)
21. [Models](#21-models)
22. [LoRA Adapter Types](#22-lora-adapter-types)
23. [Troubleshooting](#23-troubleshooting)
24. [Development Workflows](#24-development-workflows)
25. [Feature Coverage and Screenshot Evidence](#25-feature-coverage-and-screenshot-evidence)
26. [Cloud Generation: Suno](#26-cloud-generation-suno)
27. [Magenta RealTime 2 (Generate Tab)](#27-magenta-realtime-2)
28. [Edit Tool Stack](#28-edit-tool-stack)
29. [Catalogue: Cross-provider Library Browser](#29-catalogue)
30. [YouTube Import](#30-youtube-import)
31. [Controller Vision](#31-controller-vision)
32. [Admin, Module, and Assistant-Key APIs](#32-admin-module-and-assistant-key-apis)
33. [Notation, Score, Tabs, and Arrangements](#33-notation-score-tabs-and-arrangements)
34. [Quest and XR Integrations](#34-quest-and-xr-integrations)

---

## 1. Repository Anatomy

| Layer | Path | Description |
|---|---|---|
| **ML pipeline** | `stable_audio_3/` | Upstream Stability AI code: DiT, SAME autoencoder, all samplers, LoRA parametrization, distribution-shift schedules, T5Gemma conditioner. |
| **FastAPI backend** | `backend/server.py` | HTTP wrapper around the pipeline. Async job queue for generation; synchronous endpoints for studio effects and model introspection. Port 8600. |
| **Backend modules** | `backend/modules/` | Plugin system. Each subdirectory provides `module.json` (name, API prefix, enabled flag) and `router.py` (FastAPI APIRouter). The loader (`backend/modules/loader.py`) discovers and mounts every enabled module at startup; a failed module is logged and skipped without stopping the server. The modules that ship in the repo are: `analysis`, `analyzer` (`/api/edit/analyzer`), `chimera`, `controllervision`, `creative_fx` (`/api/edit/creative-fx`), `creative_neural` (`/api/edit/creative-neural`), `delivery` (`/api/edit/delivery`), `effects` (mounted at `/api/studio`), `enhance` (`/api/edit/enhance`), `library`, `magenta`, `mastering` (`/api/edit/mastering`), `midi`, `restoration` (`/api/edit/restoration`), `settings`, `stems`, `suno`, `vj`, and `ytimport`. The six `/api/edit/*` families form the **Edit Tool Stack** (§28); `suno` (§26) and `magenta` (§27) add cloud and real-time generation. |
| **React app** | `frontend/` | Tailwind 4 + React 19 + Zustand 5 + Vite 6. Multi-tab DAW interface. Proxies `/api/*` to the backend. Port 5173 in development. |

---

## 2. Architecture

Request flow:

- The browser (`:5173` in dev, static bundle in production) calls `/api/...`.
- The FastAPI backend (`:8600`) handles HTTP and dispatches generation and effects work.
- `StableAudioModel` composes three parts:
  - T5Gemma text encoder (`models/conditioners.py`)
  - DiT diffusion transformer (`models/dit.py` to `models/transformer.py`)
  - SAME autoencoder (`models/autoencoders.py`)

### Two-stage generation

The DiT generates 256-dimensional latents at 1/4096 the source audio rate. The SAME autoencoder decodes those latents to 44.1 kHz stereo audio. Both stages share the same checkpoint for bundled models. Standalone SAME checkpoints (`same-s`, `same-l`) are interchangeable with the bundled versions and reuse the cached full checkpoint when available.

### Checkpoint flavors

- **ARC**: post-trained checkpoints (`small`, `medium`). Tuned for 8-step inference with `cfg_scale=1`. Recommended for all generation tasks.
- **RF**: rectified-flow base checkpoints (`small-rf`, `medium-rf`). These require around 50 steps and `cfg_scale=7` at inference, and serve as the starting point for LoRA training.

### Web Audio engine

All in-browser audio (library playback, waveform editor preview, step sequencer, piano roll live notes) routes through a single shared `AudioContext` graph: source nodes feed a master gain node, which feeds an analyser node, which feeds the destination. The real-time spectral analyzer reads from the analyser node continuously. The player footer volume and mute controls drive the master gain.

---

## 3. Installation

### Prerequisites

Put these on your PATH first: **[uv](https://docs.astral.sh/uv/getting-started/installation/)** (Python env + packages), **[Node.js](https://nodejs.org/) v20.19+ / v22.12+** (frontend + VJ sidecar, includes npm; the Vite 7 floor), **[FFmpeg](https://www.gyan.dev/ffmpeg/builds/)** (every audio path — effects, exports, ingest, MIDI, YouTube import), **Git** (clone with `--recurse-submodules` for the Magenta sidecar source), and an **NVIDIA driver 550+** for the Medium model / Magenta (the Small model runs on CPU). On Windows, `theDAW.bat` verifies uv/node/npm, warns on missing FFmpeg, and bootstraps the venv + `node_modules` on first run (§4); the Windows specifics are in [windows/setup-guide.md](windows/setup-guide.md).

### Base Python environment

```bash
uv sync
```

### Optional Linux CUDA wheels (Medium model)

```bash
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu126
```

### With dev dependencies

```bash
uv sync --group dev
```

### Windows-specific requirements

`pyproject.toml` includes CUDA 12.8 wheel sources for torch, torchaudio, and Flash Attention under `[tool.uv.sources]`. Running `uv sync` on Windows installs all of them automatically. No additional flags or manual wheel downloads are required for Python 3.10 with CUDA 12.8.

On a different CUDA or Python version, install PyTorch manually:
```powershell
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
```

`soundfile` is included in the base dependencies. Flash Attention is conditionally installed (`sys_platform == 'win32' and python_version < '3.11'`); the wheel URL in `pyproject.toml` targets Python 3.10 with CUDA 12.8 and torch 2.7.0. For other combinations, download a matching wheel from [kingbri1/flash-attention](https://github.com/kingbri1/flash-attention/releases).

Full walkthrough: [docs/windows/setup-guide.md](windows/setup-guide.md).

### Frontend dependencies

```bash
cd frontend
npm install
```

`package-lock.json` is committed. Use `npm ci` to reproduce the exact dependency tree; `npm install` is acceptable in development.

---

## 4. Launching the Application

### One-shot launcher (Windows)

```powershell
.\theDAW.bat
```

Sequence:
1. Verifies uv, node, and npm are on PATH and warns if FFmpeg is missing.
2. Bootstraps the venv (`uv sync --group dev`) and `node_modules` (`npm install`) on first run.
3. Kills any stale process on ports 5173, 8600, and 5187.
4. Launches `backend._devstack`, which runs the backend, the Vite frontend, and the optional localtunnel together in this one console, streaming all three as prefixed `[backend]` / `[frontend]` / `[tunnel]` log lines.
5. Opens `http://localhost:5173` once Vite reports ready.

The backend runs under the rc=88 supervisor contract, so the in-app Settings → Restart Server button respawns it inside the same console. Ctrl-C in the window stops the whole stack.

### Manual launch

```bash
# Terminal 1: backend
uv run uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload

# Terminal 2: frontend
cd frontend && npm run dev
```

`vite.config.ts` proxies all `/api/*` requests to `http://localhost:8600`, so same-origin fetches require no CORS configuration in development.

---

## 5. UI Shell

The application window has five regions:

- **Full-width header** (top): the theDAW logo, a global search input, and action buttons (Docs, mobile access QR/link, Settings, user avatar, AI Assistant orb).
- **Center workspace**: the center tab bar at the top and the active workspace below it, including that tab's own controls and run action.
- **Library rail** (right, collapsible): browse and route library material without leaving the active workspace.
- **Global bottom dock**: the bottom multi-tab panel and the processing log, side by side.
- **Player footer** (bottom): a fixed transport bar.

**Full-width header:** a fixed bar spanning the entire window width. It holds the theDAW logo dot, a global search input, and the action buttons listed above. There is no left panel and no left-panel toggle; the only collapsible side panel is the Library rail on the right.

**Center tab switching:** the active workspace is controlled by the center tab bar in the locked order **MAKE / EDIT / MIX / DJ / VJ / TRAIN / LEARN** (`CENTER_TABS`). Each tab carries its own accent color. Legacy navigation targets such as `create`, `advanced`, `edit`, and `train` are translated into these center tabs, so assistant actions, library sends, and older shortcuts still route correctly.

**DJ and VJ persistence:** the DJ and VJ tabs host live performance state (a multi-deck mixer and an embedded WebGL VJ iframe). Once first visited, they stay mounted and only toggle CSS visibility on tab switch, so deck state and the warm VJ pipeline survive a switch. A backgrounded VJ tab is told to park its render loop, so it costs close to 0% GPU while hidden.

**Right-side library rail:** the Library is a collapsible panel on the right edge. A compact, vertically-centered pull handle on the right edge of the work area (present in every workspace) toggles it open or closed, and a drag handle on the rail's inner edge resizes it; the width persists between 280 px and 640 px. Expanded fully, the rail becomes the full-width Catalogue. This lets MAKE, MIX, LEARN, VJ, and editor workflows stay visible while browsing or routing library material.

**Global bottom dock:** pinned across the bottom of the app are two independent columns, the bottom multi-tab panel on the left (Visualize / Piano / Sequence / Details / Media / SLIDE / Score) and the processing log on the right, aligned under the library rail. Each column has its own height, collapse toggle, and resize handle, so expanding or resizing one does not move the other, and the dock stays put regardless of the library panel's state.

**Docs modal:** click the Docs button in the header to open this guide in-app. The modal supports anchor links, syntax-highlighted Markdown tables and code blocks, raw Markdown download, and browser print/PDF export. The assistant RAG index is built from the same guide, so doc updates improve in-app help and assistant context together.

**Mobile access share:** click the QR/link button in the header to copy or scan the current LAN or tunnel URL for mobile performance access. This is useful with the VJ tab and any browser-based controller or viewer.

**AI Assistant panel:** click the orb icon in the header to open the collapsible assistant panel. It streams chat from any configured LLM provider with RAG context sourced from this user guide, supports file attachments and voice input, and exposes provider and key-pool controls. See [§19.11](#1911-assistant) for the API reference.

**Viewport scaling:** the UI applies a CSS `zoom` factor based on viewport width (0.85 below 1440 px; 0.95 at 1440 to 1919 px; 1.1 at 1920 px and above). Shell height calculations compensate so the layout tiles cleanly down to the footer.

![UI shell with center tabs and right library rail](screenshots/01-shell-make.png)

![Header actions (Docs, share, settings, assistant)](screenshots/01-shell-make__header-actions.png)

---

## 6. MAKE Tab

### Purpose

The MAKE tab (`AdvancedView`) submits audio generation jobs to the backend and displays their output. It supports all three inference modes: text-to-audio, audio-to-audio, and inpainting/continuation. It is also where the Chimera engine fuses several sources into one init signal.

### 6.1 Primary Synthesis / Prompt

- **Prompt** (required). Plain-text description of the desired audio content, instrumentation, or sonic texture.
- **Negative prompt** (optional). Aspects or characteristics to suppress.
- **Magic prompt button** (sparkle icon, bottom-right of the prompt box). Inserts a sample prompt when the prompt field is empty. When text already exists, clicking the sparkles icon sends it to the AI Assistant to optimize the prompt for Stable Audio conditioning.

### 6.2 Generation Parameters

Six controls arranged in a 3-column grid:

| Control | Type | Notes |
|---|---|---|
| **Model** | Dropdown | `small`, `medium`, `small-rf`, `medium-rf`, plus `magenta-small` for Magenta RealTime 2 (§27) and `suno` for Suno cloud generation (§26). An `-rf` variant raises Steps to 50 and CFG to 7.0. Picking Magenta drops Steps to 1 and brings up the MRT2 conditioning controls. The Suno entry opens the Aurora Cloud Console in place of the local panel. |
| **Duration (s)** | Integer | Total output length in seconds. Small model: max 120 s. Medium and Large: max 380 s. |
| **Batch** | Integer | Number of simultaneous variations. Each variation produces a distinct library entry with its own seed. |
| **Steps** | Integer | Sampler denoising steps. ARC default: 8. RF default: 50. |
| **CFG** | Float | Classifier-free guidance scale. ARC default: 1.0. RF default: 7.0. Higher values increase adherence to the prompt and can introduce artifacts. |
| **Seed** | Integer + reroll button | Use −1 for a random seed on each run. The reroll button generates and displays a new random seed without submitting a job. |

### 6.3 Advanced Generation Panel

The Advanced Generation Panel provides a dense layout for deeper configuration.
- **Output Settings** controls automatic playback and automatic downloading behavior.
- **Quick Actions** route generated audio directly to the Waveform Editor, Init Audio, or Inpainting modules.
- **Templates Panel** saves and restores full generation parameter sets.
- **Saved Prompts Dropdown** maintains a history of frequently used user-defined prompts.
- **Spectrogram Viewer** displays Mel, STFT, Chromagram, and CQT visualizations of generated audio.

Templates and saved prompts are stored in browser local storage for rapid iteration. The prompt sparkle action calls the assistant prompt enhancer (`/api/assistant/chat`) when text already exists, or inserts a sample prompt when the field is empty.

### 6.3.1 Chimera Fusion Stack

Chimera fuses two or more audio clips into a single init signal before generation. Source clips can arrive from the Library toolbar and context menu, the Media Bucket, the microphone recorder, or other send targets. This is the engine that turns a folder of loops, a hummed melody, and an imported break into one coherent starting point.

| Control | Description |
|---|---|
| **CHIMERA banner** | Always-visible status strip at the top of MAKE. Shows the stack count and jumps to the Init Audio card. |
| **Target BPM** | `auto` uses the selected base clip BPM, the median detected BPM, or a 120 BPM fallback. A numeric value forces a target. |
| **Base clip** | Optional reference clip. When set, its BPM and duration can drive the fusion target. |
| **Noise / influence** | Per-clip slider mapped to the backend `weights`; higher noise means less influence on the fused output. |
| **Align mode** | `start` aligns clips from time zero. `downbeat` trims to detected first beats. `weave`, labeled **CRISPR** in the UI, schedules chunks of each clip into an arrangement arc, interleaving them bar by bar with controlled polyphony. |
| **Weave controls** | Chunk bars, total bars, and max polyphony shape the generated arrangement when `align_mode=weave`. |
| **Analyze on add** | Every clip dropped into the stack is analyzed immediately (`POST /api/chimera/analyze`). The detected BPM and key appear as badges on the clip row, and the beat positions feed the weave scheduler and the splice scene. |
| **CRISPR splice scene** | A live WebGL DNA scene above the stack renders one strand per clip with rungs on the detected beats. During a generation the strands are analyzed, chopped, woven, and fused into the output strand in step with the run. |

Rendering posts to `POST /api/chimera/mashup`, normalizes inputs to 44.1 kHz stereo, detects tempo and beats, time-stretches the clips, and returns a WAV file plus metadata (`target_bpm_used`, per-clip stretch ratios, warnings). The mashup request carries a `known_analysis` field so clips already analyzed on add skip server-side re-detection, and a background pre-render warms the fusion cache once the stack settles so CREATE starts from the finished mix. The fused result becomes the Init Audio for the next generation.

![Chimera multi-select cohort and stack flow](screenshots/09-chimera-cohort-multi-select__chimera-multi-select.png)

### 6.4 Init Signal / Conditioning

Audio-to-audio mode. Upload a source file through the dropzone to condition the model on existing audio. Any audio works as an init signal: a generated clip, an imported track, a mic take, a stem, or a Chimera fusion.

- **Init Noise (0–1)** controls the ratio of source signal to random noise injected at the start of the denoising trajectory. Lower values preserve more of the source character; higher values grant the model more generative freedom.
- **Type** is `Audio` (standard) or `RF-Inv` (RF-Inversion, meaningful only with `-rf` model variants).

Removing the source file returns the form to text-to-audio mode.

### 6.4.1 Microphone Recorder

The browser-side Mic Recorder uses `navigator.mediaDevices.getUserMedia` plus `MediaRecorder` to capture live audio without leaving the app. Supported browser encodings are selected in order: WebM/Opus, OGG/Opus, MP4/AAC, then WAV fallback.

After recording, the review card can:
- play and pause the take inline;
- send it to a new editor track or the first editor track tail;
- send it to Init Audio or Inpaint Audio;
- import it into the disk-backed Library through `POST /api/library/import`, so stems, MIDI conversion, lineage, and bundle downloads can run against it later.

### 6.5 Inpainting / Regen Region

Replaces a defined time window inside a source audio clip while preserving everything outside that window.

- **Enable toggle** (section header) must be active for the inpainting payload to be submitted. It activates automatically when a source file is loaded.
- **Source dropzone** accepts drag-and-drop or click-to-upload.
- **Waveform preview** is rendered by WaveSurfer once a file is loaded.
- **Region selection**: drag horizontally across the waveform to define the regeneration window. The Start, End, and Region Duration readouts update in real time.
- **Continuation**: to extend audio beyond its current end, drag the region to the end of the waveform and set Duration to a value larger than the source length. The model fills the extension conditioned on the existing audio tail.

The form fields `mask_start` and `mask_end` are submitted in seconds relative to the start of the inpaint audio file.

### 6.6 LoRA / Adaptive Layers

Stack one or more LoRA adapters for the next generation. Each adapter row shows its name, a weight slider (0 to 1), and a remove button.

> **Current status:** UI scaffolding. The `/api/generate-jobs` endpoint does not yet forward LoRA references to the pipeline. LoRA at inference is supported directly through the Python API (see [§20.5](#205-lora-at-inference)).

### 6.7 Output Status Monitor

Appears below the accordion after a job is submitted or completed.

- Binary progress bar (`queued` to `running` to `completed`).
- Engine information chip (model, steps).
- Inline audio player for the completed result.
- Download and clear buttons.
- Every completed result is auto-saved to the Library.

### 6.8 Run Generation

A sticky bar fixed at the bottom of the MAKE workspace submits the generation job to `POST /api/generate-jobs`. While a job is active, the button changes to a red **ABORT** button showing an estimated percentage. Clicking Abort cancels the polling loop; the backend job keeps running, but its result is discarded by the UI.

---

![MAKE generation controls and parameters](screenshots/make-controls.png)

## 7. EDIT Tab

### Purpose

The EDIT tab (`WaveformEditor`) is the multi-track audio composition surface. Clips are slices of source audio Blobs placed on a pixel-per-second timeline. Editing is non-destructive at the Blob level; rendering happens on demand through `OfflineAudioContext`.

### 7.1 Toolbar

| Control | Description |
|---|---|
| **ADD TRACK** | Appends an empty track. Track names auto-inherit from the first clip placed on them and stay editable. |
| **Move tool** | Default tool. Drag clips horizontally to reposition in time; drag vertically to move between tracks. |
| **Cut tool** | Click inside a clip to split it at that position. The right half becomes a new clip referencing the same source Blob with an adjusted `offsetIntoSource`, preserving source alignment. |
| **Snap** | Off / 1/4 / 1/8 / 1/16. Quantizes drag and resize operations to note-grid intervals relative to the editor BPM. |
| **Zoom in / out** | Adjusts timeline resolution in pixels-per-second. Range: 5 to 400 px/s. |
| **Delete** | Removes the selected clip. The Delete and Backspace keys do the same when a clip is selected. |
| **Mixdown name** | Text input. Sets the output filename on COMMIT EDIT. If empty, the committed file defaults to `mixdown_<id>.wav`. The `.wav` extension is appended automatically when omitted. |
| **COMMIT EDIT** | Renders the composition to a WAV file. See §7.6. |

### 7.2 Per-track Controls

Each track has a fixed-width header to the left of the timeline lanes:

| Control | Description |
|---|---|
| **Name** | Editable text. Click to edit in place. Color matches the track's assigned hue. |
| **M (Mute)** | Silences the track in both preview and final render. |
| **S (Solo)** | Exclusive across all tracks: soloing a track mutes all others. Soloing a second track adds it to the active set. |
| **× (Remove)** | Deletes the track and all clips assigned to it. |
| **Volume slider** | Per-track gain, 0 to 1. Applied in both preview and offline render. |
| **Pan slider** | Per-track stereo position, −1 (full left) to +1 (full right). Applied through a `StereoPannerNode` in the offline render. |

### 7.3 Per-clip Display and Handles

Each clip renders a downsampled waveform (240 bins, normalized) as a visual background, with a header label and a duration readout.

**Resize handles** are thin strips at the left and right edges. Dragging the left handle adjusts both `startSec` (timeline position) and `offsetIntoSource` (in-point into the source audio) together, so the audio content at the playhead position stays constant. Dragging the right handle adjusts only `durationSec` (out-point).

**Fade handles** are vertical semi-transparent lines with a circular grab point near the bottom edge. The fade-in handle sits inset from the left edge; dragging it right extends the fade-in duration. The fade-out handle sits inset from the right edge; dragging it left extends the fade-out duration. Both fades apply as linear gain ramps in the offline render and as `gain.linearRampToValueAtTime` automation during preview.

### 7.4 Inpainting from the Editor

Regenerate a sub-region of any clip with the model while keeping the surrounding audio intact.

1. Select a clip.
2. Switch to the **Paintbrush** tool (or right-drag inside a clip while in Move mode) to draw an inpaint selection region. The selection shows as a highlighted band across the clip.
3. Click **INPAINT REGION** to open the inpaint panel.
4. Set the prompt, number of steps, and seed.
5. Click **Generate** to submit an async job.

The submission process:
- The visible clip region (from `offsetIntoSource` to `offsetIntoSource + durationSec`) is extracted from the source Blob as a cropped WAV through `cropAudioBlob`. This keeps behavior correct for trimmed or split clips regardless of their in-point.
- Mask coordinates are computed relative to the start of the cropped audio: `maskStart = selection.startSec − clip.startSec`, `maskEnd = selection.endSec − clip.startSec`.
- The cropped WAV and mask are sent to `POST /api/generate-jobs`.

On completion, the result enters a **Review** phase:
- An inline audio player auditions the regenerated region.
- **Accept** replaces the clip's source Blob with the result and clears the inpaint selection.
- **Discard** dismisses the panel without modifying the clip.

### 7.5 Timeline Interaction

- **Playhead**: the red vertical line. Click any empty area in the timeline to position it. The footer transport's skip-to-start button resets it to 0.
- **Deselect**: click empty space in a track lane to deselect the active clip.
- **Scroll**: horizontal scroll on the timeline area moves the view.
- **Status bar**: shows live timecode as `MM:SS.cs / MM:SS.cs` (current / total), clip count, track count, and the selected clip's start-to-end range.

### 7.6 COMMIT EDIT

Renders the complete composition to a single 44.1 kHz stereo WAV.

Render process:
1. All non-muted (or exclusively soloed) tracks are collected.
2. Clip source Blobs are decoded in a temporary `AudioContext` (one decode per unique Blob, cached for clips sharing a source). A 15-second timeout guards against stalled decode operations.
3. An `OfflineAudioContext` is initialized at 44.1 kHz stereo with a duration equal to the total timeline length.
4. Each clip is scheduled through `BufferSourceNode.start(clipStartSec, offsetIntoSource, durationSec)`. Per-track volume and stereo pan are applied. Fade-in and fade-out gain envelopes are automated with `linearRampToValueAtTime`. Each track's insert FX chain and the master FX chain are rebuilt in the offline context with the same factories used in preview, so the psychoacoustic rack (§7.7) and any Spatializer Teleport motion (§7.8) bake into the file.
5. `OfflineAudioContext.startRendering()` produces the final `AudioBuffer`.
6. A WAV Blob is encoded as 16-bit PCM (`encodeWav`).
7. The Blob is saved to the Library (`source: 'editor-mixdown'`).
8. A browser file download is triggered automatically.

During the render, the COMMIT EDIT button shows an animated spinner and is disabled.

### 7.7 Insert FX Rack (Psychoacoustic)

EDIT carries a real-time insert-effect rack that processes audio during preview and bakes into COMMIT EDIT through the same node graph. Two scopes exist: a **master** rack on the editor mix, and a per-track rack on each track. The master rack processes only the EDIT mix, so library, DJ, and sequencer playback stay untouched.

Open the master rack from the **MASTER FX** toolbar toggle. Open a track's rack from the **F** button on its header, or right-click a track header and choose **Open FX rack**. The right-click menu also offers **Add insert** for every effect and **Clear track FX**.

Each rack is an ordered chain. The **+ Add effect…** dropdown appends an effect; per-effect controls bypass it, move it earlier or later in the chain, and remove it. Parameters are SLIDE sliders that update the running audio without a rebuild.

Six psychoacoustic processors are available:

| Effect | Group | What it does |
|---|---|---|
| **Headphone Crossfeed** | Spatial | Relieves hard-panned headphone "in-head" stereo (Bauer/BS2B). Params: Amount, Cut (Hz). |
| **Phantom Bass** | Low end | Implies the missing fundamental through synthesized harmonics, so small speakers read deep bass. Params: Drive, Blend, Crossover (Hz). |
| **Stereo Widener** | Spatial | True mid/side widening with a mono-safe low end. Params: Width, Bass mono (Hz). |
| **Aural Exciter** | Tone | Adds harmonic air and presence the ear reads as detail. Params: Freq (Hz), Amount, Mix. |
| **HRTF Spatializer** | Spatial | Positions the track in 3D around the head with motion presets (see §7.8). |
| **Loudness Contour** | Tone | Equal-loudness tilt so the balance holds at low volume. Params: Level (phon), Amount. |

### 7.8 Spatializer, Teleport, and Autopilot

The **HRTF Spatializer** effect places a track in 3D space around the listener through a `PannerNode`, with a visual placement pad and motion presets. Azimuth, Elevation, and Distance set a static position; the **Motion** control adds movement, and Rate and Depth shape it.

Twelve motion modes are available: Static, Orbit H CW, Orbit H CCW, Orbit Frontal, Orbit Sagittal, Spherical, Ping-Pong, Up / Down, Figure-8, Expand / Collapse, Teleport, and Autopilot.

**Teleport** jumps the track between positions in step with the audio. The clip is sliced on its onsets through a time-domain, FFT-free analysis, and each slice is placed by its character: louder slices sit closer and quieter ones further away, brighter slices ride higher, and a golden-angle scatter spreads them around the head. The Depth parameter widens or narrows that scatter. The same deterministic slicing runs in the offline bounce, so the export matches the preview.

**Autopilot** is a live spatial choreographer. A real-time analyser reads level, brightness, and onset timing, then steers a beat-aware orbit, an elevation follower tied to brightness, a distance follower tied to bass, a mood-weighted motion layer, and onset-fired accent jumps. Autopilot runs during live preview; the offline bounce falls back to the Spherical orbit.

### 7.9 Metamorph: Granular Identity-Bleed Morph

Open **Metamorph** from its toolbar toggle to morph one sound into another in real time. Pick a **Donor A (identity)** and a **Host B (structure)** from either the current timeline clips or the library. Metamorph rebuilds Host B out of grains taken from Donor A, so the output keeps B's structure in A's voice.

Eight sliders shape the result: **Bleed** (dry host through to full mosaic), **Grain** (grain size in seconds), **Rate** (grains per second), **Spray** (start and timing jitter), **Match** (selection strictness), **Sync** (lock grains to the host's beat grid), **Favor** (bias toward punchy donor grains), and **Gain** (output trim). **Play** auditions the morph live; **Send to editor** renders one pass and drops it on a new track as an ordinary clip, ready to trim, FX, and export.

### 7.10 Live MIDI Playback in the Timeline

A clip whose source is a piano-roll part plays its notes live through the soundfont engine during transport, not only as a pre-rendered bounce. Each track maps to one synth channel (up to sixteen), and notes are scheduled against the editor clock at the clip's BPM.

Live MIDI is opt-in: it activates only when the soundfont is in use, or a per-clip or per-track instrument is set, so projects that never touch instruments keep playing their bounced audio unchanged. A clip's instrument falls back to its track's instrument, then to the globally selected program. Mute and solo are honored by skipping a track's notes. If the synth is not ready, the clip's bounced audio plays instead. The offline export still renders from each clip's last bounce. Choose an instrument as described in §15.8.

---

![The EDIT multitrack waveform editor](screenshots/edit.png)

## 8. MIX Tab

### Purpose

The MIX tab (`MixPanel`) is the single-screen effects and mastering workspace. It applies one or more of 24 FFmpeg-backed processors to a source file as an ordered chain. Processing is synchronous; the result is returned as binary audio and made available for inline playback, download, and routing back into the app.

![MIX tab: the effect catalog, the categorized rail, the active chain, and the Quick Master macro knobs](screenshots/mix-overview.png)

### 8.1 Layout

MIX fills the viewport with no page scroll, in three bands:
- **Top**: the source field. Click or drop audio anywhere in the waveform field to load or replace it. The header strip shows the filename plus peak, RMS, sample-rate, and duration stats.
- **Middle**: three columns. The left rail holds effect categories and the Quick Master controls. The center column is the effect library. The right column is the active chain.
- **Bottom**: the output waveform, the effects visualization region, and the scope and cymatics visualizer reacting to the shared player master gain.

The player footer is the process-chain transport.

### 8.2 Quick Master

Quick Master exposes the four parameters of a `mastering_chain` entry as live knobs (low boost, high boost, limiter ceiling, target LUFS). Applying it inserts a single `mastering_chain` entry into the chain once, then live-updates that entry's parameters as the knobs move.

![Quick Master macro knobs: Punch, Air, Drive, and Ceiling](screenshots/mix-quick-master.png)

### 8.3 Effect Catalog and Chain

The effect library is organized into categories (mastering, dynamics, EQ, tempo, cleanup, export) with list and tile view modes and color-coded groups. Add effects to the chain, toggle individual rows active or inactive, reorder rows, and clear the chain in one action. Each chain entry exposes bounded sliders and numeric fields sourced from `PARAM_BOUNDS` and `EFFECT_CATALOG`.

| Effect key | Description | Macro-derived parameters |
|---|---|---|
| `mastering_chain` | EQ, limiting, and LUFS normalization | lowBoost, highBoost, limiterCeiling, targetLUFS |
| `compression` | Dynamic range compression | attack, decay |
| `highpass` | High-pass filter | cutoff frequency |
| `lowpass` | Low-pass filter | cutoff frequency |
| `volume` | Gain adjustment | output level |
| `tempo` | Time-stretch and playback rate | rate |
| `vocal_processing` | High-pass, presence boost, and LUFS normalization | highpassFreq, presenceBoost, targetLUFS |
| `lofi_vinyl` | Bit degradation and low-pass | degradation, lowpassFreq |
| `stereo_widener` | Haas-effect widening | delayMs |
| `reverb_delay` | Combined reverb and delay | delayMs, decay, reverbDecay |
| `sub_exciter` | Sub-bass and treble harmonic excitation | subBoost, trebleBoost |
| `phase_isolation` | Mid-side phase cancellation | cancelAmount |
| `eq_mid` | Single-band parametric EQ | frequency, width (Q), gain |
| `loudnorm` | ITU-R BS.1770 loudness normalization | targetLUFS, truePeak |
| `pitch_shift` | Semitone pitch transposition | shift (cents) |
| `delay` | Stereo delay | leftMs, rightMs |
| `echo` | Echo with feedback | delayMs, decay |
| `fade` | Linear fade-in and fade-out | fadeInDuration, fadeOutDuration |
| `denoise` | Noise floor reduction | noiseReduction |
| `declick` | Impulse noise removal | windowSize |
| `silence_remove` | Leading and trailing silence trimming | threshold |
| `export_flac` | Lossless FLAC export | compressionLevel |
| `export_mp3` | Lossy MP3 export | bitrate |
| `export_aac` | AAC export | bitrate |
| `export_opus` | Opus export | bitrate |

All effects are dispatched to `ffmpeg` through `subprocess.run`. Server-side bounds checks apply to every parameter; out-of-range values return HTTP 400.

### 8.4 Source, Output, and Routing

- **Source** loads through the top field by click, drop, or a Library drag using the `application/x-thedaw-library-id` transfer protocol, so a persisted track becomes the source without a manual download.
- **Output format selector**: `wav`, `flac`, `ogg`, `mp3`, `aac`, or `opus`.
- **Process** submits to `POST /api/studio/process`. The binary audio response is wrapped in a Blob URL for inline playback.
- The output result can be downloaded, sent to the EDIT timeline, or sent to Inpaint Audio in MAKE.

### 8.5 Process History

The last processing invocations are retained in the store. Any history item can be selected and promoted back to the current source.

---

![The MIX effects and mastering workspace](screenshots/mix-overview.png)

## 9. DJ Tab

### Purpose

The DJ tab (`DJView`) is a live two-deck performance mixer built on the SLIDE control surface. It loads tracks from the Library or any source, beatmatches and key-locks them, mixes through a full center console, and hands sets off to the VJ for synchronized visuals. The Web Audio engine (`djEngine.ts`) runs the signal path per deck: source, optional time-stretch, delay compensation, trim, three-band EQ, filter, gain and crossfade, the DJ master bus, then the shared player master.

![DJ console: two decks with jog wheels, the center mixer, the FX and stems racks, and the source tree](screenshots/dj-console.png)

### 9.1 Waveform Hero and Decks

The two deck waveforms span the full width at the top, each with a beatgrid, hotcue markers, and a moving playhead. A thin per-deck header shows the title, detected BPM, musical key and Camelot value, and the SYNC control. Below the hero, Deck A and Deck B flank the center mixer.

### 9.2 Per-deck Transport and Cueing

Each deck provides play and cue, four hotcues, loops with loop-roll and slip mode, beat-jump, and a key-lock toggle. SYNC engages a phase-locked beatmatch against the other deck and can hold the lock as either deck drifts. Key-lock holds musical pitch constant while tempo changes, so a pitch-shifted track stays in key. Quantize snaps cue and loop actions to the beatgrid.

### 9.3 Center Mixer

The mixer is the console between the decks. Each channel has a gain knob, a three-band EQ (high, mid, low), a single-knob filter that sweeps low-pass below center and high-pass above center, and a volume fader. The two pitch faders sit as the outer columns of the mixer. A crossfader runs along the bottom, and the toggle row (Quantize, Auto-gain, Limiter, MIDI) sits above the gain knobs. A master limiter protects the DJ master bus.

![Center mixer up close: pitch faders, per-deck gain and three-band EQ knobs, the single-knob filters, the channel faders, and the Automix toggle](screenshots/dj-center-mixer.png)

### 9.4 Live Stems and FX

Each deck has an FX and stems rack. A one-touch **Stems** toggle switches the deck between the full track and its four separated parts (drums, bass, other, vocals from Demucs), keeping the playhead in place both directions; cached stems load instantly, and an unseparated track separates on first use. In stem mode each part gets a mute pad (tap to drop it, right-click to solo) and a fine fader for level rides, so a part can be pulled out, soloed, or pushed up during playback. The FX rack adds per-deck effects on top of the EQ and filter.

### 9.5 Cue / Headphone Output

Per-deck pre-listen routes a deck to a separate output device through `setSinkId`, so a deck can be auditioned in headphones while the other plays to the main output.

### 9.6 MIDI Learn

DJ MIDI-learn binds a hardware controller to deck, mixer, and hotcue actions. It reuses the controller mapping store, so a learned layout persists. Controller recognition runs in tiers: a profile library with scored auto-detect, learn-by-capture for any rig, and a planned photo-layout inference path.

### 9.7 Automix, Sampler, and Side List

- **Automix** sequences a setlist hands-free, beatmatching each transition. The Library's **Suggest a Playlist** can populate this set and start it in one step through its **Send to DJ** action (see §13.9).
- **Sampler bank**: drag a clip onto a pad to load it, then trigger pads during a set. Each pad has a **Loop** toggle (the pad holds the sample until pressed again) and a **Choke** toggle (firing one choke pad cuts the others, for mutually exclusive sounds like open and closed hats). Pad assignments and their loop and choke settings persist across reloads.
- **Side List**: a play-next staging lane above the browser. Stage upcoming tracks, reorder them, and pull them onto a deck when ready.

### 9.8 Browser and Source Tree

The browser loads tracks onto a deck by drag or click. The source tree exposes real filtered views (Library, Favorites, Generated, Imports) with live counts, plus an Online Download source and saved Sets. **Send to VJ** pushes the current set or a single track to the VJ archive.

### 9.9 Design Mode

A floating **Edit Layout** control turns on Design Mode. In Design Mode, panels and the mixer control groups can be dragged to reorder and dragged at their borders to resize, snapped to a grid. The layout persists across sessions, a Reset restores the default, and a Copy action exports the layout as JSON to bake in as the new default.

---

![The DJ center mixer, EQ, and crossfader](screenshots/dj-center-mixer.png)

## 10. VJ Tab

### Purpose

The VJ tab (`VJView`) embeds VJ-9000 (the GANTASMO-LIVE-VJ engine) as a live, audio-reactive instrument. Its default visual is a glowing 3D reactive terrain that displaces and lights with the bass, mid, high, and volume bands derived from the audio. The backend `vj` module serves the engine lazily as a production build (it rebuilds automatically when the engine's source is newer than the build, and `theDAW_VJ_DEV=1` forces the HMR dev server for engine development), and the tab fetches its live URL from `/api/vj/url`, so the port is never hardcoded. First launch runs `npm install` plus a one-time build in the VJ project and can take a minute; later launches are fast.

### 10.1 Inputs

A toolbar row toggles which signals feed the visuals. At least one input stays active at all times.

- **Mic**: the VJ engine captures microphone input directly and requests browser permission on first use.
- **Audio**: an audio bridge reads theDAW master analyser every animation frame, derives bass, mid, high, and volume buckets, and posts them to the engine at around 30 fps. The chip shows the live bridge frame rate.
- **MIDI**: controller events from the global MIDI bus are forwarded into the engine.
- **Camera**: a toggle switches the visual source between a live camera feed and the clip or memory buffer. The button reflects the real source through a state echo and shows any camera error. The visualizer runs in a same-origin iframe granted `allow="camera; microphone; midi"`, so it pulls from any camera the browser can open through `getUserMedia`, including a built-in or USB webcam, a capture card, or a virtual camera. The same toggle drives the remote-device sources described below, since each one presents as a browser media stream.

#### Camera sources: webcams, phones on Wi-Fi, and Quest 3

The camera input extends past a webcam on the host machine. Any device that opens theDAW in a browser and grants camera permission serves as the source.

- **Phone or tablet cameras on the same Wi-Fi.** The phone opens theDAW at the LAN URL (see §10.2 Mobile, or the Mobile Access panel in the shell header) and grants the camera prompt, and the phone's camera then streams into the visuals. The Vite server binds `0.0.0.0` and the backend auto-detects the LAN IP, so the only requirement is a network that permits device-to-device connections.
- **Quest 3 headsets and off-network devices.** A device away from the LAN, such as a Quest 3, a phone on cellular, or a remote camera, joins through a public tunnel. A Cloudflare Tunnel or other public URL goes into the **External URL override** in the Mobile Access panel, and the headset or phone opens that URL in its browser and feeds its camera the same way. The browser exposes the Quest 3's passthrough and visible-light cameras like any other camera.
- **Capture inputs.** Anything that presents to the operating system as a camera, including HDMI capture cards, DSLRs in webcam mode, OBS virtual camera, and NDI-to-webcam bridges, appears in the browser's device list and selects as the source.

A master MIDI gate turns Web MIDI on or off for the whole app. When off, the app never requests Web MIDI access, so no browser permission prompt appears.

#### Dedicated in-app sources: delinQuest, STITCH, cymatics, and screen capture

Beyond the browser-camera path above, the VJ source selector offers sources the app drives directly:

- **delinQuest** streams a connected Meta Quest's video into the VJ over ADB (USB or wireless), decoded in the browser, with a choice of 16:9 or side-by-side 3D. It needs neither Quest Link nor Meta Quest Developer Hub. See §34.1.
- **STITCH** streams only the Quest's clean stitched passthrough (the real-world composite, without the performer's overlay) as a separate source. See §34.2.
- **Cymatics** renders a procedural, audio-reactive cymatics scene as the source, with plate, orb, landscape, sphere, and plasma modes, mixable against the other sources on the source crossfader.
- **Screen or window capture** picks a monitor or an application window through the browser's `getDisplayMedia` and feeds it as the source.
- **Shader** runs a generic GLSL source on the atzedent uniform convention with five scenes: a Menger flythrough plus Mandelbulb, Julia, Mandelbox, and kaleidoscopic-IFS fractals. Each scene exposes editable, audio-mappable float params and a Hue control, and a global Material picker reshades it through eight styles (Neon, Chrome, Matte, Glass, Gold, Iridescent, Velvet, Plasma). It mixes against the other sources on the crossfader.
- **Depth cloud** renders a live point cloud from the `akvj` bridge (§10.3), which fans an Azure-Kinect depth-and-color stream from a Unity app into the engine.
- **Spectra** is an audio-reactive generative source, distinct from the §16.1 spectral analyzer, mixable on the source crossfader.

### 10.2 Pop-out and Mobile

- **Pop out** opens the visuals in a separate window. Drag it onto a second monitor for live performance while theDAW keeps running on the main display. **Pop back in** returns it to the tab. Closing the window manually snaps back automatically.
- **Mobile**: when the machine has a LAN address, the Mobile button shows a copyable URL and a QR code so a phone or tablet on the same Wi-Fi can open the visual output. The shell's **Mobile Access** panel additionally offers an **External URL override** that accepts a Cloudflare Tunnel or other public URL, which reaches the visuals and feeds a camera from a device on another network such as a Quest 3 headset. See §10.1 for the camera-source details.

### 10.3 Bridges

The tab wires several bridges to the engine through `postMessage`:
- **Playback**: the player footer Play and Pause buttons drive the engine's video element, and the engine echoes its state back so the footer icon stays in sync.
- **SET hand-off**: a set or single track pushed from the DJ tab arrives in the engine's archive bucket. The toolbar shows a pending state, then confirms once the engine acknowledges the set.
- **Control sync**: the engine publishes its control manifest, which appears as glass-capsule faders in the SLIDE bottom-panel tab. Moving a SLIDE fader updates the engine, and a move inside the engine updates SLIDE, in both directions.
- **Track metadata**: the current track title, model, source, duration, and play state are posted so the engine can sync its own readouts.
- **Visibility**: when the tab is hidden, the engine parks its render loop, so a warm but backgrounded VJ tab costs close to 0% GPU.
- **akvj depth**: the `akvj` module (`/api/akvj`, with `/ws/source` and `/ws/view` WebSockets) fans an Azure-Kinect depth-and-color stream from a Unity app into the engine, feeding the Depth cloud source in §10.1.

### 10.4 Export

The visual engine records performances and the backend transcodes the recording to the chosen codec. The saved path is reported back and surfaced in the Processing Log. Exports are written to the local `exports/` folder and are never committed to the repository.

### 10.5 Broadcast and watch-link

A WebRTC signaling module (`/api/broadcast`) backs a live watch-link of the VJ output, so a viewer on the venue LAN can open a URL and watch the visuals peer-to-peer, with no media passing through the server. The GO-LIVE broadcaster front end, a DJ-audio host hop, and a TURN relay for public links are still in progress.

### 10.6 Autopilot visual effects

The VJ engine includes an Autopilot that layers audio-reactive visual effects, such as feedback wash, glitch, and waveform warp, each with its own probability, under a single Autopilot toggle. Turning it on lets the visuals evolve hands-free in time with the audio.

### 10.7 Source banks

Any source snapshots into a bank slot for instant recall during a set. Clicking an empty slot opens a place menu (clip, source, or local file) anchored at the click point, and the bank grid recalls a slot with one click.

### 10.8 Effect chain

Separate from Autopilot (§10.6), the operator stacks effects on the output as a composable, source-agnostic, MIDI-mappable chain, with a SOLO mode that isolates one effect for setup. The families are color and optics (hue, saturation, contrast, invert, edge detect), geometry (mirror, kaleidoscope, radial mirror, tiling, equirectangular 360, stereo split), generative (reaction-diffusion, SDF raymarch portal, isolines, fluid displacement), depth (fog, tilt-shift, plane splits, depth-edge outline), distortion and glitch (feedback, RGB split, chromatic aberration, strobe, pixelate, wave warp), time (speed, reverse, echo trails, slit-scan), and post (scanlines, vignette, CRT). The ASCII effect is a post pass that renders the output through a glyph atlas.

### 10.9 BPM sync and pose control

The visuals lock to a BPM taken from the audio bridge or a DJ deck, driving time-based effects and Autopilot transitions in tempo. A Sway pose control bus drives mapped parameters from camera-tracked motion, alongside the MIDI and SLIDE control paths in §10.3.

![VJ tab panel loading state](screenshots/08-vj-tab-loading__vj-panel.png)

---

## 11. TRAIN Tab

### Purpose

The TRAIN tab (`TrainingView`) is the interface for LoRA fine-tuning configuration and autoencoder round-trip validation. Some endpoints are fully implemented in the backend; others are stubs in this fork pending integration.

### 11.1 Target Architecture

| Field | Description |
|---|---|
| **Module name** | Output checkpoint filename label. |
| **Target module** | Which submodule to attach LoRA to (`attn_kv` is the default and most-tested). |
| **Epochs / Steps** | Training step budget. |
| **Rank** | LoRA rank. Controls the number of trainable parameters per layer. |
| **Alpha** | Scaling factor. Effective update scale is alpha divided by rank. Setting alpha equal to rank gives a scale of 1.0. |
| **Dataset path** | Server-side filesystem path containing audio files and paired text prompts. |

### 11.2 Pre-encode Workflow

Pre-encoding a dataset to latents before training accelerates iteration. Submit a dataset path and output path; the backend job runner calls `pre_encode.py` against the dataset.

> **Backend status:** stub, returns HTTP 501. Use `python -m stable_audio_3.scripts.pre_encode` directly until this is wired.

### 11.3 Autoencoder Round-trip

Upload an audio file; the backend encodes it to base64-serialized latents, then decodes them back to audio for reconstruction quality verification.

> **Backend status:** `/api/autoencoder/info` returns an empty list, so the TRAIN tab displays "no autoencoders available." Encode and decode endpoints return HTTP 501. The frontend intercepts these responses and shows specific messages in the UI instead of generic network errors.

### 11.4 Job Polling

Long-running training jobs are tracked through `GET /api/jobs/{id}`, polled at 1-second intervals. The `logs` field of the response is rendered as streaming console output.

---

![The TRAIN workspace for LoRA adapters](screenshots/train.png)

## 12. LEARN Tab

### Purpose

The LEARN tab (`LineageView`) visualizes the genealogy of every asset in the Library. The backend tracks parent and child relationships across generated, imported, stem, MIDI, and Chimera-derived assets, and LEARN renders that data as interactive graphs. This is the data-visualization view onto how a piece came to be, from its source clips through every transformation.

![The 3D lineage galaxy, with the camera flown into the cluster](screenshots/learn-galaxy.png "full")

### 12.1 Views

LEARN has three views, selected from the header:

- **Track**: the lineage tree rooted at one selected entry, showing its direct ancestry and descendants.
- **Genealogy**: the full library-wide family tree in 2D.
- **3D graph**: the complete genealogy as a force-directed WebGL graph, including virtual nodes for stems, MIDI files, and external source labels.

### 12.2 3D Graph Controls

The 3D graph has an Appearance panel with coordinated visual presets (for example particle cloud and galaxy), each swapping a bundle of node, edge, and force settings. A fullscreen toggle expands the graph to the full viewport, and a footer legend maps edge colors to relationship kinds (generated, imported, stem, MIDI, Chimera). The graph data comes from `GET /api/library/_graph/all`, and a single-entry tree comes from `GET /api/library/{entry_id}/lineage`.

### 12.3 How the visualizations are rendered

LEARN renders the genealogy data through three views, each built on its own rendering stack.

- **Track** view renders a per-track ancestry and descendant tree in custom React and SVG.
- **Genealogy** view renders the full library-wide DAG through a hand-built layered (Sugiyama-style) algorithm and draws it as one large SVG with no external graph dependency.
- **3D graph** renders a force-directed graph through `react-force-graph-3d` and `react-force-graph-2d`, where each node is a custom **three.js** object (a glowing sphere with a label) over a generated starfield backdrop, with its own camera flight and animation loops.

Every transformation in theDAW writes a lineage edge, so a remix, an inpaint, a stem split, a Chimera blend, and a Suno cover or mashup each show their parentage automatically (see §13.1).

theDAW carries several other rich visualizations, each documented in its own section: the four-mode **spectrogram viewer** (Mel, STFT, Chromagram, CQT, in §6.3 and §16) rendered server-side from `POST /api/spectrogram`; the real-time **spectral analyzer** with oscilloscope, spectrum, and radial modes and RMS and peak metering (§16.1); **wavesurfer.js** waveforms across the Library, DJ decks, and editor; a **three.js and GLSL cymatics** visualizer; and the DJ tab's canvas jog wheels and beatgrid overlays (§9).

![The cymatics and ferrofluid-orb visualizer](screenshots/ferro-orb.png)

---

![The 2D lineage family tree in LEARN](screenshots/learn-2d.png)

## 13. Library

### Purpose

The Library is persistent storage for generated, imported, processed, recorded, and fused audio. It is a collapsible right-side rail available across the workspace. The default provider is **backend-local**: metadata is mirrored through `/api/library/*`, audio is stored on disk under `data/generations/`, and playback uses range-streamed file responses so large tracks scrub without loading the full file into memory. The frontend keeps transient Blob caches for efficient repeated use within a session.

### 13.1 Automatic Entry Creation

Every successful generation in the MAKE tab produces one or more library entries. Batch jobs produce N entries with IDs `${jobId}_0`, `${jobId}_1`, and so on.

Each entry stores:

```typescript
{
  id: string,
  title: string,
  prompt: string,
  negativePrompt: string,
  model: string,
  duration: number,       // seconds
  steps: number,
  cfg: number,
  seed: number,
  audioBlob: Blob,
  mimeType: string,
  timestamp: string,      // ISO 8601
  favorite: boolean,
  rating: number | null,
  tags: string[],
  notes: string,
  source: 'generate' | 'editor-mixdown' | 'bucket'
}
```

Waveform editor mixdowns, MIX outputs, mic recordings, imports, and Chimera renders can also be saved here. Server records expose `audio_url`, `audio_filename`, `file_size_bytes`, mutable `favorite`, `rating`, `tags`, `notes`, and optional `chimera_sources` fields. User edits are persisted with `PATCH /api/library/entries/{id}`.

### 13.2 List and Grid Views

Toggle between a dense **List** view (one row per entry) and a **Grid** view (tile cards) through the icons in the section header. List view shows title, prompt preview, model chip, duration, date, file size, and a per-entry action cluster.

### 13.3 Search, Filter, Sort

- **Search** filters across title, prompt, model, tags, and notes at the same time.
- **FAVS** toggle restricts the view to favorited entries.
- **Sort** by Newest (timestamp descending), Duration (longest first), Title (alphabetical), or Plays (most-played first).

### 13.4 Per-entry Controls

| Control | Description |
|---|---|
| **Play / Pause** | Loads and plays the entry through `playerStore`. Pausing one entry while another is active stops playback globally. |
| **Play count** | A badge on each played entry shows how many times it has played. The first play after a load increments a per-entry tally persisted in the library database (`POST /api/library/entries/{id}/play`), so the count survives restarts and metadata edits. |
| **Favorite star** | Toggles the favorite flag; persisted to the backend immediately. |
| **Download** | Triggers a browser file download of the audio. |
| **Delete** | Removes the entry from the backend store and the in-memory store. |
| **Scissors icon** | Decodes the audio, computes 240-bin waveform peaks, and appends the clip to the first available waveform editor track. If no tracks exist, a new track is created. |
| **Row click** | Selects the entry; the Details panel in the bottom tab bar reflects the selection. |

Right-clicking an entry opens the per-row context menu. Depending on installed modules and selected entry state, it can send to Init, send to Inpaint, run analysis, separate stems, convert to MIDI, download a bundle, show lineage, or delete the entry.

![Library details rail with selected entry](screenshots/02-library-with-showcase-selected__library-details.png)

![Library entry context menu actions](screenshots/05-library-entry-right-click__entry-context-menu.png)

### 13.5 Bundle Downloads and Lineage

The Library exports a self-contained ZIP bundle from `GET /api/library/{entry_id}/bundle`. Bundles include the audio file, metadata, analysis rows, stem rows, MIDI rows, and lineage edges when available.

Lineage endpoints build parent and child graphs for generated, imported, stem, MIDI, and Chimera-derived assets:
- `GET /api/library/{entry_id}/lineage?depth=4` returns nodes and edges around one entry.
- `GET /api/library/_graph/all` returns the complete local genealogy graph, including virtual nodes for stems, MIDI files, and external source labels.

The LEARN tab visualizes this graph in 2D and 3D, with appearance options, fit and reset controls, and node details.

![Library bundle and download submenu](screenshots/04-library-download-submenu__download-submenu.png)

### 13.6 Stem Separation

The stems module mounts at `/api/stems` and runs a sidecar-backed separation pipeline. The 2, 4, and 6-stem splits run **Demucs** (`htdemucs`), the same engine behind the DJ live stems (§9.4); the 12-stem mode layers **LARSNET** on the Demucs base to separate the drum bus into kick, snare, toms, hi-hat, and cymbals, and it needs pretrained `.pth` weights (`pretrained_larsnet_models/`), so 12-stem can be unavailable when those are missing. Progress is persisted in the library database, and stem audio is served through `GET /api/library/stems/{stem_id}/audio` for editor, init, and inpaint routing. The same engine is also packaged as a standalone drop-in backend in `integration-package/`.

Important endpoints:
- `GET /api/stems/probe` checks tool availability without spawning the sidecar.
- `POST /api/stems/install` installs integration dependencies into the configured Python environment.
- `POST /api/stems/start` and `POST /api/stems/stop` manually control the sidecar.
- `POST /api/stems/{entry_id}/run` separates one library entry.
- `GET /api/stems/{entry_id}/progress` polls `phase`, `message`, `progress`, and `task_id`.
- `POST /api/stems/{entry_id}/abort` requests cancellation at the next poll tick.

### 13.7 MIDI Conversion

The MIDI module mounts at `/api/midi` and converts full tracks or separated stems to Standard MIDI Files. It supports installable engines such as `basic_pitch` and `piano_transcription_inference`. A converted file can flow straight into the Piano Roll or Step Sequencer, so a generated or imported track becomes editable notes.

Important endpoints:
- `GET /api/midi` reports capabilities and available engines.
- `POST /api/midi/install?engine=basic_pitch` installs a conversion engine.
- `POST /api/midi/{entry_id}/run?from_stems=true` runs conversion for one entry.
- `GET /api/midi/{entry_id}` lists MIDI rows for an entry.
- `GET /api/midi/file/{midi_id}` streams `.mid` bytes for import into Piano Roll or Step Sequencer.

### 13.8 Video and Image Media

The Library's **Video** sub-tab holds video and image entries (`kind='video'` and `kind='image'`) separately from audio, so the Tracks, Stems, and MIDI sub-tabs stay audio-only. **Import media** accepts common video and image formats (mp4, webm, mov, png, webp, gif, and more). Each import stores the original file untouched under `data/generations/<id>/`, probes its dimensions, duration, and transparency, and renders a poster thumbnail. Transparent media (a PNG/WebP with an alpha channel, or an alpha WebM) is badged **Alpha** to mark it as overlay-capable.

Important endpoints:
- `GET /api/library/entries?kind=media` lists video and image entries (`kind=audio` is the default for the audio library; `kind=all` returns everything).
- `POST /api/library/import-media` accepts a video or image upload and returns the new entry.
- `GET /api/library/media/{id}` streams the file with Range support for video scrubbing.
- `GET /api/library/media/{id}/thumb` serves the poster thumbnail.

This media library backs the VJ tab: clips loaded there are saved as stable library entries, so a VJ cue survives a reload, and alpha-capable media can drive overlays.

### 13.9 Format Conversion

The `convert` module (`/api/convert`) performs generic FFmpeg format conversion behind the Library's right-click **Convert to...**: audio to audio, video to video, video-to-audio extraction, video to GIF, and image to image. It is distinct from the MIDI conversion in §13.7, which transcribes audio into notes.

### 13.9 Library Analysis

A stats footer shows the total entry count, the favorites count, cumulative storage size, and cumulative playback duration.

### 13.10 Suggest a Playlist

The **SUGGEST** button opens a playlist builder that sequences analyzed tracks into a continuous set. The criteria are a target length, an optional BPM range, a flow shape (Steady, Build up, Wind down, or Wave), a harmonic toggle, and an optional genre or text filter. The backend engine (`POST /api/library/suggest-playlist`) reads each track's analysis and orders the set by harmonic key on the Camelot wheel, the chosen BPM flow, and small nudges toward popular and stylistically varied picks, filling the time budget. Each result row shows its BPM, Camelot code, and the reason it was chosen.

Two actions run the result:

- **Play All** loads the sequence into the footer player and auto-advances track to track, restoring the loop preference when it finishes.
- **Send to DJ** loads the order as the active automix set, switches to the DJ tab, and starts the beatmatch-crossfade automix (see §9.7).

Suggestions are strongest when the library is analyzed. Unanalyzed tracks still fill the budget but cannot be harmonically sequenced; the analyzer and the analyze-on-add toggle cover this over time.

### 13.11 Empty State

Shown until the first generation. It contains a **Go generate something** button that switches the active workspace to MAKE.

### 13.12 Stems and MIDI as First-Class Items

The library splits its contents into four sub-tabs: **Tracks**, **Stems**, **MIDI**, and **Video**. Stems and MIDI are first-class items rather than attachments to a parent track. Each row plays through the shared engine, can be favorited, and can be deleted on its own without touching the source track.

A stem row plays its separated audio and shows the separation model. Its right-click menu sends the stem to a new editor track, to the tail of the first track, to Init audio, to Inpaint, or to the Chimera stack, and offers a `.wav` download. A MIDI row plays through the synth and can be sent to the Piano Roll, the Step Sequencer, or (rendered to audio) to the editor, Init audio, Inpaint, or Chimera, with a `.mid` download. Favoriting or deleting a stem or MIDI row affects only that row, never its parent entry.

---

## 14. Step Sequencer

### Purpose

A 16-step drum machine driven by a BPM clock, with five synthesized voice types. All audio routes through the shared Web Audio engine. It is available as the **Sequence** tab in the bottom panel.

### 14.1 Transport

| Control | Description |
|---|---|
| **Tempo (BPM)** | Clock rate, 40 to 240 BPM. Each step represents a 16th note. |
| **Play / Stop** | Starts and stops the step clock. The first press unlocks the `AudioContext` (browser autoplay policy). |
| **Random Fill** | Randomizes the step pattern for every track at once. |
| **Clear** | Sets all step buttons to off for all tracks. |
| **Add Track (+)** | Appends a new track with a synthesized voice. |

### 14.2 Voice Synthesis

Each track's voice is synthesized on the fly through the Web Audio API:

| Voice | Synthesis method |
|---|---|
| **kick** | Pitched sine oscillator with a rapid frequency sweep (pitch drop) and an exponential gain decay. |
| **snare** | Bandpass-filtered noise burst combined with a short tonal sine body. |
| **hat** | White noise through a high-frequency bandpass filter with a short gain decay. |
| **tone** | Sawtooth oscillator through a low-pass filter with an ADSR envelope. Frequency set by the track's `freq` parameter. |
| **noise** | White noise through a frequency-dependent low-pass filter with a short decay. |

All voices share the same `triggerVoice` function, which accepts a `BaseAudioContext` and a destination node. The same synthesis code drives both live playback and offline rendering.

### 14.3 Per-track Controls

| Control | Description |
|---|---|
| **Name** | Editable text label. |
| **Voice chip** | Displays the current voice type. Click to cycle through `kick`, `snare`, `hat`, `tone`, `noise`. |
| **Volume slider** | Per-track gain, 0 to 1. |
| **Step buttons (16)** | Toggle individual steps on and off. Buttons on beats 1, 5, 9, 13 carry a distinct visual emphasis. |
| **Preview (target icon)** | Hover-revealed. Triggers the voice once without starting the clock. |
| **Remove (trash icon)** | Hover-revealed. Deletes the track. |

### 14.4 Send to Editor

Renders the current pattern offline to a WAV Blob through `OfflineAudioContext`, then appends it to the waveform editor as a new clip on a new track. The clip's source kind is set to `'audio'`.

### 14.5 MIDI Export

The sequencer exports Standard MIDI Files:
- **Single mixed track** writes all active voices into one MIDI track.
- **One track per voice** writes each sequencer lane as a separate MIDI track.
- **Bars to render** controls the offline audio render length when sending to the editor.

These exports use the same PPQ timing constants as live playback (`PPQ = 480`, one 16th note equals `PPQ / 4`), so MIDI files line up with the sequencer grid.

---

![The 16-step sequencer with five synthesized voices](screenshots/sequencer.png)

## 15. Piano Roll

### Purpose

A MIDI-style note editor for melodic and harmonic content. Notes are placed on a chromatic grid, rendered to audio through a sawtooth-and-filter synthesizer, and exported as MIDI or sent to the waveform editor. It is available as the **Piano** tab in the bottom panel.

### 15.1 Grid and Keyboard

A vertical chromatic keyboard (MIDI notes 0 to 127, configurable visible range) occupies the left axis. The horizontal grid represents time in 16th-note steps at the configured BPM. Black and white keys are visually distinguished; note labels appear on C notes.

### 15.2 Note Editing

| Action | Result |
|---|---|
| Click an empty grid cell | Places a new note at that pitch and step. |
| Drag a placed note horizontally | Repositions the note in time. |
| Drag the right edge of a note | Resizes the note's duration. |
| Click a placed note | Selects it. |
| Delete / Backspace | Removes the selected note. |

### 15.3 Playback

The Play button starts a step-based clock that advances `currentStep` and triggers each note whose `step` index matches, routed through the shared engine `AudioContext` and master gain node. Output is audible in the spectral analyzer. Stop halts the clock.

### 15.4 BPM and Grid Length

- **BPM** sets the tempo for playback and offline render. Range: 40 to 240.
- **Total Steps** defines the loop length in 16th-note steps. Longer values extend the grid horizontally.

### 15.5 MIDI Import and Export

- **Import MIDI** parses a `.mid` file through `parseMidi` and replaces the current note list with the imported content. Tempo and note mappings are preserved.
- **Export MIDI** serializes the current note list to a standard MIDI file through `downloadMidi` and triggers a browser download.

### 15.6 Send to Editor

Renders the current note pattern to a 44.1 kHz stereo WAV through `OfflineAudioContext`. The rendered clip is appended to the waveform editor on a new track. The clip's metadata records `sourceKind: 'piano-roll'`, the note list, BPM, and grid length, so it can be re-opened for editing.

### 15.7 Edit in Piano Roll

Clips in the waveform editor whose `sourceKind` is `'piano-roll'` display an **Edit in Piano Roll** action. Triggering it loads the clip's stored note list and BPM into the piano roll store and switches the bottom panel to the Piano tab.

### 15.8 Instrument: Soundfont and Synth Voices

The **Instrument** picker chooses how the Piano Roll's notes sound, both for preview and for the soundfont-backed render. The default is **Basic (sawtooth)**, the lightweight built-in synth. The **General MIDI** group selects any of the 128 GM programs, played through a bundled SoundFont (`gm.sf3`) on the SpessaSynth engine; the soundfont warms up on first use and falls back to the sawtooth if it cannot load.

The picker also lists procedural synth voices grouped as **Bass**, **Lead / Chord**, **FX**, **Psychoacoustic** (phantom-sub, binaural, Shepard, difference-tone, and related voices), and **Talk-Box** (formant-filtered vowel voices in Bass, Tenor, Countertenor, Alto, and Soprano ranges, each with five sung vowels). A Talk-Box voice runs a sawtooth glottal source through a bank of formant filters, so each vowel reads as a sung "ah/eh/ee/oh/oo." The selected instrument also drives live MIDI playback in the timeline (see §7.10).

---

![The piano roll with MIDI import and export](screenshots/piano.png)

## 16. Bottom Panel Tabs

The bottom panel is collapsible and vertically resizable (drag the grip handle above it), and a maximize toggle expands any tab to fill the window. Six tabs are available.

### 16.1 Visualize: Real-time Spectral Analyzer

Live visualization of the shared Web Audio engine's output, reading from the engine analyser node continuously through `requestAnimationFrame`.

**Display modes** (O / S / R buttons, vertical column, top-left of the canvas):

| Mode | Description |
|---|---|
| **Oscilloscope (O)** | Time-domain waveform drawn with a purple glow. Amplitude on the vertical axis; sample index on the horizontal. |
| **Spectrum (S)** | Frequency-domain bar chart. Bins are log-scaled; bar height represents magnitude. Gradient from deep purple at the base to lavender at the peak. Bars are constrained below the status overlay to prevent visual overlap. |
| **Radial (R)** | Frequency data mapped to a polar shape, drawn as a closed path centered in the canvas. |

**Status overlay** (bottom of the canvas, gradient backdrop):

- Sample rate (kHz) and FFT size.
- RMS level in dBFS (sampled every 5 animation frames), marked with a yellow lightning icon.
- Peak level in dBFS, marked with a green target icon.
- LIVE or SILENT state (signal threshold −60 dBFS). LIVE animates with a purple pulse.
- Settings and fullscreen toggle buttons.

Text in the overlay uses `textShadow` for legibility against any visualization behind it.

**Canvas scaling:** the canvas is sized to its container in physical pixels (device pixel ratio capped at 2×) through a `ResizeObserver`. The `style` dimensions are set in CSS pixels, so the canvas stays crisp on high-DPI displays.

![The real-time spectral analyzer](screenshots/visualizer.png)

### 16.2 Piano

Full piano roll interface embedded in the bottom panel. See [§15](#15-piano-roll).

### 16.3 Sequence

Full step sequencer embedded in the bottom panel. See [§14](#14-step-sequencer).

### 16.4 Details

Displays full metadata for the currently selected library entry.

| Field | Displayed value |
|---|---|
| Title | Entry title |
| Prompt / Negative prompt | Generation text |
| Model | Model key |
| Duration | MM:SS.ms |
| Steps / CFG / Seed | Generation parameters |
| Timestamp | Locale date and time |
| File size | Bytes / KB / MB |
| Tags / Notes | Editable per-entry |
| Source | `generate`, `editor-mixdown`, or `bucket` |

**Actions:**
- **Audition in engine** loads the entry into `playerStore` and begins playback.
- **Send to editor** decodes waveform peaks and appends the entry to the waveform editor as a new clip.
- **Download** triggers a browser file download of the audio.

**Prompt inference:** When the entry has been analyzed (§13.8), the **PROMPT INFERENCE** box derives a Stable Audio prompt and semantic tags from the analysis, and **USE AS PROMPT** copies the text into the MAKE prompt field. See §33.6.

### 16.5 Media

A session-scoped file holding area for arbitrary audio files. Contents are cleared on page reload.

- **Dropzone** accepts drag-and-drop or click-to-upload. Supported formats: WAV, MP3, FLAC, OGG, AAC, M4A, Opus. Library entries can be dragged in directly using the `application/x-thedaw-library-id` transfer protocol to locate the source file from the backend store.
- **Per-item display**: filename, MIME type, file size.
- **Send to Editor** decodes peaks and appends the item to the waveform editor as a new clip on a new track. Non-audio files are rejected with a log entry.
- **Send to Library** decodes the audio, measures its duration, and creates a persistent entry with `source: 'bucket'`.
- **Remove** removes the item from the bucket. The library and editor are unaffected.
- **Clear all** removes every item at once.

### 16.6 SLIDE

The SLIDE tab is the glass-capsule control surface that mirrors the VJ engine's control manifest as faders. Moving a SLIDE fader updates the matching control in the VJ, and moving a control inside the VJ updates SLIDE. A content toggle switches which control set is shown, a detach button pops SLIDE out into its own window for a second monitor, and the shared maximize toggle expands it to fill the panel.

![The SLIDE glass control surface](screenshots/slide.png)

### 16.7 Score

The Score tab renders a track's symbolic music — sheet music, guitar and bass tabs, and arrangements — from its MIDI artifacts, and exports to MusicXML, ABC, PDF, and SVG. It is documented in full in §33.

---

## 17. Player Footer

A fixed bar at the bottom of the viewport (z-index 50), visible and functional across all tabs and workspace modes.

### 17.1 Track Information (left region)

- **Thumbnail**: an animated music-note icon with a purple pulse during playback.
- **Title**: the current `playerStore.currentLabel`, truncated to fit the column.
- **Model chip**: derived from `useGenerateStore.lastModelName`. Shows `LIBRARY` for entries loaded from the library and `IDLE` when nothing has been generated or loaded.
- **Duration readout**: `MM:SS // 48kHz`, read from `playerStore.duration`.

### 17.2 Transport (center region)

| Control | Description |
|---|---|
| **Loop** | Toggles looped playback in `playerStore`. Active state shown in purple. |
| **Skip to start** | Calls `playerStore.seekByFraction(0)`. |
| **Play / Pause** | Primary playback toggle. In EDIT workspace mode with no editor audio loaded, the first press triggers an offline render of the waveform editor timeline, loads the result into `playerStore`, and begins playback. Subsequent presses toggle playback natively. |
| **Skip to end** | Calls `playerStore.seekByFraction(1)`. |
| **Fullscreen** | Toggles browser fullscreen on `document.documentElement`. |

**Progress bar:** a horizontal track showing playback position. Click anywhere to seek (`playerStore.seekByFraction`). On hover, a circular scrubber handle appears at the current position. Time labels at left and right show current time and total duration. The footer synchronizes its playhead with the Waveform Editor; scrubbing the progress bar updates the editor timeline position when the editor timeline is the active audio source.

### 17.3 Utilities (right region)

- **Mute toggle** switches the `playbackStore` mute flag. The volume icon changes to a red `VolumeX` when muted.
- **Volume slider**: an overlay `<input type="range">` drives `playbackStore.volume` (0 to 100). The visual fill scales proportionally. The combined `volume × !muted` value is forwarded to `playerStore.setMasterGain`, which drives the shared Web Audio master gain node.
- **Download** retrieves the library entry whose `id` matches `playerStore.currentEntryId` and triggers a browser file download.
- **More** is decorative.

---

## 18. Processing Log

A collapsible message log pinned in the global footer alongside the bottom panel.

### Producers

| Source | Events |
|---|---|
| `system` | Application startup, model load status. |
| `health` | Backend connectivity check results. |
| `generate` | Job submission, progress, completion, errors. |
| `training` | LoRA job updates (when wired). |
| `studio` | MIX processing results and errors. |
| `sequencer` | Sequencer start, stop, and render events. |
| `library` | Backend save and load events. |
| `vj` | VJ export results and bridge errors. |

### Log Levels

Each entry carries a severity level shown as a colored left-border indicator:

| Level | Color | Usage |
|---|---|---|
| `info` | Purple | Normal operational events. |
| `warn` | Amber | Non-fatal anomalies. |
| `error` | Red | Failures that prevented an operation from completing. |
| `debug` | Gray | Verbose internal state for development. |

### Controls

- **Ring buffer capacity:** 500 entries. The oldest entries are discarded when the cap is reached.
- **Auto-scroll:** the log panel scrolls to the most recent entry automatically.
- **Download:** exports the full buffer as `thedaw-log-YYYYMMDD-HHMMSS.txt`. Each line contains an ISO timestamp, level, source, and message.
- **Clear:** wipes the ring buffer.
- **Collapse/expand:** click anywhere on the header bar. The collapsed state shows the entry count and a "click to expand" hint.

---

## 19. Backend API Reference

All endpoints are served under `/api/*` on port 8600. Error responses use `{"detail": string}` (FastAPI default) or `{"error": string}`. The `SA3_DEBUG_ERRORS` environment variable (set to `"1"`) enables additional detail fields in error responses.

### 19.1 Health

```
GET /api/health
```

Response when healthy:
```json
{ "status": "ok", "model_loaded": true }
```

Response when degraded (HTTP 503):
```json
{ "status": "degraded", "model_loaded": false, "error": "MODEL_LOAD_FAILED" }
```

### 19.2 System Statistics

```
GET /api/system-stats
```

Returns a JSON object describing current hardware utilization. This endpoint invokes nvidia-smi and polls psutil to stream GPU VRAM usage, GPU temperature, GPU utilization, CPU usage, and RAM usage.

### 19.3 Model Info

```
GET /api/model-info
```

```json
{
  "active_model": "medium",
  "available_models": ["medium"],
  "sample_rate": 44100,
  "diffusion_objective": "rectified-flow",
  "has_cuda": true,
  "device": "cuda:0",
  "vram_used_gb": 4.2,
  "vram_total_gb": 6.0
}
```

### 19.4 Generation, Async (theDAW UI)

Submit:
```
POST /api/generate-jobs   multipart/form-data
```

| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | required | Generation text prompt. |
| `negative_prompt` | string | `""` | Aspects to suppress. |
| `model_name` | string | `"medium"` | Model key. |
| `duration` | float | `30.0` | Output length in seconds. |
| `steps` | int | `8` | Denoising steps. |
| `cfg_scale` | float | `1.0` | Classifier-free guidance scale. |
| `seed` | int | `-1` | −1 for random. |
| `batch_size` | int | `1` | Number of simultaneous variations. |
| `init_noise_level` | float | `1.0` | Audio-to-audio conditioning strength. |
| `init_audio_type` | string | `"Audio"` | `"Audio"` or `"RF-Inv"`. |
| `file_format` | string | `"wav"` | Output file format. |
| `mask_start` | float | `0.0` | Inpaint region start in seconds. |
| `mask_end` | float | `0.0` | Inpaint region end in seconds. |
| `init_audio` | file | optional | Source audio for audio-to-audio mode. |
| `inpaint_audio` | file | optional | Source audio for inpainting. |

Response:
```json
{ "job": { "id": "<uuid>" } }
```

Poll:
```
GET /api/jobs/{job_id}
```

```json
{
  "id": "...",
  "kind": "generate",
  "status": "queued | running | completed | failed",
  "progress": { "step": 4, "steps": 8 },
  "result": {
    "batch": false,
    "item": { "audio_base64": "...", "mime_type": "audio/wav", "filename": "..." }
  },
  "error": "..."
}
```

Batch results use `"batch": true` with an `"items"` array instead of a single `"item"`.

### 19.5 Spectrogram Generation

```
GET /api/spectrogram/{job_id}
GET /api/spectrogram/{job_id}/{index}
```

Retrieves cached spectrogram output to avoid redundant generation overhead.

### 19.6 Generation, Synchronous

```
POST /api/generate   multipart/form-data
```

The same surface as `/api/generate-jobs` plus advanced parameters: `sampler_type`, `apg_scale`, `sigma_max`, `cfg_rescale`, `cfg_norm_threshold`, `cfg_interval_min`, `cfg_interval_max`, all distribution-shift parameters (`dist_shift_type`, `logsnr_*`, `flux_*`, `full_*`), and RF-Inversion parameters (`inversion_steps`, `inversion_gamma`, `inversion_unconditional`).

Response: a raw binary audio body (`audio/wav` by default). This endpoint runs synchronously and exposes the full advanced parameter set.

### 19.7 Studio Processing

```
POST /api/studio/process   multipart/form-data
```

| Field | Type | Description |
|---|---|---|
| `audio` | file | Input audio. Required. |
| `effect` | string | One of the effect keys from §8.3. |
| `params` | string | JSON-serialized `Record<string, number>`. |
| `output_format` | string | `wav`, `flac`, `ogg`, `mp3`, `aac`, or `opus`. |

Response: a binary audio body with the matching `Content-Type` header.

### 19.8 Jobs List

```
GET /api/jobs
-> Array of all job objects currently in the in-memory store.
```

The job store is in-memory only, so all jobs are lost on backend restart.

### 19.9 Training and Autoencoder (Stub Endpoints)

| Endpoint | Status |
|---|---|
| `GET /api/autoencoder/info` | Returns empty arrays. |
| `POST /api/jobs/train-lora` | HTTP 501. |
| `POST /api/jobs/pre-encode` | HTTP 501. |
| `POST /api/autoencoder/encode` | HTTP 501. |
| `POST /api/autoencoder/decode` | HTTP 501. |

### 19.10 Presets

```
GET /api/presets   -> []
POST /api/presets  -> { "id": "<uuid>", "saved": true }
```

Reserved for future use.

### 19.11 Assistant

All routes under `/api/assistant` are provided by `backend/assistant_routes.py`.

**Provider catalog**
```
GET /api/assistant/providers
→ { "providers": [ { "id", "label", "default_model", "has_key", "is_local" }, ... ] }
```

Returns one entry per configured provider. `claude` (Claude Code CLI) is always present with `has_key: true`. Remote providers with no API key in the environment are still listed, and requests to them fail until a key is added.

**Model discovery**
```
GET /api/assistant/models/{provider_id}
→ { "models": [...], "model_ids": [...], "error": null | string }
```

For `openrouter` and `openrouter-free`, this fetches the model list from OpenRouter with a free or paid filter. For `ollama`, it queries the local `/api/tags` endpoint. For `gemini`, it queries the Google model list. All others use the standard `/v1/models` endpoint.

**Chat (streaming)**
```
POST /api/assistant/chat   application/json
```

Request body:
```json
{
  "provider": "gemini",
  "model": "gemini-2.0-flash",
  "messages": [ { "role": "user", "content": "..." } ],
  "attachments": [],
  "claudeMode": "interactive"
}
```

Response: server-sent events (`text/event-stream`). Each event is a JSON object:
```json
{ "type": "delta", "content": "..." }
{ "type": "done" }
{ "type": "error", "message": "..." }
```

For the `claude` provider, `claudeMode` controls process lifecycle: `interactive` and `persistent` keep a warm Claude Code stream-json process across messages; `oneshot` and `resume` spawn per message.

**Key pool management**
```
POST   /api/assistant/keys/{provider_id}/ingest      → add keys (body: newline-separated or JSON array)
DELETE /api/assistant/keys/{provider_id}/{key_hash}  → remove one key
DELETE /api/assistant/keys/{provider_id}             → clear all keys for provider
GET    /api/assistant/keys                            → status for all providers
GET    /api/assistant/keys/{provider_id}             → status for one provider
GET    /api/assistant/keys/{provider_id}/raw         → key hashes with full status
```

Keys are stored in memory and lost on restart. The pool round-robins across available keys per provider, tracking last-used timestamps and failure counts.

**RAG reindex**
```
GET /api/assistant/reindex
→ { "status": "ok", "chunks_indexed": N }
```

Forces a full re-parse and re-embedding of `USER_GUIDE.md` into the ChromaDB vector store. Called automatically at startup.

### 19.12 Module Loader

```
GET /api/modules
-> [ { "name", "label", "enabled", "api_prefix", ... }, ... ]
```

Returns the manifests (`module.json` contents) for every module that loaded successfully at startup. A module that failed to load does not appear in this list.

Settings and module-management endpoints used by the Settings modal:
```http
GET   /api/settings
PATCH /api/settings
GET   /api/modules/all
PATCH /api/modules/{dirName}/enabled
POST  /api/admin/restart
POST  /api/admin/shutdown
```

`PATCH /api/settings` accepts a partial nested object and silently drops unknown keys, so newer and older frontends stay compatible. Module enablement is persisted in module manifests and settings and takes effect according to each module's loader behavior; a backend restart may be required for import-time changes.

![Settings modal toggles and admin actions](screenshots/07-settings-modal-with-shutdown__settings-toggles.png)

### 19.13 Disk-backed Library

The default local storage provider uses `/api/library`.

```http
GET    /api/library/entries
GET    /api/library/entries/{entry_id}
GET    /api/library/audio/{entry_id}
PATCH  /api/library/entries/{entry_id}
DELETE /api/library/entries/{entry_id}
POST   /api/library/import
GET    /api/library/{entry_id}/bundle
GET    /api/library/{entry_id}/lineage?depth=3
GET    /api/library/_graph/all
GET    /api/library/_all/stems
GET    /api/library/_all/midi
GET    /api/library/stems/{stem_id}/audio
```

Audio responses use `FileResponse` and support browser range requests. Imports accept multipart audio plus JSON metadata. Bundle responses are ZIP files containing audio, metadata, analysis, stems, MIDI, and lineage edges when available.

### 19.14 Chimera

```http
GET  /api/chimera/probe
POST /api/chimera/probe/refresh
POST /api/chimera/analyze
POST /api/chimera/mashup
```

`POST /api/chimera/analyze` accepts one uploaded clip and returns its detected BPM, beat positions, and key. The MAKE stack calls it for every clip on add, shows the result as row badges, and forwards it to the mashup so the server skips re-detection.

`POST /api/chimera/mashup` accepts multiple uploaded files plus `target_bpm`, optional `base_index`, JSON `weights`, `align_mode` (`start`, `downbeat`, `weave`), `out_sr`, weave-specific bar and polyphony controls, and an optional `known_analysis` JSON list carrying per-clip BPM and beats from analyze-on-add. The response contains base64 WAV audio plus `sample_rate`, `duration_sec`, `target_bpm_used`, `target_bpm_source`, `align_mode_used`, per-clip metadata, and warnings.

### 19.15 Stems

```http
GET  /api/stems/probe
GET  /api/stems/status
POST /api/stems/install
POST /api/stems/start
POST /api/stems/stop
POST /api/stems/{entry_id}/run?stems=4&device=cuda&quality=high
GET  /api/stems/{entry_id}/progress
POST /api/stems/{entry_id}/abort
GET  /api/stems/{entry_id}
```

Stem runs operate on disk-backed library entries, hold the backend idle gate while running, and persist rows in the library database so stems appear in details, bundles, lineage, and send-target workflows.

### 19.16 MIDI

```http
GET  /api/midi
POST /api/midi/install?engine=basic_pitch
POST /api/midi/{entry_id}/run?from_stems=true
GET  /api/midi/{entry_id}
GET  /api/midi/file/{midi_id}
```

MIDI conversion runs on full entries and, when available, separated stems. The streamed `.mid` files import into the Piano Roll or attach to bundles as downloadable artifacts.

### 19.17 VJ

The VJ module powers the VJ center tab and its embedded iframe. The frontend fetches the engine URL from `GET /api/vj/url`, which also returns a `mobile_url` for LAN access when the machine has a non-loopback address. The backend serves the visual engine lazily as a production build (`vite preview`), rebuilding when the engine's source is newer than `dist/`; the port and project path can be overridden through the `theDAW_VJ_PORT` and `theDAW_VJ_PROJECT` environment variables, and `theDAW_VJ_DEV=1` forces the HMR dev server for engine development. Use the Settings modal module list and the VJ tab loading state to confirm availability.

### 19.18 Notation and Prompt Inference

The `notation` module exposes `/api/notation/*` for symbolic music (MIDI to MusicXML, tabs, arrangements, and exports), and the `analysis` module exposes `GET /api/analysis/{entry_id}/prompt` for inferred prompts. Both are documented with the feature in §33.7.

---

## 20. Python Pipeline Reference

### 20.1 Text-to-audio

```python
from stable_audio_3 import StableAudioModel

pipe = StableAudioModel.from_pretrained("medium")
audio = pipe.generate(
    prompt="Lo-fi boom bap meets orchestral strings, 84 BPM",
    duration=180,
)
```

### 20.2 Audio-to-audio

```python
import torchaudio

init_audio = torchaudio.load("/path/to/audio.wav")
audio = pipe.generate(
    init_audio=init_audio,
    init_noise_level=0.9,
    prompt="bossa nova bassline",
    duration=30,
)
```

### 20.3 Inpainting

```python
inpaint_audio = torchaudio.load("/path/to/audio.wav")
audio = pipe.generate(
    inpaint_audio=inpaint_audio,
    inpaint_mask_start_seconds=4.0,
    inpaint_mask_end_seconds=8.0,
    prompt="punchy kick drum fill",
    duration=30,
)
```

**Continuation:** set `inpaint_mask_start_seconds` equal to the source clip's total length and `duration` to the desired output length. The model fills the extension conditioned on the tail of the source.

### 20.4 Autoencoder

```python
from stable_audio_3 import AutoencoderModel

ae = AutoencoderModel.from_pretrained("same-l")
waveform, sr = torchaudio.load("audio.wav")
latents = ae.encode(waveform, sr)
audio_out = ae.decode(latents)
```

Batch encoding, chunked processing, and dataset pre-encoding for LoRA training: see [docs/workflows/autoencoder.md](autoencoder.md).

### 20.5 LoRA at Inference

```python
pipe = StableAudioModel.from_pretrained("medium")
pipe.load_lora("style.safetensors", weight=0.8)
audio = pipe.generate(prompt="...", duration=30)
```

Multiple LoRAs stack additively. Strength is adjustable at runtime:

```python
from stable_audio_3.models.lora import set_lora_strength

set_lora_strength(pipe.model, 0.5)                  # all LoRAs
set_lora_strength(pipe.model, 1.0, lora_index=0)    # first LoRA only
```

Beyond runtime strength, each LoRA can be gated to a sigma interval, so it acts only across part of the denoising trajectory, and filtered to a subset of layers, so it acts only on specific blocks. Adapters stack additively. The exact parameters are in [workflows/lora.md](workflows/lora.md).

### 20.6 Advanced Generation Parameters

```python
audio = pipe.generate(
    prompt="...",
    duration=30,
    sampler_type="dpmpp_2m_sde",    # euler | rk4 | dpmpp_2m_sde | ping_pong
    sigma_max=1.0,                   # max noise level
    apg_scale=1.0,                   # Adaptive Projected Guidance scale
    cfg_interval=(0.0, 1.0),         # sigma range over which CFG is applied
)
```

Full parameter reference: `stable_audio_3/model.py:StableAudioModel.generate`.

---

## 21. Models

| Key | Flavor | Params | Autoencoder | Hardware requirement | Max duration |
|---|---|---|---|---|---|
| `small` | ARC | 433 M | SAME-S (266 M) | CPU | 120 s |
| `medium` | ARC | 1.4 B | SAME-L (1.7 B) | GPU (CUDA) | 380 s |
| `small-rf` | RF | 433 M | SAME-S | CPU | 120 s |
| `medium-rf` | RF | 1.4 B | SAME-L | GPU (CUDA) | 380 s |
| `same-s` | Autoencoder | 266 M | n/a | CPU | n/a |
| `same-l` | Autoencoder | 1.7 B | n/a | GPU | n/a |

ARC checkpoints bundle the autoencoder. Standalone SAME checkpoints share weights with the bundled version and reuse the cached full checkpoint when both are available. The Small model runs on modest GPUs; the Medium model needs around 8 GB of VRAM.

The MAKE Model dropdown also lists two engines beyond these checkpoints. `magenta-small` reaches the Magenta RealTime 2 sidecar for streaming text-to-music (§27). Suno cloud generation sits under `suno` (§26). Both options share the dropdown with the local Stable Audio models, so one session can move across them without leaving MAKE.

### 21.1 Settings → Models: local checkpoints and the no-download guarantee

Nothing downloads at startup. The backend boots without touching a checkpoint, and a model loads only at the first CREATE that needs it. Resolution runs local-first on every load:

1. **Local model folders** — any directory listed in `local_models.txt` at the repo root or in the `SA3_LOCAL_MODELS_DIR` environment variable, plus a `models/` folder in the repo if present. Each folder holds subfolders named after the HF repo (for example `stable-audio-3-medium/`).
2. **The Hugging Face cache** — anything a previous session already downloaded.
3. **A one-time download** from the model's HF repo, only when neither local source has the files.

The one-time download runs through the `modeldl` module (`/api/models`), which streams the weights with a live progress registry surfaced in the Settings download dock, so a first fetch shows progress instead of blocking silently.

The **Models** section sits directly below the pinned Restart/Shutdown controls in Settings, with Layout Settings right under it and the backend modules as compact tiles below that. It puts the whole model story on screen:

- **Local only (never download)** is **ON by default for fresh installs**, so nothing ever downloads until it is explicitly allowed; an existing explicit choice is preserved. With it on, a missing model fails with a clear message instead of downloading. The switch persists across restarts (it drives `SA3_LOCAL_ONLY`).
- **Installed / Connected cards** cover every engine in one glance: Stable Audio 3 (catalog plus registered checkpoints, with the active/loaded model and a ★ on the recommended option), Magenta RT2 (running / installed / needs Setup-MRT2), Suno API (key configured or not, with the key field right below), Demucs/stems, and the MIDI engines. States read Active, Ready, Cached, Local, Setup, Needs key, Missing config, or Blocked.
- **Add a checkpoint you already have** registers any checkpoint on disk, with a **Browse** button that opens the native Windows folder picker (typing a path still works). Point it at a folder containing a model config JSON plus one `.safetensors` file, or at the `.safetensors` file itself. Registered checkpoints appear under **LOCAL CHECKPOINTS** in the MAKE model picker and generate exactly like catalog models. Removing an entry never touches the files.
- **When a config JSON is missing**, the failure says exactly what was found (checkpoints, configs, what failed to pair). The config comes from the Hugging Face repo the checkpoint belongs to, or from the training/export run that produced it. When the checkpoint is a recognized built-in variant and the matching config exists locally or in the cache, a **Generate config** button copies the official JSON next to the checkpoint; configs are never guessed for unknown architectures.
- **Locations** lists every model location with its size and an **Open** button: the HF cache, each local model folder, the generated-audio library, the assistant's RAG index, the Torch hub cache, and the Magenta WSL assets and engine venv (via `\\wsl.localhost\…`). Hovering a size shows what models live in that directory, their exact paths and sizes, and stars the recommended pick when several are present (ARC over RF, medium over small).
- **Hugging Face cache breakdown** expands to a per-repo size table, each row openable in Explorer.

**No usable model?** Pressing CREATE (or LOAD) with nothing installed, or with a selection that local-only would block, never fails silently: the run stops with a plain-language explanation and Settings opens straight to the Models section, which pulses to show where the fix lives.

| Method · Path | Purpose |
|---|---|
| `GET /api/storage/locations` | Every model/data location with size, file count, and the per-directory model inventory (`?refresh=1` recomputes). |
| `GET /api/storage/model-status` | One readiness report for every engine (Stable, Magenta, Suno, Demucs, MIDI), including `usable_generation`. |
| `GET /api/storage/hf-cache` | Per-repo breakdown of the Hugging Face cache. |
| `GET/POST /api/storage/checkpoints` · `DELETE /api/storage/checkpoints/{id}` | List, register, and unregister local checkpoints. |
| `POST /api/storage/checkpoints/inspect` | Pre-registration report: found checkpoints/configs, the exact problem, recognized variant. |
| `POST /api/storage/checkpoints/generate-config` | Copy the official config next to a recognized built-in checkpoint (never guessed, never downloaded). |
| `GET/PUT /api/storage/local-only` | Read or set the no-download switch. |
| `GET /api/storage/resolution-log` | Every resolution decision this session: which file came from which local folder, the HF cache, or a download. |
| `POST /api/storage/pick-folder` · `POST /api/storage/pick-file` | Native Windows path pickers behind every Browse button. |
| `POST /api/storage/open` | Open a known location in Explorer. |
| `POST /api/model/load` | Pre-load a model (the MAKE LOAD button); the response carries the full resolution trail. |

Every load also narrates itself. The backend console prints one `model resolve:` line per file with the exact path it used, and a WARNING before anything downloads (including the T5Gemma text encoder's one-time fetch). The MAKE LOAD button echoes the same trail into the in-app LOG: where each file resolved from, a loud line when a download is about to happen, and a block notice when local-only mode stops one.

### 21.2 Manual model placement (download links and folder tree)

The **Settings → Models** panel in §21.1 is the easiest route, but checkpoints can also be placed by hand. The backend searches three locations in order: every directory in the `SA3_LOCAL_MODELS_DIR` environment variable (paths separated by `;` on Windows), every path listed one-per-line in `local_models.txt` at the repo root, and a `models/` folder in the repo root if it exists. Creating that `models/` folder is the simplest setup.

Inside a search folder, each model lives in a **subfolder named after its Hugging Face repo** (the part after `stabilityai/`). The config JSON and the `.safetensors` go in that subfolder. The original Hugging Face filenames work unchanged, and so do the generic `model_config.json` + `model.safetensors` names.

Download table (each links to its Hugging Face repo):

| Key | Use | Hugging Face repo | Files to place in the subfolder |
|---|---|---|---|
| `small` | Primary inference, CPU-capable | [stable-audio-3-small](https://huggingface.co/stabilityai/stable-audio-3-small) | `stable-audio-3-small-ARC.json`, `stable-audio-3-small-ARC.safetensors` |
| `medium` | Primary inference, CUDA GPU | [stable-audio-3-medium](https://huggingface.co/stabilityai/stable-audio-3-medium) | `stable-audio-3-medium-ARC.json`, `stable-audio-3-medium-ARC.safetensors` |
| `small-rf` | LoRA training base, CPU | [stable-audio-3-small](https://huggingface.co/stabilityai/stable-audio-3-small) | `stable-audio-3-small-RF.json`, `stable-audio-3-small-RF.safetensors` |
| `medium-rf` | LoRA training base, CUDA GPU | [stable-audio-3-medium](https://huggingface.co/stabilityai/stable-audio-3-medium) | `stable-audio-3-medium-RF.json`, `stable-audio-3-medium-RF.safetensors` |
| `same-s` | Standalone autoencoder (optional) | [SAME-S](https://huggingface.co/stabilityai/SAME-S) | `SAME-S.json`, `SAME-S.safetensors` |
| `same-l` | Standalone autoencoder (optional) | [SAME-L](https://huggingface.co/stabilityai/SAME-L) | `SAME-L.json`, `SAME-L.safetensors` |

A typical Small + Medium install under the repo-root `models/` folder looks like this:

```
stable-audio-3/
└── models/
    ├── stable-audio-3-small/
    │   ├── stable-audio-3-small-ARC.json
    │   └── stable-audio-3-small-ARC.safetensors
    └── stable-audio-3-medium/
        ├── stable-audio-3-medium-ARC.json
        └── stable-audio-3-medium-ARC.safetensors
```

The subfolder name is what matters; inside it, `stable-audio-3-medium-RF.safetensors` + `stable-audio-3-medium-RF.json`, or `model.safetensors` + `model_config.json`, both resolve.

The specialized post-trained and base variants follow the same convention: a subfolder named after the repo (`stable-audio-3-small-music`, `stable-audio-3-small-sfx`, `stable-audio-3-medium-base`, and the matching `-music-base` / `-sfx-base` repos) holding `model_config.json` + `model.safetensors`.

**Which to download.** A CUDA GPU runs `medium` (the higher-quality path, roughly 17 GB). CPU-only machines run `small`. The `-rf` checkpoints are for LoRA training, not normal generation. **SAME-S and SAME-L are optional**: the ARC and RF checkpoints already bundle the autoencoder, and a standalone SAME reuses that bundled copy, so download SAME only for standalone encode/decode without a DiT.

**The T5Gemma text encoder** ([google/t5gemma-b-b-ul2](https://huggingface.co/google/t5gemma-b-b-ul2)) is always required for text conditioning. It does NOT go in the `models/` folder; it loads from the Hugging Face cache under `%USERPROFILE%\.cache\huggingface\hub\`. Let the app fetch it on the first generation, or pre-fetch it with `hf download google/t5gemma-b-b-ul2`. Set `HF_HOME` before launching to relocate the cache.

**Already have a checkpoint elsewhere?** Skip the folder convention entirely: open **Settings → Models → Add a checkpoint you already have**, click **Browse**, and point it at the folder (or the `.safetensors` file) directly.

**Magenta RealTime 2 (optional)** is not a Stable Audio checkpoint and is not placed this way. Its one-time installer is `sidecars/magenta-rt2-nvidia/Setup-MRT2.bat`, which sets up the WSL2 engine and its assets (§27).

---

## 22. LoRA Adapter Types

Eight adapter types are available, trading parameter count against expressiveness:

| Type | Trainable params per layer | Description |
|---|---|---|
| `lora` | `rank × (fan_in + fan_out)` | Standard LoRA. Two low-rank matrices A and B; update is `(alpha/rank) × B @ A`. |
| `dora-rows` | `rank × (fan_in + fan_out) + fan_out` | DoRA with per-row magnitude. The weight update is decomposed into direction and per-output-neuron magnitude. Default adapter type. |
| `dora-cols` | `rank × (fan_in + fan_out) + fan_in` | DoRA with per-column (per-input-feature) magnitude. |
| `bora` | `rank × (fan_in + fan_out) + fan_in + fan_out` | Bi-dimensional DoRA. Independent row and column magnitude scaling. |
| `lora-xs` | `rank²` | Maximum parameter efficiency. Only a `(rank, rank)` core matrix is trained; U and V bases are frozen SVD factors of the original weight. |
| `dora-rows-xs` | `rank² + fan_out` | DoRA-rows combined with the LoRA-XS frozen SVD bases. |
| `dora-cols-xs` | `rank² + fan_in` | DoRA-cols combined with LoRA-XS bases. |
| `bora-xs` | `rank² + fan_in + fan_out` | BoRA combined with LoRA-XS bases. |

### Training configuration

| Argument | Default | Description |
|---|---|---|
| `--rank` | 16 | LoRA rank. Lower means fewer parameters; higher means more capacity. |
| `--lora_alpha` | equal to `--rank` | Scaling factor. Effective scale is alpha divided by rank. |
| `--adapter_type` | `dora-rows` | Adapter type from the table above. |
| `--dropout` | 0.0 | Dropout on LoRA inputs during training. |
| `--include` | all layers | Restrict LoRA to layers whose name contains one of these substrings. Bracket ranges are supported: `layers[0-11]`. |
| `--exclude` | none | Skip layers matching any of these substrings, even if they match `--include`. |
| `--svd_bases_path` | none | Pre-computed SVD bases `.pt` file. Eliminates per-layer SVD at startup for `-XS` adapters. |
| `--base_precision` | none | Cast frozen base weights to `bf16` after applying LoRA. Reduces VRAM usage; LoRA parameters stay in fp32. |
| `--lora_checkpoint` | none | Existing checkpoint to resume from. Loaded with `strict=False`. |

Full training walkthrough: [docs/workflows/lora.md](lora.md).

---

## 23. Troubleshooting

### Generation produces a static glitch (Medium model)

Flash Attention is not loaded correctly. Verify:
```bash
uv run python -c "import flash_attn; from flash_attn import flash_attn_func; print('Version:', flash_attn.__version__)"
```
Any import error means the wheel does not match the installed Python, PyTorch, and CUDA combination. Reinstall from [kingbri1/flash-attention](https://github.com/kingbri1/flash-attention/releases).

### "API UNREACHABLE" banner in the header

The backend is not responding on port 8600. Test directly:
```bash
curl http://localhost:8600/api/health
```
If the request fails, restart the backend. On Windows, `.\theDAW.bat` kills stale processes automatically. Manually: `taskkill /F /IM uvicorn.exe`.

### COMMIT EDIT hangs indefinitely

One or more clip source Blobs are failing to decode. The decode step has a 15-second timeout per Blob; if all clips time out, the render never completes. Check the Processing Log for `decodeAudioData timeout` entries. Likely causes: a corrupted Blob in the library, or an unusually large audio file. Remove the suspect clip and retry.

### TRAIN tab displays "TRAINING METADATA FAILED"

`/api/autoencoder/info` returned a non-OK status. In this fork, the endpoint is a stub that returns an empty list, which is the expected behavior. The TRAIN tab degrades gracefully; LoRA training is available through the command line.

### Vite dev server cannot reach `/api`

The proxy block in `vite.config.ts` is missing, or `localhost:8600` is not listening. Verify the backend is running (`curl http://localhost:8600/api/health`) and that `vite.config.ts` contains:
```typescript
server: { proxy: { '/api': 'http://localhost:8600' } }
```

### Audio plays at the wrong speed or pitch

A sample-rate mismatch exists somewhere in the chain. The full pipeline is 44.1 kHz stereo end to end. Verify `pipeline.sample_rate` and that the uploaded audio file matches.

### Out-of-memory on Medium model

The Medium model needs around 8 GB VRAM. Workarounds:
- Use the `small` model.
- Reduce `duration`; shorter sequences consume less peak memory.
- Confirm no other CUDA processes are active on the same device.
- The Small model runs on modest GPUs; the Medium model needs ~8 GB of VRAM.

### Library storage fills the disk

The disk-backed library stores audio under `data/generations/`. Delete old entries with the trash icon per row to reclaim space. The metadata database lives at `data/library.db`; both paths are gitignored.

---

## 24. Development Workflows

### Lint

```bash
uv run ruff check
uv run ruff format --check
```

Ruff excludes `stable_audio_3/models`, `inference`, `interface`, and `data`. Only top-level files (`pipeline.py`, `model.py`, `model_configs.py`, `loading_utils.py`, `verbose.py`) are checked. Run both commands from the repo root.

### Tests

```bash
uv run pytest                        # Full suite (Medium tests skip on non-CUDA hosts)
uv run pytest tests/test_inference.py
uv run pytest --save-audio           # Write outputs to test_audio_outputs/ for inspection
```

Session-scoped fixtures avoid reloading models between tests. Medium tests are skipped automatically on hosts without a CUDA GPU.

### Frontend build

```bash
cd frontend
npm run build      # Outputs to frontend/dist/
npm run preview    # Serves the built bundle locally
```

### Adding a new FFmpeg effect

1. Add an entry to `EFFECT_PARAM_BOUNDS` in `backend/server.py` with the allowed parameter ranges.
2. Extend `_build_filter()` (or its equivalent) with the FFmpeg filter graph command for the new effect.
3. Add the effect to the catalog in `frontend/src/lib/effectCatalog.ts` and surface it in the MIX tab (`frontend/src/views/MixPanel.tsx`) with a display label and color class.

### Adding a backend module

Create a new directory under `backend/modules/` with two required files.

`module.json`:
```json
{
  "name": "my-module",
  "label": "My Module",
  "enabled": true,
  "api_prefix": "/api/my-module",
  "description": "What this module does"
}
```

`router.py`:
```python
from fastapi import APIRouter

router = APIRouter()

@router.get("/status")
async def status():
    return {"ok": True}
```

The loader (`backend/modules/loader.py`) discovers the directory on the next server start and mounts the router at `api_prefix`. Set `"enabled": false` in `module.json` to disable without deleting. Any import error is logged and the module is skipped; other modules and the main app continue loading normally.

### Backend job persistence

The current async job store (the `JOBS` dict in `backend/server.py`) is in-memory, so all jobs are lost on backend restart. For production deployment, swap this for SQLite or Redis; the job object shape is well-defined and the swap is a single-layer change.

### Zustand store architecture

| Store | State owned |
|---|---|
| `useEditorStore` | Waveform editor tracks, clips, playhead, tool mode, snap, zoom, inpaint selection. |
| `usePlayerStore` | HTMLAudioElement-based playback engine (load, play, pause, seek, loop). Shared by all playback sources. |
| `usePlaybackStore` | Master volume and mute. Read by `playerStore`, the library player, and the sequencer master gain. |
| `useLibraryStore` | Disk-backed provider facade plus session Blob cache, search/filter/sort state, selected entry. |
| `useGenerateStore` | Last generation metadata (filename, model, duration) for footer display. |
| `useGenerateParamsStore` | All MAKE tab form field values. |
| `useStudioStore` | MIX tab source, output, process history. |
| `useEffectChainStore` | MIX effect chain entries, order, parameters, enabled flags. |
| `useEditorPlaybackBridge` | Module-level callback registration (not a Zustand store) decoupling the footer from the editor to avoid circular dependencies. |
| `usePianoRollStore` | Piano roll note list, BPM, grid length, playback state. |
| `useMediaBucketStore` | Session-scoped file bucket items. |
| `useBottomPanelStore` | Bottom panel open state, height, active tab. |
| `useLogStore` | Processing log ring buffer. |
| `useAppUiStore` | Center-tab shell state (`make`, `edit`, `mix`, `dj`, `vj`, `train`, `learn`) and the right library rail state. |
| `useDjLayout` | DJ tab Design Mode layout (panel order, sizes, design-mode flag). |

---

## 25. Feature Coverage and Screenshot Evidence

theDAW documentation has a repeatable audit loop connecting implemented features to guide coverage and visual proof. The same repository also records its own promo video from the live app and harvests the README feature stills from it (§25.5), so the guide, the screenshots, and the feature-tour video all derive from one capture of the running app.

> [!TIP]
> Treat this section as the docs control room: feature descriptors define what exists, screenshot specs prove it visually, and the coverage report confirms the guide explains it.

### 25.1 Coverage artifacts

| Artifact | Purpose |
|---|---|
| `scripts/screenshots/specs.ts` | Canonical feature descriptors plus screenshot and crop mapping. |
| `scripts/screenshots/featureCoverage.ts` | Generates the feature-vs-doc coverage report from `docs/USER_GUIDE.md`. |
| `docs/reports/feature-doc-coverage-report.md` | Human-readable coverage matrix and screenshot map. |
| `docs/reports/feature-doc-coverage.json` | Machine-readable report for automation. |

The coverage pass records whether `repomix-output.md` was present and confirms it is not tracked. Repomix is local analysis context only.

### 25.2 Screenshot generation

The primary screenshot runner is `scripts/screenshots/capture.ts`:

```powershell
npm --prefix frontend run screenshots
```

The runner drives the live app through real DAW interactions, writes full-scene images to `docs/screenshots/`, and emits crop assets using this naming convention:

```text
<scene-id>.png
<scene-id>__<crop-id>.png
```

For example, `03-library-actions-toolbar.png` documents the Library toolbar as a whole, while `03-library-actions-toolbar__library-toolbar.png` focuses tightly on the action cluster. One full screenshot or crop can support multiple feature IDs.

### 25.3 Current feature-to-screenshot map

| Feature ID | Recommended evidence |
|---|---|
| `shell-center-tabs-right-library` | `01-shell-make.png`, `02-library-with-showcase-selected__library-details.png` |
| `docs-modal-download-print-rag` | `01-shell-make__header-actions.png`, `docs/UI/screenshots/05-docs-modal.png` |
| `assistant-orb-providers-keys-attachments` | `01-shell-make__header-actions.png` |
| `make-advanced-generation-templates-prompts-spectrograms` | `01-shell-make__make-controls.png` |
| `make-chimera-fusion-stack` | `09-chimera-cohort-multi-select.png`, `01-shell-make__make-controls.png` |
| `make-mic-recorder-send-targets` | `01-shell-make__make-controls.png` |
| `mix-effects-chain-quick-master` | `docs/UI/screenshots/02-edit-tab-overview.png` plus future MIX crop |
| `library-backend-local-storage` | `02-library-with-showcase-selected.png`, `02-library-with-showcase-selected__library-details.png` |
| `library-bundle-download-lineage-export` | `04-library-download-submenu__download-submenu.png`, `06-learn-tab-3d-graph__lineage-graph.png` |
| `library-stems-sidecar` | `05-library-entry-right-click__entry-context-menu.png` |
| `library-midi-conversion` | `04-library-download-submenu__download-submenu.png`, `05-library-entry-right-click__entry-context-menu.png` |
| `settings-feature-toggles-modules-admin` | `07-settings-modal-with-shutdown__settings-toggles.png` |
| `sequencer-midi-export-render` | `docs/UI/screenshots/06-step-sequencer.png` plus future sequencer-toolbar crop |
| `vj-sidecar-tab-mobile-share` | `08-vj-tab-loading__vj-panel.png`, `01-shell-make__header-actions.png` |

### 25.4 Documentation maintenance rule

When adding or changing a feature:

1. Add or update its `FeatureDescriptor` in `scripts/screenshots/specs.ts`.
2. Map the feature to a full screenshot and, if needed, a crop region.
3. Update `docs/USER_GUIDE.md` first.
4. Run the coverage script and the screenshot runner.
5. Sync `docs/USER_GUIDE.md` to `frontend/public/USER_GUIDE.md` before validating the Docs modal.

### 25.5 Promo video capture

theDAW records its own feature-tour video from the live app. `frontend/_capture_clips.mjs` is a Playwright harness that boots the app once, loads a hero track (imported, stem-separated, and MIDI-converted ahead of time), and drives the Zustand stores tab by tab through every scene while recording one continuous video, then slices it into per-scene clips under `showcase/clips-recorded/`. `showcase/build_roughcut.sh` stitches the clips into the 16:9 and 9:16 feature-tour videos (`_showcase_h.mp4` and `_showcase_v.mp4`), upscaling the supersampled-1080 source to 4K. The per-scene frames also supply the README feature stills. Capture a subset with `ONLY=<scene-ids> node _capture_clips.mjs` from `frontend/`, and raise the supersample with `DSF=2`.

---

## 26. Cloud Generation: Suno

The `suno` module (`/api/suno`) adds cloud song generation through Suno's public API, surfaced as the **Aurora Cloud Console** (`SunoGenPanel`) inside the Generate workspace. The backend runs a server-side proxy that stores the API key in `data/suno_api_key.json` (gitignored) and keeps it off the browser. A full standalone API reference lives in [docs/guides/SUNO_EXTERNAL_API.md](guides/SUNO_EXTERNAL_API.md).

### 26.1 Modes

| Mode | What it does |
|---|---|
| **Simple** | One natural-language description → the model writes both lyrics and style. |
| **Custom** | Supplied `lyrics` and `style`; optional `instrumental` for no vocals. |
| **Cover** | Re-generate an existing clip with new style/lyrics/voice. |
| **Mashup** | Blend two clips into a new track. |

Simple, Custom, and Cover accept one of three preset `voice_id` UUIDs, which cover the voices currently available to partners. Mashup runs without a voice.

### 26.2 Flow and library integration

Generation is asynchronous. A submission starts a Suno job, the backend polls it, and on completion the track is registered as a first-class Library entry tagged `sunoid:<clip_id>`, with its audio proxied through the backend CDN route. Cover and mashup results additionally write parent-to-child lineage edges, so they appear in the LEARN graph (§12) and the Catalogue lineage view (§29). Jobs persist to `data/suno_jobs.json` and resume polling across reloads.

### 26.3 Endpoints

| Method · Path | Purpose |
|---|---|
| `GET /api/suno/status` | Whether a key is configured. |
| `POST /api/suno/key` · `GET /api/suno/voices` | Store the API key (atomic write); list the three preset voices. |
| `POST /api/suno/simple` · `/custom` · `/cover` · `/mashup` | Start a generation in each mode. |
| `GET /api/suno/poll/{id}` · `GET /api/suno/jobs` | Poll one job; list tracked jobs. |
| `GET /api/suno/usage` | Account usage and plan limits. |
| `GET /api/suno/audio/...` | CDN audio proxy (SSRF host-allowlisted). |

Two offline helpers under `scripts/` bulk-import an existing SunoHarvester cache: `build_api_compatible_cache.py` reshapes the cache into an API-compatible JSON, and `ingest_suno_cache.py` registers those as CDN-backed Library entries (no audio download). These are manual, one-off utilities.

---

## 27. Magenta RealTime 2

The `magenta` module (`/api/magenta`) brings Google's **Magenta RealTime 2 (MRT2)** real-time music model into the Generate workspace as a text→music option. **"Magenta RT2 (text→music)"** is always present in the Model dropdown, and selecting it runs the GPU swap automatically: the Stable Audio model parks in CPU RAM (`POST /api/model/offload`), any other MRT2 engine is stopped, and the extended sidecar starts inside WSL2. A status pill beside the dropdown tracks the engine (amber **LOADING** during the one-time model load and compile, green **READY**, red **ERROR**). On a machine where the WSL engine was never installed, the swap stops before touching the GPU and the pill shows amber **SETUP** instead; its tooltip points at `Setup-MRT2.bat` (in `sidecars/magenta-rt2-nvidia/`), the one-time consent-based installer. Selecting any Stable Audio model reverses the swap: the engine stops and the Stable Audio model returns to the GPU. No terminal is involved at any point.

![Magenta RealTime 2 text→music panel in the Generate workspace, the first non-Mac MRT2 port](screenshots/make-magenta-rt2.png)

### 27.1 The sidecar and conditioning

MRT2 runs as a sidecar (default `http://localhost:8777`, override with `THEDAW_MAGENTA_URL`) that loads `MagentaRT2Jax` once on the GPU. theDAW ships an **extended** sidecar (`sidecars/magenta/server.py`) that supersedes the upstream text-only studio server and exposes all three conditioning modes over one `POST /generate`:

- **Text**: a natural-language prompt, used by default.
- **Notes**: a MIDI note list (`[{pitch:0-127, start, end}]`) encoded to the model's 128-pitch state windows.
- **Audio-style**: a reference clip embedded through the model's style encoder, which overrides the prompt.

The response's `X-Conditioning` header reports which modes were used, and the output is 48 kHz stereo WAV. The MAKE panel surfaces the full conditioning set when a Magenta model is selected: the prompt box for text, selected MIDI pitches for note steering, the Init Audio clip as the audio-style source, plus temperature, top-k, the MusicCoCa/notes/drums CFG scales, the drums switch, chunk frames, seed, and the extend toggle that continues the current piece without a cut.

The sidecar's `/health` carries an identity field (`app: "mrt2-extended"`), and the backend probe verifies it, so the bundled JSON-protocol Studio server can never be mistaken for the extended engine.

| Method · Path | Purpose |
|---|---|
| `GET /api/magenta/probe` | Sidecar health + whether the model is loaded. |
| `POST /api/magenta/generate` | Generate from text, notes, and/or an audio-style clip. |
| `GET /api/magenta/jobs/{id}` | Poll a generation job. |
| `POST /api/magenta/engine/start` | The automatic swap: parks the SA3 model in CPU RAM, stops any other MRT2 engine, spawns the extended sidecar in WSL2. Refuses with 409 while a generation runs, and with 412 (`setup_required`) when the WSL venv or model checkpoint is missing. |
| `POST /api/magenta/engine/stop` | Stops every MRT2 engine and restores the SA3 model to the GPU. |
| `GET /api/magenta/engine/status` | Engine health, protocol identity, and spawned-process state. |
| `POST /api/model/offload` · `POST /api/model/onload` · `GET /api/model/offload-status` | The SA3 side of the swap: park the loaded model(s) in CPU RAM, restore them to VRAM, and report the parked state. The engine endpoints call these automatically. |

### 27.2 First non-Mac port of Magenta RealTime 2

theDAW ships the first non-Mac port of Magenta RealTime 2, vendored as the `sidecars/magenta-rt2-nvidia` submodule. A build-system guard in upstream MRT2's CMake locks the C++ inference engine to macOS through the line `if(NOT APPLE) FATAL_ERROR "magenta-rt-v2's C++ build is macOS-only"`. The port's `port/patch_cmake.py` removes that guard, with an anchor check that aborts if upstream drifts, and flips the related switches. The port works because the inference core uses only the portable MLX C++ API, MLX now provides a native CUDA backend (`-DMLX_BUILD_CUDA=ON`), and the single piece of Apple-specific code is an autorelease-pool shim already gated behind `#if defined(__APPLE__)`.

The result runs on Windows through WSL2 with NVIDIA, on native Linux with NVIDIA, and on RunPod cloud GPUs, which extends MRT2 to platforms beyond its macOS origin. The shipped runtime uses the JAX and CUDA backend (`magenta-rt` 2.x) loading `mrt2_small`, the model behind the MAKE dropdown's `magenta-small` engine key. The submodule also includes a streaming WebSocket jam server and a RunPod-serverless path for the larger `mrt2_base`. `sidecars/magenta-rt2-nvidia/port/README.md` has the build details.

---

![The Magenta RealTime 2 conditioning panel](screenshots/magenta.png)

## 28. Edit Tool Stack

Beyond the 24-effect MIX chain (§8), theDAW mounts the **Edit Tool Stack**, six backend module families under `/api/edit/*`. Each family provides a focused set of audio processors built on FFmpeg, NumPy, and librosa DSP. The browser GUIs come from `frontend/public/edit-modules/` and iframe into the MIX effect stage.

| Family | Prefix | Focus |
|---|---|---|
| **Mastering** | `/api/edit/mastering` | Loudness, EQ, multiband, limiting, stereo, master chain. |
| **Restoration** | `/api/edit/restoration` | Denoise, declick, hum removal, HPSS stem/vocal isolation. |
| **Enhance** | `/api/edit/enhance` | Super-resolution, de-crush, studio polish, codec cleanup. |
| **Delivery** | `/api/edit/delivery` | Format export, true-peak-aware smart export, normalization. |
| **Creative FX** | `/api/edit/creative-fx` | Macro effect graphs (character, motion, texture). |
| **Creative Neural** | `/api/edit/creative-neural` | Pitch/vocoder/granular morphs (DSP implementations). |

Each family exposes the same shape via the shared module base:

| Method · Path | Purpose |
|---|---|
| `GET {prefix}/tools` · `GET {prefix}/tools/{id}` | List the family's tools / one tool's parameter manifest. |
| `POST {prefix}/process` | Apply a selected tool to an uploaded clip; returns processed audio. |

A seventh module, **AI Analyzer** (`/api/edit/analyzer`), is an experimental decision-card engine that recommends an effect stack for a clip (`/analyze`, `/recommend`, `/build-stack`). The backend implements it, and the UI wiring is pending.

> Note: some engine labels (for example RAVE and Mel-Roformer) name the target model for a processor that currently runs a high-quality DSP implementation. The audio processing is functional today, and the named neural model represents the planned upgrade.

---

## 29. Catalogue

The **Catalogue** view (`CatalogueView`, lazy-loaded in the shell) is a cross-provider gallery over the Library. It presents grid and list layouts, a filter bar, an inspector with on-demand spectrograms, a lineage panel, and **provider badges** that classify each entry (Suno, Magenta, import, and forward-compatible slots for other providers) from its `model` and `source` fields. Its context menu runs Suno cover and mashup directly from a Library entry (§26). It reads the same backend Library API (§13) and the per-entry lineage route `GET /api/library/{id}/lineage`.

---

![The cross-provider Catalogue browser](screenshots/catalogue.png)

## 30. YouTube Import

The `ytimport` module (`/api/ytimport`) imports audio from a URL into the Library.

| Method · Path | Purpose |
|---|---|
| `GET /api/ytimport` | Module capabilities / availability (e.g. whether the downloader backend is present). |
| `POST /api/ytimport/fetch` | Fetch and import audio from a supplied URL; the result lands as a Library entry with `source` metadata, so it carries lineage like any other asset. |

Imported tracks are first-class Library entries: they can be sent to the editor, used as Chimera sources or init audio, stem-separated, and they appear in the LEARN graph as imported nodes.

---

## 31. Controller Vision

theDAW recognizes a controller across three tiers: a built-in library of roughly 110 device profiles, a scored auto-detect that matches an unknown rig to the closest profile on connect, and a learn-by-capture mode that binds a control the moment it moves. The `controllervision` module (`/api/controllervision`) adds a vision-based path on top, mapping a hardware MIDI controller from an image of it. It provides three capabilities.

- **Detect** (`POST /detect`, `/detect-by-name`) runs OpenCV control detection that finds knobs, faders, and pads in an image of a controller.
- **Identify** (`POST /identify`) runs a vision-LLM pass that names the device and infers its layout from a photo.
- **Phone pairing** (`POST /session`, `GET /session/{sid}`, `POST /session/{sid}/upload`, `GET /m/{sid}`) runs a LAN pairing flow. theDAW shows a QR code and URL, the phone opens a self-served capture page (`/m/{sid}`), the page photographs the controller, and it uploads the photo back for detection, which keeps the controller in hand during the capture.

---

## 32. Admin, Module, and Assistant-Key APIs

Operational endpoints used by the Settings modal and shell.

**Admin** (`backend/admin_routes.py`)

| Method · Path | Purpose |
|---|---|
| `POST /api/admin/restart` | Restart the backend process (Settings → Restart). |
| `GET /api/admin/restart-status` | Poll readiness after a restart. |
| `POST /api/admin/shutdown` | Shut the backend down. |

**Module loader** (`backend/server.py`)

| Method · Path | Purpose |
|---|---|
| `GET /api/modules` · `GET /api/modules/all` | List mounted modules / all discovered modules with enabled state. |
| `PATCH /api/modules/{name}/enabled` | Enable or disable a module (takes effect after a restart). |

**Assistant key pool** (`backend/assistant_routes.py`). The assistant holds several API keys per provider for load distribution and failover.

| Method · Path | Purpose |
|---|---|
| `GET /api/assistant/keys` · `GET /api/assistant/keys/{provider}` | Key status per provider (hashed for display). |
| `POST /api/assistant/keys/{provider}/ingest` | Add one or more keys to a provider's pool. |
| `DELETE /api/assistant/keys/{provider}/{hash}` · `DELETE /api/assistant/keys/{provider}` | Remove one key / clear a provider's pool. |
| `GET /api/assistant/keys/{provider}/raw` | Return raw keys for local-trust convenience, where the backend operates as a trusted-local service. |

The assistant streams chat from any configured provider: Claude Code over the CLI, Gemini, Anthropic, OpenAI, Grok, Groq, OpenRouter, Ollama, LM Studio, llama.cpp, and vLLM. Each provider draws from the hashed multi-key pool above with round-robin distribution and failover, exposes live model lists and attachments, and grounds answers in a ChromaDB RAG index over these docs.

---

## 33. Notation, Score, Tabs, and Arrangements

theDAW turns audio into symbolic music and back: audio → MIDI → sheet music, guitar and bass tabs, and playable arrangements, plus an inferred Stable Audio prompt for any track. The symbolic side lives in the **Score** tab of the bottom panel (§16.7) and the **Details** panel (§16.4), backed by the `notation` module (`/api/notation`) and the `analysis` module. The standalone guide is [guides/notation-and-score.md](guides/notation-and-score.md).

A track needs a MIDI first. Convert one from the Library (right-click → Convert to MIDI, §13.7); once a MIDI artifact exists, the Score buttons activate.

![Guitar tablature rendered from a track's MIDI in the Score panel](screenshots/score.png)

### 33.1 Notation artifacts

Every symbolic file a track produces is a notation artifact with a kind: `midi`, `musicxml`, `abc`, `alphatex` (tabs), `pdf`, or `svg`. The Score panel's left rail lists them; selecting one previews it (MusicXML as sheet music through OpenSheetMusicDisplay, alphaTex as tablature through alphaTab), and DOWNLOAD saves it. Artifacts are stored under `data/generations/<entry_id>/notation/` and tracked in the library database with lineage back to their source MIDI or score.

### 33.2 Sheet music (MAKE SHEET)

MAKE SHEET converts the first MIDI artifact to MusicXML with music21, quantizing rhythm, splitting parts, and inferring a time signature. MusicXML is the canonical interchange format and also feeds tabs, arrangements, and exports.

### 33.3 Tabs

The Tabs section turns a MIDI into tablature. Choose the instrument (Guitar or Bass), a tuning (standard, drop D, 7-string, 4- or 5-string bass), a capo fret, and a difficulty (Easy / Medium / Hard, which caps fret height and reach), then press MAKE TABS. Because the same pitch can be played at several string and fret positions, a dynamic-programming pass chooses positions that minimize hand travel, prefer open strings and low frets, and keep simultaneous notes on distinct strings. The output is alphaTex, rendered as interactive tablature by alphaTab. Notes outside the instrument's range are reported as unplayable rather than forced.

### 33.4 Arrangements

The Arrange section produces a playable MusicXML arrangement from a track's MIDIs. The styles are:

- **lead-sheet** — the melody (skyline) with chord symbols above it.
- **piano-reduction** — a two-staff grand staff split at middle C.
- **simplified** — a single-staff quantized melody.
- **band-score** — one staff per separated stem, combined into a full score.

Arrangements render in the same in-browser sheet-music viewer as MAKE SHEET and are saved as MusicXML artifacts.

### 33.5 Exporting scores (ABC, PDF, SVG)

With a MusicXML score selected, the toolbar exports it to other formats. ABC (a compact lead-sheet text format) is always available through music21. PDF and SVG are engraved by the MuseScore command-line tool and appear only when MuseScore is installed and detected; set the `MUSESCORE_BIN` environment variable if MuseScore is not on PATH. Exports register as new notation artifacts.

### 33.6 Prompt inference

The Details panel infers a Stable Audio-style prompt from a track's analysis (§13.8). After a track is analyzed, the **PROMPT INFERENCE** box's **INFER** button generates a one-line prompt plus semantic tags, for example "Approximately 118 BPM, in F minor, upbeat, danceable, moody, balanced, deep, full track, stereo." A confidence score reflects how much analysis data was available, and **USE AS PROMPT** copies the text into the MAKE prompt field. The prompt is deterministic: it is derived from tempo, key and scale, energy (loudness and RMS), timbre (pitch), length, and channel count, and folds in any embedded genre and mood tags. Genre, mood, and instrument detection through dedicated models (Essentia/MERT/CLAP) is an optional future enricher; the deterministic prompt always works without it.

### 33.7 Endpoints

```http
GET  /api/notation
GET  /api/notation/{entry_id}/artifacts
POST /api/notation/{entry_id}/from-midi/{midi_id}
POST /api/notation/{entry_id}/export
POST /api/notation/{entry_id}/tabs
POST /api/notation/{entry_id}/arrange
GET  /api/notation/file/{artifact_id}
GET  /api/analysis/{entry_id}/prompt
```

`GET /api/notation` reports capabilities (music21 and MuseScore availability, supported formats, tab tunings, arrangement styles). `from-midi` converts a MIDI to MusicXML; `export` takes `{source_artifact_id, format}` with format musicxml/abc/pdf/svg; `tabs` takes `{source_artifact_id | midi_id, instrument, tuning_name, capo, difficulty}` and returns alphaTex; `arrange` takes `{style, source_artifact_id | source_artifact_ids | midi_id}` and returns MusicXML. `GET /api/analysis/{entry_id}/prompt` returns `{prompt_guess, prompt_confidence, semantic_tags}` regenerated from the stored analysis.

---

## 34. Quest and XR Integrations

theDAW drives a Meta Quest headset for live performance without Quest Link (PC tethering) or Meta Quest Developer Hub casting. Each integration rides plain ADB over USB or a wireless pairing, and the backend starts the relay it needs on demand. The headset-side app is theDAW-XR, a standalone Quest 3 build (the GANTASMO-MIDI Unity project).

### 34.1 delinQuest: Quest video into the VJ

delinQuest streams the headset's video into the VJ as a live source. The backend `questcast` module starts a Node relay that speaks the scrcpy protocol to the headset over ADB and pushes H.264 over a WebSocket; the VJ decodes it in the browser with WebCodecs and binds it to a camera stream. The VJ source button is labelled **delinQuest** and offers a full side-by-side 3D frame or a single eye cropped to 16:9. Selecting it auto-starts the relay (it verifies ADB and Node, installs the relay's dependency once, then connects), so there is no manual casting step. It requires USB debugging or a wireless ADB pairing on the headset.

This is distinct from pointing the headset's own browser at a tunnel URL (§10.1): delinQuest pulls the headset's rendered video directly over ADB, with no in-headset browser and no public tunnel.

### 34.2 STITCH: clean passthrough into the VJ

queststitch streams only the Quest's stitched passthrough, the clean real-world composite without the performer's overlaid surface, as a separate **STITCH** source. A Unity component on the headset (`GantasmoStitchStreamer`) encodes the stitch render texture to H.264 with Android MediaCodec and sends it over an ADB-reversed TCP socket; the backend `queststitch` bridge re-frames it onto a WebSocket the VJ decodes the same way as delinQuest.

### 34.3 Quest MIDI bridge

QuestMidiBridge carries MIDI both ways between the headset and the DAW over an ADB-reversed TCP socket. The simplest route uses no extra desktop software: theDAW's `questmidi` backend module listens on the tunneled socket and republishes the headset's MIDI onto the browser's global MIDI bus. A second route relays the same frames into a loopMIDI virtual port for any other WebMIDI DAW. The headset sends control and note MIDI, including 14-bit high-resolution CC for smooth hand motion, and the bridge is two-way, so the DAW can send MIDI back to the headset.

### 34.4 Hand-tracked control of theDAW

The headset works as a hands-only controller for theDAW. A floating 3D control surface (faders, knobs, buttons, and a crossfader) sits in front of the performer, and grabbing or poking a control sends its MIDI over the bridge. Hand microgestures (swipes and a thumb tap) send their own momentary MIDI alongside the surface. Every message lands on theDAW's global MIDI bus, so MIDI-learn maps any of it to DJ, VJ, MAKE, or EDIT controls, the same as a hardware controller. The surface layout is data-driven and editable in VR, so the performer can move, scale, and rearrange it on the headset. Alongside the MIDI path, the `xrcontrol` module (`/api/xr/control`) relays a control manifest with control-set and control-changed messages, so XR spatial controls can drive theDAW setters directly without passing through MIDI.

### 34.5 Quest colocation

Several headsets in one room can share a single world frame, so the control surface and visuals lock to the same physical spot for everyone and each performer sees the others as lightweight head-and-hands presence. A one-click setup wizard in theDAW-XR installs and wires the pieces: shared spatial anchors, Meta Colocation Discovery for alignment, and Netcode for GameObjects over a LAN-direct transport with no cloud relay. The only manual steps are the Meta platform gates, which are Enhanced Spatial Services on each headset, a verified developer account, and all headsets on the same Wi-Fi.

### 34.6 Setup notes

Each integration needs USB debugging enabled on the Quest, or a wireless ADB pairing. The backend auto-detects ADB and starts the relay when the source is selected; the relay ports are configurable through environment variables (`theDAW_QUESTCAST_PORT`, `theDAW_QUESTSTITCH_PORT`). No Quest Link session and no Meta Quest Developer Hub are required at any point.

### 34.7 MIDI Reactor

The MIDI Reactor is the headset-side visualizer fed by theDAW's return MIDI over the `questmidi` bridge (§34.3). Head-mounted reactive chrome responds to the incoming note and control messages, so the performer sees the DAW's state reflected in the spatial scene. It installs from theDAW-XR's GANTASMO menu.

---

## Credits

theDAW was built by **[GANTASMO](https://github.com/gantasmo)** as part of the [Music Hackspace](https://musichackspace.org) Music Technology Hackathon at [Berklee College of Music](https://www.berklee.edu).

Special thanks to [Music Hackspace](https://musichackspace.org), [Berklee College of Music](https://www.berklee.edu), and to Zack, CJ, Jordi, Zach, and Matt from [Stability AI](https://stability.ai) for their continued help and support.

**Built with:** [Stability AI](https://stability.ai) Stable Audio 3 and [stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools) (the core diffusion model and pipeline); [Magenta](https://github.com/magenta) RealTime by [Google DeepMind](https://deepmind.google), running through theDAW's own [NVIDIA/CUDA port](../sidecars/magenta-rt2-nvidia/) (the first and only non-Mac port so far); [Suno](https://suno.com) (cloud generation); [T5Gemma](https://huggingface.co/google/t5gemma-b-b-ul2) by Google (text conditioning); [Demucs](https://github.com/facebookresearch/demucs) by Meta AI (stem separation); [basic-pitch](https://github.com/spotify/basic-pitch) by Spotify (audio-to-MIDI); [music21](https://github.com/cuthbertLab/music21) by MIT (MusicXML, ABC, tabs, arrangements), with [alphaTab](https://www.alphatab.net) and [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org) for browser tab and score rendering and [MuseScore](https://musescore.org) for PDF and SVG engraving; [MLX](https://github.com/ml-explore/mlx) by Apple (the Magenta port's inference core, extended with a CUDA backend); and [PyTorch](https://pytorch.org), [FFmpeg](https://ffmpeg.org), [three.js](https://threejs.org), [react-force-graph](https://github.com/vasturiano/react-force-graph), [WaveSurfer.js](https://wavesurfer.xyz), [React](https://react.dev), [Vite](https://vitejs.dev), and [Tailwind CSS](https://tailwindcss.com), alongside the wider open-source community.

---

*Maintained by the theDAW development team.*
