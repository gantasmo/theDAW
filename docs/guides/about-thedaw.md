# About theDAW

This document gives the in-app assistant a concise, accurate overview of what
theDAW is and how its main areas fit together. It is a starting point and is
meant to grow as features land.

## What theDAW is

theDAW is a local music creation workstation built on the Stable Audio 3 model
family. It runs on the user's own machine, either as a desktop application or in
a browser, and pairs a React interface with a Python backend that performs both
generation and audio processing. A text prompt becomes finished 44.1 kHz stereo
audio.

## How generation works

Generation runs in two stages. A diffusion transformer turns a text prompt and a
target duration into compressed latents, and the SAME autoencoder decodes those
latents into stereo audio. Duration is set directly, so a request produces
exactly the requested length with no wasted padding.

## Models

theDAW ships small and medium model variants. The small model runs on CPU. The
medium model is faster and higher fidelity on an NVIDIA GPU. The model picker
switches between them and surfaces local checkpoints when they are present.

## Main areas

- MAKE creates new audio from a text prompt.
- MIX processes existing audio through the effects and mastering chain. MAKE and
  MIX are separate stages: MAKE produces material, MIX shapes material that
  already exists.
- The Library stores every generation together with its prompt, metadata,
  lineage, stems, and MIDI.
- LEARN presents the genealogy of a track as a lineage graph, showing how one
  result descends from another.
- SCORE renders notation and book-style sheet music for a track.
- DJ provides decks, key and tempo control, live stems, cueing, and an effects
  rack for performance.
- VJ drives live visuals that react to the audio.

## Where work is saved

Generations, settings, and the library live in the application's data directory
and persist between sessions. Exports are written on demand to the locations the
user chooses.
