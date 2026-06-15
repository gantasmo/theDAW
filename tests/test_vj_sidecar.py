"""Unit tests for backend.modules.vj.sidecar path resolution."""

from __future__ import annotations

from pathlib import Path

from backend.modules.vj import sidecar


def test_resolve_config_defaults_to_builtin_sidecar(monkeypatch):
    monkeypatch.delenv("theDAW_VJ_PROJECT", raising=False)
    monkeypatch.delenv("theDAW_VJ_PORT", raising=False)

    cfg = sidecar.resolve_config()

    assert cfg.project_path == sidecar.BUILTIN_PROJECT_PATH.resolve()
    assert cfg.project_source == "built-in sidecar"
    assert (cfg.project_path / "package.json").is_file()
    assert cfg.port == sidecar.DEFAULT_PORT


def test_resolve_config_honors_env_project_and_port(monkeypatch, tmp_path: Path):
    project = tmp_path / "vj"
    project.mkdir()
    (project / "package.json").write_text('{"scripts":{"dev":"vite"}}')

    monkeypatch.setenv("theDAW_VJ_PROJECT", str(project))
    monkeypatch.setenv("theDAW_VJ_PORT", "6123")

    cfg = sidecar.resolve_config()

    assert cfg.project_path == project.resolve()
    assert cfg.project_source == "theDAW_VJ_PROJECT"
    assert cfg.port == 6123


def test_probe_reports_project_source(monkeypatch):
    monkeypatch.delenv("theDAW_VJ_PROJECT", raising=False)

    info = sidecar.probe()

    assert info["project_source"] == "built-in sidecar"
    assert info["project_path"] == str(sidecar.BUILTIN_PROJECT_PATH.resolve())
    assert "issues" in info
