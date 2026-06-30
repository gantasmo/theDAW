# theDAW × SoulX-Singer — Focused Integration Guide for Agents

**Scope:** This document covers **SoulX-Singer only**. It specifies how to integrate SoulX-Singer and SoulX-Singer-SVC into the existing theDAW application as a local, Library-aware, timeline-aligned singing-vocal renderer.

**Do not expand scope in this implementation.**
- Do not add unrelated vocal engines.
- Do not add unrelated voice-conversion providers.
- Do not build a separate user-facing Gradio application.
- Do not create a parallel media library, timeline, or project store.
- Do not replace or alter the instrumental when rendering a vocal layer.

---

## 0. Source-of-truth links

Read these before writing the adapter. They are the official current implementation surfaces.

| Purpose | Link |
|---|---|
| SoulX-Singer repository | https://github.com/Soul-AILab/SoulX-Singer |
| Official README | https://github.com/Soul-AILab/SoulX-Singer/blob/main/README.md |
| Official preprocessing guide | https://github.com/Soul-AILab/SoulX-Singer/blob/main/preprocess/README.md |
| SVS CLI inference source | https://github.com/Soul-AILab/SoulX-Singer/blob/main/cli/inference.py |
| SVC CLI inference source | https://github.com/Soul-AILab/SoulX-Singer/blob/main/cli/inference_svc.py |
| SVS shell example | https://github.com/Soul-AILab/SoulX-Singer/blob/main/example/infer.sh |
| SVC shell example | https://github.com/Soul-AILab/SoulX-Singer/blob/main/example/infer_svc.sh |
| Preprocessing shell example | https://github.com/Soul-AILab/SoulX-Singer/blob/main/example/preprocess.sh |
| SoulX-Singer model files | https://huggingface.co/Soul-AILab/SoulX-Singer |
| SoulX preprocessing model files | https://huggingface.co/Soul-AILab/SoulX-Singer-Preprocess |
| Official demo page | https://soul-ailab.github.io/soulx-singer/ |
| Online demo | https://huggingface.co/spaces/Soul-AILab/SoulX-Singer |
| MIDI Editor | https://huggingface.co/spaces/Soul-AILab/SoulX-Singer-Midi-Editor |
| Technical report | https://arxiv.org/abs/2602.07803 |

**License noted by upstream:** Apache 2.0 for SoulX-Singer code/model weights. Agents must still inspect current upstream license/model-card files at implementation time.

---

## 1. What SoulX actually provides

SoulX has two separate inference products. They must appear as separate modes in theDAW because their inputs and jobs are different.

### A. SoulX-Singer SVS — generate a singing performance

Use this when theDAW has:
- a **target singer reference** (prompt audio),
- a target vocal plan represented as either:
  - **score control:** lyrics + aligned MIDI-note metadata, or
  - **melody control:** lyrics + aligned melody/F0 metadata.

This is the correct SoulX route for:
```text
Lyrics + a new editable MIDI line
→ a new sung vocal layer

Lyrics + a guide-derived F0 / melodic contour
→ a new sung vocal layer matching the intended melody
```

Upstream SVS command entry point:
```text
python -m cli.inference
```

The upstream CLI requires:
```text
--model_path
--config
--prompt_wav_path
--prompt_metadata_path
--target_metadata_path
--phoneset_path
--save_dir
--control melody|score
```

Optional:
```text
--auto_shift
--pitch_shift <semitones>
--fp16
```

### B. SoulX-Singer-SVC — convert an existing singing performance

Use this when theDAW already has:
- a **prompt/reference singer audio file**,
- a **target singing performance**,
- F0 contours for both.

This is the correct SoulX route for:
```text
Existing sung guide/performance
+ reference singer/timbre
→ converted singing performance
```

It is audio-to-audio. It preserves the target’s existing melody, rhythm, and lyric content. It does **not** create a new lyric performance from text.

Upstream SVC command entry point:
```text
python -m cli.inference_svc
```

The upstream CLI requires:
```text
--model_path
--config
--prompt_wav_path
--target_wav_path
--prompt_f0_path
--target_f0_path
--save_dir
```

Optional:
```text
--auto_shift
--pitch_shift <semitones>
--n_steps <int>
--cfg <float>
--fp16
```

---

## 2. Product behavior inside theDAW

### 2.1 New SoulX workspace/panel

Create a focused panel inside the existing theDAW flow:

```text
MAKE / EDIT
  → VOCALS
     → SOULX-SINGER
```

Do not create an independent app.

The panel has exactly two mode cards:

```text
[ CREATE SINGING PERFORMANCE ]
SoulX-Singer SVS
Inputs:
- Singer reference
- Lyrics + MIDI or melody guide
- Timeline placement
Output:
- New lead vocal stem

[ CONVERT EXISTING SINGING ]
SoulX-Singer-SVC
Inputs:
- Singer reference
- Existing singing target
- Timeline placement
Output:
- Converted singing stem
```

### 2.2 Required shared inputs

```text
Singer reference
- choose a Library audio asset
- or import/record one through existing theDAW paths
- must be a clean usable vocal reference, ideally dry

Destination
- selected EDIT timeline range
- start time / bar range
- target track
- insert result into EDIT toggle

Output
- default WAV
- preserve source artifact
- import result to Library
- create lineage edge
```

### 2.3 SVS inputs

```text
Target representation:
( ) MIDI score control
( ) Melody/F0 control

Target metadata source:
( ) SoulX preprocessing pipeline
( ) existing theDAW Piano Roll → exported SoulX metadata
( ) guide audio → SoulX preprocessing → editable metadata

Lyrics:
- editable text field / structured lyric editor

Target range:
- requested start/end time in project timeline
```

### 2.4 SVC inputs

```text
Prompt singer reference:
- Library audio asset

Target singing performance:
- Library asset / selected EDIT clip / imported audio / recorded take

Prepare target:
- extract F0 automatically
- preserve existing source
- optionally inspect generated F0 curve

Target range:
- optional crop range before rendering
```

---

## 3. Integration boundary

Create one focused module.

```text
backend/modules/soulx_singer/
├── module.json
├── router.py
├── schemas.py
├── service.py
├── jobs.py
├── paths.py
├── worker_client.py
├── preprocess.py
├── metadata.py
├── timeline.py
├── adapters/
│   ├── svs.py
│   └── svc.py
└── workers/
    ├── protocol.py
    └── soulx_worker.py
```

### Required design rules

1. **Lazy load only.** SoulX must not initialize at normal theDAW startup.
2. **Dedicated environment/worker.** Do not force its dependency graph into the main theDAW Python environment.
3. **Use Library IDs at the API boundary.** Resolve physical paths internally.
4. **Keep every source.** Prompt reference, target guide, metadata JSON, MIDI edit, and final waveform remain Library-linked artifacts.
5. **Never overwrite the original guide or source vocal.**
6. **All output must return to the existing Library and EDIT timeline.**
7. **The SoulX metadata must be stored as a first-class artifact.**
8. **Do not expose upstream shell scripts directly to the browser.** Wrap model execution in the theDAW worker contract.

---

## 4. Environment and model installation

### 4.1 Isolate SoulX

Upstream recommends Python 3.10 and Conda.

Suggested managed environment:
```text
<theDAW root>/
└── sidecars/
    └── soulx-singer/
        ├── repo/
        ├── conda-env-name.txt
        ├── models/
        ├── jobs/
        └── outputs/
```

Suggested environment:
```bash
conda create -n thedaw-soulx python=3.10 -y
conda activate thedaw-soulx
pip install -r requirements.txt
```

Clone:
```bash
git clone https://github.com/Soul-AILab/SoulX-Singer.git
cd SoulX-Singer
```

Model downloads:
```bash
pip install -U huggingface_hub

hf download Soul-AILab/SoulX-Singer \
  --local-dir pretrained_models/SoulX-Singer

hf download Soul-AILab/SoulX-Singer-Preprocess \
  --local-dir pretrained_models/SoulX-Singer-Preprocess
```

### 4.2 Model readiness contract

Add a SoulX card in the existing Settings → Models system.

```json
{
  "id": "soulx_singer",
  "display_name": "SoulX-Singer",
  "status": "not_installed | installing | ready | busy | error",
  "environment": "thedaw-soulx",
  "device": "cuda",
  "svs_checkpoint_found": false,
  "svc_checkpoint_found": false,
  "preprocess_models_found": false,
  "last_error": null
}
```

The SVS and SVC checkpoints are separate:
```text
pretrained_models/SoulX-Singer/model.pt
pretrained_models/SoulX-Singer/model-svc.pt
```

---

## 5. SoulX preprocessing: do not skip the metadata requirement

### 5.1 What SVS requires

SoulX-Singer SVS does not accept arbitrary raw text + arbitrary MIDI as its published CLI input.

It requires:
```text
Prompt singer audio
+ prompt metadata JSON
+ target metadata JSON
```

The target metadata represents:
```text
- segment timing
- lyrics/words
- note information
- durations
- F0-related information
- language
```

Upstream preprocessing produces the required format.

### 5.2 SoulX preprocessing pipeline

Official preprocess command:
```bash
python -m preprocess.pipeline \
  --audio_path <input_audio> \
  --save_dir <output_dir> \
  --language <language> \
  --device cuda \
  --vocal_sep <true|false> \
  --max_merge_duration <milliseconds> \
  --midi_transcribe <true|false>
```

Processing stages:
```text
1. Vocal separation and dereverberation — optional
2. F0 extraction
3. Voice activity / segment detection
4. Lyrics transcription
5. Note transcription
6. Metadata JSON construction
```

Important output behavior:
```text
<input>.wav / .mp3 / .flac
→ matching <input>.json copied beside the source
→ metadata.json inside save_dir
→ cut vocal wavs
→ F0 .npy files
→ intermediate separated vocal/accompaniment assets when separation is enabled
```

### 5.3 Mapping to existing theDAW tools

Reuse theDAW where safe:

```text
theDAW stem separation
→ optional clean guide/reference prep

theDAW Library asset
→ resolved source file passed into SoulX preprocess

theDAW MIDI/Piano Roll
→ can become the editor surface for score data

SoulX native preprocess
→ still required to create/maintain SoulX-compatible JSON
```

Do not assume theDAW’s existing Basic Pitch/MIDI object is already equivalent to SoulX metadata. Build an explicit converter and validate against SoulX’s editor/import path.

### 5.4 Preprocess options by mode

#### SVS
```text
midi_transcribe=True
```

Use:
- on prompt singer reference when metadata is not already available,
- on target guide or target-score seed audio when creating metadata,
- before score/melody SVS inference.

#### SVC
```text
midi_transcribe=False
```

Use:
- for prompt singer audio,
- for target singing audio,
- when only waveform + F0 are needed.

### 5.5 Metadata correction is mandatory UI work

Upstream explicitly warns that automatic lyric/note alignment can materially harm quality.

Implement a review stage:

```text
Prepare
→ generated metadata
→ review / correct
→ render
```

At minimum expose:
```text
- text/lyric words
- phrase boundaries
- note pitch
- note duration
- line start/end
- project timeline offset
```

Do not silently render unreviewed metadata as the only workflow.

---

## 6. The critical timing bridge: SoulX metadata ↔ theDAW timeline

SoulX SVS reads target metadata segment timing in milliseconds and creates a rendered output buffer based on the end of the final target segment.

theDAW operates in project timeline seconds/bars.

### Required strategy

When a user targets a project range:

```text
Project:
bar 17 through bar 25
timeline: 32.000 sec through 47.500 sec

SoulX job:
render a local vocal region with metadata from 0.000 sec through 15.500 sec

Result:
generated.wav
→ import as Library child artifact
→ insert clip in EDIT at 32.000 sec
```

Never give SoulX project-global timestamps unless the worker intentionally wants a leading silent region.

### Conversion rules

```text
project_relative_sec = absolute_project_sec - requested_region_start_sec

SoulX metadata time:
milliseconds = round(project_relative_sec * 1000)
```

After render:
```text
EDIT clip startSec = requested_region_start_sec
source offset = 0
duration = rendered audio duration
```

### Padding correction

Model/render pipelines may return leading or trailing silence.

Implement:
```text
1. Measure leading silence.
2. Save measured offset in output metadata.
3. Shift only when it is a known model-produced pad.
4. Never shift a musical pickup or intentional rest without user confirmation.
5. Preserve the untrimmed raw render in Library.
6. Make cleaned/timeline-aligned clip a child artifact.
```

---

## 7. SVS adapter

### 7.1 Required request schema

```python
class SoulXSvsRequest(BaseModel):
    instrumental_entry_id: str
    prompt_entry_id: str
    target_metadata_entry_id: str
    timeline_start_sec: float
    timeline_end_sec: float
    control: Literal["melody", "score"]
    auto_shift: bool = True
    pitch_shift: int = 0
    use_fp16: bool = True
    insert_into_edit: bool = True
    edit_track_name: str = "VOCAL — SoulX Lead"
```

### 7.2 Worker invocation

Use a structured job file, not string-concatenated shell code.

Example job payload:
```json
{
  "job_id": "job_soulx_svs_001",
  "mode": "svs",
  "model_path": "pretrained_models/SoulX-Singer/model.pt",
  "config": "soulxsinger/config/soulxsinger.yaml",
  "prompt_wav_path": "resolved/prompt.wav",
  "prompt_metadata_path": "resolved/prompt.json",
  "target_metadata_path": "resolved/target.json",
  "phoneset_path": "soulxsinger/utils/phoneme/phone_set.json",
  "save_dir": "sidecars/soulx-singer/outputs/job_soulx_svs_001",
  "control": "score",
  "auto_shift": true,
  "pitch_shift": 0,
  "fp16": true
}
```

Worker command:
```bash
python -m cli.inference \
  --device cuda \
  --model_path <model_path> \
  --config <config_path> \
  --prompt_wav_path <prompt_wav_path> \
  --prompt_metadata_path <prompt_metadata_path> \
  --target_metadata_path <target_metadata_path> \
  --phoneset_path <phoneset_path> \
  --save_dir <save_dir> \
  --control <melody|score> \
  --auto_shift \
  --pitch_shift <int> \
  --fp16
```

### 7.3 Important upstream example bug to avoid

The official `example/infer.sh` defines:
```text
control=score
```

but its shown command does not pass:
```text
--control $control
```

The actual Python CLI defaults to `melody`.

**The theDAW adapter must always explicitly pass `--control score` or `--control melody`. Never depend on the upstream script default.**

### 7.4 Output handling

Upstream SVS code writes:
```text
generated.wav
```

The published inference source writes that output at **24 kHz**.

theDAW project audio is generally 44.1 kHz. Therefore:

```text
SoulX raw output (24 kHz)
→ preserve as raw Library artifact
→ high-quality resample to 44.1 kHz
→ create a timeline-ready child artifact
→ insert child into EDIT
```

Persist:
```json
{
  "source_sample_rate": 24000,
  "project_sample_rate": 44100,
  "resampled": true,
  "resample_method": "ffmpeg high-quality resampler",
  "soulx_mode": "svs",
  "soulx_control": "score"
}
```

---

## 8. SVC adapter

### 8.1 Required request schema

```python
class SoulXSvcRequest(BaseModel):
    prompt_entry_id: str
    target_entry_id: str
    timeline_start_sec: float
    timeline_end_sec: float
    prompt_f0_entry_id: str | None = None
    target_f0_entry_id: str | None = None
    auto_shift: bool = True
    pitch_shift: int = 0
    n_steps: int = 32
    cfg: float = 3.0
    use_fp16: bool = True
    insert_into_edit: bool = True
    edit_track_name: str = "VOCAL — SoulX SVC"
```

### 8.2 Worker invocation

```bash
python -m cli.inference_svc \
  --device cuda \
  --model_path pretrained_models/SoulX-Singer/model-svc.pt \
  --config soulxsinger/config/soulxsinger.yaml \
  --prompt_wav_path <prompt_wav_path> \
  --target_wav_path <target_wav_path> \
  --prompt_f0_path <prompt_f0.npy> \
  --target_f0_path <target_f0.npy> \
  --save_dir <save_dir> \
  --auto_shift \
  --pitch_shift <int> \
  --n_steps 32 \
  --cfg 3.0 \
  --fp16
```

### 8.3 F0 requirements

SoulX SVC consumes NumPy `.npy` F0 arrays for:
```text
prompt/reference singer audio
target singing audio
```

Preferred workflow:
```text
Prompt Library asset
→ SoulX preprocess with midi_transcribe=False
→ prompt vocal.wav + prompt vocal_f0.npy

Target singing asset
→ SoulX preprocess with midi_transcribe=False
→ target vocal.wav + target vocal_f0.npy

Prompt + target + F0 arrays
→ SoulX SVC worker
```

### 8.4 Do not misuse SVC

SVC can:
```text
Preserve target performance
→ change target singer/timbre/style
```

SVC cannot replace the need for:
```text
Lyrics + melody plan
→ newly authored vocal performance
```

Do not put a lyrics input on the SVC panel unless it is explicitly marked as non-operative metadata for the project. The upstream SVC inference path does not accept lyrics or MIDI inputs.

---

## 9. API surface

```text
POST /api/soulx/prepare
POST /api/soulx/metadata/import-midi
POST /api/soulx/metadata/export-midi
GET  /api/soulx/metadata/{asset_id}

POST /api/soulx/render/svs
POST /api/soulx/render/svc

GET  /api/soulx/jobs/{job_id}
POST /api/soulx/jobs/{job_id}/cancel

GET  /api/soulx/health
GET  /api/soulx/models
```

### 9.1 `POST /api/soulx/prepare`

```json
{
  "library_entry_id": "lib_guide_012",
  "language": "English",
  "vocal_separation": true,
  "midi_transcription": true,
  "max_merge_duration_ms": 60000,
  "purpose": "svs_target"
}
```

Rules:
```text
purpose = svs_prompt | svs_target | svc_prompt | svc_target

svs_prompt:
midi_transcription=true

svs_target:
midi_transcription=true

svc_prompt:
midi_transcription=false

svc_target:
midi_transcription=false
```

Expected result:
```json
{
  "job_id": "job_soulx_prepare_012",
  "status": "queued"
}
```

### 9.2 `POST /api/soulx/render/svs`

```json
{
  "prompt_entry_id": "lib_singer_reference",
  "prompt_metadata_entry_id": "lib_singer_reference_soulx_metadata",
  "target_metadata_entry_id": "lib_target_plan_soulx_metadata",
  "instrumental_entry_id": "lib_instrumental",
  "timeline_start_sec": 32.0,
  "timeline_end_sec": 47.5,
  "control": "score",
  "auto_shift": true,
  "pitch_shift": 0,
  "use_fp16": true,
  "insert_into_edit": true,
  "edit_track_name": "VOCAL — SoulX Lead"
}
```

### 9.3 `POST /api/soulx/render/svc`

```json
{
  "prompt_entry_id": "lib_target_singer_reference",
  "target_entry_id": "lib_existing_singing_performance",
  "instrumental_entry_id": "lib_instrumental",
  "timeline_start_sec": 32.0,
  "timeline_end_sec": 47.5,
  "auto_shift": true,
  "pitch_shift": 0,
  "n_steps": 32,
  "cfg": 3.0,
  "use_fp16": true,
  "insert_into_edit": true,
  "edit_track_name": "VOCAL — SoulX SVC"
}
```

---

## 10. Metadata as an editable artifact

### 10.1 Persist SoulX metadata

Store a JSON child artifact in the Library:

```json
{
  "asset_type": "soulx_metadata",
  "source_audio_entry_id": "lib_guide_012",
  "mode": "svs_target",
  "language": "English",
  "metadata_path": "library/.../metadata.json",
  "midi_path": "library/.../vocal.mid",
  "f0_artifacts": [".../vocal_f0.npy"],
  "created_by": "soulx.prepare.v1"
}
```

### 10.2 MIDI round-trip

SoulX’s official preprocessing supports:

```text
Metadata JSON
→ MIDI
→ edit note pitch/duration/lyrics
→ MIDI
→ SoulX metadata JSON
```

Upstream commands:

```bash
python -m preprocess.tools.midi_parser \
  --meta2midi \
  --meta <metadata.json> \
  --midi <vocal.mid>
```

```bash
python -m preprocess.tools.midi_parser \
  --midi2meta \
  --midi <vocal_edited.mid> \
  --meta <edit_metadata.json> \
  --vocal <vocal.wav>
```

### 10.3 theDAW implementation requirement

Connect the round trip to the existing Piano Roll where possible:

```text
SoulX metadata
→ exported MIDI artifact
→ Piano Roll edit
→ edited MIDI export
→ SoulX metadata converter
→ SVS render
```

Do not claim the existing Piano Roll directly edits SoulX metadata until the converter preserves:
```text
- exact note timing
- pitch
- lyric/phoneme association
- voice segment timing
```

---

## 11. Worker protocol

### 11.1 Job file

Backend writes:
```text
sidecars/soulx-singer/jobs/<job_id>.json
```

Worker writes:
```text
sidecars/soulx-singer/jobs/<job_id>.status.json
sidecars/soulx-singer/outputs/<job_id>/generated.wav
sidecars/soulx-singer/outputs/<job_id>/result.json
```

### 11.2 Status contract

```json
{
  "job_id": "job_soulx_svs_001",
  "state": "queued | preparing | loading_model | inferencing | postprocessing | completed | failed | cancelled",
  "progress": 0.0,
  "message": "Loading SoulX-Singer checkpoint",
  "error": null
}
```

### 11.3 Pseudocode

```python
def render_svs(job: SoulXSvsRequest) -> RenderResult:
    paths = resolve_library_assets(job)

    assert_model_ready("soulx_singer")
    assert_soulx_metadata(paths.prompt_metadata)
    assert_soulx_metadata(paths.target_metadata)

    local_region = make_region_relative_metadata(
        metadata=paths.target_metadata,
        project_start_sec=job.timeline_start_sec,
    )

    result = soulx_worker.run_svs(
        prompt_wav=paths.prompt_wav,
        prompt_metadata=paths.prompt_metadata,
        target_metadata=local_region,
        control=job.control,
        auto_shift=job.auto_shift,
        pitch_shift=job.pitch_shift,
        fp16=job.use_fp16,
    )

    raw_asset = library.import_asset(
        result.generated_wav,
        kind="vocal_soulx_raw",
        parent_ids=[job.prompt_entry_id, job.target_metadata_entry_id],
    )

    timeline_asset = resample_and_align_for_thedaw(
        raw_asset,
        target_sample_rate=44100,
        clip_start_sec=job.timeline_start_sec,
    )

    library.add_lineage(raw_asset, timeline_asset)
    edit.insert_clip(
        asset_id=timeline_asset.id,
        track_name=job.edit_track_name,
        start_sec=job.timeline_start_sec,
    )

    return timeline_asset
```

---

## 12. UI/UX acceptance criteria

### SVS mode

1. User selects a singer reference from Library.
2. User selects or creates a target metadata asset.
3. User selects `Score (MIDI)` or `Melody (F0)`.
4. User sees an editable timing/note/lyric review state.
5. User selects a project timeline range.
6. User clicks render.
7. Job shows actual preparation/model/render progress.
8. Completed output is:
   - saved as raw SoulX output,
   - resampled/aligned as a child asset,
   - inserted onto the intended EDIT track,
   - independently auditionable against the instrumental.

### SVC mode

1. User chooses reference singer and target singing performance.
2. System prepares/reuses F0 artifacts.
3. User selects range and render settings.
4. Result is imported as a distinct child stem.
5. Original target remains untouched and independently available.

---

## 13. Test plan

| Test | Expected result |
|---|---|
| SVS: existing target metadata + score control | `--control score` is actually passed; output has no accidental melody-mode default |
| SVS: melody control | `--control melody` is explicitly passed |
| SVS: missing prompt metadata | job blocks with actionable requirement; no inference starts |
| SVS: target metadata uses project-global times | adapter converts to region-relative times before inference |
| SVS: 24 kHz output | raw result preserved; timeline child is 44.1 kHz |
| SVC: target audio with no F0 | prepare job creates/reuses target F0 before render |
| SVC: user submits lyrics | UI does not imply lyrics change SVC output |
| Prepared metadata has bad note/lyric alignment | review/edit step is visible before final render |
| Worker is unavailable | backend remains alive; model state shows error/offline |
| Rerender | creates a new Library child and lineage edge; does not overwrite prior output |
| Insert into EDIT | result begins at exact intended project timeline start |
| Model output begins with artificial silence | raw output kept; optional aligned child records measured adjustment |

---

## 14. Explicit non-goals for this SoulX implementation

Do not build these during the SoulX-only pass:

```text
- a generic lyrics-to-rap planner
- broad instrumental-aware vocal composition logic
- unrelated singing engines
- generic TTS
- another voice-conversion provider
- autonomous lyric writing
- a second DAW UI
- user-facing model shell scripting
- permanent model loading at app startup
- destructive replacement of source vocals
```

SoulX integration ends at:
```text
Prepared SoulX-compatible target metadata
→ SVS or SVC render
→ Library artifact
→ exact EDIT timeline insertion
```

A broader performance-planning layer can be added later, but it is not part of this guide.

---

## 15. Build order

### Phase 1 — worker and model readiness
- Add `soulx_singer` module.
- Add isolated environment/worker setup.
- Add Settings → Models status card.
- Add model download/path registration.
- Add health endpoint.

### Phase 2 — preprocessing and metadata artifacts
- Implement `POST /api/soulx/prepare`.
- Persist metadata JSON, F0 files, vocal/acc separation artifacts.
- Add Library lineage.
- Add metadata inspection endpoint.

### Phase 3 — SVS
- Implement SVS worker invocation.
- Explicitly pass `--control`.
- Add 24 kHz → 44.1 kHz postprocess.
- Add exact timeline placement.
- Add result artifacts and lineage.

### Phase 4 — SVC
- Implement F0 preparation/reuse.
- Implement SVC worker invocation.
- Add output import and timeline placement.
- Keep source performance immutable.

### Phase 5 — metadata editor bridge
- Implement metadata → MIDI export.
- Connect MIDI/Piano Roll editing.
- Implement MIDI → SoulX metadata import.
- Validate lyric/note alignment before SVS render.

---

## 16. Final implementation decision

Use SoulX in theDAW like this:

```text
SVS:
Singer reference + SoulX target metadata
→ SoulX-Singer
→ new singing stem
→ Library + EDIT timeline

SVC:
Singer reference + existing singing performance + F0
→ SoulX-Singer-SVC
→ converted singing stem
→ Library + EDIT timeline
```

theDAW owns:
```text
- project timeline
- Library assets
- source lineage
- job lifecycle
- model status UI
- input routing
- result import
- timeline placement
- post-render resampling/normalization
```

SoulX owns:
```text
- SVS waveform synthesis from its metadata contract
- SVC waveform synthesis from audio + F0 inputs
- its preprocessing metadata generation
```
