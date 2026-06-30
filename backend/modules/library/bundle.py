"""Build a "track bundle" zip for an entry — everything the dev would
want to take with them: audio, metadata, analysis snapshot, lineage
slice, prompts, stems/, midi/, README.

Streamed on-the-fly via zipfile to avoid materializing a multi-MB zip
in memory first.
"""

from __future__ import annotations

import io
import json
import logging
import zipfile
from pathlib import Path
from typing import Any, Iterable, Optional

log = logging.getLogger(__name__)


def _safe_zip_name(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in s)[:80] or "entry"


def build_bundle_bytes(
    *,
    entry_id: str,
    record: dict[str, Any],
    audio_path: Optional[Path],
    metadata_path: Optional[Path],
    analysis: Optional[dict[str, Any]],
    stems: Iterable[dict[str, Any]] = (),
    midis: Iterable[dict[str, Any]] = (),
    scores: Iterable[dict[str, Any]] = (),
    lineage_edges: Iterable[dict[str, Any]] = (),
) -> bytes:
    """Build the zip and return its bytes. Caller streams these to the
    client (FastAPI StreamingResponse or Response with media_type
    application/zip)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Track audio at the bundle root.
        if audio_path is not None and audio_path.is_file():
            zf.write(audio_path, arcname=audio_path.name)

        # metadata.json — the durable record source.
        if metadata_path is not None and metadata_path.is_file():
            zf.write(metadata_path, arcname="metadata.json")
        else:
            zf.writestr("metadata.json", json.dumps(record, indent=2))

        # Analysis snapshot (per-entry analysis row + ffprobe summary).
        if analysis:
            zf.writestr("analysis.json", json.dumps(analysis, indent=2, default=str))

        # Lineage edges — every relation touching this entry's id.
        lineage_payload = {"entry_id": entry_id, "edges": list(lineage_edges)}
        zf.writestr("lineage.json", json.dumps(lineage_payload, indent=2, default=str))

        # Prompts in a friendlier text format (so the user can grep / cat).
        prompt_lines: list[str] = []
        if record.get("prompt"):
            prompt_lines.append(f"# positive\n{record['prompt']}\n")
        if record.get("negative_prompt"):
            prompt_lines.append(f"# negative\n{record['negative_prompt']}\n")
        embedded = record.get("embedded_tags") or (
            analysis.get("embedded_tags") if analysis else None
        )
        if isinstance(embedded, dict) and embedded:
            prompt_lines.append("# embedded\n")
            for k, v in sorted(embedded.items()):
                prompt_lines.append(f"{k}: {v}\n")
        if prompt_lines:
            zf.writestr("prompts.txt", "".join(prompt_lines))

        # Stems and MIDI files.
        for stem in stems:
            ap = Path(stem.get("audio_path") or "")
            if ap.is_file():
                zf.write(ap, arcname=f"stems/{ap.name}")
        for midi in midis:
            mp = Path(midi.get("midi_path") or "")
            if mp.is_file():
                zf.write(mp, arcname=f"midi/{mp.name}")
        # Score / notation artifacts (sheets, tabs, arrangements, exports).
        # Dedup by filename so multiple DB rows pointing at the same file
        # don't collide in the zip.
        seen_scores: set[str] = set()
        for score in scores:
            sp = Path(score.get("path") or "")
            if sp.is_file() and sp.name not in seen_scores:
                seen_scores.add(sp.name)
                zf.write(sp, arcname=f"scores/{sp.name}")

        # README.
        readme_text = _render_readme(
            entry_id=entry_id,
            record=record,
            analysis=analysis,
            stems_count=sum(
                1 for s in stems if Path(s.get("audio_path") or "").is_file()
            ),
            midi_count=sum(
                1 for m in midis if Path(m.get("midi_path") or "").is_file()
            ),
            scores_count=len(seen_scores),
        )
        zf.writestr("README.txt", readme_text)

    buf.seek(0)
    return buf.read()


def _render_readme(
    *,
    entry_id: str,
    record: dict[str, Any],
    analysis: Optional[dict[str, Any]],
    stems_count: int,
    midi_count: int,
    scores_count: int = 0,
) -> str:
    lines: list[str] = []
    lines.append("theDAW Track Bundle")
    lines.append("=" * 60)
    lines.append(f"Entry ID: {entry_id}")
    if record.get("title"):
        lines.append(f"Title:    {record['title']}")
    if record.get("model"):
        lines.append(f"Model:    {record['model']}")
    if record.get("timestamp"):
        lines.append(f"Created:  {record['timestamp']}")
    lines.append("")
    if record.get("prompt"):
        lines.append("Prompt:")
        lines.append(f"  {record['prompt']}")
        lines.append("")
    if analysis:
        lines.append("Analysis:")
        for k in (
            "bpm",
            "key",
            "scale",
            "bars_estimated",
            "pitch_mean_hz",
            "rms_db",
            "genre",
        ):
            v = analysis.get(k)
            if v is None:
                continue
            lines.append(f"  {k}: {v}")
        lines.append("")
    lines.append(f"Stems:  {stems_count}")
    lines.append(f"MIDI:   {midi_count}")
    lines.append(f"Scores: {scores_count}")
    lines.append("")
    lines.append("Contents:")
    lines.append("  - <audio file>     the track itself")
    lines.append("  - metadata.json    durable backend record")
    lines.append("  - analysis.json    BPM/key/pitch/etc. (if analysis ran)")
    lines.append("  - lineage.json     directed edges (parents + children)")
    lines.append("  - prompts.txt      positive/negative/embedded prompts")
    lines.append("  - stems/           separated stems (if stems ran)")
    lines.append("  - midi/            MIDI transcriptions (if midi ran)")
    lines.append("  - scores/          sheet music / tabs / arrangements (if any)")
    return "\n".join(lines) + "\n"
