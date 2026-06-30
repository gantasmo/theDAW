# theDAW-XR Wiki

theDAW-XR is the spatial companion app for [theDAW](https://github.com/gantasmo/theDAW) by [GANTASMO](https://gantasmo.com). It turns a Meta Quest 3 into a hands-only control and capture surface for the desktop workstation: hand-tracked MIDI, passthrough video streaming, co-located multiplayer, and reactive head-mounted visuals, all over ADB.

## Integrations

| Integration | Function |
|---|---|
| Hand-tracked control surface | Floating 3D faders, knobs, and buttons emit MIDI from hand tracking and microgestures. |
| Passthrough streaming | The headset view reaches VJ as a live video source over ADB. |
| Co-located multiplayer | A room-aligned spatial setup for networked multi-headset performance. |
| MIDI return circuit | A reactive MIDI Reactor responds to incoming messages from the desktop. |

## Modules

Each feature installs as an embedded Unity package through Window, then Package Manager, then Add package from git URL.

| Package | Contents |
|---|---|
| `com.gantasmo.questmidi` | Core MIDI send and return, and the Setup Wizard. |
| `com.gantasmo.midi-reactor` | The head-mounted reactive chrome. |
| `com.gantasmo.passthrough` | The passthrough stitch and H.264 streamer. |
| `com.gantasmo.colocation` | The shared spatial frame and presence. |

## Requirements

- Unity 6.x (targets 6000.4.x with URP 17.4.0) on Windows.
- Meta XR SDK `com.meta.xr.sdk.all` 203.0.0.
- Meta Quest 3 in Developer Mode with hand tracking enabled.
- adb for the USB or wireless tunnel.
- theDAW running with the `questmidi`, `questcast`, and `queststitch` modules.

## Quickstart

1. Open the project and load `Assets/Scenes/QuestMIDI.unity`.
2. Run GANTASMO, then MIDI Bridge, then Setup Wizard.
3. Enable theDAW's `questmidi` module.
4. Build and deploy to the Quest, or press Play to test MIDI on the desktop.
5. Select delinQuest or STITCH in the VJ source list.

The [README](https://github.com/gantasmo/theDAW-XR/blob/main/README.md) has the full install table and editor menu.
