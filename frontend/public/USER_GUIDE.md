<div class="guide-cover">
  <div style="line-height:1; letter-spacing:-0.03em;"><span style="font-size:63px; font-weight:600; color:#a020f0; text-shadow:0 0 24px rgba(160,32,240,0.6);">the</span><span style="font-size:93px; font-weight:900; color:#ffffff; text-shadow:0 0 44px rgba(160,32,240,0.85), 0 0 16px rgba(160,32,240,0.6);">DAW</span></div>
  <div style="font-size:17px; letter-spacing:0.12em; opacity:0.74; font-weight:500; margin-top:1px;">ONE DAW TO RULE THEM ALL</div>
  <div style="font-size:22px; font-weight:800; letter-spacing:0.1em; color:#a855f7; text-shadow:0 0 19px rgba(168,85,247,0.45); margin-top:3px;">by GANTASMO</div>
</div>

theDAW combines several music tools in one program. It generates audio from a text prompt, arranges it on a multitrack timeline, masters it through an effects chain, splits it into stems, performs it across two beatmatched DJ decks, runs an audio-reactive visual show, transcribes it to sheet music and tablature, and files everything in a searchable library that records how each piece descended from the last. It trains custom models on a collection and answers questions about the app from a built-in assistant. The DAW, audio generator, stem separator, DJ rig, VJ engine, notation editor, sample manager, and model trainer run in a single window.

Generation runs on Stable Audio 3, the open generative audio model from Stability AI. A prompt becomes finished stereo, and the same model menu reaches Magenta RealTime 2 for streaming text-to-music and Suno for cloud renders. Chimera fusion folds several clips into one tempo-aligned track, while init signals, inpainting, and LoRA adapters steer a render toward a target.

A track then moves through EDIT for waveform surgery and region inpainting, and MIX for the Edit Tool Stack and Quick Master macros. The DJ workspace runs two decks with beatmatch sync, key-lock, live stems, an FX rack, hot cues, and hands-free automix, and the VJ workspace drives WebGL visuals from the audio, a microphone, MIDI, or a phone on the same network.

The Library keeps every piece on disk with its analysis, stems, and MIDI, and LEARN draws the lineage between pieces as a navigable 3D genealogy. A symbolic-music pipeline turns a track into sheet music, tablature, and multi-instrument arrangements, and reads a finished score back into a prompt. TRAIN fits LoRA adapters and runs autoencoder round-trips, an assistant answers from this guide, and a paste-a-URL importer pulls audio from YouTube, SoundCloud, and Bandcamp.

The **Docs** button in the top bar opens this guide as a modal with a filterable table of contents, a Markdown download, and a print-to-PDF in three styles. Every workspace and the full backend API follow below.

This guide is the task-oriented manual: how to *use* each workspace. For the code-grounded reference — a page per subsystem listing every feature with the exact models and libraries it uses, the full HTTP API by module, and how theDAW runs on modest hardware with no cloud — see [`docs/reference/`](reference/README.md) and [Offline and performance](OFFLINE-AND-PERFORMANCE.md). Those pages cite their source as `path:line`.

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
11. [Underfit Tab: LoRA Training](#11-underfit-tab)
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
35. [Perform Tab: Scene and Clip Grid](#35-perform-tab)
36. [Foundry Tab: Plugin UI Builder](#36-foundry-tab)
37. [App Menu and Project Operations](#37-app-menu-and-project-operations)
38. [HOME Screen and Onboarding Tour](#38-home-screen-and-onboarding-tour)
39. [Backup, Updates, and Maintenance](#39-backup-updates-and-maintenance)
40. [NodeF.I. Tab: Node-Graph Pipelines](#40-nodefi-tab)
41. [TOUR Tab: Venue Discovery and Route Planning](#41-tour-tab)
42. [Mobile Companion App](#42-mobile-companion-app)

---

## 1. Repository Anatomy

| Layer | Path | Description |
|---|---|---|
| **ML pipeline** | `stable_audio_3/` | Upstream Stability AI code: DiT, SAME autoencoder, all samplers, LoRA parametrization, distribution-shift schedules, T5Gemma conditioner. |
| **FastAPI backend** | `backend/server.py` | HTTP wrapper around the pipeline. Async job queue for generation; synchronous endpoints for studio effects and model introspection. Port 8600. |
| **Backend modules** | `backend/modules/` | Plugin system. Each subdirectory provides `module.json` (name, API prefix, enabled flag) and `router.py` (FastAPI APIRouter). The loader (`backend/modules/loader.py`) discovers and mounts every enabled module at startup; a failed module is logged and skipped without stopping the server. Forty-two module directories ship in the repo, grouped here by function: generation and models (`chimera`, `magenta`, `suno`, `modeldl` at `/api/models`, `storage` at `/api/storage`); the Edit Tool Stack under `/api/edit/*` (`mastering`, `restoration`, `enhance`, `delivery`, `creative_fx`, `creative_neural`, `analyzer`); processing and plugins (`effects` at `/api/studio`, `vst`, `plugin`, `convert`); library and audio analysis (`library`, `analysis`, `notation`, `sheetimport`, `vocal`, `midi`, `stems`); live visuals (`vj`, `akvj`, `broadcast`, `controllervision`); Quest and XR (`quest`, `questcast`, `queststitch`, `questmidi`, `xrcontrol`); projects and app data (`project`, `dawimport`, `backup`, `updates`, `settings`); credentials and proxies (`hfauth`, `genaiproxy`); builders (`foundry`, `underfit`); and URL import (`ytimport`). The `/api/edit/*` families form the **Edit Tool Stack** (§28); `suno` (§26) and `magenta` (§27) add cloud and real-time generation. |
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

Put these on the PATH first: **[uv](https://docs.astral.sh/uv/getting-started/installation/)** (Python env + packages), **[Node.js](https://nodejs.org/) v20.19+ / v22.12+** (frontend + VJ sidecar, includes npm; the Vite 7 floor), **[FFmpeg](https://www.gyan.dev/ffmpeg/builds/)** (every audio path: effects, exports, ingest, MIDI, YouTube import), **Git** (clone with `--recurse-submodules` for the Magenta sidecar source), and an **NVIDIA driver 580+** — the R580 branch, which CUDA 13 requires — for the Medium model and Magenta (the Small model runs on CPU). Turing (sm_75) through Blackwell are supported. On Windows, `theDAW.bat` verifies uv/node/npm, warns on missing FFmpeg, and bootstraps the venv + `node_modules` on first run (§4); the Windows specifics are in [windows/setup-guide.md](windows/setup-guide.md).

### Base Python environment

```bash
uv sync
```

### Linux

No separate CUDA step: `pyproject.toml` maps Linux x86_64 to the cu130
torch/torchaudio index under `[tool.uv.sources]`, so plain `uv sync` installs
the GPU build. The full walkthrough — prerequisites (Node from nvm, ffmpeg), the
`pyk4a-bundle` glibc caveat, the `./theDAW.sh` launcher, and what differs from
Windows — is [linux/setup-guide.md](linux/setup-guide.md).

### With dev dependencies

```bash
uv sync --group dev
```

### Windows-specific requirements

`pyproject.toml` includes CUDA 13.0 (cu130) wheel sources for torch, torchaudio, and Flash Attention under `[tool.uv.sources]`. Running `uv sync` on Windows installs all of them automatically. No additional flags and no manual wheel downloads are required for the project's Python 3.12 venv with CUDA 13.0.

`uv sync` is the only supported install path. `[tool.uv] required-environments` names Linux x86_64 and Windows AMD64, so `uv lock` refuses a version that has no wheels for both, and `scripts/check_lock.py` proves the lock installs on each of them — hand-installing an off-lock wheel breaks that guarantee.

`soundfile` is a base dependency, and libsndfile is what every audio read and write actually runs on, through `backend/lib/audio_io.py` (§20.2). Flash Attention is conditionally installed (`sys_platform == 'win32' and python_version < '3.15'`); `pyproject.toml` pins one prebuilt [mjun0812/flash-attention-prebuild-wheels](https://github.com/mjun0812/flash-attention-prebuild-wheels) wheel per Python minor — cp312, cp313 and cp314, all `flash_attn-2.8.3+cu130torch2.14`. On Windows this package is the only FlashAttention-2 there is, because torch's built-in flash SDPA kernel is not compiled under MSVC, and `transformer.py` gates it off below sm_80 regardless.

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

- **Full-width header** (top): the theDAW logo, the center workspace tabs, and six actions on the right: **Record**, **Fullscreen**, mobile access QR/link, the **?** help search, **IMPORT**, and the app menu (§37).
- **Center workspace**: the center tab bar at the top and the active workspace below it, including that tab's own controls and run action.
- **Library rail** (right, collapsible): browse and route library material without leaving the active workspace.
- **Global bottom dock**: the bottom multi-tab panel and the processing log, side by side.
- **Player footer** (bottom): a fixed transport bar.

**Full-width header:** a fixed bar spanning the entire window width. It holds the theDAW logo dot, the center tab bar, and the six right-hand actions above, in that order. **Fullscreen** follows **Record**, immediately left of mobile access: it toggles browser fullscreen on `document.documentElement`, and its icon flips back when Esc leaves fullscreen. Settings opens only from the app menu — the header gear was retired; Docs opens from inside the **?** help popover; the global search moved to the player footer; and the AI Assistant orb is a free-floating draggable element over the app rather than a header button. There is no left panel and no left-panel toggle; the only collapsible side panel is the Library rail on the right.

**Record:** the camera key, or F9, records the theDAW window with its own sound into a WebM file (VP9 video, stereo Opus audio at the level you hear). While it records, the key is a red stop key with the elapsed time; stopping saves the file. In the desktop app the window records itself with no picker, the file goes into Downloads with its path in the LOG and the Recent menus, and F9 works while an embedded frame such as the SWAY cockpit has focus. In a browser, Chrome asks which surface to share and offers this tab first.

**The ? help search:** the **?** button opens a search over the feature registry — the same entries the Feature Tour and the pinned Feature Notes read, so the three can never drift apart. Type what you are after and each hit says what the thing is, how to use it, and which tab it lives in; **LOCATE** hands the id to the solo spotlight, which switches workspace, opens the panel the control lives in, and rings the real control on the real screen. The field takes focus on open, Down steps into the results, Up comes back out of the top of them, Enter locates the best hit, and Escape closes and hands focus back to the button. **Docs** sits beside the input and still opens this manual untouched.

**IMPORT** sits between the ? help button and the ☰ app menu on every tab. It opens a small menu: **Audio files…** adds tracks to the library (pick several at once; the newest is selected and the library rail opens), **Open project…** opens a saved `.tasmo`, **DAW project…** imports an Ableton set. You can also drop audio files straight onto the IMPORT button.

**Dropping files from the desktop.** Anywhere a library track can be dropped also takes audio files dragged in from File Explorer or Finder: the library list itself, the EDIT timeline (each file becomes a clip, extra files on new tracks), the MAKE init and inpaint slots, the MIX source, the Chimera stack, the MIDI panel's song box, the DJ decks, sampler pads, NEXT queue and prepared sets, the Media bucket and, for video and image files, the VJ tab. The file is imported into the library first (it shows up in the library rail with the newest selected) and then lands where you dropped it, exactly as a library track would.

**Center tab switching:** the active workspace is controlled by the center tab bar (`CenterTabBar`). Each tab carries its own accent color. Legacy navigation targets such as `create`, `advanced`, `edit`, and `train` are translated into these center tabs, so assistant actions, library sends, and older shortcuts still route correctly — and the assistant can reach every workspace plus the Library rail, reporting an honest failure rather than a false success if a target does not exist. There are thirteen tabs, in this on-screen order: MAKE, EDIT, MIX, PERFORM, DJ, VJ, SWAY, FOUNDRY, UNDERFIT, NODEFI, LOOM, LEARN, TOUR. Alongside the nine core tabs below, the bar carries **SWAY** (§35), **NodeF.I.** (§40), **LOOM** and **Tour**. The nine core tabs are:

- **MAKE**: generate audio from a text prompt with the AI models (§6).
- **EDIT**: arrange clips on a timeline, add effects and automation, and export (§7).
- **MIX**: process and master audio with the effect and module rack (§8).
- **Perform**: import a project and perform its scene and clip grid live (§35).
- **DJ**: a two-deck console for mixing, cueing, stems, and automix (§9).
- **VJ**: the live visuals engine with sources, effects, and output (§10).
- **Foundry**: design and export custom plugin interfaces on an infinite canvas (§36).
- **Underfit**: train LoRA finetunes in the embedded Underfit dashboard (§11).
- **Learn**: lineage, genealogy, and the guides and assistant (§12).

**LOOM** is the thirteenth tab: the Shard Index drawn as one living colony that grows a generation every bar. It has its own guide, [guides/loom-and-shards.md](guides/loom-and-shards.md).

**Shell surfaces from the app menu:** three surfaces sit above the workspaces and open from the header. The **app menu** (§37) is the hamburger button in the header icon cluster; it groups project operations, data operations, device deploy, layout and settings, and help. The **HOME overlay** (§38) is a full-screen launcher with one card per workspace tab, a task row, and a show-at-startup preference; it appears after the boot intro and reopens from the menu. The **Feature Tour** (§38) is a chaptered guided walkthrough that spotlights real controls; it starts from the menu or the HOME task row.

**PERFORM tab:** the Perform workspace (`SessionView`) imports a DAW project or a `.tasmo` file and performs its scene/clip grid live. The project controls live in the tab header (a path input, Browse, and Import), so the session grid gets the full remaining height. Clicking or focusing the path input opens a dropdown of recent projects: ArrowDown and ArrowUp move through the list, Enter opens the highlighted entry, Escape closes the dropdown, and one click on an entry imports it immediately. The recent list persists across backend restarts (`data/recent_projects.json`).

**DJ and VJ persistence:** the DJ and VJ tabs host live performance state (a multi-deck mixer and an embedded WebGL VJ iframe). Once first visited, they stay mounted and only toggle CSS visibility on tab switch, so deck state and the warm VJ pipeline survive a switch. A backgrounded VJ tab is told to park its render loop, so it costs close to 0% GPU while hidden.

**Right-side library rail:** the Library is a collapsible panel on the right edge. A compact, vertically-centered pull handle on the right edge of the work area (present in every workspace) toggles it open or closed, and a drag handle on the rail's inner edge resizes it; the width persists between 280 px and 640 px. Expanded fully, the rail becomes the full-width Catalogue. This lets MAKE, MIX, LEARN, VJ, and editor workflows stay visible while browsing or routing library material.

**Global bottom dock:** pinned across the bottom of the app are two independent columns, the bottom multi-tab panel on the left (Levels / Visualize / MIDI / Sequence / DRAW / Score / Sing / Lyric / Details / SLIDE / SWAY) and the processing log on the right, aligned under the library rail. Each column has its own height, collapse toggle, and resize handle, so expanding or resizing one does not move the other, and the dock stays put regardless of the library panel's state.

**Docs modal:** open the **?** help popover and click **Docs** beside its search field to read this guide in-app. The modal supports anchor links, syntax-highlighted Markdown tables and code blocks, raw Markdown download, and browser print/PDF export. This guide is one document in the assistant's RAG corpus (the full list is in `backend/rag.py`), so revising it improves both the in-app manual and the assistant's grounding.

**Mobile access share:** click the QR/link button in the header to copy or scan the current LAN or tunnel URL for mobile performance access. This is useful with the VJ tab and any browser-based controller or viewer.

**AI Assistant panel:** click the assistant orb — a free-floating element you can drag anywhere over the app, not a header button — to open the collapsible assistant panel. It streams chat from any configured LLM provider with RAG context retrieved from the document corpus registered in `backend/rag.py` (this guide plus the other manuals and guides), supports file attachments and voice input, and exposes provider and key-pool controls. See [§19.11](#1911-assistant) for the API reference.

**Viewport scaling:** the Shell renders under a CSS `zoom` that fits a fixed logical canvas — 1600 x 820 CSS px — into the real window:

```
zoom = clamp(0.6, min(innerWidth / 1600, (innerHeight - 64) / 820), 1.1)
```

It is rounded to two decimals (stable across sub-pixel resize jitter), recomputed on every resize, and published as the `--layout-zoom` custom property on the `.dense-layout` root (`frontend/src/lib/layoutScale.ts`). The 64 px player footer sits outside the zoomed subtree, so the layout always tiles cleanly down to it. This replaced three width-only tiers (0.85 / 0.95 / 1.1) that had no height term, so a short window lost shell height it could not spare.

![UI shell with center tabs and right library rail](screenshots/01-shell-make.png)

![Header actions (mobile share, help search, import, app menu)](screenshots/01-shell-make__header-actions.png)

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
| **Model** | Dropdown | `small` and `medium` for primary inference, plus `magenta-small` for Magenta RealTime 2 (§27) and `suno` for Suno cloud generation (§26). Picking Magenta drops Steps to 1 and brings up the MRT2 conditioning controls. The Suno entry opens the Aurora Cloud Console in place of the local panel, and `lyria` (Lyria 3 Pro) opens the Lyria panel in place of it (§6.2.1). The `small-rf` and `medium-rf` checkpoints are rectified-flow training bases surfaced through the Underfit trainer (§11) rather than inference models; selecting an `-rf` variant for a direct render raises Steps to 50 and CFG to 7.0 to run it, and the ARC `small` and `medium` checkpoints are the intended generation path. |
| **Duration (s)** | Integer | Total output length in seconds. Small model: max 120 s. Medium and Large: max 380 s. |
| **Batch** | Integer | Number of simultaneous variations. Each variation produces a distinct library entry with its own seed. |
| **Steps** | Integer | Sampler denoising steps. ARC default: 8. RF default: 50. |
| **CFG** | Float | Classifier-free guidance scale. ARC default: 1.0. RF default: 7.0. Higher values increase adherence to the prompt and can introduce artifacts. |
| **Seed** | Integer + reroll button | Use −1 for a random seed on each run. The reroll button generates and displays a new random seed without submitting a job. |

#### 6.2.1 Lyria 3 Pro

Choosing **Lyria 3 Pro (Cloud)** in the Model dropdown replaces the whole MAKE
surface with the Lyria 3 Pro app, embedded whole and unmodified. It is its own
project (`StarskreamEXE/lyria-3-pro`), it ships its own Express server, SPA,
settings and library, and theDAW spawns it as a sidecar on port 5188 and frames
it. The model dropdown stays on screen above it, because without one you would
be stranded inside the frame with no route back to Stable Audio.

It is framed rather than absorbed on purpose: at its own origin the app's
relative `/api/*` fetches resolve against its own server, so it needs no CORS,
no base URL and no client rewrite, and its viewport styling, portals, window
event bus and Ctrl+Enter binding all apply to its own document and cannot
collide with theDAW's. It drives its own transport, so there is no bridge
between the two.

The sidecar is request-driven: the Node process only starts when someone
actually opens the panel, and the panel retries while it comes up. Once warmed,
the frame stays mounted so a round trip to Stable Audio does not restart the
server or lose its in-app state. `POST /api/lyria/install` clones the project
and runs its `npm install` in the background (it needs `git`), so Settings can
repair a missing Lyria without handing you a command line, and
`GET`/`POST`/`DELETE /api/lyria/key` manage the `GEMINI_API_KEY` theDAW passes
to it. A pop-out button opens it in its own window.

### 6.3 Advanced Generation Panel

The Advanced Generation Panel provides a dense layout for deeper configuration.
- **Output Settings** controls automatic playback and automatic downloading behavior.
- **Quick Actions** route generated audio directly to the Waveform Editor, Init Audio, or Inpainting modules.
- **Templates Panel** saves and restores full generation parameter sets.
- **Saved Prompts Dropdown** maintains a history of frequently used user-defined prompts.
- **Spectrogram Viewer** displays Mel, STFT, Chromagram, and CQT visualizations of generated audio.

Templates and saved prompts are stored in browser local storage for rapid iteration. The prompt sparkle action calls the assistant prompt enhancer (`/api/assistant/chat`) when text already exists, or inserts a sample prompt when the field is empty.

### 6.3.1 Chimera Fusion Stack

Chimera fuses two or more audio clips into a single init signal before generation. Source clips can arrive from the Library toolbar and context menu, the Media Bucket, the microphone recorder, or other send targets.

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

- **Init Noise (0 to 1)** controls the ratio of source signal to random noise injected at the start of the denoising trajectory. Lower values preserve more of the source character; higher values grant the model more generative freedom.
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

Built-in effects, VST3 plugins and `.gan` web plugins are **one concept** here. Open the master chain from the **FX** button in the toolbar, and a track's chain from the **FX** button on its header, or right-click a track header and choose **Open FX rack**. The right-click menu also offers **Add insert** for every effect and **Clear track FX**.

Either button opens a compact chain list in which built-in, VST and GAN rows look and behave identically. Clicking a row opens **that entry's own floating control window** — a plugin's native UI, a `.gan` surface, or the built-in's parameter tiles — which you can drag anywhere and leave open while you work. Windows are keyed to the chain entry, so reopening one focuses the window you already have instead of stacking duplicates.

Each chain is ordered. The **+ Add effect…** dropdown appends an effect; per-effect controls bypass it, move it earlier or later in the chain, and remove it. Parameters are SLIDE sliders that update the running audio without a rebuild, and moving one parameter never disturbs the others.

Nineteen processors are available, and the same factories run live and in the offline bounce:

| Effect | Group | What it does |
|---|---|---|
| **Headphone Crossfeed** | Spatial | Relieves hard-panned headphone "in-head" stereo (Bauer/BS2B). Params: Amount, Cut (Hz). |
| **Phantom Bass** | Low end | Implies the missing fundamental through synthesized harmonics, so small speakers read deep bass. Params: Drive, Blend, Crossover (Hz). |
| **Kargyraa Sub** | Low end | Subharmonic throat-growl bass: an octave divider, a period-doubling growl gate, a morphing vowel bank and a sygyt whistle band (see §7.7.1). |
| **Stereo Widener** | Spatial | True mid/side widening with a mono-safe low end. Params: Width, Bass mono (Hz). |
| **Aural Exciter** | Tone | Adds harmonic air and presence the ear reads as detail. Params: Freq (Hz), Amount, Mix. |
| **The Owl (HRTF Spatializer)** | Spatial | Positions the track in 3D around the head with motion presets (see §7.8). |
| **Loudness Contour** | Tone | Equal-loudness tilt so the balance holds at low volume. Params: Level (phon), Amount. |
| **OWL-Pad** | Performance | XY performance pad over the spatial engine. Params: Program, X, Y, Mix, Hold, Active. |
| **Gater** | Performance | Rhythmic gate, free-running or tempo-synced. Params: Rate, Depth, Shape, Sync, Div, BPM. |
| **Bitcrush** | Performance | Bit-depth reduction against the dry signal. Params: Bits, Mix. |
| **Ring Mod** | Performance | Metallic/robotic sidebands from a sine carrier. Params: Freq (Hz), Mix. |
| **Chop** | Performance | MPC-style buffer chop / beat-repeat (AudioWorklet). Params: Program, Rate, Slice, Mix, Latch, Gate. |
| **Parametric EQ** | EQ & Dynamics | Low shelf, sweepable mid peak, high shelf. Params: Low, Mid freq, Mid, High. |
| **Compressor** | EQ & Dynamics | Params: Threshold, Ratio, Attack, Release, Knee, Makeup. |
| **High-Pass Filter** | EQ & Dynamics | Params: Freq (Hz), Resonance. |
| **Low-Pass Filter** | EQ & Dynamics | Params: Freq (Hz), Resonance. |
| **Reverb** | Space | Params: Decay (s), Predelay (ms), Tone (Hz), Wet. |
| **Delay** | Space | Params: Time (ms), Feedback, Tone (Hz), Wet. |
| **Ares** | Performance | Multi-stage filter → delay → reverb → grains → gate composite driven by the Ares `.gan` surface. 21 normalized params. |

#### 7.7.1 Kargyraa Sub

**Kargyraa Sub** is a subharmonic bass engine modelled on Tuvan *kargyraa* undertone
singing. In kargyraa the false vocal folds close over every second vocal-fold cycle,
dropping the perceived pitch an octave, while the vocal tract merges its formants
into one narrow, very loud peak. The effect reproduces both: an octave-divider
AudioWorklet produces true f/2 and f/4 layers that follow the source's envelope, an
amplitude-modulation "growl gate" reproduces the same period doubling as sidebands,
a three-band morphing vowel filter (a–o–u–e–i) supplies talking-bass motion, and a
high-Q 0.8–2.4 kHz band is the sygyt-style focused overtone.

Params: Mix, Sub, Deep, Growl (Hz), Growl depth, Drive, Vowel, Motion (Hz), Motion
depth, Whistle (Hz), Whistle amount.

The one parameter that decides whether it growls or turns to mud is **Growl**: set it
to *half the fundamental of the bass you feed it* and the sidebands land on the true
subharmonic series (D♯2 = 77.8 Hz → 38.9; E2 = 82.4 Hz → 41.2). Feed it a bass stem
rather than a full mix so the divider locks to the fundamental instead of the hats.

### 7.8 Spatializer, Teleport, and Autopilot

The **HRTF Spatializer** effect places a track in 3D space around the listener through a `PannerNode`, with a visual placement pad and motion presets. Azimuth, Elevation, and Distance set a static position; the **Motion** control adds movement, and Rate and Depth shape it.

Twelve motion modes are available: Static, Orbit H CW, Orbit H CCW, Orbit Frontal, Orbit Sagittal, Spherical, Ping-Pong, Up / Down, Figure-8, Expand / Collapse, Teleport, and Autopilot.

**Teleport** jumps the track between positions in step with the audio. The clip is sliced on its onsets through a time-domain, FFT-free analysis, and each slice is placed by its character: louder slices sit closer and quieter ones further away, brighter slices ride higher, and a golden-angle scatter spreads them around the head. The Depth parameter widens or narrows that scatter. The same deterministic slicing runs in the offline bounce, so the export matches the preview.

**Autopilot** is a live spatial choreographer. A real-time analyser reads level, brightness, and onset timing, then steers a beat-aware orbit, an elevation follower tied to brightness, a distance follower tied to bass, a mood-weighted motion layer, and onset-fired accent jumps. Autopilot runs during live preview; the offline bounce falls back to the Spherical orbit.

### 7.9 Metamorph: Granular Identity-Bleed Morph

Open **Metamorph** from the toolbar's **TOOLS ▾** dropdown to morph one sound into another in real time. Pick a **Donor A (identity)** and a **Host B (structure)** from either the current timeline clips or the library. Metamorph rebuilds Host B out of grains taken from Donor A, so the output keeps B's structure in A's voice.

Eight sliders shape the result: **Bleed** (dry host through to full mosaic), **Grain** (grain size in seconds), **Rate** (grains per second), **Spray** (start and timing jitter), **Match** (selection strictness), **Sync** (lock grains to the host's beat grid), **Favor** (bias toward punchy donor grains), and **Gain** (output trim). **Play** auditions the morph live; **Send to editor** renders one pass and drops it on a new track as an ordinary clip, ready to trim, FX, and export.

### 7.10 Live MIDI Playback in the Timeline

A clip whose source is a piano-roll part plays its notes live through the soundfont engine during transport rather than only as a pre-rendered bounce. Each track maps to one synth channel (up to sixteen), and notes are scheduled against the editor clock at the clip's BPM.

Live MIDI is opt-in: it activates only when the soundfont is in use, or a per-clip or per-track instrument is set, so projects that never touch instruments keep playing their bounced audio unchanged. A clip's instrument falls back to its track's instrument, then to the globally selected program. Mute and solo are honored by skipping a track's notes. If the synth is not ready, the clip's bounced audio plays instead. The offline export still renders from each clip's last bounce. Choose an instrument as described in §15.8.

### 7.11 Automation Lanes

An automation lane draws one parameter's value curve over a timeline row (`AutomationLane`). Each lane targets a single automatable parameter, so track volume, track pan, and an insert-FX parameter each get their own lane and are edited on their own. Read-only lanes render the curve without accepting pointer input, so clip editing underneath stays unaffected.

An editable lane accepts breakpoint edits directly on the curve. Click an empty area of the curve to add a breakpoint at that time and value. Drag a point to move it; a dragged point is clamped between its neighbors so points never cross in time. Right-click a point, or Alt-click it, to delete it. Pointer math uses bounding-rectangle ratios, so edits stay accurate under the shell's CSS zoom.

**WRITE record mode** captures automation from live moves. With WRITE armed, moving a target parameter during transport writes breakpoints into that parameter's lane, timestamped against the editor transport clock rather than wall time, so a recorded move lines up with the audio on the next pass. Recorded lanes then edit as ordinary breakpoint curves, and they bake into COMMIT EDIT through the same offline graph as the rest of the mix (§7.6).

### 7.12 Autosave and crash recovery

The arrangement saves itself as you work, so a refresh, a crash, or a closed tab no longer destroys it. Clip audio lives in memory as Blobs, which used to mean a reload lost everything; it is now written into browser storage (OPFS) addressed by content hash, so a clip that was split or duplicated stores its audio exactly once. Alongside it, a debounced manifest records tracks, clips, effects, automation, markers, BPM, and the loop region.

When a recoverable session exists, theDAW offers to restore it at startup. **Autosaving stays paused until you answer**, so opening the app and starting something new cannot overwrite the thing you are trying to recover. Accepting rebuilds the clips and their waveform peaks and drops you on EDIT with the arrangement back.

This is insurance, not a replacement for saving: use **Save Project** (§37) to keep a real `.tasmo` on disk.

### 7.13 Separate a clip into stems

Right-click a clip and choose **Separate Stems → Tracks…** to split it with the Demucs separator and explode the result straight into the arrangement. A dialog picks the stem count, the device, and the quality; a progress banner tracks the run and can abort it.

Each stem returns as its own colour-coded track, placed at exactly the source clip's position and trim, and the source clip is muted so you hear the stems rather than both. Unmuting it is the whole undo. Re-running on the same clip reuses the cached separation instead of paying for it twice. The separation backend and its settings are covered in §13.6.

---

![The EDIT multitrack waveform editor](screenshots/edit.png)

## 8. MIX Tab

### Purpose

The MIX tab (`MixPanel`) is the single-screen effects and mastering workspace. It applies one or more of 25 FFmpeg-backed processors to a source file as an ordered chain, arranged in six categories: seven mastering and character stacks, six dynamics processors, three EQ filters, two tempo and pitch tools, three cleanup tools, and four export encoders. Processing is synchronous; the result is returned as binary audio and made available for inline playback, download, and routing back into the app.

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

### 8.6 Categorized effect rail

The left rail groups everything MIX can add to the chain. **All** lists every processor at once in list or tile view. **Studio** holds the studio module instruments, the Ares XY control surface, and the psychoacoustic effects. **Magenta** holds the Magenta RealTime 2 generative tools. **VST** lists scanned VST3 plugins (§8.7). **Plugins** lists installed `.gan` web-plugins (§8.8). Below those, one entry per backend effect category (mastering, dynamics, EQ, tempo, cleanup, export) filters the library to that category. Each rail row shows a live count. Selecting a category populates the center library; clicking an item in the library appends it to the chain on the right.

### 8.7 VST3 hosting through pedalboard

The VST category scans the standard VST3 folders and lists the plugins it finds; the **Rescan** button re-runs the scan. The `vst` module (`/api/vst`) hosts plugins through pedalboard, so a scanned plugin adds to the chain as a `vst3` node and processes audio in chain order like any other effect. A chain entry for a hosted plugin exposes a control that opens the plugin's native GUI; adjusting and closing that GUI captures the plugin's raw state, so the saved settings ride with the node on the next process. The full walkthrough is [guides/mix-vst-and-gan.md](guides/mix-vst-and-gan.md).

### 8.8 The .gan web-plugin loader

The Plugins category loads `.gan` web-plugins, the browser-based pseudo-VST format produced by the Foundry builder (§36). **Open .gan** loads a `.gan` file, and **Import** wraps a Foundry export (`project.json`) into a `.gan`. The `plugin` module (`/api/plugin`) serves the plugin UI into the effect stage as an iframe and relays the plugin's control output to theDAW targets. Selecting an installed `.gan` opens it in the stage; right-clicking a tile reveals the file in its folder.

### 8.9 How chain nodes process together

Backend effects, studio modules, psychoacoustic effects, hosted VST3 plugins, and `.gan` plugins all become entries in the one MIX chain. The chain runs left to right, and each entry can be bypassed, reordered, or removed. Pressing Process on the footer transport applies the whole chain to the source and returns the processed audio for playback, download, and routing (§8.4).

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

- **Automix** sequences a setlist hands-free, beatmatching each transition. Starting a set is §9.10, and what happens inside a blend is §9.11. The Library's **Suggest a Playlist** can populate this set and start it in one step through its **Send to DJ** action (see §13.9). **Prepared performance sets** load from `data/performance-sets/<Set>/performance.json` (a folder of audio files plus a timeline, as written by Z-AutoDJ or by hand; `GET /api/library/setlists` lists them and the audio is registered in the library in place). A prepared track carries a cue-in point, a mix-out point and a transition length, and automix follows them instead of its fixed distance-from-end rule. The assistant orb can steer a running set: read what is on, make a set active, start or stop automix, blend into the next track now, or move a named track to play next.
- **Sampler bank**: drag a clip onto a pad to load it, then trigger pads during a set. Each pad has a **Loop** toggle (the pad holds the sample until pressed again) and a **Choke** toggle (firing one choke pad cuts the others, for mutually exclusive sounds like open and closed hats). Pad assignments and their loop and choke settings persist across reloads.
- **Side List**: a play-next staging lane above the browser. Stage upcoming tracks, reorder them, and pull them onto a deck when ready.

### 9.8 Browser and Source Tree

The browser loads tracks onto a deck by drag or click. The source tree exposes real filtered views (Library, Favorites, Generated, Imports) with live counts, plus an Online Download source and saved Sets. **Send to VJ** pushes the current set or a single track to the VJ archive.

### 9.9 Design Mode

A floating **Edit Layout** control turns on Design Mode. In Design Mode, panels and the mixer control groups can be dragged to reorder and dragged at their borders to resize, snapped to a grid. The layout persists across sessions, a Reset restores the default, and a Copy action exports the layout as JSON to bake in as the new default.

### 9.10 Starting a set

**START AUTO DJ** in the DJ header above the decks is the one-click way in. It is never a disabled `<button>` — a disabled control loses its tooltip and its place in tab order, so the reason would never reach you — but it marks itself `aria-disabled` whenever the press cannot change anything, which is the "pick a set" and "add tracks" cases. With no sets at all the press does do something: it creates the set it is asking for. The tooltip says what is missing — "Create a set first — click to make one", "Pick a set below", "Add at least 2 tracks to this set" — and the accessible name a screen reader announces carries the same reason in its own wording ("Start Auto DJ — pick a set below first"). While a mix runs it reads **STOP AUTO DJ**, which stops the sequencer and leaves the decks playing. In the Source Tree, each Sets row opens the set by name, badges the set automix actually reads as **ACTIVE**, and carries a **▶** that auto-DJs it; the ▶ is dimmed while the set's tracks are being registered or while it holds fewer than two tracks. Until a deck holds a track, a three-line hint floats over the decks — pick a set, press START AUTO DJ, or drag a track onto a deck. If the first deck never finishes decoding, automix gives up after 15 seconds with "Automix: Deck A never finished loading" and switches itself off. The full walkthrough is in [guides/dj-and-genealogy.md](guides/dj-and-genealogy.md).

### 9.11 Inside an automix blend

A blend starts on a 16-beat phrase line of the outgoing track, quantised down from the mix-out point (a prepared set's own point, else 18 seconds from the end, and never before half the track has played — so a track shorter than about 18 seconds mixes out from its midpoint rather than its first frame). The first track of a set waits up to 3 seconds for its tempo and then starts on its first beat. Across the fade, the outgoing low band is handed to the incoming one over the middle third (the bass swap), the follower is pulled into phase by bending the platter rather than seeking, sync-lock is held for the whole blend so the two decks cannot drift apart, and key-lock engages when the match needed more than about 3 % of pitch. The messages are honest about what happened: "NOT beatmatched" means the pitch fader cannot reach that tempo at the selected ±range, so the deck is left at 0 % with no key-lock and no phase nudge, and "Automix: mixing unmatched" means the blend went ahead without a beatmatch, naming the reason — the incoming tempo is unknown, the outgoing one is, or the pair is outside the ±range. There is no dead air — a deck that ran out is rescued with a one-second crossfade, while a deck that has never played is waited for instead of being skipped — and with at least three tracks still to come, a key clash straight ahead is skipped for the nearest Camelot-compatible track. Each behaviour is covered in full in [guides/dj-and-genealogy.md](guides/dj-and-genealogy.md).

### 9.12 Auto-seeded hot cues

When a track's analysis lands, its four hotcue pads are seeded the way a DJ places them by hand: the first downbeat (the first beat when no downbeats are known), then the starts of the 16, 32 and 48-bar phrases after it, with matching markers on the waveform. Cues you set or clear yourself are never overwritten — after any edit the seeder leaves that track alone — and a phrase that falls past the end of a short track leaves its pad empty instead of stacking another marker on the end. Downbeats come from the rhythm module's cache, which the DJ tab only ever reads: a deck load asks for a cached analysis and falls back to plain beats when there is none, and it never starts a rhythm run of its own. Run the **Rhythm** analysis on a track (see [guides/rhythm-analysis.md](guides/rhythm-analysis.md)) and the DJ tab picks up real bar lines on the next deck load, for the beatgrid, the cue seeding, and the phrase a blend starts on.

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
- **Point clouds (KINECT and DEPTH)**: KINECT renders a live point cloud from the `akvj` bridge (§10.3), which fans an Azure-Kinect depth-and-color stream into the engine, and DEPTH builds a point cloud from the loaded clip (or the webcam) through an in-browser monocular depth model. Both share one control set: the **Move X/Y/Z** and **Rot X/Y/Z** sliders move and rotate the cloud itself about its own center (double-click a slider label to reset it), a **LOCK** toggle (on by default) keeps the camera facing the cloud center, and **RECENTER** reframes the cloud so it fills the output dead-center, after which the **Distance** slider scales around that fit.
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
- **akvj depth**: the `akvj` module (`/api/akvj`, with `/ws/source` and `/ws/view` WebSockets) fans an Azure-Kinect depth-and-color stream into the engine, feeding the KINECT point-cloud source in §10.1. Delivery is drop-to-latest per viewer, so a slow viewer never stalls the feed, and the Kinect sidecar caches its startup calibration table on disk, so the table builds in milliseconds instead of several seconds.

### 10.4 Export

The visual engine records performances and the backend transcodes the recording to the chosen codec. The saved path is reported back and surfaced in the Processing Log. Exports are written to the local `exports/` folder and are never committed to the repository.

### 10.5 Broadcast and watch-link

A WebRTC signaling module (`/api/broadcast`) backs a live watch-link of the VJ output, so a viewer on the venue LAN can open a URL and watch the visuals peer-to-peer, with no media passing through the server. The GO-LIVE broadcaster front end, a DJ-audio host hop, and a TURN relay for public links are still in progress.

### 10.6 Autopilot visual effects

The VJ engine includes an Autopilot that layers audio-reactive visual effects, such as feedback wash, glitch, and waveform warp, each with its own probability, under a single Autopilot toggle. Turning it on lets the visuals evolve hands-free in time with the audio.

### 10.7 Source banks

Any source snapshots into a bank slot for instant recall during a set. Clicking an empty slot opens a place menu (clip, source, or local file) anchored at the click point, and the bank grid recalls a slot with one click.

### 10.8 Effect chain

Separate from Autopilot (§10.6), the operator stacks effects on the output as a composable, source-agnostic, MIDI-mappable chain, with a SOLO mode that isolates one effect for setup. The families are color and optics (hue, saturation, contrast, invert, edge detect), geometry (mirror, kaleidoscope, radial mirror, tiling, equirectangular 360, stereo split), generative (reaction-diffusion, SDF raymarch portal, isolines, fluid displacement), depth (fog, tilt-shift, plane splits, depth-edge outline), distortion and glitch (feedback, RGB split, chromatic aberration, strobe, pixelate, wave warp), time (speed, reverse, echo trails, slit-scan), and post (scanlines, vignette, CRT). The ASCII effect is a post pass that re-renders the final composited output through a glyph atlas, so the whole frame converts to ASCII and the raw video never shows through underneath, even with TRAILS or Autopilot active.

### 10.9 BPM sync and pose control

The visuals lock to a BPM taken from the audio bridge or a DJ deck, driving time-based effects and Autopilot transitions in tempo. A Sway pose control bus drives mapped parameters from camera-tracked motion, alongside the MIDI and SLIDE control paths in §10.3.

![VJ tab panel loading state](screenshots/08-vj-tab-loading__vj-panel.png)

---

## 11. Underfit Tab

### Purpose

The Underfit tab (`UnderfitView`) hosts LoRA finetuning of the Stable Audio models. It embeds the Underfit dashboard, a vendored trainer that runs as its own process, and drives dataset preparation and training from inside theDAW. The full workflow lives in [guides/underfit.md](guides/underfit.md).

### 11.1 The embedded dashboard

The Underfit dashboard runs as a standalone server on `http://localhost:8791` and appears in the tab as an iframe. The tab pings the server for reachability every three seconds and mounts the iframe only once the server answers, so a dashboard that is still starting shows a connecting state instead of a dead page. A reload control remounts the iframe, and an open-externally control loads the dashboard in a separate browser tab.

### 11.2 Sidecar lifecycle

The `underfit` backend module (`/api/underfit`) manages the dashboard process. It spawns the vendored server on `:8791` at backend startup, so the tab loads without launching anything separately. `GET /api/underfit/status` reports the sidecar state (`listening`, `process_alive`, `project_path`, `port`, and any `issues`). When the checkout exists but the server is not running, the tab shows an installed-but-stopped state with a **Start Underfit** button that calls `POST /api/underfit/start` and blocks until the server answers.

### 11.3 Missing-environment state

When the trainer environment is absent, the status probe returns install issues and the tab shows "Underfit isn't installed on this machine yet" with the specific problems (a missing checkout or a missing venv). A **Create environment** button calls `POST /api/underfit/setup`, which builds `underfit/.venv` with a one-time dependency sync and no terminal. The tab polls `GET /api/underfit/setup-status` until the build finishes, then starts the dashboard. Model packs download later, on demand, when a run needs them. A **Re-check** button re-runs the probe.

### 11.4 Dataset-to-LoRA flow

Training happens inside the dashboard. Point it at a dataset of audio clips with paired text captions, choose a rectified-flow base checkpoint (`small-rf` or `medium-rf`, §21) and the LoRA settings, and run the finetune. The resulting adapter loads at inference through the Python API (§20.5); the adapter types and training arguments are documented in §22. See [guides/underfit.md](guides/underfit.md) for the end-to-end walkthrough.

---

![The Underfit LoRA trainer dashboard](screenshots/train.png)

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

### 12.4 The lineage explorer: every number opens a list

On a library of a few hundred thousand songs there is no whole-library picture to draw, so LEARN opens on a landing page of counted headlines, relationship-kind rows, and ranked lists. Every number on that page is a button: pressing one opens the list of songs it counted, read one page at a time from `GET /api/lineage-scale/explore/*`.

What opens:

- **Songs with lineage** and **songs without**, the two numbers under the Songs card. Together they are the whole library.
- **One relationship kind**, with the song as parent, as child, or on either end (`/explore/kinds/{kind}`). Each row carries that song's own count for the kind and role asked for.
- **A ranking** for any kind in either role, "most links of kind K as a parent" or "as a child" (`/explore/rankings`), not only the four presets the landing page shows.
- **Families** by size (`/explore/families`) and the members of one family (`/explore/families/{id}/members`). A family is a connected component over ancestry links only. A mashup cluster welds unrelated trees into one component tens of thousands of songs wide, so it is counted on its own and is not a family.

Every list pages; the songs, kind, and family-member lists also search and sort. A ranking is count-ordered only and the family list is size-ordered only — neither has a search box. A page is 50 rows and the server counts the rest, so the browser holds 50 rows whether the list is 50 songs or 173,000; the page box commits on Enter or when it loses focus. Search is a title substring match, sanitised by the Library's own search tokeniser so the two cannot disagree about what counts as a token — but it matches titles only, not prompts, tags, or lyrics. A row shows the provider badge, the title, the number the list was ranked by, and two named buttons: **Focus** draws that song's neighbourhood, **Copy id** copies its entry id. A family row opens the family instead.

The whole-graph counts are computed once per change to the link graph and cached, and the pass is warmed by a background thread about twenty seconds after startup, so opening a list does not read the relations table.

### 12.5 The classic graph of one song, inside LEARN

The classic lineage view stays reachable on a library too large for the library-wide drawing. The header's **Classic graph** button mounts it inside LEARN, rooted at the song in focus; pressing it again closes it. Its two whole-library tabs, Genealogy and the 3D graph, are refused there and say why on the controls themselves ("library too large for the whole-library graph; use the per-track graph"), and the whole-library request is never sent.

The per-track answer is bounded by the server rather than by the browser. `GET /api/library/{entry_id}/lineage` walks parents and children breadth-first, stops at 600 nodes, and reads at most 4,000 relation rows for any one hop. The cut follows the walk, so a hop is admitted whole before the next is looked at: the near family is complete and distant relatives are what is dropped. When the cap bites, the answer is marked truncated and the view shows "Showing the nearest N of a larger family."


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

Toggle between a dense **List** view (one row per entry) and a **Grid** view (tile cards) through the icons in the section header. List view shows title, prompt preview, model chip, duration, date, file size, and a per-entry action cluster. Each row also carries a **provider badge** — Stable Audio, theDAW, Suno, Udio, Riffusion, Magenta, Imported, or Unknown — classified from the file's embedded tags first and its `model` and `source` fields second; a `chirp-*` model is Suno's own model family, so those entries badge as Suno (§29).

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

**How stems, MIDI and lyrics are scheduled.** Stem separation, MIDI conversion, lyric alignment and whisper share one coordinator (`backend/core/pipeline.py`). For any one entry each of them runs once at a time: a second request, whether from the auto-on-import queue, a manual run, the SING tab or favouriting, joins the run already in flight instead of starting another process. An artifact that exists is not redone. MIDI conversion waits for a stem separation in flight, so the per-stem conversions see the stems. The heavy models share a single GPU lane (Demucs, whisper, the MMS aligner, basic-pitch through ONNX Runtime's CUDA provider, and piano transcription) so two never run on the card together, and the idle-gated background queue stays parked while a foreground job holds the lane. Without a GPU every engine falls back to the CPU, whisper with its CPU-sized model.

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

Analysis runs in one of two profiles. The **full** profile runs every step — tempo and beats, key, RMS, pitch statistics, integrated loudness, an inferred prompt — and takes roughly 10-20 seconds per track on a cache miss. The **dj** profile (`POST /api/analysis/{id}/run?profile=dj`) runs only what a deck reads: ffprobe, one shared decode, tempo and beats with the detector's confidence, key, and RMS. It skips the pitch statistics and the second, full-rate decode that integrated loudness needs, which together are most of the cost — about 2-3 seconds instead of 10. The DJ tab uses it for every track it analyses, so loading a deck no longer waits on work no deck shows.

A row written by the dj profile is a **partial** row, and it says so: `GET /api/analysis/{id}` and the entry's stored analysis carry a `profile` field, so the Details panel, the node inspector and the prompt route can tell a partial row from a complete one whose expensive fields happen to be empty. Running the full profile later completes it and clears the marker; a full run that fails to measure something falls back to the values already stored rather than erasing them, so a re-run whose tempo step fails cannot wipe a BPM that was measured before.

`bpm_confidence` is the beat detector's own confidence in the BPM it reported, from 0 to 1. A low value means the tempo is a guess — a shifting or rubato track, a sparse intro, a file the detector could not lock onto. Treat a low-confidence BPM as a number to look at rather than to beatmatch on: the value is persisted with the analysis and carried on the deck’s analysis row, so a shaky reading can be told apart from a solid one — nothing greys it out in the interface yet — and an automix blend into a track whose tempo is wrong says "NOT beatmatched" instead of pretending (§9.11).

At most **two analyses run at once in the whole backend process**. The cap sits on the analysis itself, not on the HTTP route, so a manual run, a deck load and the library's background auto-analysis all share it; callers asking for the same entry and profile join the run already in flight instead of starting a second one. Each analysis is a full decode of hundreds of megabytes on one core, so two keeps a core busy without letting the decodes pile up.

The DJ tab queues analyses in two lanes. A **request** lane holds what you actually asked for — the tracks on the decks — and is drained first and never dropped. A **sweep** lane pre-analyses the rows worth having next, capped at 24 and ranked decks → the active set → the visible browser rows; each sweep replaces the previous one, so scrolling re-aims the window instead of building a backlog. A row whose analysis fails is retried after 60 s, then after 120 s, then given up on at the third failure — loading it onto a deck still runs it, because asking for a track is a statement that it is worth another try. The queue can also be paused and resumed as a whole, so nothing new starts while something latency-sensitive is going on.

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

A stem row plays its separated audio and shows the separation model. Its right-click menu sends the stem to a new editor track, to the tail of the first track, to Init audio, to Inpaint, or to the Chimera stack, and offers a `.wav` download. A MIDI row plays through the synth and can be sent to the Piano Roll, the Step Sequencer, or (rendered to audio) to the editor, Init audio, Inpaint, or Chimera, with a `.mid` download. Its menu also brings every stem MIDI of the row's song in at once, and never the full-mix MIDI. **All stems to piano roll** puts one roll part per stem into the MIDI tab in place of the roll's parts, and a song with one stem sends it into the part being edited. **All stems to EDIT as tracks** puts one EDIT track per stem at the start of the timeline, in one undo step. Each part or track is named for its stem and plays its stem's instrument, the drums on channel 10 on a drum track, and each roll part takes the next free channel. Every note stays at the second it was transcribed at, on one tempo map the stems share, and a stem's pitch wheel becomes its notes' own bends. Both items show the number of stems beside them, and a song with no stem MIDI shows them off with "no stems". A stem whose file does not load is named in the LOG, and the other stems come in without it. Favoriting or deleting a stem or MIDI row affects only that row, never its parent entry.

A MIDI row dragged onto an EDIT lane lands as one piano-roll clip that plays the file's own program. A drum file plays its kit on a drum track. On a drum track that has a kit of its own, a drum file on program 0, which a writer puts on channel 10 when it names no kit, plays the track's kit. A blank lane (no clips, no instrument) takes the file's kind, drum or melodic, and the file's program. A lane of the other kind that holds clips or an instrument keeps its voice, the file goes on a new track, and the LOG says why. The clip opens in the piano roll as a percussion part for a drum file, and MATCH keeps its notes at their seconds.

### 13.13 Media roots: entries whose audio lives outside the library

An entry can exist whose audio was never written under `data/generations/`: catalogued from a provider that kept the file behind a URL, imported as metadata, or restored from a backup that carried the database and not the files. **Media roots** are the folders on this machine the library searches for those files.

Set them in **Settings → Storage → Media roots**, or in the `theDAW_MEDIA_ROOTS` environment variable (folders separated by `;` on Windows, `:` elsewhere). The environment variable wins outright: when it is set, the Settings list is not consulted at all. A root must be an absolute path to a folder that exists, and a folder inside another root is dropped because the outer walk already reaches it. A root typed into Settings that breaks those rules is refused there with the reason; a bad entry in the environment variable is logged and dropped, and the remaining roots still index.

One background scan indexes every root. A file is matched to an entry by its name, in two shapes: the entry's full 36-character id anywhere in the name, or the first eight hex digits of that id in square brackets immediately before the extension — the short tag a library export writes (`Some Title [c27de18c].flac`). When both shapes claim one entry the full id wins; between two short tags the newest file wins. (Entry ids are uuids; an entry whose id is not a uuid is not matched by either shape.) The walk runs on its own thread, because a few hundred thousand files on a spinning disk takes minutes, and until it finishes a lookup answers exactly as it did before any roots existed.

Nothing is copied. A file found this way is played in place: no bytes are written into the entry's folder and its metadata is not touched. The library asks the entry's own folder first, the media-root index second, and only then a remote copy.

The panel reports the index — how many files, how old, whether a walk is running — and a **Rescan** button walks the roots again on a background thread and answers immediately. A root is re-checked at most every 30 seconds while audio is being served, and a rescan starts when the root folder itself changed (gained or lost a top-level child). Files added deeper inside a root need **Rescan**.

AIFF, WMA, and APE are containers the browser has no demuxer for. When one of those is served from a media root it is remuxed to WAV once (header only, nothing re-encoded, no bit depth lost) and the copy is cached under `data/playable-cache/<entry id>/` rather than beside your file. That cache is derived state and can be deleted at any time; it is rebuilt on the next play.

The routes (`GET /api/library/media-roots`, `POST /api/library/media-roots/rescan`) and the settings keys that set the list answer only to this machine: loopback, or the desktop shell's launch token. A phone or LAN companion reads "Hidden on this device — manage media roots on the theDAW PC" in place of the folders and cannot set them. Naming every media folder on a machine is reconnaissance for anyone on the network, and a panel that cannot write the list has no use for its contents.


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

- **BPM** sets the roll's starting tempo for playback and offline render. Range: 20 to 300.
- **KEEP TIME**, beside BPM, decides what a new BPM does to the notes. On, every note keeps its time in seconds, so a transcription stays on the audio it came from. Off, every note keeps its place in the bar and plays faster or slower. It starts on for a roll whose parts came from a song's audio and off for a roll written on the grid. A press holds for that roll, also while the MIDI tab is closed and opened again. A controller knob mapped to BPM sets the tempo through the same choice. A BPM typed with KEEP TIME on writes to the LOG how many notes kept their time in seconds.
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

A part can also play through a **VST3 instrument**. The part's **Sound** select in the MIDI tab's parts column lists the scanned VST3 instruments under **VST3 instruments**, the same list EDIT's MIDI track VST slot offers, and the rescan key beside the label runs the scan again. With one chosen, a **VST3 instrument** box opens under the select: the plugin's name (press it to open the plugin's own window over the roll; what you set there is kept with the part and saved with the project), a status dot and word (**Live**, **Opening**, **Fallback**, **Off**), a power key that switches the plugin off and on with its settings kept, and an X that takes it away. PLAY, a note drawn or clicked on the keyboard, the arpeggiator and a hardware key all sound through the plugin, on the roll's tempo and transport. **Fallback** picks the General MIDI program the part plays whenever the plugin cannot (while it opens, if it fails to load, or with no live VST host installed) and that a MIDI export writes; a plugin that fails says so in the LOG and the part plays that program. **Articulations** picks how the plugin is told a note's articulation: keyswitch notes from C0, or UACC on CC 32. The EDIT key sends the plugin with the part onto its EDIT track's VST slot, where every bounce, freeze and export prints it.

### 15.9 Transcriptions and MATCH

A part whose notes were timed against a song's audio is marked as such: a LIBRARY MIDI row sent to the piano roll, **All stems to piano roll**, a MIDI row dropped on EDIT and opened in the roll, and the notes of a vocal take. **MATCH** gives the roll the song's tempo and meter, and every marked part keeps its notes at their seconds under the new tempo, so a transcription stays on the song. Every other part keeps its place in the bar. MATCH's status line says how many notes from the song's audio kept their time. The mark travels with the part in its EDIT clip, in a `.tasmo` and in a MIDI file the roll writes. Recording over the part with a MIDI keyboard and **CLEAR** remove it, and so does importing any other file into the part. A stem sent into one part while other parts hold notes lands at its transcribed seconds on the roll's tempo map, also after MATCH has changed that map.

### 15.10 CLEAN

**CLEAN**, after **TRANSFORM** on the MIDI tab's action rail, opens a card with two tools for tidying a transcription. Both work on the selected notes, else on every note of the part being edited.

- **ONE AT A TIME** reduces the notes to one line. Its **Keep** choice picks **Top line** (where notes overlap the higher note stays, for a melody), **Bottom line** (the lower note stays, for a bass line) or **Latest note** (each note cuts the one before it, as a monophonic synth plays). A pitch struck again while it still sounds cuts the note it repeats and plays on.
- **KEEP RANGE** removes every note below **LOW** or above **HIGH**, both MIDI note numbers shown with their note names. The range starts at the part instrument's range, else at the lowest and highest pitch of the notes.

Each tool is one undo step, keeps the notes it left selected, and writes what it did to the LOG.

### 15.11 A stem's instrument on import

basic-pitch writes its transcriptions on General MIDI program 4, Electric Piano 1. A part that arrives on program 4 from a file named for a song stem takes that stem's instrument: the voice for vocals, the electric bass, the electric guitar, the piano, the organ, and a drum kit on channel 10 for drums and for each piece of a split kit (kick, snare, toms, hi-hat, cymbals). A part the file left unnamed takes the stem's name. The stem comes from the LIBRARY row, or from the file's name (`bass.mid`) when the file comes in through the MIDI tab's **IMPORT** and its **As EDIT tracks**, EDIT's MIDI drop or the LIBRARY's **Import a .mid file into the piano roll** key. A stem that names no instrument (other, the full mix, no_vocals) keeps the file's program. A stem sent into the part being edited replaces the part's instrument, and a part named for its old instrument takes the new instrument's name. A name you gave the part stays.

### 15.12 Pitch wheel under chords

A MIDI file that moves one channel's pitch wheel under overlapping notes is read note by note. While one note sounds, the wheel becomes that note's own bend. While several sound, the wheel is left out and the chord plays unbent. The LOG says how many notes took their bend and warns how many chords play unbent. A channel that plays one note at a time keeps its bend lane and curve, and a file the roll wrote keeps its lanes' curves as written. **IMPORT**, **Send to piano roll**, **As EDIT tracks** and EDIT's MIDI drop all read files this way.

---

![The piano roll with MIDI import and export](screenshots/piano.png)

## 16. Bottom Panel Tabs

The bottom panel is collapsible and vertically resizable (drag the grip handle above it), and a maximize toggle expands any tab to fill the window. Eleven tabs are available, in order: Levels, Visualize, MIDI, Sequence, DRAW, Score, Sing, Lyric, Details, SLIDE, and SWAY. Development builds add a twelfth, **XR Bus**, a tester for the XR control bus (§34.4); production builds hide the tab and remap a persisted selection so it can never strand you on a missing tab.

Two tabs carry their own layout toggle in the tab row. **Details** switches between Details alone, Media alone, and both side by side — and in the side-by-side layout the right column carries its own **LIBRARY / MEDIA** switch (§16.4), so the layout choice and what fills that column are independent; **Sing** switches between **Lyrics**, **Both**, **Score** and **Study** (the lyrics beside the literary analysis). What each tab *is* lives in the feature registry under `panel-<id>`, so the hover tooltip on a tab and the sentence the **?** help search returns for it are the same sentence.

The panel's tab strip reads as part of the footer rather than a separate slab: it carries the footer's tinted-blur treatment and hairline border, the group toggle is a labelled **PANELS** button showing the active tab, and both dock bodies animate outward from the button that opened them.

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

### 16.2 MIDI

The tab reads **MIDI** in the tab row. It is the full piano roll interface embedded in the bottom panel. See [§15](#15-piano-roll).

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

**The library column.** In the side-by-side layout the right-hand column lists the **whole library**, so you browse on the right and read the metadata on the left. Each row shows the cover, the title, and the model, length and date; a star marks a favourite and a speaker marks whatever is sounding. Clicking a row selects it, and the details on the left follow. The list is keyboard-driven: Tab into it, then the arrow keys, Home and End move the selection and Enter plays. A selection made anywhere else — a LIBRARY row's **Open details**, or the assistant — scrolls the matching row into view.

The column's toolbar carries a **LIBRARY / MEDIA** switch (MEDIA puts the media bucket back in the column, §16.5), a filter that narrows the list without changing the LIBRARY tab, a sort that is the library's own order and so reorders the LIBRARY rail with it, and **IMPORT**. Rows can be dragged out to anywhere that accepts a library track — an EDIT track, a DJ deck, MAKE's init slot — and audio files dropped in from File Explorer or Finder are imported and the newest is selected. Files that are not audio are skipped with one line in the LOG naming them.

### 16.5 Media (a pane of Details)

Media is not its own tab any more. It is reached two ways from the DETAILS tab: the **Details tab layout** toggle in the tab row gives it the whole tab (Details alone, Media alone, or both side by side), and in the side-by-side layout the right column's **LIBRARY / MEDIA** switch puts it in that column beside the details. The choice persists.

It is a session-scoped file holding area for arbitrary audio files. Contents are cleared on page reload.

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

The Score tab renders a track's symbolic music (sheet music, guitar and bass tabs, and arrangements) from its MIDI artifacts, and exports to MusicXML, ABC, PDF, and SVG. It is documented in full in §33.

### 16.8 Levels

The Levels tab is the master-metering panel. It reads the shared playback bus and reports LUFS loudness, true-peak in dBTP, dynamics, and a stereo-image reading, updating continuously during playback. The readings let a mix be checked against a delivery target before it goes through Smart Export (§13.9).

### 16.9 DRAW

The DRAW tab turns drawn gestures into generative music. A pointer stroke on the canvas drives note and texture generation through one of four brushes, each with its own synthesis behavior:

| Brush | Behavior |
|---|---|
| **Organic** | An L-system growth that seeds melodic material from the stroke path. |
| **Fibonacci** | A phyllotaxis spiral whose notes step by Fibonacci intervals under a pulsing amplitude. |
| **Neural** | A network-styled brush that routes the stroke through a neural-flavored voice. |
| **Nebulous** | A diffuse cloud brush for pad and texture material. |

The result records to the library or appends to the EDIT timeline. Sound modes cover a drone voice, a SoundFont voice, and a granular voice.

### 16.10 SWAY

The SWAY tab hosts the **SwayCommand cockpit** — the Audima Labs Sway's own performance app, embedded in theDAW. The tab boots the cockpit straight into a project rather than its splash screen: it opens the most recent project saved from the cockpit, or the bundled `will-i-dream` template on a fresh install, and theDAW registers that project's media so its clips are allowed to load.

Saving inside the cockpit is durable: a save writes a `.sway` file into `data/sway-projects/` through theDAW's backend (`POST /api/sway/project-save`) and its media paths are allowlisted at the same time, so the project reopens intact.

theDAW holds the only `requestMIDIAccess()` and relays MIDI to the cockpit, so a plugged-in Sway is visible to both at once.

The Sway's six expressive-motion dimensions (`strike`, `sway`, `pulse`, `glide`, `press`, `sculpt`) are published on a shared bus that the VJ engine consumes for motion-driven visuals (§10.9) and the Perform tab consumes as a modulation source (§35.3). Playing a set from the hardware is covered end to end in [guides/sway-perform-live.md](guides/sway-perform-live.md).

---

### 16.11 Sing

The Sing tab shows the selected song's lyrics large and centred and moves them with the track line by line and word by word. Lyrics come from the entry's Lyrics field (Suno imports and tagged files fill it), a paste, an LRC file or whisper. **ALIGN** keeps your words and times every one of them against the vocal stem with a forced aligner; whisper then reviews the result in a separate job and underlines words it heard differently. **TAP** stamps line starts by hand while the song plays. **AUTO** runs ALIGN by itself when a song opens with lyrics but no timings. **PITCH** shows the vocal's melody and scores what you sing into the microphone. **EXPORT** writes LRC. The full walkthrough, the `lyrics` settings and the API are in [guides/sing-along-and-lyrics.md](guides/sing-along-and-lyrics.md).

### 16.12 Lyric

The writing surface: a notebook of lyric drafts that is not tied to a library track, with the analysis pane beside it. Write here, analyse from here, and mark rhymes by hand here — hand-made marks are stored against a lyric document, so MARK is only offered on a notebook draft. See [guides/lyric-notebook.md](guides/lyric-notebook.md) and [guides/lyric-analysis.md](guides/lyric-analysis.md).

## 17. Player Footer

A fixed 64 px bar at the bottom of the viewport (z-index 50), visible and functional across all tabs and workspace modes. It sits outside the Shell's zoomed subtree (§5), so it is the one region that never scales. Two rows: a scrub strip on top, and a control row beneath it laid out as three tracks — now playing, the transport plate, up next and the utilities.

### 17.1 Now playing (left region)

- **Orb speech bubble**: on wide windows (xl and up) the assistant orb's tip bubble occupies the leftmost slot, where the global search used to sit.
- **Title**: the current `playerStore.currentLabel`, truncated to fit the column.
- **Model chip**: derived from `useGenerateStore.lastModelName`, drawn in the active theme's accent. Shows `LIBRARY` for entries loaded from the library and `IDLE` when nothing has been generated or loaded.
- **Duration readout**: `MM:SS // 48kHz`, read from `playerStore.duration`.
- **Like** and **Share** appear on hover or keyboard focus. In VJ mode a **VJ** chip also shows how many items the current set holds and whether the VJ has acknowledged it.

### 17.2 Transport (center region)

The transport is a single matte plate of five labelled keys on a hairline grid, held on the exact viewport centre by the surrounding `1fr · auto · 1fr` layout (an even key count either side of PLAY is what keeps it there):

| Key | Description |
|---|---|
| **LOOP** | Toggles looped playback in `playerStore`. A latched key draws in the active theme's accent (`--et-accent`), not a fixed purple. |
| **START** | Calls `playerStore.seekByFraction(0)`. |
| **PLAY / PAUSE** | Primary playback toggle; the printed legend flips with the glyph. In EDIT workspace mode with no editor audio loaded, the first press triggers an offline render of the waveform editor timeline, loads the result into `playerStore`, and begins playback. Subsequent presses toggle playback natively. |
| **END** | Calls `playerStore.seekByFraction(1)`. |
| **RAND** | Random order: any other library track plays next instead of the following one. |

Fullscreen is not on the plate. It is in the header, immediately left of mobile access (§5).

**Scrub strip:** the footer's first row is a scrub strip, centred at three-fifths of the footer width with the elapsed and total times either side of it. The rail is a flat hairline that thickens under the pointer or keyboard focus; the filled part draws in the theme accent, and the playhead is a small cursor bar that widens under the hand. Click or drag anywhere to seek, and a time bubble follows the pointer. It is a real slider for assistive technology (`role="slider"` with `aria-valuetext`): Left/Right and Up/Down step by 5 s, Shift multiplies the step by six, and Home and End jump to the ends. The footer synchronizes its playhead with the Waveform Editor; scrubbing updates the editor timeline position when the editor timeline is the active audio source.

### 17.3 Up next and utilities (right region)

- **Up Next** (xl and up) mirrors the Now Playing block on the right: the next library entry's title and duration under an **Up Next** chip. Clicking it loads that track; with RAND on it is a random other entry, which the tooltip says. It reads "Nothing queued" when the library has nothing to follow with.
- **Master FX indicator** is a chip that appears whenever the global master insert has effects on it. It says how many, and its tooltip says whether any of them take level; clicking it opens MIX, and the chevron beside it expands a list of what is on the insert. It draws in the theme accent and is hidden when the insert is empty.
- **Mute toggle** switches the `playbackStore` mute flag. The volume icon changes to a red `VolumeX` when muted.
- **Volume**: a `SlideTrack` (a custom `role="slider"`, keyboard-operable) drives `playbackStore.volume` (0 to 100). The combined `volume × !muted` value is forwarded to `playerStore.setMasterGain`, which drives the shared Web Audio master gain node.
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
- **SIMPLE / VERBOSE toggle:** a mode switch in the log toolbar. SIMPLE (the default) shows message-only lines, folds consecutive identical messages into one line with an xN counter, and hides debug entries. VERBOSE shows every entry with its timestamp and [source] tag.
- **Auto-scroll:** the log panel scrolls to the most recent entry automatically.
- **Download:** exports the full raw buffer as `thedaw-log-YYYYMMDD-HHMMSS.txt` in both modes, regardless of the SIMPLE/VERBOSE view. Each line contains an ISO timestamp, level, source, and message.
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

Forces a full re-parse and re-embedding of the document corpus registered in `backend/rag.py` (`DOC_PATHS`, which includes this guide alongside the other manuals and guides) into the ChromaDB vector store. The index also builds lazily on the assistant's first RAG query.

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

The background processing an import or a generation triggers is per section, each with `auto_on_import` and `auto_on_generate` flags: `analysis` (on), `stems` (`default_count`, `device`, `quality`), `lyrics` (`auto_transcribe`, `language`, `aligner`, `review`; see [guides/sing-along-and-lyrics.md](guides/sing-along-and-lyrics.md)), `midi` (`from_stems`) and `notation`. The jobs run in that order on the idle-gated queue, through the pipeline coordinator (§13.7), so a song is singable before it is notated.

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

Stem runs operate on disk-backed library entries, go through the pipeline coordinator (one separation per entry at a time, on the shared GPU lane; a run already in flight is joined, §13.7), and persist rows in the library database so stems appear in details, bundles, lineage, and send-target workflows. `device` defaults to the `stems.device` setting, with `auto` resolving to the GPU when there is one.

### 19.16 MIDI

```http
GET  /api/midi
POST /api/midi/install?engine=basic_pitch
POST /api/midi/{entry_id}/run?from_stems=true
GET  /api/midi/{entry_id}
GET  /api/midi/file/{midi_id}
```

MIDI conversion runs on full entries and, when available, separated stems, on the GPU when there is one (basic-pitch through ONNX Runtime's CUDA provider, piano transcription on CUDA), one conversion per entry at a time through the pipeline coordinator (§13.7). The streamed `.mid` files import into the Piano Roll or attach to bundles as downloadable artifacts.

### 19.17 VJ

The VJ module powers the VJ center tab and its embedded iframe. The frontend fetches the engine URL from `GET /api/vj/url`, which also returns a `mobile_url` for LAN access when the machine has a non-loopback address. The backend serves the visual engine lazily as a production build (`vite preview`), rebuilding when the engine's source is newer than `dist/`; the port and project path can be overridden through the `theDAW_VJ_PORT` and `theDAW_VJ_PROJECT` environment variables, and `theDAW_VJ_DEV=1` forces the HMR dev server for engine development. Use the Settings modal module list and the VJ tab loading state to confirm availability.

### 19.18 Notation and Prompt Inference

The `notation` module exposes `/api/notation/*` for symbolic music (MIDI to MusicXML, tabs, arrangements, and exports), and the `analysis` module exposes `GET /api/analysis/{entry_id}/prompt` for inferred prompts. Both are documented with the feature in §33.7.

### 19.19 Lyrics

```http
GET    /api/lyrics/{entry_id}
PUT    /api/lyrics/{entry_id}
DELETE /api/lyrics/{entry_id}
POST   /api/lyrics/{entry_id}/align
POST   /api/lyrics/{entry_id}/transcribe
GET    /api/lyrics/{entry_id}/job
GET    /api/lyrics/jobs/{job_id}
POST   /api/lyrics/{entry_id}/import
GET    /api/lyrics/{entry_id}/export?format=lrc|txt&words=0|1
```

The `lyrics` module keeps one timed document per entry (`lyrics.json` next to the audio). `align` times the entry's own words against its vocal stem with the MMS forced aligner and then runs a whisper review job; `transcribe` lets whisper write the words. Both return `{"job": {"id"}, "reused": bool}`, and a second call while a job runs for the entry returns that job. The tab and the settings are in [guides/sing-along-and-lyrics.md](guides/sing-along-and-lyrics.md).

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
from backend.lib.audio_io import load_audio

waveform, sr = load_audio("/path/to/audio.wav")
init_audio = (sr, waveform)   # the pipeline takes (sample_rate, tensor)
audio = pipe.generate(
    init_audio=init_audio,
    init_noise_level=0.9,
    prompt="bossa nova bassline",
    duration=30,
)
```

> **Do not call `torchaudio.load` or `torchaudio.save`.** From 2.9 they decode
> through torchcodec, which loads FFmpeg's *shared* libraries at import — no
> ordinary Windows ffmpeg build ships them, so the call raises "Could not load
> libtorchcodec". `backend/lib/audio_io.py` reads and writes through libsndfile,
> falls back to the ffmpeg CLI for containers libsndfile cannot open, never
> clamps, and returns the same `(tensor[channels, frames], sample_rate)` shape
> `torchaudio.load` used to. torchaudio stays in the project for transforms only.
>
> Note the order: `load_audio` returns `(tensor, sample_rate)`, and the pipeline
> wants `(sample_rate, tensor)`.

### 20.3 Inpainting

```python
from backend.lib.audio_io import load_audio

waveform, sr = load_audio("/path/to/audio.wav")
inpaint_audio = (sr, waveform)
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
waveform, sr = load_audio("audio.wav")
latents = ae.encode(waveform, sr)
audio_out = ae.decode(latents)
```

Batch encoding, chunked processing, and dataset pre-encoding for LoRA training: see [docs/workflows/autoencoder.md](workflows/autoencoder.md).

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

The `small-rf` and `medium-rf` rectified-flow checkpoints are training bases rather than primary inference models. They are the starting point for LoRA finetuning and are surfaced through the Underfit trainer (§11) rather than as a recommended MAKE selection. Use ARC `small` or `medium` for generation.

The MAKE Model dropdown also lists two engines beyond these checkpoints. `magenta-small` reaches the Magenta RealTime 2 sidecar for streaming text-to-music (§27). Suno cloud generation sits under `suno` (§26). Both options share the dropdown with the local Stable Audio models, so one session can move across them without leaving MAKE.

### 21.1 Settings → Models: local checkpoints and the no-download guarantee

Nothing downloads at startup. The backend boots without touching a checkpoint, and a model loads only at the first CREATE that needs it. Resolution runs local-first on every load:

1. **Local model folders**: any directory listed in `local_models.txt` at the repo root or in the `SA3_LOCAL_MODELS_DIR` environment variable, plus a `models/` folder in the repo if present. Each folder holds subfolders named after the HF repo (for example `stable-audio-3-medium/`).
2. **The Hugging Face cache**: anything a previous session already downloaded.
3. **A one-time download** from the model's HF repo, only when neither local source has the files.

The one-time download runs through the `modeldl` module (`/api/models`), which streams the weights with a live progress registry surfaced in the Settings download dock, so a first fetch shows progress instead of blocking silently.

**Gated models and the Hugging Face sign-in card.** The post-trained `small` and `medium` checkpoints are gated on Hugging Face: you must accept the licence on the model page once, and downloads need a token. When a download is refused for that reason, theDAW raises a **Hugging Face sign-in card** in the bottom-right notice stack. Paste a **read** token from huggingface.co/settings/tokens into it; the backend validates the token and stores it in the same file the Hugging Face CLI uses, so every later download picks it up — no environment variable and no relaunch. The download dock's error text names the failing repo and links straight to its licence page. (`small` also has an ungated public mirror that is tried automatically; `medium` does not.)

The **Models** section sits directly below the pinned Restart/Shutdown controls in Settings, with Layout Settings right under it and the backend modules as compact tiles below that. It puts the whole model story on screen:

- **Local only (never download)** is **ON by default for fresh installs**, so nothing ever downloads until it is explicitly allowed; an existing explicit choice is preserved. With it on, a missing model fails with a clear message instead of downloading. The switch persists across restarts (it drives `SA3_LOCAL_ONLY`).
- **Installed / Connected cards** cover every engine in one glance: Stable Audio 3 (catalog plus registered checkpoints, with the active/loaded model and a ★ on the recommended option), Magenta RT2 (running / installed / needs Setup-MRT2), Suno API (key configured or not, with the key field right below), Demucs/stems, and the MIDI engines. States read Active, Ready, Cached, Local, Setup, Needs key, Missing config, or Blocked.
- **Add a checkpoint** registers any checkpoint already on disk, with a **Browse** button that opens the native Windows folder picker (typing a path still works). Point it at a folder containing a model config JSON plus one `.safetensors` file, or at the `.safetensors` file itself. Registered checkpoints appear under **LOCAL CHECKPOINTS** in the MAKE model picker and generate exactly like catalog models. Removing an entry never touches the files.
- **When a config JSON is missing**, the failure says exactly what was found (checkpoints, configs, what failed to pair). The config comes from the Hugging Face repo the checkpoint belongs to, or from the training/export run that produced it. When the checkpoint is a recognized built-in variant and the matching config exists locally or in the cache, a **Generate config** button copies the official JSON next to the checkpoint; configs are never guessed for unknown architectures.
- **Locations** lists every model location with its size and an **Open** button: the HF cache, each local model folder, the generated-audio library, the assistant's RAG index, the Torch hub cache, and the Magenta WSL assets and engine venv (via `\\wsl.localhost\…`). Hovering a size shows what models live in that directory, their exact paths and sizes, and stars the recommended pick when several are present (ARC over RF, medium over small).
- **Hugging Face cache breakdown** expands to a per-repo size table, each row openable in Explorer.

**No usable model?** Pressing CREATE (or LOAD) with nothing installed, or with a selection that local-only would block, never fails silently: the run stops with a plain-language explanation and Settings opens straight to the Models section, which pulses to show where the fix lives.

**Media roots** sit one section over, under **Settings → Storage**: the folders the library searches for an entry whose audio was never written under `data/generations/`. Files there are referenced in place and never copied, and both the list and its routes can only be read or set from this machine (§13.13).

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

**Repo naming since the June 2026 reorganization.** Stability restructured the Hugging Face repos. The former `stable-audio-3-small` repo was retired in favor of two specialized small models, `stable-audio-3-small-music` and `stable-audio-3-small-sfx`. Every repo now ships exactly two model files, `model_config.json` and `model.safetensors`; the old `stable-audio-3-*-ARC` / `-RF` filenames no longer exist on the Hub. Repos without a suffix hold the post-trained ARC checkpoints and are gated: accepting the license on the repo page grants access automatically, and downloads then need a logged-in Hugging Face token (see the token section below). The `-base` repos hold the RF training bases and download without a token. theDAW's `small` key maps to the music variant.

**Zero-token default for `small`.** So a fresh install generates without a Hugging Face account, `small` automatically falls back to a public ungated mirror of the same weights when the gated official repo is not accessible. The gated repo is still tried first, so a logged-in user with access keeps using the official copy. Point the fallback elsewhere, or turn it off, with `SA3_MODEL_MIRRORS="stabilityai/stable-audio-3-small-music=your-org/your-mirror"` (an empty value after `=` disables it). `medium` has no public mirror, so the higher-quality path still needs an accepted license and a token.

Download table (each links to its Hugging Face repo):

| Key | Use | Hugging Face repo | Files to place in the subfolder |
|---|---|---|---|
| `small` | Primary inference, CPU-capable | [stable-audio-3-small-music](https://huggingface.co/stabilityai/stable-audio-3-small-music) | `model_config.json`, `model.safetensors` |
| `medium` | Primary inference, CUDA GPU | [stable-audio-3-medium](https://huggingface.co/stabilityai/stable-audio-3-medium) | `model_config.json`, `model.safetensors` |
| `small-rf` | LoRA training base, CPU | [stable-audio-3-small-music-base](https://huggingface.co/stabilityai/stable-audio-3-small-music-base) | `model_config.json`, `model.safetensors` |
| `medium-rf` | LoRA training base, CUDA GPU | [stable-audio-3-medium-base](https://huggingface.co/stabilityai/stable-audio-3-medium-base) | `model_config.json`, `model.safetensors` |
| `same-s` | Standalone autoencoder (optional) | [SAME-S](https://huggingface.co/stabilityai/SAME-S) | `model_config.json`, `model.safetensors` |
| `same-l` | Standalone autoencoder (optional) | [SAME-L](https://huggingface.co/stabilityai/SAME-L) | `model_config.json`, `model.safetensors` |

A typical Small + Medium install under the repo-root `models/` folder looks like this:

```
stable-audio-3/
└── models/
    ├── stable-audio-3-small-music/
    │   ├── model_config.json
    │   └── model.safetensors
    └── stable-audio-3-medium/
        ├── model_config.json
        └── model.safetensors
```

The subfolder name matches the repo, and the two files inside keep their Hugging Face names. Repo-named copies such as `stable-audio-3-medium-ARC.safetensors` also resolve. Placements that followed the pre-reorg version of this guide keep working too: the resolver still accepts the old folder names (`stable-audio-3-small`, `stable-audio-3-medium`) holding the old suffixed filenames (`stable-audio-3-small-ARC.json`, `stable-audio-3-medium-RF.safetensors`, and so on).

The sound-effects variant follows the same convention: a subfolder named `stable-audio-3-small-sfx` (or `stable-audio-3-small-sfx-base` for its training base) holding `model_config.json` + `model.safetensors`.

**Which to download.** A CUDA GPU runs `medium` (a roughly 9 GB checkpoint). CPU-only machines run `small`. The `-rf` checkpoints are for LoRA training rather than normal generation. **SAME-S and SAME-L are optional**: the ARC and RF checkpoints already bundle the autoencoder, and a standalone SAME reuses that bundled copy, so download SAME only for standalone encode/decode without a DiT.

**The T5Gemma text encoder** ([google/t5gemma-b-b-ul2](https://huggingface.co/google/t5gemma-b-b-ul2)) is always required for text conditioning. It does NOT go in the `models/` folder; it loads from the Hugging Face cache under `%USERPROFILE%\.cache\huggingface\hub\`. Let the app fetch it on the first generation, or pre-fetch it with `hf download google/t5gemma-b-b-ul2`. Set `HF_HOME` before launching to relocate the cache.

**Hugging Face token (gated repos).** The `hfauth` module (`/api/hfauth`) manages a Hugging Face token for repos that require authentication. It detects a token already present in the environment or stored on disk and validates it against the Hugging Face `whoami` endpoint, reporting the account it belongs to. Logging in submits a new token, which is validated the same way before it is stored. Logging out removes the stored token. The token affects only authenticated fetches; the cache locations and the local-first resolution order above are unchanged.

**Registering a checkpoint stored elsewhere.** Skip the folder convention entirely: open **Settings → Models → Add a checkpoint**, click **Browse**, and point it at the folder (or the `.safetensors` file) directly.

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

Full training walkthrough: [docs/workflows/lora.md](workflows/lora.md).

---

## 23. Troubleshooting

### Generation produces a static glitch (Medium model)

Flash Attention is not loaded correctly. Verify:
```bash
uv run python -c "import flash_attn; from flash_attn import flash_attn_func; print('Version:', flash_attn.__version__)"
```
Any import error means the wheel does not match the installed Python, PyTorch, and CUDA combination. The wheel must be built for **torch 2.14 and CUDA 13** — that is what this project pins, and a wheel for any other pair will not import. `uv sync` installs the right one, so the fix is almost always to re-sync:

```powershell
uv sync --reinstall-package flash-attn
```

The wheels themselves are the `flash_attn-2.8.3+cu130torch2.14-cp3XX-cp3XX-win_amd64.whl` assets on [mjun0812/flash-attention-prebuild-wheels release v0.10.2](https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/tag/v0.10.2), one per Python minor (cp312, cp313, cp314); `pyproject.toml` pins them under `[tool.uv.sources]`.

### "FlashAttention only supports Ampere GPUs or newer"

Older cards (Turing RTX 20xx / GTX 16xx, Volta V100) import the Flash Attention wheel but cannot run its kernels. theDAW detects a compute capability below 8.0 per GPU and uses PyTorch's SDPA attention instead, so generation, Chimera init audio and inpainting work without changes; expect the LOG line `flash_attn disabled on <GPU name>` once per session and somewhat slower sampling. If you still see this error, the backend predates the September 2026 attention gate — update and restart it.

### "API UNREACHABLE" banner in the header

The backend is not responding on port 8600. Test directly:
```bash
curl http://localhost:8600/api/health
```
If the request fails, restart the backend. On Windows, `.\theDAW.bat` kills stale processes automatically. Manually: `taskkill /F /IM uvicorn.exe`.

### COMMIT EDIT hangs indefinitely

One or more clip source Blobs are failing to decode. The decode step has a 15-second timeout per Blob; if all clips time out, the render never completes. Check the Processing Log for `decodeAudioData timeout` entries. Likely causes: a corrupted Blob in the library, or an unusually large audio file. Remove the suspect clip and retry.

### Underfit tab reports a missing environment or stays on "connecting"

The Underfit dashboard runs as a sidecar on port 8791. On a fresh install the tab can report that the trainer environment is missing. Click **Create environment** in the tab to build `underfit/.venv`, which runs once and takes a few minutes. If the tab stays on "connecting" after that, the sidecar started but did not bind the port; check `data/underfit-sidecar.log` for the dashboard output.

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

theDAW ships the first non-Mac port of Magenta RealTime 2, vendored as the `sidecars/magenta-rt2-nvidia` submodule. A build-system guard in upstream MRT2's CMake locks the C++ inference engine to macOS through the line `if(NOT APPLE) FATAL_ERROR "magenta-rt-v2's C++ build is macOS-only"`. The port's `engine/patch_cmake.py` removes that guard, with an anchor check that aborts if upstream drifts, and flips the related switches. The port works because the inference core uses only the portable MLX C++ API, MLX now provides a native CUDA backend (`-DMLX_BUILD_CUDA=ON`), and the single piece of Apple-specific code is an autorelease-pool shim already gated behind `#if defined(__APPLE__)`.

The result runs on Windows through WSL2 with NVIDIA, on native Linux with NVIDIA, and on RunPod cloud GPUs, which extends MRT2 to platforms beyond its macOS origin. The shipped runtime uses the JAX and CUDA backend (`magenta-rt` 2.x) loading `mrt2_small`, the model behind the MAKE dropdown's `magenta-small` engine key. The submodule also includes a streaming WebSocket jam server and a RunPod-serverless path for the larger `mrt2_base`. `sidecars/magenta-rt2-nvidia/README.md` and `INSTALL.md` have the build details.

---

![The Magenta RealTime 2 conditioning panel](screenshots/magenta.png)

## 28. Edit Tool Stack

Beyond the 25-effect MIX chain (§8), theDAW mounts the **Edit Tool Stack**, six backend module families under `/api/edit/*`. Each family provides a focused set of audio processors built on FFmpeg, NumPy, and librosa DSP. The browser GUIs come from `frontend/public/edit-modules/` and iframe into the MIX effect stage.

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

The **Catalogue** view (`CatalogueView`, lazy-loaded in the shell) is a cross-provider gallery over the Library. It presents grid and list layouts, a filter bar, an inspector with on-demand spectrograms, a lineage panel, and **provider badges** that classify each entry from its embedded tags first and its `model` and `source` fields second: Stable Audio (theDAW's own generations), Suno, Udio, Riffusion, Magenta, Import, and theDAW (made here, origin unspecified — performance sets, renders, VJ output). A Suno, Udio or Riffusion frame in an imported file is labeled as such and its embedded prompt, style and lyrics are ingested; the badge is filterable. Its context menu runs Suno cover and mashup directly from a Library entry (§26). It reads the same backend Library API (§13) and the per-entry lineage route `GET /api/library/{id}/lineage`.

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

The assistant streams chat from any configured provider: Claude Code over the CLI, Gemini, Anthropic, OpenAI, Grok, Groq, OpenRouter, Ollama, LM Studio, llama.cpp, and vLLM. Each provider draws from the hashed multi-key pool above with round-robin distribution and failover, exposes live model lists and attachments, and grounds answers in a ChromaDB RAG index over the document corpus registered in `backend/rag.py`, which includes more documents than this guide.

---

## 33. Notation, Score, Tabs, and Arrangements

theDAW turns audio into symbolic music and back: audio → MIDI → sheet music, guitar and bass tabs, and playable arrangements, plus an inferred Stable Audio prompt for any track. The symbolic side lives in the **Score** tab of the bottom panel (§16.7) and the **Details** panel (§16.4), backed by the `notation` module (`/api/notation`) and the `analysis` module. The standalone guide is [guides/notation-and-score.md](guides/notation-and-score.md).

A track needs a MIDI first. Convert one from the Library (right-click → Convert to MIDI, §13.7); once a MIDI artifact exists, every way of writing it activates.

![Guitar tablature rendered from a track's MIDI in the Score panel](screenshots/score.png)

### 33.1 Notation artifacts

Every symbolic file a track produces is a notation artifact with a kind: `midi`, `musicxml`, `abc`, `alphatex` (tabs), `pdf`, or `svg`. The Score panel's left rail lists them; selecting one previews it (MusicXML as sheet music through OpenSheetMusicDisplay, alphaTex as tablature through alphaTab), and DOWNLOAD saves it. Artifacts are stored under `data/generations/<entry_id>/notation/` and tracked in the library database with lineage back to their source MIDI or score.

### 33.2 Making notation (the maker)

The top of the Score panel's left rail is one maker: pick an Instrument (Piano, Voice, Guitar, Bass, Ukulele, Drums, Band), pick how to Write as, and press MAKE. Piano offers Grand, Lead, Exact and Chords; Voice offers Melody, Lead and Exact; Guitar offers Tab, Chords, Melody and Exact; Bass offers Tab and Exact; Ukulele offers Tab and Chords; Drums offers Exact (a drum-kit MIDI becomes a percussion staff); Band offers Score. From picks the MIDI to read and starts on the instrument's own stem, falling back to the full-mix MIDI. Exact converts that MIDI to MusicXML with music21, quantizing rhythm, splitting parts, and inferring a time signature; MusicXML is the canonical interchange format and also feeds exports. Chords builds the chord track from the lead sheet when one exists, else from the audio, and needs no MIDI. When MAKE cannot run, the reason is printed under it. The « key in the rail's header collapses the rail to a thin strip and » opens it again.

### 33.3 Tabs

Pick Guitar, Bass or Ukulele and Tab, then a Tuning (only that instrument's: standard, drop D or 7-string guitar; 4- or 5-string bass; standard ukulele), a Level (Easy / Medium / Hard, which caps fret height and reach) and a Capo fret, and press MAKE. Because the same pitch can be played at several string and fret positions, a dynamic-programming pass chooses positions that minimize hand travel, prefer open strings and low frets, and keep simultaneous notes on distinct strings. The output is alphaTex, rendered as interactive tablature by alphaTab. Notes outside the instrument's range are reported as unplayable rather than forced.

### 33.4 Arrangements

Four of the maker's ways are rule-based arrangements:

- **Lead** (`lead-sheet`): the melody (skyline) with chord symbols above it.
- **Grand** (`piano-reduction`): a two-staff grand staff split at middle C.
- **Melody** (`simplified`): a single-staff quantized melody.
- **Score** on Band (`band-score`): one staff per separated stem, combined into a full score.

Arrangements render in the same in-browser sheet-music viewer and are saved as MusicXML artifacts. In the STRIP view every part's name is pinned to the left edge, level with its staves, while the score scrolls.

### 33.5 Exporting scores (the EXPORT menu)

With a MusicXML sheet or a MIDI artifact selected, the toolbar's **EXPORT** button opens a two-column menu: pick a part (All parts, or one part of the sheet), then a format. Every format works for one part as well as for the whole sheet. XML is the sheet itself (a new MusicXML artifact when it is one part, or when the source is a MIDI); XML + PDF PACK zips it with a PDF engraved on download. PDF and SVG are engraved by the headless OpenSheetMusicDisplay renderer, the same engraver the SCORE tab draws with (it needs node and the frontend's dependencies on the backend machine); when that renderer is missing or fails, the MuseScore command-line tool engraves the same format, so either engraver produces both. ABC (a compact lead-sheet text format) is always available through music21. NOTECHART writes the Unity note chart, and BEAT SABER opens the level-pack popover. MuseScore is found on PATH, at the usual install locations on Windows, macOS and Linux, at the path saved in Settings (the artist button's MuseScore field, with BROWSE… in the desktop app) or in `MUSESCORE_BIN`. When neither engraver is available, PDF and SVG stay in the menu, disabled, with the reason as their tooltip, and GET MUSESCORE (the download page) and LOCATE MUSESCORE… (point theDAW at an installed copy) appear under them. Exports register as new notation artifacts, a single-part export named after its part.

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

`GET /api/notation` reports capabilities (music21 and MuseScore availability, `osmd_pdf`, supported formats, `engravers` for pdf and svg, tab tunings, arrangement styles). `from-midi` converts a MIDI to MusicXML; `export` takes `{source_artifact_id, format, options?}` with format musicxml/abc/pdf/svg/notechart/beatsaber from a MusicXML or MIDI source (`options.parts` exports only those parts for any format, `options.engine` picks the pdf/svg engraver, the rest is read by beatsaber); `tabs` takes `{source_artifact_id | midi_id, instrument, tuning_name, capo, difficulty}` and returns alphaTex; `arrange` takes `{style, source_artifact_id | source_artifact_ids | midi_id}` and returns MusicXML. `GET /api/analysis/{entry_id}/prompt` returns `{prompt_guess, prompt_confidence, semantic_tags}` regenerated from the stored analysis.

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

### 34.8 Deploy to Quest

The **Deploy to Quest** item in the app menu (§37, Devices) installs the theDAW-XR headset app over adb without a Unity build. The `quest` module (`/api/quest`) drives it. The walkthrough is [guides/quest-deploy.md](guides/quest-deploy.md).

- **adb discovery.** The backend resolves an adb executable even when adb is not on PATH. It honors an explicit override saved to `data/quest.json`, then falls back to adb on PATH, then searches the Android SDK, the Unity Hub bundled SDK, and the Meta Quest Developer Hub install locations. The dialog reports where adb came from and lets the operator set the override path once.
- **Device detection.** The dialog lists connected devices from `adb devices -l`, showing each device's serial, connection state (`device`, `unauthorized`, or `offline`), and model. A headset is flagged as a Quest from its model, product, and device fields, including the hardware codenames, so a terse model string still reads as a Quest. A device is deployable once its state is `device`.
- **Get Latest.** The dialog can pull the newest release APK instead of requiring a local build. It reads the latest release of `gantasmo/theDAW-XR` on GitHub, downloads the `.apk` asset into `data/quest/`, and reuses an existing complete download when the file size already matches, so re-clicking does not re-download.
- **Install over adb.** Installing runs `adb install -r` for the selected APK against the chosen device, replacing any prior install while keeping data. An optional launch step starts the installed package's launcher activity so the headset opens straight into theDAW-XR.

Each path needs USB debugging enabled on the headset, or a wireless adb pairing. No Quest Link session and no Meta Quest Developer Hub casting are required.

---

## 35. Perform Tab

### Purpose

The Perform tab (`SessionView`) plays a project as a live scene and clip grid. It imports a DAW project or a `.tasmo` file (§37), lays the project's scenes and clips out on a launch grid, and performs them during a set. The project controls live in the tab header, so the grid takes the remaining height.

### 35.1 Loading a project

The header carries a project path input, a Browse control, and an Import button. Clicking or focusing the path input opens a dropdown of recent projects. ArrowDown and ArrowUp move through the list, Enter opens the highlighted entry, Escape closes the dropdown, and one click on an entry imports it immediately. The recent list persists across backend restarts (`data/recent_projects.json`).

A `.tasmo` path opens directly in the grid. Any other project path goes through detection and import: the backend identifies the DAW that wrote the file and parses it, and the header reports the detected DAW along with any format limitations or per-track warnings. The parser set is covered in §37.

### 35.2 The scene and clip grid

Once a project loads, the grid (`DawSessionGrid`) fills the workspace with the project's scenes and clips laid out for launching. The header shows the project name and tempo, the scene count, and the track count. Columns are tracks and rows are scenes: launching a row stops what is playing and fires that whole row, while clicking a single cell layers it over what is already running, so a bassline can hold while the drums change. A launch-quantize control delays launches to the next bar boundary.

Each column also carries a **live effect chain** built from the project's saved devices, so an imported or authored set arrives with its filters, delays and creative FX already running, and metering is post-FX. Built-in effects are audible live; VST3 plugins stay listed but silent until the track is frozen or rendered.

### 35.3 Routing panel — the SwayCommand deck

A **Routing** toggle in the header opens the routing panel (`PerformRoutingPanel`), which renders the **SwayCommand deck**: a live schematic of the hardware. Click any control on the deck to bind it, and the right rail shows what that control currently drives.

The factory map is knobs on CC 20–27, the XY pad on CC 50 (X) and CC 38 (Y), the pulse/press/sway gestures on CC 35/36/37, and the sixteen pads on notes 24–39. Buttons have no factory code and are bound by learn: arm a transport function, then press the button.

A control can drive a track's **volume** or **mute**, or any **parameter of any effect** in that track's live chain, with its own value range — an inverted range is how a filter that closes as you turn up is authored. Pads launch scenes, and can also **punch effects**: bound to an effect parameter, a pad pushes it while held and releases it on lift, or latches it on alternate presses. The shipped templates put scenes on pads 1–8 and punches on pads 9–16.

All of it is captured into the project when it is saved as `.tasmo` and restored on open. Full walkthrough: [guides/sway-perform-live.md](guides/sway-perform-live.md).

### 35.4 DAW project into a scene

Two header actions move an imported project onward. The **.tasmo** action saves the current project, together with its perform routing, as a `.tasmo` file (§37). The **Edit Timeline** action loads the imported project into the editable EDIT timeline (§7), so a session arranged for launching can be opened as clips on tracks for detailed editing.

---

## 36. Foundry Tab

### Purpose

The Foundry tab (`FoundryView`) embeds the VST Foundry plugin-UI builder, a tool for designing plugin interfaces on an infinite canvas and exporting them. The full walkthrough is [guides/foundry.md](guides/foundry.md).

### 36.1 The sidecar

Foundry is a Node application that serves its own interface on its own port. The `foundry` backend module (`/api/foundry`) spawns that sidecar on first request and returns its live URL from `GET /api/foundry/url`; the tab points an iframe at that URL. The first launch installs the Node dependencies and boots the server, so the tab retries the URL fetch and shows a starting state while that runs. When Foundry cannot start (for example when Node.js is not installed), the backend returns its diagnostic message and the tab shows it verbatim. A reload control re-fetches the URL, and a pop-out control opens the same URL in a standalone window for a larger design surface.

### 36.2 Exports into MIX

A Foundry design exports as a `.gan` web-plugin. The MIX `.gan` loader imports that export and runs the plugin in the effect stage (§8.8), so an interface built in Foundry becomes a usable processor in a MIX chain.

---

## 37. App Menu and Project Operations

The app menu (`HamburgerMenu`) is the hamburger button in the header icon cluster. It opens a keyboard-navigable dropdown grouped into five sections. The project and DAW-import workflow is documented in [guides/projects-and-daw-import.md](guides/projects-and-daw-import.md).

### 37.1 Menu items

- **Project**: **New Project** clears the workspace for a fresh session. **Open Project** loads a saved `.tasmo` file. **Save Project** writes the current session to a `.tasmo` file. **Import DAW Project** brings in a project written by another DAW. **Open Project** and **Import DAW Project** are also reachable from the header IMPORT button, which is on screen on every tab.
- **Data**: **Backup / Migrate**, **Check for Updates**, and **Restore Previous Version** open the maintenance dialogs described in §39.
- **Devices**: **Deploy to Quest** opens the headset deploy dialog described in §34.8.
- **App**: **Edit Layout** toggles Design Mode for the draggable panel layouts (its row shows an accent dot while active). **Change Theme** opens the theme picker ([guides/themes.md](guides/themes.md)). **Settings** opens the Settings modal — this menu is the only way in, the header gear having been retired. **Docs** opens this guide (§5).
- **Help**: **Feature Tour** starts the guided walkthrough, **Hide Feature Notes** / **Show Feature Notes** turns the pinned labels off or brings every one of them back (dismissed ones included), and **Home Screen** reopens the HOME overlay. All three are covered in §38 and [guides/feature-notes.md](guides/feature-notes.md).

### 37.2 The .tasmo project format

theDAW saves and loads native projects as `.tasmo` files through the `project` module (`/api/project`). The format is a hybrid of MsgPack and ZIP, with optional embedding of the audio the project references. Open and Save in the Project menu read and write this format, and the Perform tab saves an imported session as `.tasmo` from its header (§35.4).

### 37.3 DAW import parser set

**Import DAW Project** reads a project written by another DAW and converts it for theDAW. The `dawimport` module (`/api/dawimport`) parses Ableton Live (`.als`), Reaper (`.RPP`), and Logic Pro X (`.logicx`) projects. The importer reports the detected DAW and any format limitations. An imported project can open as a Perform scene grid (§35) or load into the EDIT timeline (§7). Per-DAW coverage and limitations are in [guides/projects-and-daw-import.md](guides/projects-and-daw-import.md).

---

## 38. HOME Screen and Onboarding Tour

### 38.1 HOME overlay

The HOME overlay (`HomeScreen`) is a full-screen launcher. It appears after the boot intro finishes and reopens on demand from the app menu's **Home Screen** item (§37). The top row shows the theDAW wordmark and a version chip. Below the hero line sit the workspace cards, one per center tab — MAKE, EDIT, MIX, Perform, DJ, VJ, SWAY, Foundry, Underfit, NodeF.I., LOOM, Learn and Tour; each card shows the tab's name and its one-line description, and clicking a card opens that workspace and dismisses the overlay.

A slim task row sits under the cards with **Open Project**, **Import Audio** (shown when an import handler is available), and **Feature Tour**. A **Show at startup** checkbox controls whether HOME appears on the next launch; the preference persists on its own (the overlay's open state always resets per launch). Escape dismisses the overlay.

### 38.2 Feature Tour

The Feature Tour is a chaptered guided walkthrough (`TOUR_CHAPTERS` and `TOUR_STEPS` in `frontend/src/onboarding/tourSteps.tsx`). It starts from the app menu's **Feature Tour** item or the HOME task row and opens on a chapter picker: take the six chapters in order, or open the one you need and leave. Each step switches to the relevant tab, opens the panel the control lives in, and spotlights the real on-screen control — the overlay swallows clicks, so a step shows you a control rather than asking you to operate one.

1. **Getting started** — the shell: workspaces, library, the dock, the transport, the menu.
2. **Making music** — prompts, models, starting from audio, Chimera, DRAW and SEQUENCE.
3. **Editing and mixing** — the timeline, the effect rack, meters, spectrum and track details.
4. **Performing** — PERFORM, DJ, VJ, SWAY and the SLIDE control surface.
5. **Words and notes** — Score, karaoke, lyric analysis, the rhyme web and the piano roll.
6. **The deep end** — LOOM, NodeF.I., FOUNDRY, UNDERFIT, the assistant, LEARN and TOUR.

Chapters exist because the whole walk is forty-one steps, which is not a sitting — and because the center panel warm-mounts each heavy workspace the first time it is visited, so one linear pass would start a WebGL visuals engine, a map, a 3D graph and four sidecar iframes on a machine whose owner has not made a sound yet. A chapter mounts what you opened and nothing else.

The same feature registry backs the header's **?** help search and the pinned Feature Notes, so a control named in one is findable in the others.

---

## 39. Backup, Updates, and Maintenance

The app menu's **Data** section (§37) holds backup, restore, and update operations. The full workflow is [guides/backup-and-updates.md](guides/backup-and-updates.md).

### 39.1 Backup and restore

**Backup / Migrate** opens the backup dialog, backed by the `backup` module (`/api/backup`). A backup exports user data to a portable ZIP: the library (audio, the database, stems, MIDI, scores, and video, with lineage), `.tasmo` projects, and settings. Restoring that ZIP on another install brings the same data back, so a setup can move between machines.

### 39.2 Update checks and version restore

**Check for Updates** opens the update dialog, backed by the `updates` module (`/api/updates`). It compares the installed version, read from `pyproject.toml`, against the latest published release on GitHub, and caches the result on disk for six hours (`?force=true` bypasses the cache). Being offline never produces an error page: the check returns "unknown" with the reason attached.

When an update is available the dialog installs it, and how depends on the install kind `GET /check` detects:

- **A git clone** (theDAW.bat, theDAW.sh, Pinokio, dev Electron) is updated in place by `POST /api/updates/apply`. The backend pulls, then exits with code **89**; the launcher that spawned it reads that code as "pull done", syncs dependencies and respawns, while the dialog polls `/api/updates/apply-status` and then `/api/health` and reloads the page when the backend is back. A clone with uncommitted local changes is refused with a 409 rather than overwritten, and a missing `git` returns 503.
- **The packaged Windows app** downloads the installer through electron-updater — the progress bar is that download — then quits and runs it.
- **The macOS dmg** is unsigned and cannot self-update, so the button downloads the new dmg for you to open.

If anything fails, the dialog shows the log tail with **Try again** and **Release page**. **Restore Previous Version** opens the same dialog on its releases list; moving *backward* is release-driven, so it hands you that release's download page rather than switching versions for you. The full walkthrough is [guides/backup-and-updates.md](guides/backup-and-updates.md).

---

## 40. NodeF.I. Tab

The NodeF.I. tab (the tab bar reads **NODEFI**) is a node-graph editor for building generation pipelines. Circular node cards sit on a dark, pannable and zoomable canvas and connect through glowing bezier edges. A palette on the left adds nodes, and an inspector on the right edits the selected node's parameters.

### 40.1 Node types

| Node | Role |
|---|---|
| **Library** | A source that reads an existing entry from the disk-backed library. |
| **Generate** | A Stable Audio or Magenta generation step with its own prompt, model, duration, steps, CFG, and seed. |
| **Effect** | An audio processing step applied to its input. |
| **Merge** | A stage that combines several inputs into one. |
| **Feedback** | A stage that routes output back into the graph for iterative passes. |
| **Output** | A terminal that writes the result back to the library. |

### 40.2 Running a graph

Run drives the graph through the same generate, effect, and library actions the rest of the app uses (`lib/nodefiRunner.ts`), so a NodeF.I. pipeline produces the same first-class library entries a manual MAKE render would. Each node reports its run status on the card, and outputs save back to the library on completion. The canvas is hand-built, with a CSS-transform world layer, SVG edges, and pointer-driven pan, node drag, and drag-to-connect.

---

## 41. TOUR Tab

The TOUR tab (`TourView`, `tour` module at `/api/tour`) plans live dates on a map. It discovers venues, promoters, and festivals, enriches them with booking contacts, and builds an optimized multi-stop route with optional EV-charger planning. Every third-party call runs server-side, so no key reaches the browser. Keys resolve env-first, then the in-app data file `data/tour_keys.json` (set through `POST /api/tour/config`). The map renders MapLibre GL against OpenFreeMap, which is keyless, so the map itself needs no configuration.

### 41.1 Discovery

A region search geocodes a place name through Nominatim, and venue discovery queries OpenStreetMap Overpass for music venues in view. The backend annotates each result with a genre and vibe vocabulary, and persistent filter chips narrow the virtualized venue list. Selecting a venue centers the map and scrolls the list to its row. A reverse lookup fills in a venue's city when the source data omits it.

### 41.2 Enrichment and routing

Per-venue enrichment runs a web search through any configured assistant provider to gather booking-contact channels. A route itinerary adds venues as stops, optimizes the drive order through OpenRouteService, and draws the geometry on the map with per-leg drive times, grouped by city while building. A start point and a date window bound the plan. An EV mode overlays charging stations sampled along the drawn route from OpenChargeMap, and a gas mode hides them.

### 41.3 Endpoints

| Method · Path | Purpose |
|---|---|
| `GET /api/tour/status` · `GET /api/tour/config` · `POST /api/tour/config` | Report which keys are configured; read and store third-party keys server-side. |
| `GET /api/tour/geocode` · `GET /api/tour/reverse` | Geocode a region name; reverse-geocode a venue's city. |
| `POST /api/tour/venues` | Discover venues in view, annotated with genre and vibe labels. |
| `GET /api/tour/filters` · `PUT /api/tour/filters` | Read and save persistent filter presets. |
| `POST /api/tour/enrich` | Gather a venue's booking-contact channels via web search. |
| `POST /api/tour/route` | Optimize the stop order and return the route geometry and per-leg times. |
| `POST /api/tour/chargers` | Sample EV charging stations along the route. |

---

## 42. Mobile Companion App

theDAW ships a standalone phone web app served from its own Vite entry at `mobile.html` (`frontend/src/mobile/`). The phone pairs to the desktop over the control-bus WebSocket and drives a performance from across the room. The companion boots a lean shell scoped to remote control, so it loads quickly on a phone and leaves the cinematic, MIDI, XR, and pose subsystems to the desktop.

A link indicator reports the pairing state: **linked** when paired, **locked** when the desktop rejected the pairing, and **offline** when the bus is unreachable. Four tabs cover the phone's role:

| Tab | Role |
|---|---|
| **Make** | Submit a generation to the desktop remotely. |
| **Remote** | Transport control for the desktop player. |
| **DJ** | Drive the DJ console from the phone. |
| **Library** | Browse and audition the disk-backed library. |

The control contract between the phone and the desktop is documented in [docs/companion-control-contract.md](companion-control-contract.md).

---

## Credits

theDAW was built by **[GANTASMO](https://github.com/gantasmo)** as part of the [Music Hackspace](https://musichackspace.org) Music Technology Hackathon at [Berklee College of Music](https://www.berklee.edu).

Special thanks to [Music Hackspace](https://musichackspace.org), [Berklee College of Music](https://www.berklee.edu), and to Zack, CJ, Jordi, Zach, and Matt from [Stability AI](https://stability.ai) for their continued help and support.

**Built with:** [Stability AI](https://stability.ai) Stable Audio 3 and [stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools) (the core diffusion model and pipeline); [Magenta](https://github.com/magenta) RealTime by [Google DeepMind](https://deepmind.google), running through theDAW's own [NVIDIA/CUDA port](../sidecars/magenta-rt2-nvidia/) (the first and only non-Mac port so far); [Suno](https://suno.com) (cloud generation); [T5Gemma](https://huggingface.co/google/t5gemma-b-b-ul2) by Google (text conditioning); [Demucs](https://github.com/facebookresearch/demucs) by Meta AI (stem separation); [basic-pitch](https://github.com/spotify/basic-pitch) by Spotify (audio-to-MIDI); [music21](https://github.com/cuthbertLab/music21) by MIT (MusicXML, ABC, tabs, arrangements), with [alphaTab](https://www.alphatab.net) and [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org) for browser tab and score rendering and [MuseScore](https://musescore.org) as the second PDF and SVG engraver; [MLX](https://github.com/ml-explore/mlx) by Apple (the Magenta port's inference core, extended with a CUDA backend); and [PyTorch](https://pytorch.org), [FFmpeg](https://ffmpeg.org), [three.js](https://threejs.org), [react-force-graph](https://github.com/vasturiano/react-force-graph), [WaveSurfer.js](https://wavesurfer.xyz), [React](https://react.dev), [Vite](https://vitejs.dev), and [Tailwind CSS](https://tailwindcss.com), alongside the wider open-source community.

---

*Maintained by the theDAW development team.*
