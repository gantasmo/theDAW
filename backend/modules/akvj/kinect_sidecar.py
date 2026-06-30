"""Headless Azure Kinect (K4A) capture sidecar for the native ``akvj3d`` path.

Opens the Azure Kinect directly with pyk4a, builds a one-time XY unprojection ray
table, and streams to the akvj relay's ``/ws/source``:

  * a one-time XY table (sent on connect + a slow heartbeat), chunked into
    row-blocks so each WebSocket message stays under the 1 MB default cap; and
  * per frame, depth16 (640x576) + the depth-aligned colour as JPEG.

The VJ ``akvj3d`` source unprojects ``position = (rayX, rayY, 1) * depthMeters``
in a vertex shader and renders the point cloud, so the look lives in the browser.

Wire format (little-endian), matching backend/modules/akvj/router.py and the VJ
``useAkvj3d`` parser:

  Table chunk:  '<4sBBHHHH' magic="AKV1" type=1 version=1 W H rowStart rowCount
                + float32[rowCount*W*2]   (rayX, rayY interleaved, row-major)
  Frame:        '<4sBBHHBBII' magic="AKV1" type=2 version=1 W H
                depthEnc colorEnc depthLen colorLen
                + depth bytes (uint16 LE mm) + colour bytes (JPEG RGB)

Speaks structured JSON status lines on stdout for the sidecar manager:
  {"status": "device", ...} once the camera opens
  {"status": "streaming", "fps": N, ...} periodically
  {"status": "error", "message": ...} on any fatal problem

Windows x64 / Linux x64 only. pyk4a-bundle ships the matched k4a/depthengine
native DLLs, so nothing else has to be installed.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import struct
import sys
import time

MAGIC = b"AKV1"
MSG_TABLE = 1
MSG_FRAME = 2
VERSION = 1
DEPTH_ENC_RAW_U16 = 0
COLOR_ENC_JPEG = 0
ROWS_PER_CHUNK = 64  # 64 * 640 * 2 * 4 = 327 KB/chunk, safely under the 1 MB cap
TABLE_HEARTBEAT_SEC = 5.0
OPEN_ATTEMPTS = 5  # retry device-open so a brief webcam/other-app hold rides out
OPEN_RETRY_SEC = 1.0


def emit(**kw) -> None:
    """Write one structured status line to stdout for the sidecar manager."""
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()


def _fps_enum(fps_int: int):
    from pyk4a import FPS

    if fps_int <= 5:
        return FPS.FPS_5, 5
    if fps_int <= 15:
        return FPS.FPS_15, 15
    return FPS.FPS_30, 30


def build_xy_table(calibration, width: int, height: int):
    """Per-pixel ray slopes (rayX, rayY) with position = (rayX, rayY, 1)*depth.

    Built once from k4a's 2d->3d unprojection at a reference depth, so the browser
    only needs depth per frame. Invalid pixels get (0, 0) and render at the origin
    (the shader discards zero-depth points anyway). Emits progress because the
    per-pixel build takes a few seconds and would otherwise look like a hang."""
    import numpy as np
    from pyk4a import CalibrationType

    table = np.zeros((height, width, 2), dtype="<f4")
    ref_mm = 1000.0
    step = max(1, height // 10)
    valid = 0
    for y in range(height):
        for x in range(width):
            try:
                p = calibration.convert_2d_to_3d(
                    (x, y), ref_mm, CalibrationType.DEPTH, CalibrationType.DEPTH
                )
            except Exception:  # noqa: BLE001 — invalid pixel, leave (0,0)
                continue
            if p is None:
                continue
            z = float(p[2])
            if z <= 1e-3:
                continue
            table[y, x, 0] = float(p[0]) / z
            table[y, x, 1] = float(p[1]) / z
            valid += 1
        if y % step == 0 or y == height - 1:
            emit(
                status="building_table",
                percent=round((y + 1) * 100 / height),
                rows=y + 1,
                total=height,
            )
    emit(status="table_ready", valid_pixels=valid, total_pixels=width * height)
    return table


def pack_table_chunks(table, width: int, height: int):
    """Yield one AKV1 table-chunk message per row-block."""
    for row in range(0, height, ROWS_PER_CHUNK):
        rows = min(ROWS_PER_CHUNK, height - row)
        header = struct.pack(
            "<4sBBHHHH", MAGIC, MSG_TABLE, VERSION, width, height, row, rows
        )
        payload = table[row : row + rows].tobytes()
        yield header + payload


def encode_color_jpeg(transformed_color, quality: int) -> bytes:
    """BGRA (H,W,4) depth-aligned colour -> JPEG (RGB) bytes."""
    from PIL import Image

    rgb = transformed_color[:, :, :3][:, :, ::-1]  # BGRA -> RGB
    img = Image.fromarray(rgb, "RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def pack_frame(width, height, depth_bytes, color_bytes) -> bytes:
    header = struct.pack(
        "<4sBBHHBBII",
        MAGIC,
        MSG_FRAME,
        VERSION,
        width,
        height,
        DEPTH_ENC_RAW_U16,
        COLOR_ENC_JPEG,
        len(depth_bytes),
        len(color_bytes),
    )
    return header + depth_bytes + color_bytes


async def run() -> None:
    import numpy as np
    import websockets
    from pyk4a import ColorResolution, Config, DepthMode, ImageFormat, PyK4A

    ws_url = os.getenv("AKVJ_WS_URL", "ws://127.0.0.1:8600/api/akvj/ws/source")
    quality = int(os.getenv("AKVJ_COLOR_QUALITY", "70"))
    fps_req = int(os.getenv("AKVJ_FPS", "30"))
    fps_enum, fps_n = _fps_enum(fps_req)

    emit(
        status="opening", ws_url=ws_url, fps=fps_n, color="720p", depth="NFOV_UNBINNED"
    )

    k4a = PyK4A(
        Config(
            color_resolution=ColorResolution.RES_720P,
            color_format=ImageFormat.COLOR_BGRA32,
            depth_mode=DepthMode.NFOV_UNBINNED,  # 640x576
            camera_fps=fps_enum,
            synchronized_images_only=True,
        )
    )
    opened = False
    for attempt in range(1, OPEN_ATTEMPTS + 1):
        try:
            k4a.start()
            opened = True
            emit(status="opened", attempt=attempt)
            break
        except Exception as e:  # noqa: BLE001 — device open failed (in use / unplugged)
            detail = f"{type(e).__name__}: {e}".strip().rstrip(": ")
            emit(
                status="opening",
                attempt=attempt,
                attempts=OPEN_ATTEMPTS,
                retrying=attempt < OPEN_ATTEMPTS,
                note=(
                    f"open failed ({detail or 'no detail'}); the sensor may still be "
                    "releasing from the DEVICE/webcam path or held by another app"
                ),
            )
            if attempt < OPEN_ATTEMPTS:
                time.sleep(OPEN_RETRY_SEC)
    if not opened:
        emit(
            status="error",
            message=(
                f"could not open the Azure Kinect after {OPEN_ATTEMPTS} tries. Check it "
                "is on a USB 3.0 port, powered with its own supply, and not held by the "
                "DEVICE/webcam source, k4aviewer, Unity Akvj, or another app. A fresh "
                "sensor may also need a one-time firmware update."
            ),
        )
        return

    width, height = 640, 576
    emit(
        status="device",
        width=width,
        height=height,
        depth_mode="NFOV_UNBINNED",
        fps=fps_n,
    )

    emit(
        status="building_table",
        percent=0,
        note="one-time XY unprojection table (a few seconds)",
    )
    table = build_xy_table(k4a.calibration, width, height)
    table_msgs = list(pack_table_chunks(table, width, height))
    emit(status="table_packed", chunks=len(table_msgs))

    loop = asyncio.get_event_loop()
    frames = 0
    fps_t0 = time.monotonic()
    fps_count = 0

    emit(status="connecting", ws_url=ws_url)
    try:
        async with websockets.connect(
            ws_url, max_size=None, ping_interval=20, ping_timeout=20
        ) as ws:
            emit(status="relay_connected", ws_url=ws_url)
            for m in table_msgs:
                await ws.send(m)
            last_table = time.monotonic()
            emit(
                status="streaming", fps=0, frames=0, note="sending depth+colour frames"
            )

            while True:
                capture = await loop.run_in_executor(None, k4a.get_capture)
                depth = capture.depth
                color = capture.transformed_color
                if depth is None or color is None:
                    continue

                depth_bytes = np.ascontiguousarray(depth, dtype="<u2").tobytes()
                color_bytes = encode_color_jpeg(color, quality)
                await ws.send(pack_frame(width, height, depth_bytes, color_bytes))

                frames += 1
                fps_count += 1
                now = time.monotonic()
                if now - fps_t0 >= 2.0:
                    fps = round(fps_count / (now - fps_t0))
                    emit(status="streaming", fps=fps, frames=frames)
                    fps_t0 = now
                    fps_count = 0
                if now - last_table >= TABLE_HEARTBEAT_SEC:
                    for m in table_msgs:
                        await ws.send(m)
                    last_table = now
    except Exception as e:  # noqa: BLE001 — relay closed / device error mid-stream
        emit(status="error", message=f"stream ended: {e}")
    finally:
        try:
            k4a.stop()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except Exception as e:  # noqa: BLE001
        emit(status="error", message=str(e))
        sys.exit(1)
