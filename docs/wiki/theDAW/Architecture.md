# Architecture

theDAW is a React frontend over a FastAPI backend that wraps the Stable Audio 3 pipeline, a plugin module system, and a set of spawned sidecars. The frontend on port 5173 proxies `/api/*` to the backend on port 8600.

## System

```mermaid
flowchart TD
  UI["theDAW UI<br/>MAKE EDIT MIX DJ VJ TRAIN LEARN"]:::in
  API["FastAPI backend :8600<br/>job queue, FFmpeg, introspection"]:::proc
  SA3["Stable Audio 3<br/>DiT + SAME AE"]:::eng
  MODS["Plugin modules"]:::proc
  MRT2["magenta-rt2-nvidia<br/>WSL2 + JAX"]:::side
  VJ["VJ-9000<br/>WebGL engine"]:::side
  XR["theDAW-XR<br/>Quest 3"]:::side
  UI -->|/api/*| API
  API --> SA3
  API --> MODS
  MODS -. spawn .-> MRT2
  MODS -. iframe .-> VJ
  XR <-->|ADB, MIDI, video| MODS
  classDef in fill:#0f3d57,stroke:#3aa0db,color:#eaf6ff;
  classDef eng fill:#3a2356,stroke:#a877e0,color:#f3ecff;
  classDef proc fill:#0e3b3b,stroke:#2bb3a3,color:#e6fffb;
  classDef side fill:#4a3115,stroke:#e09a3a,color:#fff4e3;
```

## Generation

Several inputs condition one generation. The DiT renders SAME latents, the autoencoder decodes them, every render saves to the library, and LEARN draws the lineage.

```mermaid
flowchart TD
  P["Text prompt"]:::in
  INIT["Init audio<br/>voice, file, library, pattern"]:::in
  MASK["Inpaint region"]:::in
  CHI["Chimera fusion"]:::in
  P --> GEN
  INIT --> GEN
  MASK --> GEN
  CHI --> GEN
  GEN["DiT transformer"]:::eng --> LAT["SAME latents"]:::eng
  LAT --> DEC["SAME decode"]:::eng
  DEC --> WAV["44.1 kHz stereo"]:::out
  WAV --> LIB["Library"]:::out
  LIB --> LRN["LEARN lineage"]:::out
  classDef in fill:#0f3d57,stroke:#3aa0db,color:#eaf6ff;
  classDef eng fill:#3a2356,stroke:#a877e0,color:#f3ecff;
  classDef out fill:#13402a,stroke:#46c47a,color:#e7ffee;
```

## Routing

Player audio, a microphone, MIDI, and the SLIDE surface drive the VJ engine and the DJ console, and theDAW-XR feeds hand-tracked MIDI and passthrough video into the same buses.

```mermaid
flowchart TD
  DJ["DJ console<br/>2 decks, FX, stems"]:::live
  MIC["Microphone"]:::in
  MIDI["MIDI<br/>~110 profiles, learn"]:::in
  SLIDE["SLIDE surface"]:::in
  XR["theDAW-XR<br/>hand MIDI, passthrough"]:::side
  DJ --> AUD["Player audio ~30 fps"]:::proc
  AUD --> VJ
  MIC --> VJ
  MIDI --> VJ
  MIDI --> DJ
  SLIDE <-->|sync| VJ
  XR --> MIDI
  XR -->|video| VJ
  VJ["VJ-9000<br/>sources, FX, shaders"]:::live --> OUT["Live output"]:::out
  VJ -->|watch-link| WEB["Remote viewers"]:::out
  classDef in fill:#0f3d57,stroke:#3aa0db,color:#eaf6ff;
  classDef proc fill:#0e3b3b,stroke:#2bb3a3,color:#e6fffb;
  classDef live fill:#4a1530,stroke:#e85a8a,color:#ffe9f1;
  classDef out fill:#13402a,stroke:#46c47a,color:#e7ffee;
  classDef side fill:#4a3115,stroke:#e09a3a,color:#fff4e3;
```

## Inference

The pipeline runs in two stages. The DiT generates compressed SAME latents from the conditioning, and the same autoencoder decodes them to 44.1 kHz stereo. Duration is set directly, so a request produces exactly the requested length with no wasted padding. See [Models](Models) and the [model overview](https://github.com/gantasmo/theDAW/blob/main/docs/guides/model-overview.md).

## Reference

- [Dataflow](Dataflow) maps every input, process, and output in one chart.
- [Modules and Sidecars](Modules-and-Sidecars) lists the plugin modules and spawned processes.
- [User Guide §2](https://github.com/gantasmo/theDAW/blob/main/docs/USER_GUIDE.md#2-architecture) holds the full technical description.

---

<p align="center"><a href="Getting-Started">&lt; Previous: Getting Started</a> &nbsp; | &nbsp; <a href="Dataflow">Next: Dataflow &gt;</a></p>
