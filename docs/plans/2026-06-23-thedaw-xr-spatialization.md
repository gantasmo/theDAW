# theDAW to theDAW-XR Spatialization Plan

Date: 2026-06-23
Status: proposed map, pending review
Scope: spatialize theDAW's MAKE (Chimera), DJ (scratch), VJ (XY pads), and the
LEARN lineage graph into theDAW-XR's Quest hand-tracked 3D interface, driven from
data so the port stays low-maintenance.

Repos:
- theDAW (web app): `d:/StableAudio/JoshOG/stable-audio-3` (`frontend/src` is React/TS)
- theDAW-XR (Unity): `d:/Dev/Unity/GANTASMO-MIDI/GANTASMO-MIDI`
- OwlPad3D foundation: already taken into theDAW-XR at `Assets/OwlPad3D`

## 1. The core idea

theDAW already describes its controls in machine-readable registries and already
dispatches control changes by name. theDAW-XR already builds an entire spatial
control surface procedurally from a ScriptableObject config. The port connects
those two facts with a single unified control manifest carried over one
websocket. A control becomes a data row in a catalogue, and the XR scene
instantiates a spatial widget for it automatically. Adding a control in theDAW
surfaces it in XR with no Unity edit, no prefab, and no scene change.

MIDI stays the low-latency carrier for any scalar that already has a CC. The new
websocket carries the manifest itself plus the toggles, enums, and rich payloads
that a 7-bit or 14-bit CC cannot express.

## 2. What already exists (the four substrates)

| Substrate | Where | What it gives |
|---|---|---|
| DJ control manifest | `frontend/src/state/bindableTargets.ts` (`DJ_TARGETS`, line 35) | An array of `BindableTarget{id,label,group,kind,min,max,step,unit,invoke()}`. `invoke()` is a fully wired setter. This is the exact shape the manifest should take. |
| VJ two-way control channel | `frontend/src/state/sa3Bridge.ts` + `controlManifest.ts` | The VJ iframe answers `sa3-vj/request-controls` with `sa3-vj/controls-manifest{manifest,values}`, accepts `sa3-vj/control-set{key,value}`, and echoes `sa3-vj/control-changed`. Built procedurally from `MIDI_PARAMS` + `TOGGLE_CONTROLS`. |
| MAKE action dispatcher | `frontend/src/orb-kit/actionHandlers.ts` (`handletheDAWAction`, line 83) | String-keyed actions: `set_prompt/model/duration/steps/cfg/seed/sampler/shift/init_noise`, `apply_params` (bulk ~25-field patch), `generate/abort`, `get_status`. Every control reads the shared zustand store, so firing an action moves the React UI with zero per-control code. |
| XR transport | `frontend/src/state/questMidiClient.ts` to backend `/api/questmidi/ws` | A websocket that republishes inbound Quest MIDI onto the global `midiBus` and returns MIDI to the headset (the MIDI Reactor consumes the return path today). |

On the Unity side the procedural surface already exists in
`Packages/com.gantasmo.questmidi/`:
- `Runtime/QuestMidiSender.cs` sends 7-bit and 14-bit CC (`SendControlChange14`)
  and Note On/Off.
- `Runtime/ControlSurface/MidiControlSurface.cs` routes a surface's controls to
  the sender on a shared channel.
- `Runtime/ControlSurface/{MidiSlider,MidiKnob,MidiButton,MicrogestureMidiSource}.cs`
  are the primitive widgets and the hands-free gesture source (five discrete
  microgesture events).
- `Editor/GantasmoSurfaceConfig.cs` plus `GantasmoControlSurfaceBuilder.cs`
  instantiate the whole surface from a config asset. This already proves that a
  new control is a new data row rather than new code.

## 3. The new contract: `/api/xr/control` plus a unified manifest

Stand up one backend websocket module, cloning the proven questmidi and
queststitch socket-plus-module pattern. It serves a manifest on connect and
relays control changes both ways.

### 3.1 Manifest entry

A flat array of self-describing entries, aggregated host-side from the existing
registries:

```
{
  id:      "dj.eqHi.A" | "make.cfg" | "vj.glitch" | "fx.owlpad.<entryId>.x",
  area:    "make" | "dj" | "vj" | "fx" | "learn",
  group:   "deckA.eq" | "chimera.weave" | "distortion",   // spatial bucketing
  label:   short human string,
  kind:    "knob"|"fader"|"button"|"toggle"|"select"|"xy"|"xyz"|"jog"|"grid",
  min, max, step,            // numeric domain (absent for button/toggle/select)
  options: string[],         // for select/enum
  default, value,            // value seeds the XR widget on connect
  unit:    "dB"|"%"|"s"|"BPM",
  transport: "midi" | "ws",  // midi when a CC/note exists, ws otherwise
  midi:    { kind:"cc"|"note", number, channel, bits:7|14 },  // when transport=midi
  worldHint: { anchor, size } // optional placement
}
```

This mirrors the shapes three registries already use. `BindableTarget` maps
field-for-field minus `invoke` (replaced by `transport`/`midi`). The VJ
`ControlManifestEntry{key,label,kind,group,min,max,step}` forwards almost
verbatim with `area:"vj"`. MAKE entries are generated from the `SlideRow`/
`SlideFader` props that already encode `min/max/step` in `AdvancedGenPanel.tsx`,
each tagged with the `handletheDAWAction` name it fires.

### 3.2 Messages

- Outbound to XR: `{type:"manifest", version, entries:[...]}` on connect and on
  change; `{type:"control-changed", id, value}` on any host-side move.
- Inbound from XR, scalar: `{type:"control-set", id, value}`. The host routes it
  to that id's setter: `DJ_TARGETS.invoke`, the VJ `control-set`, a
  `handletheDAWAction`, or a new `setRackParam`.
- Inbound from XR, rich kinds the scalar path cannot express:
  - `{type:"pad", id, x, y, z?, gate}` for xy and xyz pads,
  - `{type:"jog", id, velocity, phase:"grab"|"move"|"release"}` for the platter,
  - `{type:"trigger", id, index}` for grids (clip launch, hotcues, sampler).

A `manifestVersion` integer lets XR re-instantiate only when the manifest
changes.

### 3.3 Why this is the low-maintenance path

A new theDAW control surfaces in XR the moment it is registered in its area's
catalogue. There is no Unity edit, no prefab, and no scene change. MIDI remains
the low-latency value carrier for anything MIDI-mappable, which already works
through the questmidi websocket. The new websocket carries the manifest, the
toggles, the enums, and the rich pad and jog payloads.

## 4. Per-area spatialization

### 4.1 MAKE and Chimera

Layout: a shallow arc in front of the performer holds the scalar cluster, and the
Chimera DNA hero occupies the deep center volume so the stack reads as a
sculpture rather than a wall of knobs. Scalars summon as a curved panel on gaze.
Magenta mode swaps the cluster contents in place rather than adding a second
panel.

Controls: CFG, Steps, and Length port as three large 3D knobs or faders, already
wired through `set_cfg`/`set_steps`/`set_duration`. Seed becomes a jog dial plus
a dice button. Model becomes a labeled button cluster, one cube per engine,
firing `set_model` plus the `patch()` and `swapEngineForModel` side-effects that
the action must replicate. CREATE and ABORT become one large palm-press launch
button with a progress halo, driven by `generate`/`abort` and `get_status`.

Hero: the Chimera CRISPR DNA scene (`ChimeraDnaScene.tsx`). It is the single
highest-leverage reuse in the port. `getRunFraction()` is already exported, the
real chunk plan lives in `lastMeta.per_clip.placements`, and the helix is already
depth-sorted under an orthographic camera, so it simulates 3D today. In XR each
clip becomes a grabbable floating helix lane that stacks and reorders. On CREATE
the chunks lift, travel to a shared output strand above the stack, and fuse,
paced by `getRunFraction()` so the DNA and the progress percentage always agree.
The stack add, remove, reorder, per-clip noise, and base interactions have no
actions today and reach the engine through `addBlobsToChimera` plus store
methods, so they need a thin bridge action (`set_chimera_field`).

### 4.2 DJ

Layout: two deck faces angled inward like a booth, the mixer strip (crossfader
plus the two channel faders) in the centered hero slot, FX pods and pad grids on
summonable side rails. Waveform ribbons curve along the top and the transport
sits low, per the design ruleset. Only one deck's deep controls expand at a time.

Controls: nearly the entire DJ surface ports with zero new code by enumerating
`DJ_TARGETS` and spawning one widget per `target.kind` bound to `target.invoke`:
EQ hi/mid/lo, filter, gain, channel volume, pitch, crossfade, the FX flanger/
reverb/wah, keylock, slip, headcue, limiter, play, and cue. Hotcues, sampler, and
beat loops port as lit button grids calling the directly callable engine
functions, which need `grid`/`trigger` rows added to the catalogue.

Hero: the jog and scratch platter. It is the priority primitive and the one DJ
control absent from `DJ_TARGETS`, because its value model is a signed continuous
angular velocity plus grab and release rather than a scalar. The XR platter
reuses `JogWheel.tsx` angle-to-velocity math (`VEL_K = SEC_PER_REV / 2PI`) on a
hand-grabbed disc: grab calls `enterVinyl`, the per-frame hand angular delta
calls `setVinylVelocity` (clamped to -16..+16), and release calls `exitVinyl`.
Position read-back flows through `djEngine.subscribe` to drive the emissive ring
imperatively. This is the jog-binding sibling of the generalized XYZ pad.

### 4.3 VJ

Layout: a large curved video screen shows the live composited output, streamed in
over the existing delinQuest/queststitch WebCodecs path or a `captureStream`
texture. The XYZ FX pad floats at hand height center stage. The knob banks
(color, geometry, look, timecode groups) and the toggle grid arc to the sides,
auto-instantiated one widget per manifest entry. The Resolume-style clip grid
sits on a side rail as stacked banks.

Controls: the entire distortion, color, geometry, look, and timecode groups plus
the crossfader and the toggles spatialize with zero per-control code by consuming
the existing `sa3-vj/controls-manifest` and emitting `sa3-vj/control-set` per
widget. Native min and max in the manifest auto-scale the 3D widgets, and
`control-changed` echoes light toggle state. Range parameters can additionally be
driven by MIDI CC over questmidi with no new code. Three small additions close
the gaps: a `sa3-vj/launch-clip{index,bank}` message, an enum/select kind, and a
host-side relay so an external Unity process can reach the postMessage bridge.

Hero: the XYZ FX pad. The VJ tab has no XY pad of its own today, so the hero is
the generalized OwlPad3D bound to three chosen manifest keys at once (for
example X to glitch, Y to feedback, Z to pixelate). The same primitive doubles as
the OWL-Pad and Spatializer rack pads described in section 5.

### 4.4 LEARN (lineage graph)

Layout: a walk-in volume the performer teleports through. Nodes float as
clustered constellations tinted by source, edges render as colored tubes. The
room is the control. A floating inspector summons on point-to-select.

Controls: zero backend work. XR fetches the same `GET /api/library/_graph/all`
payload and instantiates node meshes reusing the existing `nodeShape` enum, with
one shared material per source color and edge tubes per edge kind, honoring the
asset-reuse rule. `flyHome`/`flyForward` map to walk and teleport locomotion. The
hover-lights-lineage BFS becomes gaze or point highlight of a track's full
ancestry and descendants. Node selection opens a floating detail panel. This is a
pure renderer swap riding the new websocket for node-pick and metadata.

Hero: the walk-in derivation graph itself. The force-graph already produces real
x, y, z node positions and typed edges, so the spatial form is native.

## 5. The XYZ pad, generalized from OwlPad3D

Generalize the demo (now at `Assets/OwlPad3D`) into one reusable `XyzPad`
primitive, instanced for the VJ FX pad, the OWL audio pad, the Spatializer
positioner, and the DJ scratch decks. One primitive, configured per instance.

Keep verbatim:
- `OwlPadController` plane projection and 0..1 normalization (the coordinate
  engine).
- The ScriptableObject event-channel decoupling (`OwlPadEventChannel`), the
  zero-edit seam where a new consumer attaches.
- The pooled ripple, grid, and indicator visuals, with one shared material per
  instance.
- The idempotent `CreateOrLoadAsset` factory from `OwlPad3DAutoSetup` as the
  spawn-pad-from-descriptor builder.

Promote the Z axis: the controller already computes the signed finger-to-plane
distance (`distanceToPad` from `padPlane.GetDistanceToPoint`) but only
threshold-tests it as a binary touch gate. Expose
`normalizedZ = Clamp01((hoverCeiling - dist) / hoverRange)` and replace the
hardcoded `pressure = 1.0` with it. The demo becomes a true XYZ surface with no
new math. Generalize the payload to `Vector3` plus a stable `padId` so one event
bus serves many pads.

Add the one missing piece, a generic `PadBinding` consumer ScriptableObject that
replaces the four audio-effect SOs. It reads an axis-to-target assignment from the
manifest entry (per-axis enable, invert, min, max, curve, plus a touch gate) and
emits per axis either a 14-bit CC over the questmidi socket or a `control-set`
over the new websocket, with touch-down and touch-up as a gate. It reuses
`OwlPadEffect`'s per-axis enable, invert, and `AnimationCurve` range shaping as
the CC range and curve config.

Bindings:
- OWL-pad: X and Y to its program-dependent Freq, Reso, Time, and Feedback axes,
  Z to mix. The HOLD and GATE become a latch toggle beside the pad.
- Spatializer: the pad plane to azimuth and distance, Z to elevation. The 2D
  pad's missing third axis becomes free in XR, the cleanest 2D-to-3D promotion in
  the app.
- DJ scratch: the jog-binding variant. It emits X velocity (signed dPosition/dt)
  as a relative jog centered on 64 and gates platter contact on Z, mirroring
  `JogWheel`'s velocity math, because an absolute-position CC cannot express a
  scratch.

All four targets bind from descriptor rows, so adding a pad-driven control is a
manifest edit.

The pad graduates from `Assets/OwlPad3D` into
`Packages/com.gantasmo.questmidi/Runtime/ControlSurface/` as the `XyzPad`
primitive once generalized, so package code can instantiate it. The namespace
moves to the Gantasmo convention at that point.

## 6. Avoiding overcrowding

Treat the manifest `group` field as the spatialization budget and never render
every control at once.

1. Context-switching per area: only one tab's surface is materialized at a time
   (MAKE, DJ, VJ, or LEARN), switched by a microgesture shortcut or a wrist menu.
   The other areas dismiss entirely.
2. Summon and dismiss on gaze: scalar clusters stay collapsed to a single group
   anchor and expand into a curved panel only when the performer gazes at or
   reaches toward it, then auto-collapse on look-away. The always-present
   elements per tab are the hero and three to five must-have controls.
3. Single-deck and single-cluster expansion: in DJ only the focused deck expands
   its loops, hotcues, and stems; in MAKE the expert sub-panels stay hidden until
   SHIFT mode is engaged.
4. Proximity layering by depth: heroes occupy the deep center volume, primary
   controls sit at hand height in the near arc, secondary controls live on side
   rails reachable by a small lean. The XYZ pad's third axis itself reduces widget
   count, since one pad replaces two or three knobs.
5. Group-driven instancing with shared assets: the factory buckets widgets by
   manifest group into tidy clusters using one shared material per group, so
   density reads as organized constellations.

LEARN is the model for density without clutter: hundreds of nodes become a
walk-in constellation with detail summoned only on point-to-select.

## 7. Phased delivery

| Phase | Deliverable | Depends on |
|---|---|---|
| P0 Control-bus contract | Define the manifest entry schema and stand up `/api/xr/control` as a backend websocket cloning the questmidi module pattern. Prove the transport end to end with a hand-written three-entry stub manifest. | questmidi router as template; agreement on the entry shape. |
| P1 Host aggregator, DJ first | A theDAW aggregator that publishes `DJ_TARGETS` verbatim into the manifest and routes inbound `control-set` to `DJ_TARGETS.invoke`, with `control-changed` echoes via `djEngine.subscribe`. The whole DJ scalar surface becomes XR-drivable with no per-control code. | P0; `bindableTargets.ts`. |
| P2 XR ingester and factory | Replace the hand-authored `GantasmoSurfaceConfig` with a runtime loader that fetches the manifest and feeds the existing builder to instantiate widgets per `entry.kind`. Add the two-way adapter that writes inbound values back onto knob and fader transforms so XR seeds from and follows theDAW. | P1; `GantasmoControlSurfaceBuilder` + `QuestMidiSender` inbound events. |
| P3 Generalized XYZ pad | Promote OwlPad3D into `XyzPad` (Z axis, `Vector3`+`padId`, `PadBinding` SO, spawn factory). Ship one VJ FX-pad instance and the jog-binding DJ scratch deck on `enterVinyl`/`setVinylVelocity`/`exitVinyl`. | P2; OwlPad3D; `JogWheel`/`djEngine` value model; VJ manifest. |
| P4 VJ and MAKE aggregators | Forward the VJ `controls-manifest` through the host relay (add the enum kind and the `launch-clip` message). Build the MAKE catalogue from `generateParamsStore` metadata wired to `handletheDAWAction`, including the Chimera bridge actions and the model side-effects, plus CREATE/ABORT with the progress halo and the DNA hero. | P0 to P3; `sa3Bridge.ts`; `actionHandlers.ts`; `ChimeraDnaScene`. |
| P5 FX-rack hook and walk-in graph | Add a `setRackParam` registry entry so OwlPad and Spatializer params are externally settable, then bind the XyzPad and the positioner. Render the LEARN graph from `/api/library/_graph/all` with shared materials and point-to-highlight. Final overcrowding pass. | P0 to P4; `rackEffects.ts` `ChainEntry.params`; library graph endpoint. |

## 8. Risks and constraints

- The VJ bridge is `window.postMessage` between the theDAW host and the VJ iframe
  or popout, not a network socket. An external Unity process cannot postMessage
  in. The `/api/xr/control` relay must bridge it, or VJ control silently never
  reaches XR.
- The OWL-pad is two different controls. theDAW's `OwlPad.tsx` is an audio FX-rack
  XY pad, while the VJ tab has no pad of its own. Both `OwlPad` and `Spatializer`
  are sealed inside `ChainEntry.params` with no external hook today and need a
  `setRackParam` entry before any XR pad can drive them.
- The jog and scratch primitive does not fit the scalar or CC model. It is signed
  continuous velocity plus grab and release, absent from `DJ_TARGETS`. Forcing it
  through a 0..1 CC feels wrong. It needs the dedicated jog-binding path and the
  short stall and wind-down behavior from `JogWheel` to feel like a record.
- MIDI's 7-bit ceiling makes hand-tracked sweeps steppy, and 127 CCs per channel
  caps the control count. 14-bit CC (`SendControlChange14`, already present) fixes
  smoothness, and more than 127 controls forces multi-channel allocation or routes
  rich and scalar traffic onto the websocket.
- Several MAKE fields (sigmaMax, apgScale, the schedule-shift faders, the Magenta
  params, file format and naming, autoplay) are not in `buildParamUpdates` and
  have no action, and the Chimera stack has no actions at all. They are reachable
  by extending `buildParamUpdates` and adding store-method bridges in one place,
  but that work is real and easy to under-scope.
- Some controls (the hero-tab and compare-layer toggles, DJ Quantize, Auto-gain,
  Automix, Sync-Lock) are local React `useState`, not in any store, so they are
  not externally settable until lifted into a store. Low priority, and not free.
- Two-way value sync requires theDAW to emit value mirrors on every host-side
  move. `djEngine.subscribe` and the VJ `control-changed` echo cover their areas;
  MAKE has only `get_status` polling until a push channel is added.
- The bridge is tethered today: adb reverse over USB-C plus loopMIDI on Windows,
  single PC. Any wireless or multi-host story is unaddressed, and the queststitch
  video uplink shares the constraint.
- The spatial layout and the pad hit-testing must carry the `DESIGN_PRINCIPLES`
  ruleset (waveforms top, left-to-right flow, symmetric rails with a centered
  hero, transport at the footer) and the rendered-pixel mapping discipline from
  the CSS-zoom lesson, or the result drifts into clutter and mis-registered touch
  points.

## 9. Verified file pointers

theDAW:
- `frontend/src/state/bindableTargets.ts` (`DJ_TARGETS`)
- `frontend/src/state/sa3Bridge.ts`, `frontend/src/<vj>/controlManifest.ts`
- `frontend/src/orb-kit/actionHandlers.ts` (`handletheDAWAction`)
- `frontend/src/state/questMidiClient.ts`, `frontend/src/state/midiBus.ts`
- `frontend/src/components/chimera/ChimeraDnaScene.tsx`,
  `ChimeraControls.tsx`, `ChimeraStack.tsx`
- `frontend/src/components/audio/{OwlPad,SpatializerPad,JogWheel,SlidePad}.tsx`
- `frontend/src/views/{AdvancedGenPanel,DJView,VJView}.tsx`

theDAW-XR (`Packages/com.gantasmo.questmidi/`):
- `Runtime/QuestMidiSender.cs` (`SendControlChange14`)
- `Runtime/ControlSurface/{MidiControlSurface,MidiSlider,MidiKnob,MidiButton,MicrogestureMidiSource}.cs`
- `Editor/{GantasmoSurfaceConfig,GantasmoControlSurfaceBuilder}.cs`
- `Assets/OwlPad3D/` (the XYZ-pad foundation)
