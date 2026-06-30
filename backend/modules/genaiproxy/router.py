"""Google Gemini native-REST proxy module.

A thin pass-through layer that forwards any request from theDAW's frontend to
Google's Generative Language API at ``https://generativelanguage.googleapis.com``
while injecting the server-side ``GEMINI_API_KEY`` (the same env var the in-app
assistant uses). The browser never sees the real key.

What this module does:
  - Catches every path + method under its mount and replays it verbatim to
    Google, swapping in the server key as ``x-goog-api-key``.
  - Strips any client-supplied ``key`` query param and ``authorization`` header
    so a frontend placeholder key cannot leak through or override the real one.
  - Returns Google's status, body, and content-type unchanged so the client SDK
    behaves exactly as if it had hit Google directly.

Mounted at /api/genai-proxy by backend/modules/loader.py (api_prefix in
module.json). The APIRouter here has NO prefix — the loader applies it.
"""

from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, Request, Response

router = APIRouter()

UPSTREAM_BASE = "https://generativelanguage.googleapis.com"


@router.api_route("/{rest:path}", methods=["GET", "POST", "OPTIONS"])
async def proxy(rest: str, request: Request) -> Response:
    """Forward any path + method to Google, injecting the server-side key."""
    body = await request.body()
    key = os.environ.get("GEMINI_API_KEY", "")

    if not key:
        return Response(
            status_code=503,
            content=b'{"error":"GEMINI_API_KEY not set on server"}',
            media_type="application/json",
        )

    url = f"{UPSTREAM_BASE}/{rest}"

    # Pass through every query param except any client-supplied ``key``; the real
    # key travels in the ``x-goog-api-key`` header instead.
    params = {k: v for k, v in request.query_params.items() if k.lower() != "key"}

    # Build a clean header set: only the content type and our server key. We
    # deliberately drop the client's authorization header and any placeholder key.
    headers = {
        "content-type": request.headers.get("content-type", "application/json"),
        "x-goog-api-key": key,
    }

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, read=120.0)
        ) as client:
            resp = await client.request(
                method=request.method,
                url=url,
                params=params,
                content=body,
                headers=headers,
            )
    except httpx.HTTPError as e:
        return Response(
            status_code=502,
            content=f'{{"error":{_json_str(str(e))}}}'.encode(),
            media_type="application/json",
        )

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )


def _json_str(s: str) -> str:
    """Encode a string as a JSON string literal (quotes included)."""
    import json

    return json.dumps(s)
