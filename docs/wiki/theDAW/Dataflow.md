# Dataflow

One map of every input, engine, process, and output in theDAW, and how they feed each other. The library is the hub: nearly everything writes to it, and most processes read from it. Colors group nodes by role (inputs blue, generation purple, processing teal, live rig magenta, outputs green).

```mermaid
flowchart TD
  subgraph INPUTS["Inputs"]
    direction LR
    PROMPT["Text prompt"]:::in
    VOICE["Mic / voice"]:::in
    FILE["Imported file"]:::in
    URL["URL import"]:::in
    PAT["Piano roll / sequencer"]:::in
    CAMIN["Cameras / Quest"]:::in
    CTRL["MIDI / pose / XR"]:::in
  end
  subgraph ENGINES["Generation"]
    direction LR
    SA["Stable Audio 3"]:::eng
    MRT["Magenta RT2"]:::eng
    SUNO["Suno cloud"]:::eng
    CHIM["Chimera fusion"]:::eng
  end
  subgraph PROCESS["Processing"]
    direction LR
    EDIT["EDIT timeline"]:::proc
    MIX["MIX / Edit Tool Stack"]:::proc
    STEMS["Stem separation"]:::proc
    NOTE["Audio to MIDI / notation"]:::proc
    ANALYZE["Analysis: key, tempo, loudness"]:::proc
  end
  subgraph RIG["Live rig"]
    direction LR
    DJ["DJ console"]:::live
    VJ["VJ-9000 visuals"]:::live
    SLIDE["SLIDE surface"]:::live
  end
  subgraph OUTPUTS["Outputs"]
    direction LR
    LIB["Library + lineage"]:::out
    SCORE["Score / tabs / PDF"]:::out
    EXPORT["Export / convert"]:::out
    REC["VJ recording / watch-link"]:::out
  end
  PROMPT --> SA & MRT & SUNO
  PAT --> SA & NOTE
  VOICE --> SA & STEMS
  FILE --> SA & STEMS & MIX & CHIM
  URL --> LIB
  CAMIN --> VJ
  CTRL --> DJ & VJ & SLIDE
  LIB --> CHIM
  CHIM --> SA
  SA & MRT & SUNO --> LIB
  LIB --> EDIT & MIX & STEMS & NOTE & ANALYZE & DJ & VJ
  EDIT --> LIB
  MIX --> LIB & EXPORT
  STEMS --> LIB & DJ
  NOTE --> SCORE & LIB
  ANALYZE --> SCORE & DJ
  DJ --> VJ & REC
  VJ --> REC
  SLIDE <--> VJ
  EXPORT --> LIB
  classDef in fill:#0f3d57,stroke:#3aa0db,color:#eaf6ff;
  classDef eng fill:#3a2356,stroke:#a877e0,color:#f3ecff;
  classDef proc fill:#0e3b3b,stroke:#2bb3a3,color:#e6fffb;
  classDef live fill:#4a1530,stroke:#e85a8a,color:#ffe9f1;
  classDef out fill:#13402a,stroke:#46c47a,color:#e7ffee;
```

The same flow in words: prompts, voice, files, patterns, and URLs feed the generation engines and the library; the library feeds editing, mixing, stems, notation, analysis, and the live rig; those processes write back to the library or out to scores, exports, and recordings; and MIDI, pose, and XR control runs the live rig. See [Architecture](Architecture) for the subsystem-level charts and [Workspaces](Workspaces) for what each stage does.

---

<p align="center"><a href="Architecture">&lt; Previous: Architecture</a> &nbsp; | &nbsp; <a href="Workspaces">Next: Workspaces &gt;</a></p>
