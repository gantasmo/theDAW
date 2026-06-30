"""faster-whisper transcription sidecar for the vocal engine.

Importing this package stays cheap: only the stdlib/subprocess-based sidecar
manager loads here. faster-whisper itself is imported solely inside worker.py,
which runs in the isolated .whisper_venv.
"""

from .sidecar import (
    available,
    ensure_ready,
    install_dependencies,
    probe,
    resolve_config,
    transcribe,
)

__all__ = [
    "available",
    "ensure_ready",
    "install_dependencies",
    "probe",
    "resolve_config",
    "transcribe",
]
