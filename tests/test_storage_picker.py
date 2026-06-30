from types import SimpleNamespace

from backend.modules.storage import router


def test_macos_picker_returns_selected_path(monkeypatch):
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout="/Users/morgan/project.als\n", stderr="")

    monkeypatch.setattr(router.sys, "platform", "darwin")
    monkeypatch.setattr(router.subprocess, "run", fake_run)

    result = router.storage_pick_file()

    assert result == {"path": "/Users/morgan/project.als", "cancelled": False}
    assert calls[0][0][0] == "osascript"
    assert "choose file" in calls[0][0][2]


def test_macos_picker_handles_cancel(monkeypatch):
    def fake_run(*_args, **_kwargs):
        return SimpleNamespace(returncode=1, stdout="", stderr="execution error: User canceled. (-128)")

    monkeypatch.setattr(router.sys, "platform", "darwin")
    monkeypatch.setattr(router.subprocess, "run", fake_run)

    assert router.storage_pick_folder() == {"path": None, "cancelled": True}
