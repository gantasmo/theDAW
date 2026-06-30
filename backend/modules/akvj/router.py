"""FastAPI router for the AKVJ module — a Unity-desktop / native-Kinect -> VJ bridge.

Two senders feed the same relay, and the relay forwards their binary messages
verbatim, so it never has to understand the payload:

1. The legacy MJPEG path (Unity Akvj, the maximal-look techie hatch): a Unity
   desktop app JPEG-encodes its rendered view each frame and pushes the frames to
   ``/ws/source``. The VJ ``useAkvj`` hook decodes them as a flat video.

2. The native ``akvj3d`` path (the idiotproof default): a headless Python sidecar
   (pyk4a) opens the Azure Kinect directly and streams a one-time XY unprojection
   table plus per-frame depth16 + depth-aligned color, framed with a small ``AKV1``
   header. The VJ ``useAkvj3d`` hook unprojects that into a live three.js point
   cloud, so the VJ deck owns the look (re-light, point size, noise displacement,
   audio reactivity) instead of receiving pre-rendered pixels.

The relay only peeks at the 5-byte ``AKV1`` header to tell the two table-chunk
messages (which a late-joining viewer must be primed with) apart from frames. A
plain JPEG frame has no ``AKV1`` magic, so the MJPEG path is unaffected.

Endpoints (prefix /api/akvj):
    GET  /status      source/viewer/frame counters
    GET  /sidecar     native Kinect sidecar lifecycle state
    POST /start       lazily spawn the native Kinect sidecar (guarded)
    POST /stop        stop the native Kinect sidecar
    WS   /ws/source   the sender: binary messages are JPEG frames or AKV1 frames
    WS   /ws/view     a VJ viewer: primed with the XY table + latest frame
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

from fastapi import APIRouter, Body, WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

router = APIRouter(tags=["akvj"])

# Native-path framing. A message is an AKV1 message when it starts with this
# magic; byte 4 is the message type. Type 1 = XY unprojection table chunk (the
# relay caches these so late joiners can rebuild the full table); any other type
# (2 = depth+color frame) is treated like a plain frame and only the latest is
# kept. A legacy MJPEG JPEG frame lacks the magic and falls through to "frame".
_MAGIC = b"AKV1"
_MSG_TABLE = 1


def _is_table_chunk(data: bytes) -> bool:
    return len(data) >= 5 and data[:4] == _MAGIC and data[4] == _MSG_TABLE


def _table_row_start(data: bytes) -> Optional[int]:
    """rowStart field of an AKV1 table chunk header (uint16 LE at offset 10).

    Header: 4s magic, B type, B version, H width, H height, H rowStart, H rowCount.
    """
    if len(data) < 14:
        return None
    return int.from_bytes(data[10:12], "little")


class _State:
    viewers: set[WebSocket] = set()
    source: Optional[WebSocket] = None
    latest: Optional[bytes] = None  # most recent frame (JPEG or AKV1), for priming
    # XY table chunks keyed by rowStart, so a late-joining viewer can be primed
    # with the whole table without waiting for the next heartbeat resend.
    table_chunks: dict[int, bytes] = {}
    frames: int = 0
    last_frame_at: float = 0.0


_s = _State()


def source_connected() -> bool:
    """Whether a sender currently holds /ws/source. Used by the sidecar start
    guard so it never spawns a second process that would fight for the USB
    device that a running Unity Akvj (or a remote Kinect PC) already owns."""
    return _s.source is not None


async def _broadcast(frame: bytes) -> None:
    if not _s.viewers:
        return
    dead: list[WebSocket] = []
    for ws in list(_s.viewers):
        try:
            await ws.send_bytes(frame)
        except Exception:  # noqa: BLE001 — viewer went away mid-send
            dead.append(ws)
    for d in dead:
        _s.viewers.discard(d)


@router.get("/status")
async def get_status() -> dict[str, Any]:
    now = time.monotonic()
    return {
        "source_connected": _s.source is not None,
        "viewers": len(_s.viewers),
        "frames": _s.frames,
        "have_frame": _s.latest is not None,
        "have_table": len(_s.table_chunks) > 0,
        "table_chunks": len(_s.table_chunks),
        "stale_ms": int((now - _s.last_frame_at) * 1000) if _s.last_frame_at else None,
    }


@router.get("/sidecar")
def sidecar_status() -> dict[str, Any]:
    """Native Kinect sidecar lifecycle state (separate from the relay counters)."""
    from .sidecar import get_sidecar

    return get_sidecar().status()


@router.post("/start")
def start(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """Lazily spawn the native Kinect sidecar.

    Idempotent: if OUR sidecar is already running, reuse it and return its status
    (selecting the Kinect source again must not respawn or report contention). Only
    refuse when a FOREIGN source (a running Unity Akvj or a remote Kinect PC) holds
    the relay, since the local sidecar would fight it for the USB device. The body
    may carry {ws_url?, fps?} overrides for the techie escape hatch."""
    from .sidecar import get_sidecar

    sc = get_sidecar()
    # Our own sidecar is already up -> idempotent reuse. This is the fix for the
    # "device in use everywhere" report: re-selecting the Kinect source used to see
    # the sidecar's own relay connection as contention and refuse.
    if sc.running:
        st = sc.status()
        st["ok"] = True
        st["reused"] = True
        return st
    # A foreign source already holds the relay/device; refuse cleanly.
    if source_connected():
        return {
            "ok": False,
            "error": (
                "A foreign source is already streaming to this relay (Unity Akvj or "
                "a remote Kinect feed). Stop it before starting the local Kinect "
                "sidecar so they do not fight for the device."
            ),
            "source_connected": True,
        }
    overrides = payload if isinstance(payload, dict) else {}
    return sc.start(overrides)


@router.post("/stop")
def stop() -> dict[str, Any]:
    from .sidecar import get_sidecar

    return get_sidecar().stop()


@router.websocket("/ws/source")
async def ws_source(websocket: WebSocket) -> None:
    """The sender (Unity MJPEG or the native Kinect sidecar). Binary messages are
    frames; text is ignored (keepalive). Only one source is active at a time — a
    reconnecting sender supersedes the previous one and resets the cached table."""
    await websocket.accept()
    prev = _s.source
    _s.source = websocket
    # A fresh source means a fresh (or no) XY table; drop the previous one so a
    # stale table from an earlier session cannot mis-place the new cloud.
    _s.table_chunks = {}
    if prev is not None and prev is not websocket:
        try:
            await prev.close()
        except Exception:  # noqa: BLE001
            pass
    log.info("akvj: source connected")
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is None:
                continue  # ignore stray text frames (keepalive, etc.)
            if _is_table_chunk(data):
                row = _table_row_start(data)
                if row is not None:
                    _s.table_chunks[row] = data
                await _broadcast(data)
                continue
            _s.latest = data
            _s.frames += 1
            _s.last_frame_at = time.monotonic()
            await _broadcast(data)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001 — sender went away mid-frame
        log.debug("akvj: source error: %s", e)
    finally:
        if _s.source is websocket:
            _s.source = None
        log.info("akvj: source disconnected")


@router.websocket("/ws/view")
async def ws_view(websocket: WebSocket) -> None:
    """A VJ viewer. Primed with the cached XY table chunks (native path) then the
    latest frame, so it can rebuild the cloud immediately on a late join."""
    await websocket.accept()
    _s.viewers.add(websocket)
    try:
        for row in sorted(_s.table_chunks):
            await websocket.send_bytes(_s.table_chunks[row])
        if _s.latest is not None:
            await websocket.send_bytes(_s.latest)
    except Exception:  # noqa: BLE001 — viewer went away immediately
        _s.viewers.discard(websocket)
        return
    try:
        # One-way (source -> viewer); await to detect the viewer closing.
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.debug("akvj: viewer error: %s", e)
    finally:
        _s.viewers.discard(websocket)
