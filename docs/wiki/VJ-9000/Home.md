# VJ-9000 Wiki

VJ-9000 is a browser-based, audio-reactive visual engine for live performance by [GANTASMO](https://gantasmo.com). It renders live cameras, video clips, generated sources, and still images through a real-time WebGL effects stack with MIDI-mappable controls. It runs standalone and serves as the live-visuals engine embedded in [theDAW](https://github.com/gantasmo/theDAW).

## Sources

One active source feeds the effect chain, and the LIVE/CLIP crossfader blends a live source against a loaded clip.

- **Cameras.** A local webcam or capture card, and a phone, tablet, or headset camera over the LAN through a URL and QR code.
- **Clips and stills.** Video clips and image backdrops by drag-and-drop or a file picker.
- **GLSL shader.** A Menger flythrough plus four distance-field fractals, each with editable audio-mappable params, a Hue control, and a global Material picker (Neon, Chrome, Matte, Glass, Gold, Iridescent, Velvet, Plasma).
- **Depth and generative.** Cymatics, an akvj depth point cloud, and a spectra source.
- **Quest passthrough.** A Quest 3 headset view through theDAW's `questcast` and `queststitch` bridges.
- **Source banks.** Snapshot the live source into a slot, or click an empty slot to place a clip, source, or local file at the click point, then recall it during a set.

## Effects

A composable GPU chain, every node MIDI-mappable, with a SOLO mode and an ASCII post pass. The chain covers color and optics, geometry, generative fields, depth, distortion and glitch, time, and post looks. The [README](https://github.com/gantasmo/VJ-9000/blob/main/README.md) lists every effect.

## Performance

Audio reactivity from the host player or a microphone, BPM sync, an auto-LFO, and Autopilot. Every control is MIDI-mappable, the host's SLIDE surface stays in two-way sync, and the Sway pose bus drives parameters from camera-tracked motion. Captures record to WebM and transcode through theDAW's backend, and a WebRTC watch-link streams the output to remote viewers.

## Integration

Inside theDAW's VJ tab, VJ-9000 runs in an iframe and talks to the host over `postMessage`. theDAW streams master-player audio levels at about 30 fps, forwards MIDI, and pushes metadata; SLIDE stays in two-way sync; imported clips upload to theDAW's library; and a LAN URL and QR code make the output reachable from another device. The [README](https://github.com/gantasmo/VJ-9000/blob/main/README.md) covers running locally.
