# theDAW Vocal-Layer Generation — Implementation Brief for Agents

**Purpose:** Add a production-oriented vocal-layer system to the existing theDAW application.

**Primary output:** isolated, timeline-aligned vocal clips/stems that sit over a fixed existing instrumental. The system must produce usable lead vocals and optional layers, then route them into theDAW EDIT/MIX/Library/lineage system.

**This is not a request for a replacement song generator.** The existing instrumental is the fixed musical context. The vocal system must listen to it, respect its timing and structure, then render vocals that belong on its exact timeline.

---

## 1. Non-negotiable product behavior

### Mode A — Guide-performance / audio-to-audio

Inputs:
- Fixed instrumental from theDAW Library or EDIT timeline.
- Optional guide recording, imported vocal, hum, rap, melody, or reference performance.
- Optional target lyric text.
- Optional target singer/timbre profile.
- Optional target section/range on the timeline.

Required behavior:
1. Analyze the guide’s timing, phrase boundaries, pauses, rhythmic density, pitch/F0 contour, and optionally words.
2. Preserve its **temporal behavior**: starts, stops, cadence, rhythm, phrase shape, note contour where requested.
3. Create a new vocal layer aligned to the fixed instrumental timeline.
4. Return a dry/mostly dry vocal stem and metadata, not a replacement instrumental.

Examples:
- Rough rap guide + new lyric text → new vocal that follows the rap’s cadence.
- Hummed sung guide + lyric text → sung vocal with the guide’s melodic contour.
- Existing clean singing take → alternate lyric version preserving its melody.

### Mode B — Lyrics + structure tags

Inputs:
- Fixed instrumental.
- Lyrics.
- Section tags and delivery instructions.
- Optional per-section vocal role/tone/register settings.
- Optional voice/timbre profile.

Required behavior:
1. Read musical context from the instrumental: tempo, beats, downbeats, bar grid, key/scale if available, arrangement/energy regions, and available space.
2. Build an editable **Vocal Performance Plan** before rendering.
3. Decide syllable placement, rhythmic density, rests, breaths, line starts, held notes, pitch/MIDI/F0 curve, section-level energy, and vocal layers.
4. Render aligned vocal stem(s) and place them on the existing theDAW timeline.

Example:
```text
[VERSE 1 | 16 bars | low-energy melodic rap | intimate | sparse]
lyrics...

[PRE | 8 bars | build | rising melody | double final words]
lyrics...

[CHORUS | 8 bars | strong sung hook | wide doubles + high harmony]
lyrics...
```

---

## 2. Existing theDAW foundations to reuse, not duplicate

Agents must integrate with the existing system rather than add another disconnected audio application.

### Existing backend/module architecture

The project already uses a FastAPI backend and independently mounted modules.

Relevant paths:
```text
backend/server.py
backend/modules/
backend/modules/loader.py
frontend/
```

Existing module pattern:
```text
backend/modules/<module_name>/
├── module.json
└── router.py
```

Existing relevant components:
```text
analysis       # audio analysis
chimera        # source analysis, BPM/key/beat alignment, fusion
library        # persistent assets and lineage
midi           # audio-to-MIDI / symbolic artifacts
stems          # Demucs separation
effects        # effects and processing
magenta        # real-time model sidecar
settings       # model registration/readiness
```

### Existing workflow primitives to reuse

```text
Instrumental Library asset
→ existing analysis / BPM/key/beats

Mic or imported guide
→ existing Library ingest and optional stem isolation

Guide analysis
→ existing MIDI module + new alignment/F0 data

Generated vocal stem
→ Library import + lineage edge

Library asset
→ EDIT timeline track + clip placement

EDIT clip
→ MIX vocal processing chain
```

### Existing UI/tooling that should remain the source of truth

- Library assets and lineage
- MAKE/EDIT/MIX workspace navigation
- existing async job queue/progress behavior
- Settings → Models readiness and local checkpoint registration
- mic recorder
- stem separation
- MIDI / Piano Roll
- EDIT timeline clip placement, tracks, fades, trims, snapping
- MIX effects and exports

Do not build:
- a separate Gradio app as the user-facing workflow
- a second standalone media library
- an independent timeline
- a parallel local-model setup page
- a model loaded at startup by default

---

## 3. Proposed module

Create one new backend module:

```text
backend/modules/vocal/
├── module.json
├── router.py
├── schemas.py
├── service.py
├── jobs.py
├── model_registry.py
├── adapters/
│   ├── soulx_singer.py
│   ├── yingmusic_singer.py
│   ├── acestep.py
│   ├── diffsinger.py
│   ├── rvc.py
│   └── seed_vc.py
├── preprocess/
│   ├── guide_isolation.py
│   ├── transcription.py
│   ├── alignment.py
│   ├── f0.py
│   ├── notes.py
│   ├── instrumental_context.py
│   └── sections.py
├── planning/
│   ├── plan_builder.py
│   ├── lyric_parser.py
│   ├── cadence.py
│   ├── melody.py
│   └── layers.py
├── render/
│   ├── render_svs.py
│   ├── render_svc.py
│   ├── render_layers.py
│   ├── normalize.py
│   └── timeline.py
└── workers/
    ├── worker_protocol.py
    ├── soulx_worker.py
    ├── yingmusic_worker.py
    ├── acestep_worker.py
    └── vc_worker.py
```

### Mandatory architectural rules

1. **One adapter interface.** Model-specific code stays inside `adapters/`.
2. **Lazy model loading.** Do not load SoulX, YingMusic, ACE-Step, voice-conversion engines, or their dependencies at backend startup.
3. **Per-engine environments/workers.** Do not force potentially incompatible model dependency stacks into the theDAW base environment.
4. **Library IDs over arbitrary paths.** API payloads use theDAW Library IDs and timeline coordinates. Resolve paths internally.
5. **Output artifacts must re-enter the Library.** Each output stem gets analysis/metadata/lineage, then may be inserted into EDIT.
6. **The generated performance plan is an artifact.** Persist it as JSON alongside audio and link it to the source instrumental, guide, lyrics, and render.
7. **Render dry stems first.** Doubles/harmonies/ad-libs should be individual clips/stems, not permanently baked into a full mix.

---

## 4. Engine classification

These are different jobs. Do not collapse them into one misleading “AI vocal model” dropdown.

| Engine class | Job | Candidate implementation | Position in pipeline |
|---|---|---|---|
| Singing voice synthesis (SVS) | Lyrics + MIDI/F0 → sung stem | SoulX-Singer, DiffSinger | Primary renderer |
| Melody-preserving lyric edit | Guide singing + new lyrics → new vocal | YingMusic-Singer | Guide mode renderer |
| Broad music/vocal model | Experimental lyric/audio generation or repairs | ACE-Step | Optional/experimental provider |
| Voice conversion | Existing vocal performance → target timbre/identity | RVC/Applio, Seed-VC | Optional downstream pass |
| Alignment | Word/syllable timing from guide | WhisperX | Guide preprocessing |
| Pitch extraction | Dense melody/F0 contour | RMVPE | Guide preprocessing |
| Audio-to-MIDI | Editable note events from guide | existing Basic Pitch integration | Guide preprocessing / Piano Roll |
| Separation | Pull guide vocal from mixed reference | existing Demucs integration | Optional preprocessing |

### Critical distinction: RVC is not a vocal generator

RVC-style systems should not be presented as the core “Generate Vocals” engine.

```text
Vocal performance generation:
lyrics + plan + melody/cadence
→ actual sung/rapped performance

Voice conversion:
existing performance
→ a different perceived singer/timbre
```

RVC/Applio/Seed-VC are useful **after** there is a performance to convert. They do not solve lyrics-to-performance planning.

---

## 5. Main external implementation links

### Primary singing-render engines

#### SoulX-Singer — primary initial engine
- Repository: https://github.com/Soul-AILab/SoulX-Singer
- Paper: https://arxiv.org/abs/2602.07803
- Hugging Face organization/models: https://huggingface.co/Soul-AILab

Why it matters:
- Zero-shot singing voice synthesis.
- Supports symbolic score/MIDI and melodic/F0-style conditioning.
- Designed for controllable, multilingual singing output.
- Strongest first engine for theDAW’s `lyrics + performance plan` route.

Agent implementation focus:
1. Read the repository’s inference, preprocessing, model download, and environment instructions.
2. Identify the smallest programmatic inference entry point.
3. Wrap it in a managed worker.
4. Inputs should be: lyrics, target singer reference/profile, MIDI or F0, sample rate/config, and output target.
5. Convert output into theDAW’s standard audio/import metadata pipeline.

#### YingMusic-Singer — guide-singing + lyric replacement
- Repository: https://github.com/ASLP-lab/YingMusic-Singer
- Paper: https://arxiv.org/abs/2603.24589
- Project/demos: inspect the repository README and linked demo/model pages.

Why it matters:
- Takes a melody-providing singing clip, altered lyrics, and optional timbre reference.
- Designed to preserve melody while changing lyric content.
- Direct candidate for guide mode when users have already performed the cadence/melody but need a regenerated version.

Agent implementation focus:
1. Keep its input guide vocal separate from the instrumental.
2. Run guide-isolation first when the uploaded guide is a full mixed bounce.
3. Pass output through alignment and timeline placement.
4. Keep the original guide linked in lineage.

#### DiffSinger — deterministic score-driven fallback
- Repository: https://github.com/openvpi/diffsinger
- OpenUTAU project: https://github.com/stakira/OpenUtau
- OpenVPI documentation/community: https://github.com/openvpi

Why it matters:
- A controllable score-driven fallback for exact notes, phonemes, durations, and reproducible rerenders.
- Useful when theDAW needs an explicit “vocal instrument / Piano Roll” workflow.

### Experimental music/vocal model

#### ACE-Step
- Repository: https://github.com/ace-step/ACE-Step
- Project site: https://ace-step.github.io/
- Original paper: https://arxiv.org/abs/2506.00045
- ACE-Step 1.5 paper: https://arxiv.org/abs/2602.00744

Why it matters:
- Broad music-generation foundation model with lyric alignment/editing and vocal-related tasks.
- Treat as experimental in theDAW: useful for alternate ideas, localized regeneration, or exploratory workflows.
- Do not assume it reliably returns clean isolated vocal stems against a fixed instrumental without testing.

### Voice conversion providers

#### RVC
- Original project: https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI
- API reference starting point: https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/main/api_240604.py

#### Applio
- Repository: https://github.com/IAHispano/Applio
- Documentation: https://docs.applio.org/

#### Seed-VC
- Repository: https://github.com/Plachtaa/seed-vc
- Project/demo page: https://plachtaa.github.io/

Agent implementation focus:
- Implement conversion as an optional `timbre_provider`, never as the only vocal render path.
- Preserve guide performance timing and pitch by default.
- Make conversion a separate render step and artifact so users can compare pre/post-conversion.
- Review licenses before shipping or embedding each provider.

### Guide preprocessing / alignment

#### WhisperX
- Repository: https://github.com/m-bain/whisperX
- Examples: https://github.com/m-bain/whisperX/blob/main/EXAMPLES.md

Use for:
- transcript,
- word timestamps,
- aligned lyrics,
- phrase boundaries,
- optional diarization if it becomes relevant later.

#### RMVPE
- Repository: https://github.com/Dream-High/RMVPE

Use for:
- dense F0 extraction,
- melody contour,
- voiced/unvoiced masks,
- note transition cues.

#### Basic Pitch
- Repository: https://github.com/spotify/basic-pitch
- Programmatic usage: https://github.com/spotify/basic-pitch#programmatic

Use for:
- guide audio → MIDI/note events,
- editable Piano Roll seeding,
- note onset/duration candidates.

#### Demucs
- Repository: https://github.com/facebookresearch/demucs
- Python usage: https://github.com/facebookresearch/demucs#calling-from-another-python-program

Use for:
- source separation only.
- Prefer the existing theDAW stems module rather than new standalone integration.

### Useful analysis/developer references

- FastAPI: https://fastapi.tiangolo.com/
- Pydantic: https://docs.pydantic.dev/
- PyTorch: https://pytorch.org/docs/stable/index.html
- librosa beat tracking: https://librosa.org/doc/latest/generated/librosa.beat.beat_track.html
- librosa onset detection: https://librosa.org/doc/latest/onset.html
- Essentia documentation: https://essentia.upf.edu/documentation.html
- FFmpeg filters: https://ffmpeg.org/ffmpeg-filters.html
- Web Audio API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API

---

## 6. Core data contracts

### 6.1 Instrumental context

Persist or retrieve this from existing analysis/Chimera/library machinery.

```json
{
  "instrumental_entry_id": "lib_beat_001",
  "duration_sec": 183.42,
  "sample_rate": 44100,
  "bpm": 140.0,
  "key": "F# minor",
  "beats_sec": [0.0, 0.4286, 0.8571],
  "downbeats_sec": [0.0, 1.7143, 3.4286],
  "bar_grid": [
    {"bar": 1, "start_sec": 0.0, "end_sec": 1.7143}
  ],
  "sections": [
    {"label": "verse_1", "start_bar": 1, "end_bar": 17, "energy": 0.41},
    {"label": "chorus_1", "start_bar": 17, "end_bar": 25, "energy": 0.88}
  ],
  "analysis_source": "library/chimera"
}
```

### 6.2 Guide performance

```json
{
  "guide_entry_id": "lib_guide_013",
  "source_type": "mic_take",
  "isolated_vocal_entry_id": "lib_guide_013_vocals",
  "transcript": "optional guide transcript",
  "word_timestamps": [
    {"word": "running", "start_sec": 32.14, "end_sec": 32.56, "confidence": 0.96}
  ],
  "phrases": [
    {"start_sec": 32.14, "end_sec": 35.80, "beat_start": 65, "beat_end": 73}
  ],
  "f0_hz": [{"time_sec": 32.14, "hz": 220.0}],
  "voiced_mask": [{"start_sec": 32.14, "end_sec": 35.80}],
  "midi_notes": [
    {"pitch": 57, "start_sec": 32.14, "end_sec": 32.52, "velocity": 94}
  ],
  "cadence_features": {
    "syllables_per_beat": 2.25,
    "onset_offsets_beats": [0.0, 0.5, 0.75],
    "pause_regions_sec": [[33.19, 33.44]]
  }
}
```

### 6.3 Vocal Performance Plan

This is the central missing artifact. It must exist before renderer invocation.

```json
{
  "plan_id": "vocalplan_001",
  "instrumental_entry_id": "lib_beat_001",
  "timeline_start_sec": 32.0,
  "timeline_end_sec": 64.0,
  "mode": "lyrics_from_scratch",
  "renderer_preference": "soulx_singer",
  "voice_profile_id": "voice_profile_01",
  "sections": [
    {
      "id": "verse_1",
      "start_bar": 17,
      "end_bar": 33,
      "delivery": "melodic_rap",
      "energy": 0.48,
      "register": "low_mid",
      "lyrics": "line one ...",
      "phrase_events": [
        {
          "line_index": 0,
          "start_sec": 32.14,
          "end_sec": 35.80,
          "word_timing": [
            {"word": "line", "start_sec": 32.14, "end_sec": 32.35}
          ],
          "syllable_timing": [
            {"text": "line", "start_sec": 32.14, "end_sec": 32.35}
          ],
          "rests": [{"start_sec": 33.19, "end_sec": 33.44}],
          "breaths": [{"at_sec": 35.70, "strength": 0.4}],
          "midi_notes": [
            {"pitch": 57, "start_sec": 32.14, "end_sec": 32.52}
          ],
          "f0_source": "generated_or_guide",
          "intensity_curve": [
            {"time_sec": 32.14, "value": 0.42},
            {"time_sec": 35.80, "value": 0.58}
          ]
        }
      ],
      "layer_plan": [
        {"role": "lead", "enabled": true, "pan": 0.0, "gain_db": 0},
        {"role": "low_double", "enabled": false, "pan": -0.18, "gain_db": -8},
        {"role": "high_double", "enabled": false, "pan": 0.18, "gain_db": -8}
      ]
    }
  ],
  "created_by": "vocal.plan_from_lyrics.v1"
}
```

### 6.4 Render request

```json
{
  "plan_id": "vocalplan_001",
  "engine": "soulx_singer",
  "render_mode": "svs_midi",
  "target_sample_rate": 44100,
  "target_format": "wav",
  "output_roles": ["lead", "low_double", "high_double"],
  "dry_output": true,
  "insert_into_edit": true,
  "target_track_names": {
    "lead": "VOCAL — Lead",
    "low_double": "VOCAL — Low Double",
    "high_double": "VOCAL — High Double"
  }
}
```

---

## 7. Required API surface

```text
POST /api/vocal/prepare-guide
POST /api/vocal/plan/from-guide
POST /api/vocal/plan/from-lyrics
POST /api/vocal/plan/{plan_id}/validate
GET  /api/vocal/plan/{plan_id}

POST /api/vocal/render
POST /api/vocal/render/convert-voice
POST /api/vocal/render/layers
GET  /api/vocal/jobs/{job_id}
POST /api/vocal/jobs/{job_id}/cancel

GET  /api/vocal/providers
GET  /api/vocal/providers/{provider_id}/health
GET  /api/vocal/voices
POST /api/vocal/voices/import-reference
```

### `POST /api/vocal/prepare-guide`

Input:
```json
{
  "guide_entry_id": "lib_guide_013",
  "instrumental_entry_id": "lib_beat_001",
  "separate_if_needed": true,
  "transcribe": true,
  "extract_f0": true,
  "extract_midi": true,
  "align_to_instrumental": true
}
```

Expected output:
```json
{
  "job_id": "job_vocal_prepare_001",
  "status": "queued"
}
```

### `POST /api/vocal/plan/from-lyrics`

Input:
```json
{
  "instrumental_entry_id": "lib_beat_001",
  "lyrics_with_tags": "[VERSE | melodic rap]\n...\n[CHORUS | wide sung hook]\n...",
  "timeline_start_bar": 17,
  "voice_profile_id": "voice_profile_01",
  "planner_options": {
    "respect_sections": true,
    "generate_midi": true,
    "generate_f0": true,
    "allow_rewrite_suggestions": false,
    "max_layers": 3
  }
}
```

Expected output:
```json
{
  "plan_id": "vocalplan_001",
  "status": "ready_for_review"
}
```

---

## 8. End-to-end pipelines

### Pipeline A — guide performance

```text
Guide audio / mic take
→ Library import
→ optional Demucs isolation
→ WhisperX word alignment
→ RMVPE F0 extraction
→ existing Basic Pitch MIDI extraction
→ guide-performance artifact

Guide-performance artifact + fixed instrumental context + optional new lyrics
→ Vocal Performance Plan
→ Singing renderer:
   - SoulX SVC/SVS OR
   - YingMusic lyric editing
→ optional voice conversion:
   - RVC/Applio OR Seed-VC
→ normalize / trim / stems metadata
→ Library import + lineage
→ insert dry vocal clip(s) into EDIT
→ user mixes in MIX
```

### Pipeline B — lyrics + tags

```text
Fixed instrumental Library asset
→ existing analysis:
   BPM / key / beats / downbeats / sections / energy

Lyrics + structure/delivery tags
→ lyric parser
→ cadence/melody planner
→ Vocal Performance Plan:
   word/syllable timing + rests + MIDI/F0 + layer roles

Vocal Performance Plan
→ SoulX-Singer SVS
→ one isolated lead stem
→ optional planned doubles / harmonies
→ Library + lineage
→ EDIT tracks, aligned to timeline
→ MIX
```

### Pipeline C — voice conversion only

```text
Existing recorded/generated vocal stem
→ optional pitch cleanup
→ RVC/Applio OR Seed-VC
→ converted stem
→ A/B artifacts in Library
→ EDIT replacement/parallel track
```

---

## 9. Rendering and placement rules

### Output policy

Always preserve:
- original instrumental unchanged,
- source guide unchanged,
- pre-conversion vocal unchanged,
- converted vocal as a new artifact,
- vocal plan JSON,
- provider/model/version/config,
- source assets and lineage edges.

### Timeline policy

1. Render vocal audio in the exact timeline window represented by the plan.
2. Trim leading model padding/silence only after measuring it.
3. Align the rendered phrase to `timeline_start_sec`.
4. Use theDAW’s editor BPM/grid and source timecode.
5. Place each requested layer on a separate EDIT track.
6. Do not auto-merge lead/doubles/harmonies unless the user explicitly asks for a printed stack.

### Suggested track naming

```text
VOCAL — Lead
VOCAL — Low Double
VOCAL — High Double
VOCAL — Harmony Low
VOCAL — Harmony High
VOCAL — Ad-libs
VOCAL — Guide (hidden/optional)
```

---

## 10. Provider adapter interface

Use one internal provider contract.

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Literal

@dataclass
class VocalRenderInput:
    plan_path: Path
    lyrics: str
    midi_path: Path | None
    f0_path: Path | None
    guide_audio_path: Path | None
    voice_reference_path: Path | None
    sample_rate: int
    output_dir: Path
    options: dict

@dataclass
class VocalRenderResult:
    audio_path: Path
    sample_rate: int
    duration_sec: float
    provider: str
    provider_version: str | None
    metadata: dict

class VocalProvider(Protocol):
    provider_id: str
    display_name: str

    def health(self) -> dict: ...
    def ensure_ready(self) -> None: ...
    def render(self, request: VocalRenderInput) -> VocalRenderResult: ...
```

Adapters must not leak Gradio/UI assumptions into `router.py`.

---

## 11. Model-worker policy

Each heavyweight model gets a separate worker process/environment.

Suggested worker strategy:
```text
theDAW backend
→ writes immutable job spec JSON + resolved local paths
→ starts/reuses named worker:
   soulx-worker
   yingmusic-worker
   acestep-worker
   voice-conversion-worker
→ worker sends progress events
→ worker writes result path + metadata JSON
→ backend imports assets into Library and writes lineage
```

Worker status:
```text
not_installed
installing
ready
busy
error
offline
```

Settings → Models should surface those states beside existing Stable Audio/Magenta/Demucs/MIDI entries.

---

## 12. MVP scope and build order

### Phase 1 — no model yet: make the plan and asset flow real

Deliver:
- `vocal` module scaffold.
- Library-linked guide preparation job.
- guide transcript + F0 + MIDI + phrase data.
- editable Vocal Performance Plan JSON.
- plan review UI in theDAW.
- dummy renderer that returns an existing guide/muted placeholder only for end-to-end timeline testing.

Acceptance:
- A mic take can become a guide artifact.
- Plan is visible/editable.
- One generated/placeholder stem can be inserted accurately into EDIT.
- All source/output lineage is correct.

### Phase 2 — SoulX-Singer as first real render provider

Deliver:
- SoulX model worker.
- model registration/readiness UI.
- `svs_midi` and `svs_f0` request paths.
- lead-vocal rendering.
- output normalization and exact timeline insertion.

Acceptance:
- Lyrics + hand-authored Piano Roll MIDI creates a lead vocal stem.
- A guide-derived F0/MIDI path creates a vocal stem.
- Result lands on the designated EDIT track in time.

### Phase 3 — guide lyric replacement

Deliver:
- YingMusic worker.
- guide singing + replacement lyric workflow.
- guide vocal isolation preflight.
- preserve-melody visual comparison.

Acceptance:
- A clean guide can be re-sung with changed lyric text while retaining its broad melody/timing.
- Original guide and transformed output remain linked and independently auditionable.

### Phase 4 — multiple layers and conversion

Deliver:
- lead/double/harmony plan roles.
- optional RVC/Applio and/or Seed-VC conversion providers.
- per-layer render configs.
- stack placement and simple mixing defaults.

Acceptance:
- One plan creates separate lead, double, and harmony clips.
- Voice conversion creates a separate child artifact, never overwrites the source performance.

### Phase 5 — generative planner quality

Deliver:
- instrumental-aware lyric timing.
- cadence selection.
- energy/section-aware delivery.
- melody/MIDI proposal.
- auto-created rests/breaths.
- editable plan review before render.

Acceptance:
- Lyrics+tags workflow can produce a reasonable editable first performance plan without a guide.
- User can move words/notes/rests and re-render only the selected region/phrase.

---

## 13. Test matrix

| Test | Expected |
|---|---|
| 140 BPM instrumental + rap guide | Output cadence starts on the same intended beat locations |
| Sung guide + rewritten lyric | Melody and phrase timing broadly preserve; words change |
| Lyrics only + tagged chorus | Planner builds notes/timing and output starts/ends within requested bar window |
| Guide is a mixed bounce | Separation step is offered/required before lyric-edit route |
| 44.1 kHz instrumental | Returned stem is 44.1 kHz and aligns correctly in EDIT |
| Engine unavailable | Job reports `not_installed` or specific error; does not crash backend |
| Provider returns extra silence | System measures/compensates offset, records adjustment |
| Rerender same plan | Creates a new child artifact; never replaces prior audio |
| RVC conversion | Is optional downstream process and preserves original performance artifact |
| Model worker dies | Job fails cleanly, worker is marked unhealthy, existing backend stays live |

---

## 14. License / shipping caution

Agents must verify current upstream licenses and model terms before bundling or commercial deployment.

Known things to check:
- SoulX-Singer code/model terms and included dependencies.
- YingMusic-Singer code/model terms; verify all bundled VAE/checkpoint restrictions.
- ACE-Step’s current code/model license and commercial-use policy.
- RVC project terms and downloaded model provenance.
- Applio license plus dependencies.
- Seed-VC GPL-3.0 implications.
- Demucs, WhisperX, RMVPE, and Basic Pitch licenses.
- Consent and rights for uploaded voice references/training data.

**Do not claim commercial clearance based on this document alone.** Confirm in the upstream repository and model-card license files at implementation time.

---

## 15. Decision summary

### Build first
```text
SoulX-Singer
+ existing Demucs
+ WhisperX
+ RMVPE
+ existing Basic Pitch / Piano Roll
+ theDAW Library + job system + EDIT timeline
```

### Add second
```text
YingMusic-Singer
```

### Add later / optional
```text
RVC/Applio
Seed-VC
DiffSinger
ACE-Step
```

### Product rule
```text
TheDAW owns:
- instrumental context
- project/timeline alignment
- guide analysis
- lyrics/tags parsing
- Vocal Performance Plan
- asset lifecycle
- track placement
- lineage

External engines own:
- singing waveform synthesis
- optional voice/timbre conversion
```
