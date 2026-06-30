# Models

| Key | Flavor | Params | Autoencoder | Hardware | Max Duration |
|---|---|---|---|---|---|
| `small` | ARC | 433 M | SAME-S | CPU | 120 s |
| `medium` | ARC | 1.4 B | SAME-L | GPU (CUDA) | 380 s |
| `small-rf` / `medium-rf` | RF | 433 M / 1.4 B | SAME-S / SAME-L | CPU / GPU | 120 / 380 s |
| `same-s` / `same-l` | Autoencoder | 266 M / 1.7 B | n/a | CPU / GPU | n/a |

ARC checkpoints are post-trained for 8-step inference at `cfg_scale=1`. RF checkpoints are rectified-flow bases for LoRA training at `cfg_scale=7` and roughly 50 steps. ARC and RF checkpoints bundle the autoencoder, and standalone SAME checkpoints reuse the cached full checkpoint when one is available.

## Loading

Nothing downloads at startup. Local-only mode is on by default: a model loads at the first CREATE that needs it, resolving local folders first, then the Hugging Face cache, with a one-time download only after explicit consent. The **Settings, then Models** panel shows every engine's readiness, registers any checkpoint already on disk through a native folder picker, and maps every model location with sizes and one-click open-in-Explorer.

## Placement

For which model, which files, the exact folder tree with download links, and where the T5Gemma text encoder lives, see [User Guide §21.2](https://github.com/gantasmo/theDAW/blob/main/docs/USER_GUIDE.md#212-manual-model-placement-download-links-and-folder-tree).

## Engines

The [magenta-rt2-nvidia](https://github.com/gantasmo/magenta-rt2-nvidia) sidecar adds Magenta RealTime 2 text-to-music, and Suno adds cloud generation. Both appear in the same Generate surface as the local engines. See [User Guide §27](https://github.com/gantasmo/theDAW/blob/main/docs/USER_GUIDE.md#27-magenta-realtime-2) and [§26](https://github.com/gantasmo/theDAW/blob/main/docs/USER_GUIDE.md#26-cloud-generation-suno).

---

<p align="center"><a href="Workspaces">&lt; Previous: Workspaces</a> &nbsp; | &nbsp; <a href="Modules-and-Sidecars">Next: Modules and Sidecars &gt;</a></p>
