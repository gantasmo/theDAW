"""Legacy UI model IDs must not leak into Gemini completion requests.

Run without the audio-model fixtures: python -m unittest tests.test_assistant_gemini_alias
All HTTP traffic is intercepted by MockTransport; no real keys or API calls.
"""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from backend import assistant_routes as routes


class GeminiAliasTests(unittest.IsolatedAsyncioTestCase):
    async def stream(self, model=None, provider="gemini", reject_tools=False):
        requests = []

        def respond(request):
            body = json.loads(request.content)
            requests.append((request, body))
            if reject_tools and "tools" in body:
                return httpx.Response(400, text="Function calling is not supported")
            # Reproduce Google's rejection of the application's legacy UI alias.
            if provider == "gemini" and body["model"] == "gemini-flash-recent":
                return httpx.Response(404, json={"error": {"status": "NOT_FOUND"}})
            return httpx.Response(
                200,
                text='data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n',
            )

        client_class = httpx.AsyncClient
        transport = httpx.MockTransport(respond)
        pool = MagicMock()
        pool.get_raw_keys.return_value = ["test-key-not-real"]
        with (
            patch.object(routes, "key_pool", pool),
            patch.object(routes, "_get_api_key", return_value="test-key-not-real"),
            patch.object(
                routes.httpx,
                "AsyncClient",
                side_effect=lambda **kw: client_class(transport=transport, **kw),
            ),
        ):
            req = routes.ChatRequest(
                provider=provider,
                model=model,
                messages=[routes.ChatMessage(role="user", content="hello")],
            )
            peer = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
            frames = [
                json.loads(frame.removeprefix("data: ").strip())
                async for frame in routes._stream_openai_compat(req, peer, provider)
            ]
        return requests, frames

    async def test_default_gemini_model_uses_documented_latest_alias(self):
        requests, frames = await self.stream()
        self.assertEqual(requests[0][1]["model"], "gemini-flash-latest")
        self.assertEqual(
            str(requests[0][0].url),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        )
        self.assertIn({"type": "text_delta", "delta": "hello"}, frames)
        self.assertFalse(any(f["type"] == "error" for f in frames))

    async def test_saved_legacy_alias_is_translated(self):
        requests, frames = await self.stream("gemini-flash-recent")
        self.assertEqual(requests[0][1]["model"], "gemini-flash-latest")
        self.assertEqual(frames[-1]["type"], "done")
        self.assertFalse(any(f["type"] == "error" for f in frames))

    async def test_explicit_model_selection_is_preserved(self):
        for model in ("gemini-flash-latest", "gemini-3.8-flash", "custom-model"):
            with self.subTest(model=model):
                requests, _ = await self.stream(model)
                self.assertEqual(requests[0][1]["model"], model)

    async def test_other_providers_do_not_rewrite_model_ids(self):
        requests, _ = await self.stream("gemini-flash-recent", provider="openai")
        self.assertEqual(requests[0][1]["model"], "gemini-flash-recent")

    async def test_tool_compatibility_retry_uses_resolved_model(self):
        requests, frames = await self.stream("gemini-flash-recent", reject_tools=True)
        self.assertEqual(len(requests), 2)
        self.assertIn("tools", requests[0][1])
        self.assertNotIn("tools", requests[1][1])
        self.assertEqual(
            [body["model"] for _, body in requests], ["gemini-flash-latest"] * 2
        )
        self.assertIn({"type": "text_delta", "delta": "hello"}, frames)


if __name__ == "__main__":
    unittest.main()
