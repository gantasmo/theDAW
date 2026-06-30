"""faster-whisper transcription worker.

Runs INSIDE the isolated .whisper_venv, never in the main app process. Reads one
JSON request from stdin, transcribes with faster-whisper, and writes a single
JSON line to stdout as the LAST line. All diagnostics and model-download progress
go to stderr so stdout stays clean for the parent to parse.

Request  : {"audio": str, "language": str|null, "model": str, "device": str,
            "compute_type": str}
Response : {"ok": true, "language": str, "text": str,
            "segments": [{"text", "start", "end",
                          "words": [{"word", "start", "end"}]}]}   (seconds)
            or {"ok": false, "error": str}
"""

import json
import sys


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _fail(msg: object) -> int:
    _emit({"ok": False, "error": str(msg)[:600]})
    return 1


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        return _fail(f"bad request json: {e}")

    audio = req.get("audio")
    if not audio:
        return _fail("no audio path")

    language = req.get("language") or None
    if language in ("auto", ""):
        language = None
    model_size = req.get("model") or "small"
    device = req.get("device") or "cpu"
    compute_type = req.get("compute_type") or "int8"

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        return _fail(f"faster-whisper import failed: {e!r}")

    try:
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            audio,
            language=language,
            word_timestamps=True,
            vad_filter=True,
        )
        seg_out = []
        text_parts = []
        for seg in segments:
            words = []
            for w in seg.words or []:
                words.append(
                    {
                        "word": w.word,
                        "start": float(w.start) if w.start is not None else None,
                        "end": float(w.end) if w.end is not None else None,
                    }
                )
            seg_out.append(
                {
                    "text": seg.text,
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "words": words,
                }
            )
            text_parts.append(seg.text)
    except Exception as e:
        return _fail(f"transcription failed: {e!r}")

    _emit(
        {
            "ok": True,
            "language": getattr(info, "language", None) or (language or ""),
            "text": "".join(text_parts).strip(),
            "segments": seg_out,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
