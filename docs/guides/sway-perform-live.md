# Playing Live: PERFORM, the Sway, and Performance Templates

This is the live-performance path through theDAW: load a set into the **PERFORM**
grid, drive it from an **Audima Labs Sway** (or any MIDI controller), and punch effects
in and out with the pads while the clips keep running.

It covers the grid, the SwayCommand deck, the routing model that travels inside a
`.tasmo` project, the performance templates that ship with the repo, and the
**Kargyraa Sub** subharmonic bass engine built for this rig.

---

## 1. What PERFORM is

PERFORM is a clip-launch grid in the Ableton Session sense: **columns are tracks**,
**rows are scenes**, and every cell holds a clip. Launching a scene stops whatever
is playing and fires that whole row, so a scene is a complete arrangement state
rather than a single sound.

Each column carries its own **live effect chain** built from the project's saved
devices, so an imported or authored set arrives with its EQ, filters, delays and
creative FX already running — not preserved-but-silent. Metering is post-FX.

Open a set from the PERFORM header's Open icon. Three formats land here:

| Format | Source | Notes |
|---|---|---|
| `.tasmo` | theDAW's own project format | Full fidelity: clips, scenes, FX chains, routing |
| `.als` | Ableton Live set | Clips, devices and the set's own MIDI-learn mappings |
| `.swayproj` | Audima Labs Sway project | Preset/zone map; seeds gesture bindings by preset name |

---

## 2. The grid

- **Launch a scene** — click its row button, or hit the pad bound to it. The row
  replaces whatever was playing.
- **Launch one clip** — click the cell. This layers: hold a bassline while you
  change the drums, which a whole-row launch cannot do.
- **Launch quantize** — the header's bars control delays launches to the next
  bar boundary (`0` = immediate).
- **Stop** — clears all playing clips.

Clips honour their trim and loop window. A clip saved with a loop range sustains
when launched instead of one-shotting from sample 0.

A MIDI cell plays its notes on its column's instrument, by the rule EDIT uses for a clip: the cell's own General MIDI program, else its track's program, else the voice of the Instrument picker, each in the bank it was picked in. A drum track's cells play on the drum channel, where the program picks the kit. A set imported from another DAW carries no programs, so its MIDI cells follow the Instrument picker, and a cell that follows the picker renders again on the new voice when the picker changes. A MIDI cell saved from PERFORM reopens in PERFORM with its notes where they were, on the program, bank and drum channel it was saved with.

**Edit in timeline** hands the set to EDIT with each track's program, bank, sound bank and drum channel, and each MIDI clip plays and renders there on the voice it had in the grid.

---

## 3. The SwayCommand deck

The deck is PERFORM's assignment surface — a schematic of the hardware sitting
under the grid. Click any control on it to bind that control, and the right rail
shows what it currently drives.

**Factory control map** (`swaydeck/deckState.ts`):

| Control | Sends | Default role |
|---|---|---|
| Knobs 1–8 | CC 20–27 | Per-column volume (templates also use 26/27 for delay time/tone) |
| XY pad — X | CC 50 | "Amount" axis |
| XY pad — Y | CC 38 | "Tone" axis |
| Gesture: pulse | CC 35 | Dim value |
| Gesture: press | CC 36 | Dim value |
| Gesture: sway | CC 37 | Dim value |
| Pads 1–16 | Notes 24–39 | Scene launch and/or FX punch |
| Buttons 1–8 | *(no factory map)* | Transport, by learn only |

Pads are **note-only** and velocity is used just for the visual flash. Buttons have
no factory code, so bind them with learn: arm the function in the deck's button
panel, then press the physical button.

> **Pad mode matters.** The routing layer expects the Sway's *chromatic* pad mode
> (notes 24–39). In Theory-Engine pad mode the hardware emits a different note set
> (47, 49, 50, 52, …) — the deck's visualiser understands both, but scene and punch
> bindings authored at 24–39 will not match. Keep the pads chromatic for these sets.

### The DAW-control mirror

When theDAW detects an Audima Labs Sway, it turns on the Sway's DAW-control mirror, which drives EDIT with the MIDI map the Sway's Ableton Remote Script uses. The Play button (note 0, channel 1) starts and stops EDIT's transport, CC 1–8 and CC 9–16 on channel 1 set the volume and pan of a bank of eight EDIT tracks that follows the track selection, and notes 24–39 on channel 16 sound General MIDI notes from the pads.

The mirror stands down while PERFORM or the SWAY tab is the open view. A pad press there reaches only that view, PERFORM's scene and punch bindings or the SWAY tab's cockpit, and sounds no note. The Play button and the faders leave EDIT alone. A pad the mirror holds when either tab opens, a latched one included, is released. While the mirror stands down, the pads and the Play button do not sound through the keyboard monitor either. On every other tab the mirror works as described above.

---

## 4. The routing model

Everything the hardware does is expressed as one of four things, and all four
travel inside a `.tasmo` file's `perform_routing` block.

### `sceneCtrls` — direct scene launch
Scene index → control. A pad bound here launches that scene outright.

### `transport` — the five transport functions
`select` (a CC encoder that scrubs the highlighted scene), `launch`, `stop`,
`next`, `prev`.

### `trackMods` — gesture dims
The Sway's six motion dims (`pulse`, `strike`, `sway`, `glide`, `press`, `sculpt`)
modulate a column's **volume** or **mute**. A held hand position keeps modulating
across scene launches, so a gesture is a continuous performance layer rather than a
one-shot trigger.

### `ccMods` — direct control routes
The workhorse. Each route maps one control to one target on one column:

| Target | Effect |
|---|---|
| `volume` | 0–1 multiplier on top of the track's own fader |
| `mute` | Muted above 0.5 |
| `fx` | Drives one parameter of one device in that column's live chain |

An `fx` route names a `deviceIndex` (the position in the track's `effect_chain`)
and a `paramKey`, plus a `min`/`max` range. The value is scaled
`min + value × (max − min)`, and **the range may be inverted** — `min: 20000,
max: 160` is exactly how a filter-sweep-on-turn-up is authored.

> `ccMods` belong to the *project*, not the machine: they are not persisted to
> local storage, but they do travel in the `.tasmo` and come back on open.
> `transport`, `sceneCtrls` and `trackMods` persist locally as well, so your
> hardware layout survives across projects.

---

## 5. Pads: scenes *and* FX punches

Pads used to launch scenes and nothing else. They now do both, split by note range
in the shipped templates:

| Pads | Notes | Role |
|---|---|---|
| 1–8 | 24–31 | Scene launches |
| 9–16 | 32–39 | **FX punches** |

An FX punch is an `fx` route bound to a note instead of a CC. Two behaviours:

- **Momentary** (default) — press pushes the parameter to `max`, release returns it
  to `min`. This is the classic hold-to-mangle: the effect is in only while your
  finger is down.
- **Latch** (`latch: true`) — each press toggles between `max` and `min` and the
  release is ignored. Use it for states you want to leave running with both hands
  free.

One pad can drive many routes at once, so a single punch can hit every column
simultaneously (a whole-mix gate) or one column surgically (ring-mod the keys).

A note bound to both a scene and a punch fires **both** — deliberate, and how you
build a pad that changes the arrangement *and* slams a filter in one hit. The
shipped templates keep the two ranges disjoint so this only happens when you ask
for it.

---

## 6. Live devices in a set

A `.tasmo` track's `effect_chain` becomes the column's live chain. What is audible
in PERFORM depends on the node kind:

| Node kind | Audible in PERFORM? | Control surface |
|---|---|---|
| Built-in rack effect | **Yes** — real Web Audio, live, metered post-FX | Knob/XY/pad routes; full window in EDIT |
| `ares` (the .gan composite) | **Yes** — its DSP runs live | Its `.gan` panel opens in EDIT/MIX |
| VST3 | **Yes**: hosted live in theDAW's live VST host, following the grid's transport and tempo | Native plugin GUI in EDIT/MIX; offline render |

A VST3 node on a column runs in theDAW's live VST host, the same host that plays VST3 inserts on the EDIT timeline. The plugin follows the grid as its transport. The first clip that starts while the grid is stopped starts the transport at the grid's beat and tempo, a tempo change while the grid plays reaches the plugin, and Stop, or leaving PERFORM, stops it. A plugin whose host opens after the grid started is told where the grid has got to, so a tempo-synced delay or gate lands on the grid's beat. A plugin that cannot open passes the column's audio through. A plugin from a set imported from another DAW opens at its defaults, since neither host reads another DAW's preset data.

Any column can take more. The rail's **Params** tab lists every track with an add menu holding the whole rack catalog and every scanned VST3 plugin; a pick goes on the end of the track's chain and the column plays it at once. A rack effect's slot shows its controls, a plugin's slot shows the plugin's own parameter list, and each slot has a bypass dot. **Window** opens the plugin's own window, sized to the plugin, and what is set there is kept on the slot. The deck's FX picker reads the same chain, so a knob, an XY axis or a gesture can drive a plugin's parameter as well as a rack effect's. Save writes the added devices after the file's own inserts, each slot's bypass, and each plugin's state.

Three built-ins are backed by AudioWorklets — **Chop**, the **Ares** grain stage,
and the **Kargyraa Sub** octave divider. PERFORM preloads all three when the grid
mounts, so a set using them is at full strength on first launch.

---

## 7. Kargyraa Sub — the subharmonic throat-bass engine

`kargyraa` is a built-in rack effect (group: Low end) that models Tuvan
**kargyraa** undertone singing and welds it to a formant "talking" dubstep bass.

**Why it sounds like that.** In kargyraa, the ventricular (false) folds close over
every *second* vocal-fold cycle, so the perceived pitch drops an octave — period
doubling. Separately, the singer merges vocal-tract formants into one narrow,
very loud peak, which is what makes the overtone melody audible over the drone.
The effect reproduces both:

| Stage | What it is | Models |
|---|---|---|
| Octave divider | Schmitt-triggered flip-flop → f/2 and f/4 squares, envelope-followed | Ventricular period doubling |
| Growl gate | Amplitude modulation at a sub-audio rate | The same doubling as sidebands |
| Vowel bank | Three morphing band-passes (a–o–u–e–i) with LFO wobble | Vocal-tract formants |
| Whistle band | One high-Q band, 0.8–2.4 kHz | Sygyt-style focused overtone |

**Parameters**

| Key | Range | What it does |
|---|---|---|
| `mix` | 0–1 | Wet/dry. Templates author this at 0 so a pad punches it in |
| `subLevel` | 0–1.5 | Level of the divided octave-down |
| `deepLevel` | 0–1 | Level of the two-octaves-down layer |
| `growlRate` | 20–90 Hz | AM rate. **Set to half the bass fundamental** for true subharmonics |
| `growlDepth` | 0–1 | How hard the growl chews |
| `drive` | 1–40 | Harmonic enrichment feeding the formant bank |
| `vowel` | 0–4 | Morph across a → o → u → e → i |
| `motionRate` | 0–8 Hz | Vowel wobble speed |
| `motionDepth` | 0–1 | Vowel wobble amount |
| `whistleHz` | 800–2400 Hz | Sygyt band centre |
| `whistleAmt` | 0–1 | Sygyt band level |

**Tuning it.** `growlRate` is the parameter that decides whether this sounds like
a growl or like mud. Set it to **half the fundamental of the bass you are feeding
it** and the AM sidebands land exactly on the subharmonic series. For reference:
D#2 = 77.8 Hz → `growlRate` 38.9; E2 = 82.4 Hz → 41.2.

The sub path band-limits its input hard before the divider, so the divider locks to
the bass fundamental rather than chattering on hi-hats. Feed it a bass stem, not a
full mix, for the cleanest tracking.

---

## 8. The shipped performance templates

Two generator scripts author ready-to-play `.tasmo` sets into
`~/Documents/theDAW Projects/`. Both link their audio rather than embedding it, so
the files stay small and the stems stay where they are.

```bash
uv run python scripts/make_sway_template.py        # Madman Returns x Et Tu Machina
uv run python scripts/make_sway_song_templates.py  # Prologue, EACC, Just Give Up
```

### Madman x Machina — the cross-song clash set

8 stem columns (two songs, four stems each), 44 looping clips, **16 scenes on all
16 pads**, including cross-song CLASH rows that run one song's drums against the
other's vocal. Knobs are column volumes; the XY pad sweeps a resonant low-pass
down from 20 kHz while a dub delay blooms in.

### Per-song sets — Prologue / EACC / Just Give Up

One file per song, each built from that song's six-stem split
(drums / bass / guitar / piano / other / vocals). Per set: 6 columns, 26 clips,
29 devices, 8 scenes, 29 punch routes and 47 knob/XY routes.

**Pads 1–8 — scenes**

`FULL MIX` · `DRUMS + BASS` · `INSTRUMENTAL` · `NO DRUMS` · `VOX ONLY` ·
`STRIPPED (bass + vox)` · `BREAKDOWN (keys tex vox)` · `DRUMS + VOX`

**Pads 9–16 — punches**

| Pad | Punch | Behaviour | Hits |
|---|---|---|---|
| 9 | `KARGYRAA` | Latch | Kargyraa Sub on the bass stem |
| 10 | `THROAT VOX` | Momentary | Kargyraa Sub on the vocal stem |
| 11 | `GATER` | Momentary | Eighth-note trance gate, every column |
| 12 | `CRUSH` | Momentary | 6-bit crush, every column |
| 13 | `ROBOT` | Momentary | Ring-mod on the keys |
| 14 | `THROW` | Momentary | Dub delay throw, every column |
| 15 | `FREEZE` | Latch | Ares granular freeze + wash on the vox |
| 16 | `SLAM` | Momentary | Low-pass slam to 220 Hz, every column |

**Continuous controls**

- **Knobs 1–6** — column volumes.
- **Knobs 7–8** — delay time and tone across every column.
- **XY X** — closes a resonant low-pass over every column while the delay blooms;
  also morphs the Kargyraa vowel on bass and vox.
- **XY Y** — drives filter resonance and delay feedback toward self-oscillation;
  also deepens the kargyraa growl and raises the sygyt whistle band.
- **Gestures** — `pulse` → drums volume, `strike` → bass volume, `sway` → vox
  volume, `press` → mutes the keys and texture columns.
- **Transport** — notes 40–43 plus CC 19 for scene select. Re-learnable on the deck.

Each set's tempo, delay time and growl rate are baked from that song's analysis:
Prologue 134.75 BPM (D♯ minor), EACC 129.49 BPM (E minor), Just Give Up 147.55 BPM
(D♯ minor). Delays default to a dotted eighth at the song's tempo.

Every column also carries the Ares composite and a real VST3 node on the vocal
column, so a single set exercises built-in FX, `.gan` and plugin hosting together.

---

## 9. Gotchas

- **FX routes do not reset.** Removing a route leaves the parameter wherever it was
  last driven — a filter left at 160 Hz stays there. Volume and mute routes *do*
  return to neutral when their route disappears.
- **A device's `bypass` is baked at load.** There is no live per-device on/off in
  PERFORM; author a punch on a wet/mix/depth parameter instead, which is exactly
  what the templates do.
- **`deviceIndex` is the position in `effect_chain`.** Inserting a device shifts
  every index after it, so re-author the routes if you edit a chain by hand.
- **Opening a set with no routing leaves the previous layout live.** Only `ccMods`
  are cleared per project; your pad→scene and transport bindings persist.

---

## See also

- [Projects and DAW import](projects-and-daw-import.md) — the `.tasmo` container
  and the importers that feed it
- [MIX, VST and .gan plugins](mix-vst-and-gan.md) — hosting plugins and effect
  control windows
- [PERFORM / Foundry / NodeF.I. reference](../reference/features/08-perform-foundry-nodefi.md)
  — the code-grounded subsystem reference
