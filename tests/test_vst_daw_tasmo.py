"""Smoke tests for the VST / DAW import / .tasmo modules."""

import sys
import os

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def test_daw_models():
    from backend.modules.dawimport.models import DawProject, DawTrack

    p = DawProject(source_daw="ableton", name="Test Project", tempo=140.0)
    assert p.source_daw == "ableton"
    assert p.tempo == 140.0
    assert p.tracks == []
    t = DawTrack(name="Kick", type="audio", volume_db=-3.0)
    p.tracks.append(t)
    d = p.to_dict()
    assert d["tracks"][0]["name"] == "Kick"
    print("  models OK")


def test_tasmo_project():
    from backend.modules.project.tasmo_project import TasmoProject, Track

    p = TasmoProject(project_name="My Song", tempo=128.0)
    assert p.format_version == 1
    assert p.tempo == 128.0
    assert p.time_signature == [4, 4]
    t = Track(id="t1", name="Bass", type="audio")
    p.tracks.append(t)
    d = p.model_dump()
    assert d["tracks"][0]["name"] == "Bass"
    print("  TasmoProject OK")


def test_tasmo_file_roundtrip(tmp_path=None):
    import tempfile
    from backend.modules.project.tasmo_project import TasmoProject, Track
    from backend.modules.project.tasmo_file import TasmoFile

    project = TasmoProject(project_name="Roundtrip Test", tempo=110.0)
    project.tracks.append(Track(id="t1", name="Drums", type="audio"))

    if tmp_path is None:
        tmp_path = tempfile.mkdtemp()
    path = os.path.join(tmp_path, "test.tasmo")

    # Save
    manifest = TasmoFile.save(project, path)
    assert manifest["format"] == "tasmo"
    assert manifest["project_name"] == "Roundtrip Test"
    print("  TasmoFile.save OK")

    # Info (manifest-only read)
    info = TasmoFile.info(path)
    assert info["format_version"] == 1
    print("  TasmoFile.info OK")

    # Load
    loaded, lmanifest = TasmoFile.load(path)
    assert loaded.project_name == "Roundtrip Test"
    assert loaded.tempo == 110.0
    assert len(loaded.tracks) == 1
    assert loaded.tracks[0].name == "Drums"
    print("  TasmoFile.load OK")


def test_tasmo_embed_roundtrip(tmp_path=None):
    import tempfile
    from backend.modules.project.tasmo_project import TasmoProject, Track, Clip
    from backend.modules.project.tasmo_file import TasmoFile

    if tmp_path is None:
        tmp_path = tempfile.mkdtemp()

    # A fake on-disk audio file (embedding stores bytes, does not decode).
    audio_src = os.path.join(tmp_path, "kick.wav")
    payload = b"RIFF....fake-wav-bytes-0123456789"
    with open(audio_src, "wb") as f:
        f.write(payload)

    project = TasmoProject(project_name="Embed Test", tempo=128.0)
    track = Track(id="t1", name="Drums", type="audio")
    track.clips.append(
        Clip(
            id="c1", name="Kick", clip_type="audio", track_id="t1", audio_file=audio_src
        )
    )
    # Second clip points at the same source -> must be stored once.
    track.clips.append(
        Clip(
            id="c2",
            name="Kick2",
            clip_type="audio",
            track_id="t1",
            audio_file=audio_src,
        )
    )
    project.tracks.append(track)

    path = os.path.join(tmp_path, "embed.tasmo")
    manifest = TasmoFile.save(project, path, embed_audio=True)
    assert manifest["audio_mode"] == "embedded"
    embedded = TasmoFile.list_audio(path)
    assert len(embedded) == 1, f"expected 1 embedded file, got {embedded}"
    print(f"  embed: stored {embedded}")

    # Load into a fresh media dir; clips relink to a real extracted file.
    media = os.path.join(tmp_path, "media_out")
    loaded, _ = TasmoFile.load(path, media_dir=media)
    c1, c2 = loaded.tracks[0].clips
    assert c1.audio_file is not None
    assert c1.audio_file.startswith(media), c1.audio_file
    assert os.path.isfile(c1.audio_file)
    with open(c1.audio_file, "rb") as f:
        assert f.read() == payload
    assert c2.audio_file == c1.audio_file  # shared source -> shared extraction
    assert (c1.audio_file_checksum or "").startswith("sha256:")
    print("  TasmoFile embed round-trip OK")


def test_vst_scanner():
    from backend.modules.vst.scanner import _default_vst3_dirs, Vst3PluginInfo

    dirs = _default_vst3_dirs()
    print(f"  VST3 dirs found: {len(dirs)}")
    # Vst3PluginInfo creation
    info = Vst3PluginInfo(name="Test.vst3", path="/tmp/Test.vst3", category="effect")
    assert info.name == "Test.vst3"
    print("  Vst3PluginInfo OK")


def test_vst_host():
    from backend.modules.vst.host import list_instances

    instances = list_instances()
    assert isinstance(instances, list)
    # list_builtin_effects requires pedalboard; skip if not installed
    try:
        from backend.modules.vst.host import list_builtin_effects

        builtins = list_builtin_effects()
        assert len(builtins) > 0
        assert any(b["name"] == "Reverb" for b in builtins)
        print(f"  Built-in effects: {len(builtins)}")
    except ImportError:
        print("  Built-in effects: skipped (pedalboard not installed)")


def test_ableton_parser_structure():
    from backend.modules.dawimport.ableton import parse_als

    # Can't test without a real .als file, but verify the function exists
    assert callable(parse_als)
    print("  ableton.parse_als callable OK")


def test_reaper_parser_structure():
    from backend.modules.dawimport.reaper import parse_rpp

    assert callable(parse_rpp)
    print("  reaper.parse_rpp callable OK")


def test_logic_parser_structure():
    from backend.modules.dawimport.logic import parse_logicx, export_hint

    assert callable(parse_logicx)
    hint = export_hint()
    assert hint["format"] == "logicx"
    assert "recommended_workflow" in hint
    print("  logic.export_hint OK")


def test_fl_studio_parser_structure():
    from backend.modules.dawimport.fl_studio import parse_flp

    assert callable(parse_flp)
    print("  fl_studio.parse_flp callable OK")


def test_audacity_parser_structure():
    from backend.modules.dawimport.audacity import parse_aup3

    assert callable(parse_aup3)
    print("  audacity.parse_aup3 callable OK")


def test_audition_parser_structure():
    from backend.modules.dawimport.audition import parse_sesx

    assert callable(parse_sesx)
    print("  audition.parse_sesx callable OK")


def test_bitwig_parser_structure():
    from backend.modules.dawimport.bitwig import parse_bwproject

    assert callable(parse_bwproject)
    print("  bitwig.parse_bwproject callable OK")


def test_resolume_parser_structure():
    from backend.modules.dawimport.resolume import parse_avc

    assert callable(parse_avc)
    print("  resolume.parse_avc callable OK")


def test_detect_all_formats():
    from backend.modules.dawimport.router import router as dawimport_router

    assert hasattr(dawimport_router, "routes")
    routes = [r.path for r in dawimport_router.routes]
    assert "/detect" in routes
    assert "/ableton" in routes
    assert "/reaper" in routes
    assert "/logic" in routes
    assert "/fl-studio" in routes
    assert "/audacity" in routes
    assert "/audition" in routes
    assert "/bitwig" in routes
    assert "/resolume" in routes
    assert "/cubase/export-hint" in routes
    assert "/pro-tools/export-hint" in routes
    print(f"  dawimport routes: {len(routes)} endpoints OK")


if __name__ == "__main__":
    print("Running VST / DAW import / .tasmo smoke tests...")
    test_daw_models()
    test_tasmo_project()
    test_tasmo_file_roundtrip()
    test_tasmo_embed_roundtrip()
    test_vst_scanner()
    test_vst_host()
    test_ableton_parser_structure()
    test_reaper_parser_structure()
    test_logic_parser_structure()
    test_fl_studio_parser_structure()
    test_audacity_parser_structure()
    test_audition_parser_structure()
    test_bitwig_parser_structure()
    test_resolume_parser_structure()
    test_detect_all_formats()
    print("\nAll tests passed!")
