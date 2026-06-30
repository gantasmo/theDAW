"""End-to-end tests for the /api/library router."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from tests.test_library_store import _seed_generate_entry


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    """Build a fresh app with the library router pointing at tmp_path. Resets
    the lazily-cached store so each test gets its own filesystem fixture."""
    # Force the module-level store to be re-created.
    monkeypatch.setattr(library_router_module, "_store", None)
    # Override the root via env var (default_library_root() honors it).
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))

    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def test_list_entries_endpoint_returns_empty_when_root_is_fresh(
    client_with_root, tmp_path
):
    r = client_with_root.get("/api/library/entries")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 0
    assert body["entries"] == []
    assert str(tmp_path) in body["root"]


def test_list_entries_includes_seeded_generation(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_test", 0, extra_meta={"prompt": "endpoint"})

    r = client_with_root.get("/api/library/entries")
    assert r.status_code == 200
    body = r.json()

    assert body["count"] == 1
    assert body["entries"][0]["id"] == "job_test_00"
    assert body["entries"][0]["prompt"] == "endpoint"
    assert body["entries"][0]["audio_url"] == "/api/library/audio/job_test_00"


def test_get_single_entry_endpoint(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_solo", 0)
    r = client_with_root.get("/api/library/entries/job_solo_00")
    assert r.status_code == 200
    assert r.json()["id"] == "job_solo_00"


def test_get_missing_entry_returns_404(client_with_root):
    r = client_with_root.get("/api/library/entries/no-such-entry")
    assert r.status_code == 404


def test_stream_audio_endpoint_returns_file_bytes(client_with_root, tmp_path):
    audio = b"RIFF\x00\x00\x00\x00WAVEdata fake"
    _seed_generate_entry(tmp_path, "job_audio", 0, audio_bytes=audio)

    r = client_with_root.get("/api/library/audio/job_audio_00")
    assert r.status_code == 200
    assert r.content == audio
    assert "audio" in r.headers.get("content-type", "")


def test_patch_entry_updates_favorite_and_tags(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_patch", 0)

    r = client_with_root.patch(
        "/api/library/entries/job_patch_00",
        json={"favorite": True, "tags": ["alpha", "beta"], "notes": "hello"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["favorite"] is True
    assert body["tags"] == ["alpha", "beta"]
    assert body["notes"] == "hello"

    # Persistence check via fresh GET.
    r2 = client_with_root.get("/api/library/entries/job_patch_00")
    assert r2.json()["favorite"] is True


def test_patch_does_not_modify_backend_owned_fields(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_lock", 0, extra_meta={"prompt": "original"})

    r = client_with_root.patch(
        "/api/library/entries/job_lock_00",
        json={"prompt": "should not change", "favorite": True},
    )
    assert r.status_code == 200
    assert r.json()["prompt"] == "original"
    assert r.json()["favorite"] is True


def test_delete_entry_removes_from_disk(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_del", 0)
    r = client_with_root.delete("/api/library/entries/job_del_00")
    assert r.status_code == 200

    listed = client_with_root.get("/api/library/entries").json()
    assert listed["count"] == 0


def test_import_endpoint_creates_entry(client_with_root, tmp_path):
    audio = b"RIFF\x00\x00\x00\x00WAVEdata imported"
    r = client_with_root.post(
        "/api/library/import",
        files={"file": ("song.wav", audio, "audio/wav")},
        data={"metadata": json.dumps({"title": "From bucket", "source": "import"})},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "From bucket"
    assert body["source"] == "import"
    assert body["file_size_bytes"] == len(audio)

    # The streamed audio should round-trip.
    audio_r = client_with_root.get(body["audio_url"])
    assert audio_r.status_code == 200
    assert audio_r.content == audio


def test_import_endpoint_rejects_invalid_metadata_json(client_with_root):
    r = client_with_root.post(
        "/api/library/import",
        files={"file": ("song.wav", b"abc", "audio/wav")},
        data={"metadata": "{not valid"},
    )
    assert r.status_code == 400


def test_import_endpoint_rejects_empty_file(client_with_root):
    r = client_with_root.post(
        "/api/library/import",
        files={"file": ("song.wav", b"", "audio/wav")},
        data={"metadata": "{}"},
    )
    assert r.status_code == 400


def test_stream_stem_audio_endpoint_serves_stem_bytes(client_with_root, tmp_path):
    """The /api/library/stems/{stem_id}/audio route lets the frontend
    fetch one separated stem's WAV bytes for the editor / init / inpaint
    pipelines without an in-memory copy. Test that the path-to-bytes
    round-trip works."""
    _seed_generate_entry(tmp_path, "job_stems", 0)
    # Write a fake stem file in the entry dir + register it in the DB
    # so the endpoint can resolve it.
    entry_dir = tmp_path / "job_stems_00"
    if not entry_dir.is_dir():
        entry_dir = tmp_path / "job_stems" / "00"
    stems_dir = entry_dir / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    stem_bytes = b"RIFF\x00\x00\x00\x00WAVEdata fake-bass"
    stem_path = stems_dir / "bass.wav"
    stem_path.write_bytes(stem_bytes)

    store = library_router_module.get_store()
    assert store.db is not None
    store.db.add_stem(
        stem_id="job_stems_00__bass",
        entry_id="job_stems_00",
        stem_name="bass",
        audio_path=str(stem_path),
        file_size_bytes=len(stem_bytes),
        model="demucs",
        model_variant="4-stem",
    )

    r = client_with_root.get("/api/library/stems/job_stems_00__bass/audio")
    assert r.status_code == 200
    assert r.content == stem_bytes
    assert "audio" in r.headers.get("content-type", "")


def test_stream_stem_audio_endpoint_404_for_unknown_stem(client_with_root):
    r = client_with_root.get("/api/library/stems/does-not-exist/audio")
    assert r.status_code == 404


def test_list_entries_attaches_analysis_and_embedded_tags(client_with_root, tmp_path):
    """Regression for the analytics-surfacing fix: the /entries payload must
    carry the stored musical analysis + embedded file tags so the Catalogue
    inspector (which reads ``entry.analysis`` / ``entry.embedded_tags``) and the
    library search can render/use them. An entry WITHOUT an analysis row must
    stay untouched — no empty ``analysis`` key."""
    _seed_generate_entry(tmp_path, "job_anal", 0)
    _seed_generate_entry(tmp_path, "job_plain", 0)

    # First list registers the on-disk entries into the DB — the FK target the
    # analysis row references (foreign_keys is ON).
    client_with_root.get("/api/library/entries")

    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "job_anal_00",
        {
            "bpm": 120.0,
            "key": "C",
            "scale": "major",
            "key_confidence": 0.9,
            "semantic_tags": ["warm", "ambient"],
            "embedded_tags": {"artist": "Tester", "play_count": 7},
            "ffprobe": {"_summary": {"sample_rate": 44100, "codec": "pcm_s16le"}},
            "version": 2,
        },
    )

    body = client_with_root.get("/api/library/entries").json()
    by_id = {e["id"]: e for e in body["entries"]}

    enriched = by_id["job_anal_00"]
    assert enriched["analysis"]["bpm"] == 120.0
    assert enriched["analysis"]["key"] == "C"
    assert enriched["analysis"]["scale"] == "major"
    assert enriched["analysis"]["semantic_tags"] == ["warm", "ambient"]
    # ffprobe `_summary` technicals are flattened onto the analysis dict.
    assert enriched["analysis"]["sample_rate"] == 44100
    assert enriched["analysis"]["codec"] == "pcm_s16le"
    # Embedded ID3/Vorbis tags surface under their own key.
    assert enriched["embedded_tags"] == {"artist": "Tester", "play_count": 7}

    # The un-analyzed entry must NOT gain empty analysis / embedded_tags keys.
    plain = by_id["job_plain_00"]
    assert "analysis" not in plain
    assert "embedded_tags" not in plain


def test_single_entry_endpoint_attaches_analysis(client_with_root, tmp_path):
    """The per-id endpoint enriches via the targeted single-row lookup
    (``_attach_analysis_one``), not the whole-table bulk path."""
    _seed_generate_entry(tmp_path, "job_one", 0)
    client_with_root.get("/api/library/entries")

    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis("job_one_00", {"bpm": 90.0, "key": "A"})

    data = client_with_root.get("/api/library/entries/job_one_00").json()
    assert data["analysis"]["bpm"] == 90.0
    assert data["analysis"]["key"] == "A"
