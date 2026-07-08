/**
 * Control-surface widget contract.
 *
 * A "widget" is one relocatable control (a knob, fader, toggle, pad, etc.) that
 * a tab registers with the generic ControlSurface. Each widget owns a `render`
 * closure that draws the live control fitted to a measured cell size — the
 * closure captures its own wiring (engine calls, store setters, deck binding),
 * so moving a widget between panels changes WHERE it renders, never WHAT it
 * does.
 *
 * The shape intentionally echoes `slideStore.VisualControl` (key/label/kind/
 * group) so the two registries read alike, and reserves `source`/`binding` for
 * a later phase where the user creates custom action-bound controls — adding
 * those is additive, not a rearchitecture.
 */
import type React from 'react';

export type WidgetId = string;

export type WidgetKind =
  | 'knob'
  | 'fader'
  | 'toggle'
  | 'pad'
  | 'crossfader'
  | 'jog'
  | 'button'
  | 'fixed';

/** Pixel size of the cell the widget is being rendered into. */
export interface WidgetSize {
  w: number;
  h: number;
}

/** Preset outline shape for a framed REGION container. */
export type FrameShape = 'rect' | 'rounded' | 'hexagon' | 'capsule' | 'beveled' | 'blob';

/** Shape of a pad/button. The four `tri-*` are right-angle halves of a square
 *  (the right angle sits at that corner); two complementary tris tile a square. */
export type ButtonShape =
  | 'default'
  | 'square'
  | 'rect'
  | 'circle'
  | 'tri-tl'
  | 'tri-tr'
  | 'tri-bl'
  | 'tri-br';

/** Render-time hints the surface passes per cell. */
export interface WidgetRenderOpts {
  /** Mirror composite controls (flip icon/name side, horizontal internals). */
  mirror?: boolean;
  /** Content alignment within the cell. */
  justify?: 'start' | 'center' | 'end';
  /** True when the surface fill mode wants the control to grow to fill. */
  fill?: boolean;
  /** Pad/button shape override (applied by SlidePad). */
  shape?: ButtonShape;
  /** The host panel's flow — controls size to the shared cross-axis (row →
   *  height, column → width) so same-kind controls match. */
  flow?: 'row' | 'column';
  /** Match-sizes is active for this cell (global pref OR panel.uniform). */
  match?: boolean;
}

/** Reserved for the future custom-control phase; unused for built-in widgets. */
export interface WidgetBinding {
  /** e.g. a djEngine method name, a controlSyncBus key, or a MIDI action id. */
  target?: string;
  params?: Record<string, unknown>;
}

export interface WidgetDef {
  id: WidgetId;
  /** Human label shown in the palette and (optionally) as a tooltip. */
  label: string;
  /** Palette grouping bucket (e.g. 'Mixer', 'Deck A', 'FX', 'Sampler'). */
  group: string;
  kind: WidgetKind;
  /** Hint for the footprint a widget prefers on first placement. */
  defaultSpan?: { w?: number; h?: number };
  /** Draw the live control fitted to the measured cell, honoring opts. */
  render: (size: WidgetSize, opts?: WidgetRenderOpts) => React.ReactNode;
  /** 'builtin' today; 'custom' reserved for user-created controls. */
  source?: 'builtin' | 'custom';
  /** Reserved for the custom-control phase. */
  binding?: WidgetBinding;
}

export type WidgetRegistry = Record<WidgetId, WidgetDef>;

/* ── custom (user-created) controls ───────────────────────────────────────────
 * A custom control is added at runtime from the Add-Control picker: the user
 * chooses a control KIND + a STYLE tint, then either binds it to a backend
 * TARGET (it drives that setter live) or drops in a VISUALIZER. Unlike builtin
 * widgets (whose render closures are baked into the tab registry), a custom
 * control is pure data persisted in the layout and rendered by `CustomControl`.
 */
export type ControlKind = 'knob' | 'fader' | 'toggle' | 'pad' | 'crossfader';

/** A bindable backend endpoint a custom control can drive. The tab supplies the
 *  catalogue (e.g. DJ_TARGETS); the surface stays generic. */
export interface BindableTarget {
  id: string;
  label: string;
  /** Picker grouping bucket (e.g. 'Deck A', 'Mixer'). */
  group: string;
  /** The control kind that fits this target best (pre-selects in the picker). */
  kind: ControlKind;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Push a value: a number for ranges, a boolean for toggles; triggers (pads)
   *  ignore the argument. */
  invoke: (v: number | boolean) => void;
  /** Read the current value, when the target can report one. Lets a manifest
   *  consumer (e.g. the XR / companion bus) seed a widget with true state
   *  instead of a guess — important for stateful toggles like the limiter. */
  read?: () => number | boolean;
}

export type VisualizerKind = 'spectrum';

/** Persisted definition of one user-created control (lives in SurfaceLayout). */
export interface CustomWidgetDef {
  id: WidgetId;
  /** A bound control, or an embedded visualizer. */
  mode: 'control' | 'visualizer';
  label: string;
  /** control mode — the chosen kind + the target it drives + a style tint. */
  kind?: ControlKind;
  targetId?: string;
  /** Accent tint 0..1 (style/skin colour); undefined = value-driven default. */
  tint?: number;
  /** Pad/button shape (control mode, pad kind). */
  shape?: ButtonShape;
  /** visualizer mode — which visualizer to embed. */
  visualizer?: VisualizerKind;
}
