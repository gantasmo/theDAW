# Automation Lanes (EDIT tab)

An automation lane records how one parameter moves over the length of the
timeline. Each lane stores a list of breakpoints, where a breakpoint is a pair
of timeline seconds and a value. During playback the lane plays those values
back, so a fader ride or an effect sweep repeats exactly as it was captured.
Between two breakpoints the value moves in a straight line. Before the first
breakpoint and after the last one the lane holds the nearest value.

Lanes live in the EDIT tab, drawn as colored curves over the track rows. One
lane exists per automated parameter, so a control always resolves to a single
lane.

## Automatable targets

Four kinds of parameter can carry a lane.

- Track volume draws a green curve over the track row, inside the band the
  volume line uses. Its values run from zero at the bottom of the band to unity
  at the top.
- Track pan draws a blue curve over the track row. Its values run from full left
  to full right.
- Each parameter of a per-track rack effect draws an amber curve, scaled to that
  parameter's minimum and maximum.
- Each parameter of a master-bus rack effect draws an amber curve in the Master
  FX strip below the track rows.

An OWL-Pad drag moves two parameters at once (x and y), so it records into two
lanes together. Any effect control that changes more than one parameter in a
single move records each changed key into its own lane.

## The volume line

Every track row draws its volume as a green line across the lane, below the clip
title strip. The top of its band is unity (0 dB) and the bottom is silence.

A track with no volume keyframes shows a flat line at the fader's value. Drag
the line up or down to move the fader.

Right-click the line, or double-click it, to add a keyframe at that time. The
keyframe takes the line's value at that point, so the level does not jump. From
the first keyframe on, the line is the track's volume lane and the header fader
shows an A.

- Drag a keyframe to move it in time and level. It stays between its two
  neighbours. Time snaps to the grid, and Alt places it freely. Shift makes the
  drag fine.
- Drag the line between two keyframes to raise or lower both together.
- Click a keyframe to select it. Its level shows beside it in dB.
- With a keyframe selected, Up and Down change it by 0.1 dB, or by 1 dB with
  Shift. Left and Right move it one grid step.
- Press Enter, double-click the keyframe, or click its dB readout to type a
  level. `-inf` silences it.
- Delete removes the selected keyframe. Alt-click removes a keyframe directly.
- Right-click a keyframe for Set volume, Unity, Delete, Bypass and Clear.

The clip menu and the timeline's add menu both carry Add volume keyframe, which
places one at the pointer's time on that track.

A change made while the transport rolls is heard at once. Escape during a drag
puts the line back. Each drag is one undo step.

Bypass keeps the keyframes and hands the level back to the fader, and the line
then draws dashed. Clear removes every keyframe on the track.

The cut tool leaves the line alone, so a cut never moves it. Timeline
preferences has Show volume line to hide the lines.

## Record a lane with WRITE

The WRITE button sits in the EDIT toolbar and shows a red dot when armed. It
arms write mode for the whole timeline.

To capture a move:

1. Arm write mode by clicking WRITE.
2. Start playback.
3. Ride a track fader, drag a pan control, or move an effect control while the
   transport rolls.

While WRITE is on and the transport is rolling, each move stamps a breakpoint at
the current audio-clock position and drives the value onto the live signal, so
the change is heard as it is recorded. If no lane exists yet for that control, a
new enabled lane is created on the first recorded point. Recorded gestures are
thinned so points closer than a short spacing collapse into one, which keeps a
fast ride from filling the lane with redundant points.

Moving a control while WRITE is off, or while the transport is stopped, changes
the control without recording.

## Open the lane editor and read the overlay

The AUTO button sits next to WRITE in the toolbar and shows an amber dot when
active. Clicking it toggles automation edit mode and opens the Automation Lanes
panel at the top left. If no lane is selected yet, the first lane becomes the
active one.

The panel lists every lane. Each row carries four controls.

- A colored dot toggles the lane on or off. An off lane is ignored for both
  recording and playback.
- The lane name and its breakpoint count sit next to the dot. Clicking the name
  selects the lane for editing.
- CLR removes every breakpoint but keeps the lane.
- The close icon deletes the lane.

On the timeline, every lane with points draws its curve over the matching track
row. Volume reads green, pan reads blue, and effect parameters read amber.
Read-only lanes draw with a thinner, fainter line and pass pointer events
through to the clips beneath them. Master effect lanes appear only while edit
mode is on, inside the Master FX strip under the last track.

While edit mode is off, a track's volume lane is drawn and edited by the volume
line. While edit mode is on, the volume lines are hidden and the lane editor
draws volume lanes in the same band.

During playback with edit mode off and one or more enabled lanes, the on-screen
controls follow the recorded values for display, while the audio follows the
lanes underneath.

## Edit and drag breakpoints

Selecting a lane in the panel makes its curve editable on the timeline. The
active lane draws with a brighter line and accepts pointer input. Only one lane
is editable at a time.

On the active lane:

- Click an empty part of the curve to add a breakpoint at that time and value.
- Drag a breakpoint to move it. A dragged point is held between its two
  neighbors, so points never cross or reorder.
- Alt-click or right-click a breakpoint to delete it.

Pointer positions are read against the drawn rectangle, so edits stay accurate
under the app's display scaling.

## How lanes are committed

Playback and the committed render read the same lanes, so what plays back is
what gets baked.

During live playback, track volume and pan lanes ride their audio parameters on
a scheduled envelope, and effect-parameter lanes are stepped by a lookahead
writer that updates the effect repeatedly as the playhead moves.

When an edit is committed, the render walks every enabled lane that has points.
The render starts at time zero, so each breakpoint's timeline position is its
render position. Track volume and pan follow a parameter timeline built from the
breakpoints, holding the first value, then ramping in a straight line to each
later value. A track volume or pan lane overrides that track's static fader
setting for the render. Effect parameters are stepped at each breakpoint. Lanes
that are switched off, or that hold no breakpoints, are skipped, so disabling a
lane removes its effect from the committed result without discarding its points.
