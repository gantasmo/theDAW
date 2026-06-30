# ASCILINE -> GLSL ASCII VJ source: porting spec

Status: spec, no code. Created 2026-06-25. This is the load-bearing first step of
the ASCII source (head of the next-block queue, see
`docs/plans/2026-06-25-next-block-vfx.md`). It captures the exact ASCILINE
conversion semantics so the GLSL port is a mechanical translation rather than a
guess.

## Source and license

ASCILINE by YusufB5 (`D:\StableAudio\ASCILINE`,
https://github.com/YusufB5/ASCILINE). Distributed under the MIT License WITH an
ANTI-ADVERTISEMENT RESTRICTION clause (see its LICENSE). Obligations for absorbing
it:

- Vendor with attribution. Keep a copyright + MIT + anti-advertisement notice in
  code comments and an ACKNOWLEDGMENTS entry.
- Port only the algorithm, the palette, and (if the streaming transport is ever
  wanted) the codec. Never port the Canvas2D / ANSI text-write render path; the
  GLSL source replaces it.
- Honor the anti-advertisement clause: the source must not be used to render
  advertising. Surface that restriction wherever the source is documented.

## The conversion to replicate (AsciiMapper.convert)

From `ascii_video_player2.py` (MODULE 2, lines 110-181). Per output cell:

1. Downscale the source frame to the cell grid `(cols, rows)` with bilinear
   interpolation (`cv2.resize(..., INTER_LINEAR)`).
2. Luminance per cell from the downscaled BGR via OpenCV BGR2GRAY, which is
   Rec.601: `Y = 0.299*R + 0.587*G + 0.114*B`, on 0..255.
3. Glyph index from luminance over the 93-character ramp (next section).
4. Color per cell is the cell's own source RGB (true color). ASCILINE optionally
   quantizes color to 6 bits for its RLE transport; that is a wire optimization
   with no visual purpose, so the GLSL port samples full-precision color and drops
   quantization.

The RLE / per-row escape-code construction and the ANSI string output are terminal
transport, not part of the visual, and are dropped.

## The glyph ramp (93 chars, dark to light), verbatim

```
 `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@
```

The first character is a space (darkest), the last is `@` (lightest). `N = 93`.

## Glyph index formula and one quirk to decide

ASCILINE computes `index = clip(gray // (256 // N), 0, N-1)`. With `N = 93`,
`256 // 93 = 2` (integer floor), so the real behavior is:

```
index = clamp(floor(gray_u8 / 2), 0, 92)
```

Consequence: gray maps to glyphs only across 0..184; every cell brighter than gray
184 saturates onto the single brightest glyph `@`. The top ~28% of the brightness
range collapses to one glyph. This is an integer-division artifact in the original,
not an intentional curve.

Two options for the port, the user picks:

- Faithful: replicate the saturating step exactly, `index = clamp(floor(luma*127.5),
  0, 92)` with `luma` in 0..1. Matches ASCILINE byte for byte.
- Corrected (recommended for the GLSL look): spread the whole ramp,
  `index = clamp(floor(luma * 93.0), 0, 92)`. Uses all 93 glyphs, so highlights
  read as `%`, `&`, `@` rather than flattening to `@`. This is the better-looking
  default for a VJ source; flag it as a deliberate divergence.

## GLSL implementation

A dedicated `AsciilineRenderer.ts` modeled on the new `ShaderRenderer.ts` (raw
WebGL2 fullscreen quad, same audio-uniform and dispose lifecycle), with two added
inputs the self-generating shaders do not need:

- `u_source` (sampler2D): the live upstream frame, uploaded each frame from the
  active `<video>` element via `texImage2D` (the loaded clip, else the webcam).
  This is why ASCII is a distinct renderer rather than a `ShaderRenderer` preset:
  it transforms an external frame instead of synthesizing one. A later option is
  to generalize `ShaderRenderer` to accept input textures so ASCII becomes a
  preset, but the first build keeps them separate.
- `u_atlas` (sampler2D): the 93 glyphs prebaked once at load into a horizontal
  strip atlas. Rasterize each glyph centered in a fixed cell (a monospace font on
  an offscreen Canvas2D, white on transparent) into a `glyphPx*N` by `glyphPx`
  texture, uploaded once. This is the only allowed Canvas2D use, and it runs once
  at init, never per frame.

Fragment shader, per output pixel `uv` in 0..1:

```
// 1. cell coordinates
vec2 grid = vec2(u_cols, u_rows);
vec2 cell = floor(uv * grid);
vec2 inCell = fract(uv * grid);
// 2. sample source at the cell center (point-ish; source is already cell-sized
//    if uploaded at grid res, or sample the full frame here and let it average)
vec2 cuv = (cell + 0.5) / grid;
vec3 src = texture(u_source, cuv).rgb;
float luma = dot(src, vec3(0.299, 0.587, 0.114));
// 3. glyph index (corrected spread; swap for the faithful step if chosen)
float idx = clamp(floor(luma * 93.0), 0.0, 92.0);
// 4. map the within-cell uv into that glyph's sub-rect of the strip atlas
vec2 auv = vec2((idx + inCell.x) / 93.0, inCell.y);
float ink = texture(u_atlas, auv).a; // glyph coverage 0..1
// 5. compose: glyph tinted by source colour (true-colour mode) over background
vec3 col = (u_mono > 0.5) ? (u_accent * ink) : (src * ink);
fragColor = vec4(col, 1.0);
```

Cell aspect: monospace glyph cells are about 0.5 wide-to-tall, so to keep glyphs
unstretched derive `rows` from `cols`, the canvas aspect, and the glyph aspect:
`rows = round(cols * (canvasH / canvasW) * (glyphW / glyphH))`. Expose `cols`
(density) as the user control and compute `rows`.

Color modes mirror ASCILINE: a true-color mode (tint each glyph by its source
pixel, the default) and a mono mode (a single accent color, the classic terminal
look), toggled by `u_mono` with a `u_accent` color.

## Audio reactivity

Cheap, shader-uniform-only, using the bands the renderer already provides
(`u_bass/u_mid/u_high/u_volume`):

- Bass drives glyph density: nudge `u_cols` (or a within-cell scale) on bass so the
  type grid breathes with the kick.
- High band lifts ink brightness or adds a faint per-cell jitter for sparkle.
- The "dynamic font-size" idea from the roadmap becomes a per-cell scale on `inCell`
  driven by `bass`, so loud cells render larger glyphs.

## Out of scope for this base source

- The adaptive frame codec (`codec.py` / `codec.js`, RAW/ZLIB/DELTA): that is a
  WebSocket transport optimization for ASCILINE's streaming path and is irrelevant
  to a local GLSL render. It is a separate, optional reuse for VJ thumbnails or the
  watch-link feed later.
- Depth-aware glyph density (pick the glyph by depth instead of luminance for a
  self-shading volumetric ASCII portrait): that is the glyph-skin / body-cloud
  combination in the next-block plan, a later item that needs the segmentation
  matte or the depth cloud.

## The six VJ seams (when built)

Same cameraSource pattern as the shader and spectra sources: add `'asciiline'` to
the `types.ts` union plus `asciiCols` / `asciiMono` / `asciiAccent` state fields and
defaults; the `useMedia.ts` guard, positional stream param, genStream ternary, and
dep array; the `App.tsx` `useAsciiline` hook, `useMedia` arg, and SourcePreview; and
a `VJControls.tsx` SOURCE chip plus a sub-panel (density slider, mono/true-color
toggle, accent color), all ARIA-labelled, Tailwind v4 forms only.
