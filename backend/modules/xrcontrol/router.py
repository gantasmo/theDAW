"""FastAPI router for the XR control bus (spatialization P0).

A transport-only relay between theDAW (the browser, which owns the control
manifest and the wired setters) and a theDAW-XR headset (which requests the
manifest and sends control changes). The relay holds no manifest and no control
state: it forwards each JSON frame to every OTHER connected peer, so the browser
host and the XR controller exchange messages without the backend understanding
them.

Endpoints (prefix /api/xr/control):
    GET  /status   connected-peer count
    WS   /ws       peer relay (browser host <-> XR controller)

Message shapes (defined by the manifest contract in the frontend, not enforced
here):
    host -> controller : {"type":"manifest", "version":N, "entries":[...]}
                         {"type":"control-changed", "id":..., "value":...}
    controller -> host : {"type":"request-controls"}
                         {"type":"control-set", "id":..., "value":...}
                         {"type":"pad"|"jog"|"trigger", ...}
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

router = APIRouter(tags=["xrcontrol"])

# Every connected peer (browser hosts and XR controllers alike). A frame from
# any peer is relayed to all the others. Single-host is the intended topology;
# extra hosts would each apply inbound control-sets, which is idempotent.
_clients: set[WebSocket] = set()


@router.get("/status")
async def status() -> dict:
    return {"clients": len(_clients)}


async def _relay(origin: WebSocket, msg: object) -> None:
    """Forward one frame to every peer except its sender."""
    dead: list[WebSocket] = []
    for peer in list(_clients):
        if peer is origin:
            continue
        try:
            await peer.send_json(msg)
        except Exception:  # noqa: BLE001 — drop peers that went away
            dead.append(peer)
    for d in dead:
        _clients.discard(d)


@router.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    _clients.add(websocket)
    log.info("xrcontrol: peer connected (%d total)", len(_clients))
    try:
        while True:
            msg = await websocket.receive_json()
            await _relay(websocket, msg)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001 — peer went away mid-message
        log.debug("xrcontrol: ws error: %s", e)
    finally:
        _clients.discard(websocket)
        log.info("xrcontrol: peer disconnected (%d total)", len(_clients))
