# Getting Started

## Quickstart

Double-click `theDAW.bat`. It checks the machine, installs anything missing after one confirmation, and opens theDAW in the browser. The Stable Audio model downloads on its own the first time a track is generated.

```powershell
.\theDAW.bat
```

The launcher bootstraps dependencies when the tree is fresh (`uv sync --group dev`, `npm install`), clears stale processes on ports 5173, 8600, and 5187, then runs the backend, Vite, and an optional tunnel in one console.

## Manual

```bash
uv run uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload   # backend
cd frontend && npm run dev                                              # frontend
```

On Windows, `uv sync` installs CUDA 12.8 torch and torchaudio plus the pre-built Flash Attention wheel automatically.

## Prerequisites

`theDAW.bat` installs these the first time a tool is missing.

| Tool | Role |
|---|---|
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | Python environment and package manager. |
| [Node.js](https://nodejs.org/) 20.19+ or 22.12+ | Frontend dev server and the VJ sidecar. |
| [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) on PATH | All audio I/O: effects, exports, library ingest, MIDI conversion, import. |
| [Git](https://git-scm.com/) | Clones the repo; `--recurse-submodules` brings in the Magenta sidecar source. |
| NVIDIA driver 550+ | Runs the Medium model and Magenta. The Small model runs on CPU. |

## Reference

- [Windows setup guide](https://github.com/gantasmo/theDAW/blob/main/docs/windows/setup-guide.md) for CUDA, Flash Attention, and soundfile details.
- [User Guide §3](https://github.com/gantasmo/theDAW/blob/main/docs/USER_GUIDE.md#3-installation) for the full walkthrough.

---

<p align="center"><a href="Home">&lt; Previous: Home</a> &nbsp; | &nbsp; <a href="Architecture">Next: Architecture &gt;</a></p>
