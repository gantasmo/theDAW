"""Tests for the model-download job registry (backend.modules.modeldl.router).

``huggingface_hub.hf_hub_download`` is monkeypatched in the router namespace so
no network call or weight download ever happens. The download pool is real, so
each test that starts a job polls for the terminal state with a timeout to stay
deterministic without sleeping on a fixed delay.
"""

from __future__ import annotations

import io
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.modeldl import router as modeldl


@pytest.fixture
def client(monkeypatch):
    """A TestClient over an app that mounts only the modeldl router.

    The registry is reset before and after each test so jobs never leak between
    cases (it is module-global, shared with the live app).
    """
    with modeldl._LOCK:
        modeldl._REGISTRY.clear()

    app = FastAPI()
    app.include_router(modeldl.router, prefix="/api/models")
    with TestClient(app) as test_client:
        yield test_client

    with modeldl._LOCK:
        modeldl._REGISTRY.clear()


def _wait_for_status(
    client: TestClient, job_id: str, target: str, timeout: float = 5.0
):
    """Poll GET /downloads until the job reaches ``target`` or ``timeout`` elapses."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        jobs = client.get("/api/models/downloads").json()["jobs"]
        last = next((j for j in jobs if j["id"] == job_id), None)
        if last is not None and last["status"] == target:
            return last
        time.sleep(0.02)
    raise AssertionError(
        f"job {job_id} did not reach {target!r} within {timeout}s; last={last!r}"
    )


def _first_catalog_name() -> str:
    return next(iter(modeldl.all_models))


def test_download_unknown_name_returns_404(client):
    resp = client.post("/api/models/not-a-real-model/download")
    assert resp.status_code == 404


def test_download_valid_name_reaches_done(client, monkeypatch):
    calls: list[tuple[str, str]] = []

    def fake_download(*, repo_id, filename, **kwargs):
        calls.append((repo_id, filename))
        # A job-bound _JobTqdm subclass must be forwarded so live progress works.
        tqdm_class = kwargs.get("tqdm_class")
        assert tqdm_class is not None and issubclass(tqdm_class, modeldl._JobTqdm)
        return f"/fake/cache/{repo_id}/{filename}"

    monkeypatch.setattr(modeldl, "hf_hub_download", fake_download)

    name = _first_catalog_name()
    resp = client.post(f"/api/models/{name}/download")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == name
    assert body["status"] in {"queued", "downloading", "done"}
    job_id = body["job_id"]
    assert job_id

    job = _wait_for_status(client, job_id, "done")
    # Both the config file and the checkpoint file were fetched, in that order.
    assert len(calls) == 2
    assert len(job["files"]) == 2
    assert all(f["done"] for f in job["files"])
    assert job["dest_dir"]
    assert job["error_detail"] is None


def test_duplicate_download_while_live_returns_same_job(client, monkeypatch):
    release = threading.Event()
    entered = threading.Event()

    def blocking_download(*, repo_id, filename, **kwargs):
        # Hold the worker inside the first file so the job stays "downloading"
        # for the duration of the duplicate POST, forcing the dedup path.
        entered.set()
        assert release.wait(timeout=5.0), "test never released the blocked download"
        return f"/fake/cache/{repo_id}/{filename}"

    monkeypatch.setattr(modeldl, "hf_hub_download", blocking_download)

    name = _first_catalog_name()
    first = client.post(f"/api/models/{name}/download").json()
    assert entered.wait(timeout=5.0), "worker never started the download"

    second = client.post(f"/api/models/{name}/download").json()
    assert second["job_id"] == first["job_id"]
    assert second["status"] in {"queued", "downloading"}

    # Exactly one job exists for this name while it is live.
    jobs = client.get("/api/models/downloads").json()["jobs"]
    live = [j for j in jobs if j["name"] == name]
    assert len(live) == 1

    release.set()
    _wait_for_status(client, first["job_id"], "done")


def test_download_error_path_records_detail(client, monkeypatch):
    def boom(*, repo_id, filename, **kwargs):
        raise RuntimeError("network exploded")

    monkeypatch.setattr(modeldl, "hf_hub_download", boom)

    name = _first_catalog_name()
    job_id = client.post(f"/api/models/{name}/download").json()["job_id"]

    job = _wait_for_status(client, job_id, "error")
    assert job["status"] == "error"
    assert job["error_detail"] == "network exploded"
    assert job["error_repo_id"] == modeldl._repo_id(modeldl.all_models[name])


def test_clear_removes_finished_jobs(client, monkeypatch):
    monkeypatch.setattr(
        modeldl,
        "hf_hub_download",
        lambda *, repo_id, filename, **kwargs: f"/fake/{repo_id}/{filename}",
    )

    name = _first_catalog_name()
    job_id = client.post(f"/api/models/{name}/download").json()["job_id"]
    _wait_for_status(client, job_id, "done")

    cleared = client.post("/api/models/downloads/clear").json()
    assert cleared["cleared"] == 1

    jobs = client.get("/api/models/downloads").json()["jobs"]
    assert all(j["id"] != job_id for j in jobs)


def test_jobtqdm_publishes_from_foreign_thread():
    """Live progress must update even when tqdm.update() runs on a different
    thread than the worker — as huggingface_hub's Xet backend does. This fails
    with a contextvar-based binding and passes with the job-bound subclass.
    """
    job_id = "foreign-thread-job"
    with modeldl._LOCK:
        modeldl._REGISTRY[job_id] = {
            "id": job_id,
            "name": "x",
            "repo_id": "x/x",
            "label": "X",
            "status": "downloading",
            "files": [
                {
                    "filename": "f",
                    "bytes_done": 0,
                    "bytes_total": 0,
                    "speed": 0.0,
                    "done": False,
                }
            ],
            "current_file": 0,
            "dest_dir": "",
            "error_detail": None,
            "error_repo_id": None,
        }
    try:
        bar = modeldl._bound_tqdm(job_id)(total=100, file=io.StringIO())
        # Drive update() from a foreign thread; a contextvar would not carry here.
        worker = threading.Thread(target=lambda: bar.update(40))
        worker.start()
        worker.join()
        bar.close()

        with modeldl._LOCK:
            entry = modeldl._REGISTRY[job_id]["files"][0]
        assert entry["bytes_done"] == 40
        assert entry["bytes_total"] == 100
    finally:
        with modeldl._LOCK:
            modeldl._REGISTRY.pop(job_id, None)
