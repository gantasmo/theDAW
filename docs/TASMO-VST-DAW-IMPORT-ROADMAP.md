# .tasmo Format · VST Plugin Hosting · DAW Project Import — Technical Roadmap

> **Status:** Planning (as of June 2026) | **Authors:** GANTASMO engineering | **Codebase:** theDAW (stable-audio-3)

---

## 1. Current Codebase Inventory

### 1.1 Backend Stack
| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Runtime | Python | 3.10+ | Pinned in pyproject.toml |
| API | FastAPI | 0.135.1+ | All modules expose `APIRouter` |
| ML Engine | PyTorch / torchaudio | 2.7.1 + CUDA 12.8 | Lazy-loaded |
| Audio I/O | soundfile, librosa, FFmpeg | — | WAV/FLAC/MP3/M4A/OGG |
| DSP | scipy, pyloudnorm, aubio | — | Linear-phase FIR, LUFS, onset |
| MIDI | basic-pitch | 0.4.0+ | Audio-to-MIDI transcription |
| Tags | mutagen | 1.47+ | Detects ableton/logic pro/reaper signatures |
| Sidecars | Magenta RT2, Whisper | — | Subprocess-managed |

### 1.2 Module System
Backend uses a **plugin-style module system** (`backend/modules/loader.py`): each module has `module.json` + `router.py`, auto-mounted by the loader. **24+ modules** currently loaded. **VST and DAW import become new modules — zero architectural surgery.**

### 1.3 Frontend Stack
React 19, Vite 7, Zustand 5, Tailwind 4, wavesurfer.js 7, SpessaSynth (MIDI), alphaTab/OSMD (notation)

### 1.4 Effects System (Existing)
`backend/modules/effects/` processes audio via FFmpeg filter chains with param validation. Frontend has `effectChainStore.ts` + `effectCatalog.ts` + `drawEffectChainStore.ts`. **VST plugins slot in as a new effect type.**

### 1.5 What Does NOT Exist
| Gap | Detail |
|-----|--------|
| No VST host | No VST2/VST3 scanning, loading, or processing |
| No DAW project parser | No .als, .RPP, .logicx parsing |
| No project save/load | No custom project file format; sessions are ephemeral |
| No binary serialization | No msgpack/protobuf usage |

---

## 2. VST Plugin Integration

### 2.1 Primary: `pedalboard` 0.9.23 (Spotify, May 15 2026)

Full VST3 instrument + effect hosting via `pedalboard.load_plugin()`. Python 3.10-3.14, Windows/macOS/Linux, GPL-3.0, JUCE-based, thread-safe (releases GIL), live `AudioStream`, 15+ built-in effects.

```python
import pedalboard
plugin = pedalboard.load_plugin("/path/to/Serum.vst3")
plugin.parameters["Filter Cutoff"] = 0.5
processed = plugin(audio_array, sample_rate)
board = pedalboard.Pedalboard([pedalboard.Reverb(room_size=0.8), pedalboard.load_plugin("...")])
output = board(audio, 48000)
```

### 2.2 Alternative: `minihost` 0.1.7 (May 16 2026)
Headless JUCE host with VST3+AU+LV2, MIDI, automation, .vstpreset I/O, C+C++ API. **Start with pedalboard; upgrade to minihost if LV2 or MIDI-through-VST becomes critical.**

### 2.3 VST2: Not supported. Steinberg deprecated SDK in 2018. VST3 only.

### 2.4 Backend Module: `backend/modules/vst/`

```
backend/modules/vst/
  module.json        # {"name":"vst","api_prefix":"/api/vst"}
  router.py          # FastAPI endpoints
  scanner.py         # VST3 filesystem discovery
  host.py            # pedalboard session manager
  chain.py           # Plugin chain builder
  preset_manager.py  # .vstpreset I/O
  schemas.py         # Pydantic models
```

**API Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/vst/scan | Scan standard VST3 dirs |
| GET | /api/vst/scan/{path} | Scan custom dir |
| POST | /api/vst/load | Load VST3; return param descriptors |
| GET | /api/vst/plugins | List loaded instances |
| POST | /api/vst/process | Run audio through plugin/chain |
| PUT | /api/vst/param/{id} | Set parameter |
| GET | /api/vst/param/{id} | Read parameters |
| POST | /api/vst/preset/save | Save .vstpreset |
| POST | /api/vst/preset/load | Load .vstpreset |
| DELETE | /api/vst/unload/{id} | Unload instance |
| GET | /api/vst/builtin | List pedalboard built-ins |

**VST3 Scan Paths:** Win: `C:\Program Files\Common Files\VST3\`, Mac: `/Library/Audio/Plug-Ins/VST3/`, Linux: `/usr/lib/vst3/`

### 2.5 Frontend
New: `vstStore.ts`, `VstScanner.tsx`, `VstPluginCard.tsx`, `VstChainView.tsx` under `frontend/src/components/audio/vst/`

### 2.6 Effects Chain Integration
Add `"vst3"` node type to `effectChainStore` / `drawEffectChainStore`. Backend `/api/studio/process` gets optional `vst_chain` slot. Pipeline: `Source -> FFmpeg Chain -> VST Chain (pedalboard) -> Output`

---

## 3. DAW Project Import

### 3.1 Format Overview
| DAW | Extension | Format | Parseable? | Python Libs |
|-----|-----------|--------|------------|-------------|
| Ableton Live | .als | Gzip-compressed XML | Yes | Custom parser (stdlib gzip + ElementTree) |
| Reaper | .RPP | Plain text chunk-structured | Yes | `reaproj` (pip), `rppxml` (C++), `rpp` (PLY, 79 stars) |
| Logic Pro X | .logicx | macOS package + proprietary binary | Partial | None exist anywhere |

### 3.2 Ableton Live (.als) Import
.als files are **gzip-compressed XML**. `gzip -d Project.als` produces 5-50MB XML.

Key XML: `<LiveSet>` root, `<Tracks>` with `<AudioTrack>/<MidiTrack>`, `<ClipSlot>` with `<AudioClip>/<MidiClip>`, `<Devices>` with VST/AU plugin chains + param snapshots, `<SampleRef>/<FileRef>` audio paths, `<WarpMarkers>`, `<Tempo>`, `<Locator>`.

**No external library needed — Python stdlib suffices:**
```python
import gzip, xml.etree.ElementTree as ET
def parse_als(path):
    with gzip.open(path, "rb") as f:
        tree = ET.parse(f)
    return extract_live_set(tree.getroot().find("LiveSet"))
```

**Extract:** tracks/clips/warp markers/tempo/locators/MIDI/VST names+params. **Skip:** routing matrix, Ableton built-in device state, Max for Live, automation envelopes (v2).

### 3.3 Reaper (.RPP) Import
Plain text with `<>` bracket nesting. **Recommended: `reaproj`** (pip, MIT, verified against REAPER 7):
```python
from reaproj import Project
project = Project.load("Session.RPP")
for track in project.tracks:
    for item in track.items:
        print(item.position, item.length, item.source_path)
```

### 3.4 Logic Pro X (.logicx) Import
macOS package directory. `DocumentInfo.plist` (parseable via `plistlib`), `Media/Audio Files/` (copyable), `Freeze Files/` (copyable). **BUT:** `ProjectData` is proprietary binary with NO parser anywhere. **Strategy:** Parse metadata + copy audio files. For full arrangement, tell users to Export All Tracks as Audio Files from Logic first.

### 3.5 Backend Module: `backend/modules/dawimport/`
```
backend/modules/dawimport/
  module.json, router.py, ableton.py, reaper.py, logic.py, mapping.py, audio_resolver.py, schemas.py
```
API: POST /api/dawimport/detect, /ableton, /reaper, /logic | GET /status/{job_id} | POST /resolve-audio

### 3.6 DAW-Agnostic Model
All parsers produce `DawProject` (source_daw, name, tempo, time_sig, tracks[DawTrack], locators, plugins_used, warnings, missing_files). `DawTrack` has clips[DawClip] and devices[DawDevice]. `DawClip` has start/end, file_path, midi_notes, warp_markers. `DawDevice` has name, plugin_type, plugin_path, parameters.

---

## 4. The .tasmo Proprietary Project Format

### 4.1 Design Goals
1. Capture full project state (audio refs, gen params, effect chains, VST states, timeline, MIDI)
2. Fast read/write (100+ clips in <500ms)
3. Forward/backward compatible (future theDAW reads old .tasmo; old theDAW gracefully degrades)
4. Human-inspectable metadata (readable without special tools)
5. Optional audio embedding (portability) or external linking (small files)
6. Diff-friendly for version control

### 4.2 Architecture: Hybrid MsgPack + ZIP

```
.tasmo File (ZIP container):
  manifest.json          -- Version, format ID, checksums (human-readable)
  project.msgpack        -- Binary-serialized project model
  audio/                 -- Embedded audio files (optional)
    001_kick.wav
    002_snare.flac
  vst_presets/           -- .vstpreset files for VST states
  thumbnails/            -- Waveform thumbnails for quick preview
```

### 4.3 Why This Architecture
| Choice | Rationale |
|--------|-----------|
| ZIP container | Universal (Office, JAR, APK, Ableton .alp all use ZIP). Python `zipfile` stdlib. Random access to embedded audio. |
| MsgPack for project data | Binary, 3-5x smaller than JSON, 10-20x faster deserialize. `msgpack` 1.2.1 (June 2026) supports Python 3.10-3.14 with C extensions. |
| manifest.json (not msgpack) | Human-readable entry point. `unzip -p *.tasmo manifest.json` works anywhere. |
| Audio as separate files in ZIP | Each stays in original format (WAV/FLAC/MP3). No repacking needed. |

### 4.4 manifest.json
```json
{
  "format": "tasmo", "format_version": 1, "thedaw_version": "0.1.0",
  "project_name": "My Track", "created_at": "2026-06-27T22:00:00Z",
  "audio_mode": "embedded", "total_tracks": 8, "sample_rate": 48000,
  "checksums": {"project.msgpack": "sha256:abc123..."}
}
```

### 4.5 TasmoProject Pydantic Model (project.msgpack)
```python
class VstPluginState(BaseModel):
    plugin_path: str; plugin_name: str; parameters: dict[str, float]
    preset_path: str | None; instance_id: str

class EffectChainNode(BaseModel):
    node_type: str  # "ffmpeg" | "vst3" | "builtin"
    effect_name: str; parameters: dict[str, float]; bypass: bool = False
    vst_state: VstPluginState | None = None

class Clip(BaseModel):
    id: str; name: str; clip_type: str  # "audio"|"midi"|"generated"
    track_id: str; start_time: float; end_time: float
    loop_start: float | None; loop_end: float | None
    audio_file: str | None; sample_rate: int = 48000; channels: int = 2
    midi_notes: list[dict] | None; midi_file: str | None
    generation_prompt: str | None; generation_seed: int | None; generation_params: dict | None
    warp_markers: list[dict] | None; effect_chain: list[EffectChainNode] = []

class Track(BaseModel):
    id: str; name: str; type: str; color: str | None
    volume_db: float = 0.0; pan: float = 0.0; mute: bool = False; solo: bool = False
    clips: list[Clip] = []; effect_chain: list[EffectChainNode] = []
    send_amounts: dict[str, float] = {}

class TasmoProject(BaseModel):
    format_version: int = 1; project_name: str = "Untitled"
    created_at: datetime; modified_at: datetime; author: str = ""
    tempo: float = 120.0; time_signature: tuple[int, int] = (4, 4); sample_rate: int = 48000
    tracks: list[Track] = []; locators: list[Locator] = []; automation: list[AutomationLane] = []
    generation_history: list[dict] = []
    source_daw: str | None; source_daw_version: str | None; import_warnings: list[str] = []
```

### 4.6 Read/Write
```python
class TasmoFile:
    @staticmethod
    def save(project: TasmoProject, path: str, audio_files: dict[str, bytes] | None = None):
        project_bytes = msgpack.packb(project.model_dump(), use_bin_type=True)
        manifest = {"format": "tasmo", "format_version": 1, ...}
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))
            zf.writestr("project.msgpack", project_bytes)
            if audio_files:
                for name, data in audio_files.items():
                    zf.writestr(f"audio/{name}", data)

    @staticmethod
    def load(path: str) -> tuple[TasmoProject, dict]:
        with zipfile.ZipFile(path, "r") as zf:
            manifest = json.loads(zf.read("manifest.json"))
            project = TasmoProject.model_validate(msgpack.unpackb(zf.read("project.msgpack"), raw=False))
            return project, manifest
```

### 4.7 Audio Embedding Modes
| Mode | When | Trade-off |
|------|------|-----------|
| Embedded | Sharing, backup, archive | Large (100MB+) but self-contained |
| Linked | Everyday work, same machine | Small (<1MB) but breaks if audio moves |
| Mixed | Default (clips <30s embedded, longer linked) | Best balance |

### 4.8 Version Compatibility
- Same version -> load normally
- Older version -> apply migration transforms in order (v1->v2->v3)
- Newer version -> refuse with clear error + download link
- Every field has a default value so older data naturally fills in

### 4.9 Backend Module: `backend/modules/project/`
```
backend/modules/project/
  module.json, router.py, tasmo_file.py, tasmo_project.py, migration.py, audio_embed.py, schemas.py
```
API: POST /api/project/save, /load, /save-as | GET /info, /recent | POST /export/audio | GET /preview/{clip_id}

### 4.10 Magic Number
ZIP archive comment set to `TASMOv1` for `file` command identification:
```bash
$ file my_track.tasmo
my_track.tasmo: Zip archive data, comment: TASMOv1
```

---

## 5. Dependency Additions Summary

### Python (Backend)
| Package | Version | Purpose | Install |
|---------|---------|---------|---------|
| `pedalboard` | 0.9.23 | VST3 hosting + built-in effects | `pip install pedalboard` |
| `reaproj` | 0.1.0+ | Reaper .RPP parsing | `pip install reaproj` |
| `msgpack` | 1.2.1 | Binary serialization for .tasmo | `pip install msgpack` |
| `pydantic` | 2.13.4 | Data validation | Already present (FastAPI dep) |

**No new deps for Ableton .als** — stdlib `gzip` + `xml.etree.ElementTree`.
**No new deps for Logic .logicx** — stdlib `plistlib` handles parseable metadata.
**No new NPM packages** — existing React 19 / Zustand 5 / Vite 7 handles all UI.

---

## 6. Architecture Diagram

```
                              theDAW Application
 +-------------------------------------------------------------------+
 |  FastAPI Backend :8600                                            |
 |   /api/vst       /api/dawimport    /api/project    /api/studio   |
 |   (scan/load/    (ableton/reaper/  (save/load/     (effects/     |
 |    process/       logic/resolve)    info/preview)   export)      |
 |        |               |               |              |           |
 |   +----+---------------+---------------+--------------+------+   |
 |   |              Audio Processing Pipeline                   |   |
 |   |  Source -> FFmpeg Chain -> VST Chain (pedalboard) -> Out |   |
 |   +---------------------------------------------------------+   |
 |   |              .tasmo File I/O                              |   |
 |   |  TasmoProject (Pydantic) --msgpack--> ZIP/.tasmo         |   |
 |   |  TasmoProject (Pydantic) <--msgpack-- ZIP/.tasmo         |   |
 |   +---------------------------------------------------------+   |
 |                                                                   |
 |  React 19 + Vite 7 Frontend                                     |
 |   VST Panel       DAW Import       Project Save/Open            |
 |   (Scanner/       (.als/.RPP/      (.tasmo                     |
 |    PluginCard/     .logicx ->)      save/load/recent)          |
 |    ChainView/                                                   |
 |    PresetMgr)                                                   |
 +-------------------------------------------------------------------+
```

---

## 7. Implementation Phases

| Phase | Scope | Timeline | Key Deliverables |
|-------|-------|----------|-----------------|
| **1** | .tasmo format | Week 1-2 | TasmoProject model, TasmoFile save/load, projectStore.ts, Save/Open dialogs |
| **2** | VST hosting | Week 2-4 | pedalboard integration, /api/vst/* endpoints, vstStore.ts, VstScanner/PluginCard/ChainView |
| **3** | Ableton import | Week 3-5 | ableton.py parser, DawProject mapping, import wizard, audio resolution |
| **4** | Reaper import | Week 4-5 | reaproj integration, reaper.py parser, DawProject mapping |
| **5** | Logic import | Week 5-6 | logic.py package reader, media+metadata extraction, export-hint for users |
| **6** | VST+DAW integration | Week 6-7 | VST matching on DAW import, .tasmo VST state save/restore, placeholder for missing VSTs |
| **7** | Polish | Week 7-8 | Large project stress test, .tasmo size optimization, undo/redo, file association, drag-drop |

---

## 8. Risk & Compatibility Matrix

| Risk | Severity | Mitigation |
|------|----------|------------|
| pedalboard GPL-3.0 | Medium | theDAW is open-source; GPL is compatible. |
| VST3 plugin crashes | Medium | Run in thread with timeout. pedalboard/JUCE has safety wrappers. Add watchdog. |
| 32-bit VST3 on 64-bit Python | Low | Detect at scan, filter out. |
| Ableton XML schema changes between versions | Medium | Defensive parsing with .find() + fallbacks. Log warnings for unknown elements. Test against Live 10/11/12. |
| Logic Pro ProjectData unreadable | High | Clearly document limitation. Provide "Export All Tracks" workflow. |
| Large .tasmo files (5GB+ with embedded audio) | Medium | Default to "mixed" embedding. Add "Consolidate" feature. Soft warn at 500MB. |
| Audio path portability (linked mode) | Medium | Store absolute + relative paths. On load: try absolute, then relative, then prompt user. |
| reaproj maturity (new, 0 stars) | Low | Verified against REAPER 7. Fallback: use `rpp` (79 stars, pure Python). |

---

## 9. Open Questions

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | VST processing: in-process or out-of-process? | **In-process** (per user decision) |
| 2 | .tasmo audio: original format or normalize to FLAC? | **Original format** (per user decision) |
| 3 | DAW import: write-back to DAW formats? | **Write-back if possible** (per user decision — v2, after read import works) |
| 4 | MIDI clips from DAW imports: render to audio or store as MIDI? | **Store as MIDI** in .tasmo; render on demand (per user decision) |
| 5 | .tasmo embedded audio size limit? | **Soft warn at 500MB** (per user decision) |

---

## 10. Extended DAW Compatibility (June 2026)

> Audition, Audacity, FL Studio, Cubase, Bitwig, Resolume, Pro Tools

### 10.1 Master Compatibility Matrix

| DAW | Extension | Internal Format | Parseable? | Python Lib | Priority |
|-----|-----------|----------------|------------|------------|----------|
| **FL Studio** | `.flp` | Proprietary binary (NEM) | ✅ Yes | **py-flp** (200★, pip) | **P0** |
| **Audacity** | `.aup3` | SQLite + custom binary XML | ✅ Yes | **py-aup3** (MIT, pip) | **P0** |
| **Adobe Audition** | `.sesx` | Plain XML + media folder | �B Yes | stdlib only | **P1** |
| **Bitwig Studio** | `.bwproject` | Gzip-compressed XML | ✅ Yes | stdlib only | **P1** |
| **Resolume Arena** | `.avc` | JSON | ✅ Yes | stdlib only | **P1** |
| **Cubase/Nuendo** | `.cpr` | Proprietary binary (Steinberg) | ❌ No | None | **P3 export-only** |
| **Pro Tools** | `.ptx` | Proprietary binary (Avid) | ❌ No | None | **P3 export-only** |

### 10.2 FL Studio (.flp) — P0

NEM binary format. **py-flp** (demberto, 200★, pip): full parser+serializer, channels/patterns/arrangement/mixer/plugins/automation, Python 3.10+. **New dep: `py-flp>=1.0.0`**. Write-back supported!

### 10.3 Audacity (.aup3) — P0

SQLite DB + custom binary XML. **py-aup3** (mildsunrise, MIT, pip): pure Python, reads binary XML + sample data, numpy dep. **New dep: `py-aup3>=0.1.0`**.

### 10.4 Adobe Audition (.sesx) — P1

**Plain XML** (uncompressed). `<sesx>` root with `<session>/<tracks>/<audioTrack>/<fileList>/<markers>`. **No new dep** — stdlib ElementTree.

### 10.5 Bitwig Studio (.bwproject) — P1

**Gzip-compressed XML** (same concept as .als). Bitwig's XML is actually cleaner/more consistent than Ableton's. **No new dep** — same gzip+ET pattern.

### 10.6 Resolume Arena (.avc) — P1

**JSON** — entire composition as JSON (decks, clips, layers, effects, audio sources, BPM). **No new dep** — `json.loads()`. We extract audio clips + BPM + VST3 effect chains only.

### 10.7 Cubase (.cpr) — P3 Export-Only

Steinberg proprietary binary. No spec, no parser. **Strategy:** Export All Tracks as Audio from Cubase, import into theDAW.

### 10.8 Pro Tools (.ptx) — P3 Export-Only

Avid proprietary binary. Even more locked down. **Strategy:** Export → All Tracks as Audio, import into theDAW.

### 10.9 Additional Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `py-flp` | >=1.0.0 | FL Studio .flp parsing + write-back |
| `py-aup3` | >=0.1.0 | Audacity .aup3 parsing (SQLite + binary XML) |

No new deps for Audition (.sesx XML), Bitwig (.bwproject gzip+XML), Resolume (.avc JSON) — all stdlib.
