"""Import a VST Foundry project export into a .gan web plugin.

A VST Foundry export is a ``project.json`` (a flat list of absolutely-positioned
UI elements) plus a ``background.png``. Most elements are ``CustomCode`` (a
self-contained ``<script>`` that fills its window and posts
``{type:'updateValue', id, ...}`` to ``window.parent``); one is a native
``Knob``. This composes those into a single responsive ``index.html`` that:

  * lays each element out by percentage over the background (so it scales to the
    MIX stage while staying aligned to the artwork),
  * mounts each ``CustomCode`` element in its own iframe (``el_<id>.html``) so its
    full-document assumptions hold, and
  * relays every child ``updateValue`` message up to theDAW (the grand-parent).

The result is a controller-kind .gan: it emits control values, it does not
process audio.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path

from backend.modules.plugin.gan_manifest import (
    GanCanvas,
    GanControl,
    GanManifest,
)

log = logging.getLogger(__name__)

_DEFAULT_W = 1672.0
_DEFAULT_H = 941.0


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.strip().lower()).strip("-")
    return s or "plugin"


def _png_size(data: bytes) -> tuple[int, int] | None:
    """Parse width/height from a PNG IHDR header, or None if not a PNG."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    if data[12:16] != b"IHDR":
        return None
    w = int.from_bytes(data[16:20], "big")
    h = int.from_bytes(data[20:24], "big")
    if w <= 0 or h <= 0:
        return None
    return w, h


def _el_doc(custom_code: str) -> str:
    """Wrap a CustomCode body as a standalone, transparent full-window document."""
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        "<style>html,body{margin:0;padding:0;overflow:hidden;width:100%;height:100%;"
        "background:transparent}</style></head><body>" + custom_code + "</body></html>"
    )


def _knob_html(el: dict, idx: int) -> str:
    """Render a native VST Foundry Knob as a minimal, draggable rotary that posts
    its 0..1 value to the host. Drag up/down to adjust."""
    eid = str(el.get("id") or f"knob{idx}")
    glow = str(el.get("glowColor") or "#888888")
    active = str(el.get("activeColor") or "#666666")
    default = float(el.get("value", 0.0) or 0.0)
    knob_id = f"gan-knob-{eid}"
    return (
        f'<div class="gan-knob" id="{knob_id}" '
        f'role="slider" aria-label="Knob {eid}" tabindex="0" '
        f'aria-valuemin="0" aria-valuemax="1" aria-valuenow="{default}" '
        f'style="--gan-glow:{glow};--gan-active:{active}">'
        f'<span class="gan-knob-ind"></span></div>'
        "<script>(function(){"
        f"var el=document.getElementById('{knob_id}');var id='{eid}';"
        f"var v={default};var dragging=false,sy=0,sv=0;"
        "function clamp(x){return x<0?0:(x>1?1:x);}"
        "function render(){el.style.transform='rotate('+(-135+v*270)+'deg)';"
        "el.setAttribute('aria-valuenow',v.toFixed(3));}"
        "function emit(){window.parent.postMessage({type:'updateValue',id:id,value:v},'*');}"
        "el.addEventListener('pointerdown',function(e){dragging=true;sy=e.clientY;sv=v;"
        "try{el.setPointerCapture(e.pointerId);}catch(_){}});"
        "window.addEventListener('pointermove',function(e){if(!dragging)return;"
        "v=clamp(sv+(sy-e.clientY)/200);render();emit();});"
        "window.addEventListener('pointerup',function(){dragging=false;});"
        "el.addEventListener('keydown',function(e){var s=0;"
        "if(e.key==='ArrowUp'||e.key==='ArrowRight')s=0.02;"
        "if(e.key==='ArrowDown'||e.key==='ArrowLeft')s=-0.02;"
        "if(s){e.preventDefault();v=clamp(v+s);render();emit();}});"
        "render();})();</script>"
    )


def _wrapper_style(el: dict, w: float, h: float) -> str:
    x = float(el.get("x", 0) or 0)
    y = float(el.get("y", 0) or 0)
    ew = float(el.get("width", 0) or 0)
    eh = float(el.get("height", 0) or 0)
    left = (x / w * 100) if w else 0
    top = (y / h * 100) if h else 0
    pw = (ew / w * 100) if w else 0
    ph = (eh / h * 100) if h else 0
    style = (
        f"position:absolute;left:{left:.4f}%;top:{top:.4f}%;"
        f"width:{pw:.4f}%;height:{ph:.4f}%;"
    )
    blend = el.get("blendMode")
    if blend and blend != "normal":
        style += f"mix-blend-mode:{blend};"
    return style


def import_vst_foundry(
    project_json_path: str,
    *,
    name: str | None = None,
    plugin_id: str | None = None,
    background_path: str | None = None,
    exclude_substrings: list[str] | None = None,
) -> tuple[GanManifest, dict[str, bytes]]:
    """Parse a VST Foundry export and return (manifest, assets) for GanFile.save."""
    pj_path = Path(project_json_path)
    if not pj_path.is_file():
        raise FileNotFoundError(f"project.json not found: {project_json_path}")

    raw = pj_path.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    elements = data.get("elements", [])
    if not isinstance(elements, list):
        raise ValueError("Invalid VST Foundry export: 'elements' is not a list")

    assets: dict[str, bytes] = {}

    # Canvas dimensions: prefer the background image's real pixel size (keeps the
    # percentage layout aligned to the artwork), then explicit canvas fields,
    # then element extents, then the documented default.
    bg_name = str(data.get("background") or "background.png")
    bg_path = Path(background_path) if background_path else (pj_path.parent / bg_name)
    canvas_w = canvas_h = None
    if bg_path.is_file():
        bg_bytes = bg_path.read_bytes()
        assets["background.png"] = bg_bytes
        size = _png_size(bg_bytes)
        if size:
            canvas_w, canvas_h = float(size[0]), float(size[1])
    if canvas_w is None:
        canvas_w = float(data.get("canvasWidth") or data.get("width") or 0) or None
        canvas_h = float(data.get("canvasHeight") or data.get("height") or 0) or None
    if canvas_w is None or canvas_h is None:
        max_x = max(
            (
                float(e.get("x", 0) or 0) + float(e.get("width", 0) or 0)
                for e in elements
            ),
            default=0,
        )
        max_y = max(
            (
                float(e.get("y", 0) or 0) + float(e.get("height", 0) or 0)
                for e in elements
            ),
            default=0,
        )
        canvas_w = canvas_w or max_x or _DEFAULT_W
        canvas_h = canvas_h or max_y or _DEFAULT_H

    has_bg = "background.png" in assets
    controls: list[GanControl] = []
    body_parts: list[str] = []

    for idx, el in enumerate(elements):
        etype = str(el.get("type") or "")
        eid = str(el.get("id") or f"el{idx}")
        ename = str(el.get("name") or eid)
        if exclude_substrings and any(
            s.lower() in ename.lower() for s in exclude_substrings
        ):
            continue
        style = _wrapper_style(el, canvas_w, canvas_h)

        if etype == "CustomCode":
            code = str(el.get("customCode") or "")
            asset_name = f"el_{eid}.html"
            assets[asset_name] = _el_doc(code).encode("utf-8")
            body_parts.append(
                f'<div class="gan-el" style="{style}">'
                f'<iframe class="gan-frame" src="{asset_name}" '
                f'title="{ename}" scrolling="no"></iframe></div>'
            )
            kind = "xy" if "valueX" in code else "value"
            controls.append(GanControl(id=eid, name=ename, kind=kind))
        elif etype == "Knob":
            body_parts.append(
                f'<div class="gan-el gan-knob-wrap" style="{style}">'
                f"{_knob_html(el, idx)}</div>"
            )
            controls.append(GanControl(id=eid, name=ename, kind="value"))
        else:
            # Unknown native type — render a labelled placeholder rather than
            # silently dropping it, so nothing disappears without a trace.
            log.info("owl import: unhandled element type %r (%s)", etype, eid)
            body_parts.append(
                f'<div class="gan-el gan-unknown" style="{style}" '
                f'title="{ename} ({etype})"></div>'
            )

    index_html = _compose_index(canvas_w, canvas_h, has_bg, body_parts)
    assets["index.html"] = index_html.encode("utf-8")

    disp_name = name or pj_path.parent.name or "Owl Tool"
    pid = plugin_id or f"{_slug(disp_name)}-{hashlib.sha256(raw).hexdigest()[:8]}"
    manifest = GanManifest(
        id=pid,
        name=disp_name,
        description="Imported from a VST Foundry export.",
        kind="controller",
        canvas=GanCanvas(width=canvas_w, height=canvas_h),
        controls=controls,
        source="vst-foundry",
    )
    return manifest, assets


def _compose_index(w: float, h: float, has_bg: bool, body_parts: list[str]) -> str:
    bg_css = (
        "background:url(background.png) 0 0/100% 100% no-repeat;"
        if has_bg
        else "background:#0a0a0f;"
    )
    head = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<style>"
        "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;"
        "background:#07080c;}"
        "#gan-stage{position:absolute;inset:0;display:flex;align-items:center;"
        "justify-content:center;}"
        f"#gan-canvas{{position:relative;aspect-ratio:{w:.0f}/{h:.0f};"
        "width:100%;height:100%;max-width:100%;max-height:100%;"
        f"{bg_css}}}"
        ".gan-el{box-sizing:border-box;}"
        ".gan-frame{width:100%;height:100%;border:0;display:block;background:transparent;}"
        ".gan-knob-wrap{display:flex;align-items:center;justify-content:center;}"
        ".gan-knob{width:80%;height:80%;border-radius:50%;cursor:ns-resize;"
        "background:radial-gradient(circle at 50% 40%,var(--gan-active),#111);"
        "box-shadow:0 0 18px var(--gan-glow);display:flex;align-items:flex-start;"
        "justify-content:center;touch-action:none;}"
        ".gan-knob-ind{width:3px;height:38%;margin-top:8%;border-radius:2px;"
        "background:#fff;box-shadow:0 0 6px var(--gan-glow);}"
        ".gan-unknown{border:1px dashed rgba(255,255,255,0.15);border-radius:4px;}"
        "</style></head><body>"
    )
    relay = (
        "<script>window.addEventListener('message',function(e){"
        "var d=e.data;"
        "if(d&&d.type==='updateValue'){window.parent.postMessage(d,'*');}"
        "});</script>"
    )
    body = (
        '<div id="gan-stage"><div id="gan-canvas">'
        + "".join(body_parts)
        + "</div></div>"
        + relay
        + "</body></html>"
    )
    return head + body
