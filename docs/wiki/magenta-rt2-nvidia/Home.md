# magenta-rt2-nvidia Wiki

magenta-rt2-nvidia is an NVIDIA/CUDA port of Magenta RealTime 2 by [GANTASMO](https://gantasmo.com): a one-click local studio that runs `mrt2_small` on a WSL2 GPU through JAX and serves a browser UI for prompt-to-audio generation at 48 kHz stereo, roughly 2x real-time. It is the first non-Mac port of MRT2, and it powers the Generate real-time engine inside [theDAW](https://github.com/gantasmo/theDAW), where it is vendored at `sidecars/magenta-rt2-nvidia`.

## Quickstart

1. Download the latest release ZIP (`MRT2-Studio.zip`) from the [releases page](https://github.com/gantasmo/magenta-rt2-nvidia/releases/latest).
2. Unzip it anywhere.
3. Double-click `Setup-MRT2.bat`. It checks the PC, states what it needs and how large the downloads are, asks before downloading anything, and fixes common problems.
4. The Studio opens in the browser. After the first run, double-click `MRT2-Studio.bat`.

## Features

- Generate from a text prompt up to 3 minutes, with temperature, top-k, style strength, and melody strength.
- Extend and morph: continue the current piece seamlessly, or change the prompt first to morph into a new vibe without a hard cut.
- Drums with Auto, On, or Off and a separate drum-strength control.
- A live visualizer in Bars, Wave, or Radial.
- Player tools: master volume, loop, per-track download, and a history kept across reloads.

## Requirements

- Windows 10 or 11 with an NVIDIA GPU (the installer enables WSL2 if needed), or a Linux host with an NVIDIA GPU.
- About 6 GB of free disk space and an internet connection for first-time setup.
- The `mrt2_small` model runs locally; the larger `mrt2_base` model runs on a RunPod cloud GPU.

## Cloning

The upstream engine source is a git submodule at `port_src/`. The app does not require it. To get the engine source, clone with `git clone --recurse-submodules https://github.com/gantasmo/magenta-rt2-nvidia`. See the [README](https://github.com/gantasmo/magenta-rt2-nvidia/blob/main/README.md) and [INSTALL.md](https://github.com/gantasmo/magenta-rt2-nvidia/blob/main/INSTALL.md).
