"""SQLite-backed query layer for the library.

The filesystem layout under ``data/generations/<entry_id>/`` remains the
durable source of truth (each entry's ``metadata.json`` survives any DB
corruption). SQLite is a query accelerator + the home for the richer
data we accumulate as features land:

  - ``entries``       core record, mirrors metadata.json
  - ``analysis``      bpm / key / pitch / genre / loudness etc.
  - ``stems``         separated stems linked to a parent entry
  - ``midis``         MIDI conversions (from full track or per-stem)
  - ``relations``     directed edges for lineage / chimera-sources /
                      inits / inpaint / stems-of / midi-of / derived-from
  - ``tag_index``     denormalized many-to-many (entry_id, tag) for fast filters
  - ``prompt_corpus`` (entry_id, prompt_kind, prompt_text) for LoRA labelling
  - ``schema_meta``   key/value store for the schema version + first-init time

Edge tables are designed so a future export to a real graph DB (kuzudb /
oxigraph) is a ~30-line script.

Zero external deps — stdlib ``sqlite3`` only. JSON1 is enabled by default
in CPython's bundled SQLite, so flexible JSON blobs work out of the box.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

log = logging.getLogger(__name__)


SCHEMA_VERSION = 5


# Each tuple is (schema_version_after_running, statements list).
# Add new migration tuples as the schema evolves; never edit a shipped one.
_MIGRATIONS: list[tuple[int, list[str]]] = [
    (
        1,
        [
            """
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT 'audio',
                title TEXT NOT NULL DEFAULT '',
                prompt TEXT NOT NULL DEFAULT '',
                negative_prompt TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                duration_sec REAL NOT NULL DEFAULT 0,
                steps INTEGER NOT NULL DEFAULT 0,
                cfg REAL NOT NULL DEFAULT 0,
                seed INTEGER NOT NULL DEFAULT 0,
                mime TEXT NOT NULL DEFAULT 'audio/wav',
                audio_filename TEXT NOT NULL DEFAULT '',
                file_size_bytes INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'generate',
                favorite INTEGER NOT NULL DEFAULT 0,
                rating TEXT,
                notes TEXT NOT NULL DEFAULT '',
                timestamp TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                analysis_status TEXT NOT NULL DEFAULT 'pending',
                stems_status TEXT NOT NULL DEFAULT 'pending',
                midi_status TEXT NOT NULL DEFAULT 'pending',
                metadata_json TEXT NOT NULL DEFAULT '{}'
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_entries_created_at
                ON entries(created_at DESC)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_entries_source
                ON entries(source)
            """,
            """
            CREATE TABLE IF NOT EXISTS analysis (
                entry_id TEXT PRIMARY KEY,
                bpm REAL,
                beats_json TEXT,
                key TEXT,
                key_confidence REAL,
                scale TEXT,
                pitch_mean_hz REAL,
                pitch_std_hz REAL,
                loudness_lufs REAL,
                rms_db REAL,
                bars_estimated REAL,
                genre TEXT,
                genre_confidence REAL,
                embedded_tags_json TEXT,
                ffprobe_json TEXT,
                analyzed_at REAL,
                version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS stems (
                id TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL,
                stem_name TEXT NOT NULL,
                audio_path TEXT NOT NULL,
                file_size_bytes INTEGER NOT NULL DEFAULT 0,
                model TEXT,
                model_variant TEXT,
                separated_at REAL,
                version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_stems_entry_id
                ON stems(entry_id)
            """,
            """
            CREATE TABLE IF NOT EXISTS midis (
                id TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL,
                source TEXT NOT NULL,            -- 'full' | 'stem'
                source_ref TEXT,                 -- stem_id if source='stem'
                midi_path TEXT NOT NULL,
                engine TEXT NOT NULL DEFAULT '',
                engine_version TEXT NOT NULL DEFAULT '',
                notes_count INTEGER NOT NULL DEFAULT 0,
                converted_at REAL,
                version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_midis_entry_id
                ON midis(entry_id)
            """,
            """
            CREATE TABLE IF NOT EXISTS relations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_id TEXT NOT NULL,
                to_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1.0,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                UNIQUE (from_id, to_id, kind)
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id)
            """,
            """
            CREATE TABLE IF NOT EXISTS tag_index (
                entry_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY (entry_id, tag),
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_tag_index_tag ON tag_index(tag)
            """,
            """
            CREATE TABLE IF NOT EXISTS prompt_corpus (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id TEXT NOT NULL,
                prompt_kind TEXT NOT NULL,       -- 'positive' | 'negative' | 'embedded' | 'user'
                prompt_text TEXT NOT NULL,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_prompt_corpus_entry
                ON prompt_corpus(entry_id)
            """,
            """
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """,
        ],
    ),
    (
        2,
        [
            """
            CREATE TABLE IF NOT EXISTS notation_artifacts (
                id TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                source_ref TEXT,
                path TEXT NOT NULL,
                engine TEXT NOT NULL DEFAULT '',
                engine_version TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_notation_artifacts_entry_id
                ON notation_artifacts(entry_id)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_notation_artifacts_kind
                ON notation_artifacts(kind)
            """,
        ],
    ),
    (
        3,
        [
            "ALTER TABLE analysis ADD COLUMN prompt_guess TEXT",
            "ALTER TABLE analysis ADD COLUMN prompt_confidence REAL",
            "ALTER TABLE analysis ADD COLUMN semantic_tags_json TEXT NOT NULL DEFAULT '[]'",
        ],
    ),
    (
        4,
        [
            "ALTER TABLE entries ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE entries ADD COLUMN last_played_at REAL",
            "CREATE INDEX IF NOT EXISTS idx_entries_play_count ON entries(play_count DESC)",
        ],
    ),
    (
        5,
        [
            # Stems and MIDI become first-class library items: they can be
            # favorited just like parent tracks. Default 0 keeps existing
            # rows unflagged.
            "ALTER TABLE stems ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE midis ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
        ],
    ),
]


def _now() -> float:
    return time.time()


class LibraryDB:
    """Thin DAO over a single SQLite file.

    The connection uses ``check_same_thread=False`` so it survives
    FastAPI's threadpool, gated by an internal ``RLock``. All writes go
    through ``_writelock`` so concurrent updates serialize cleanly.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._writelock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # Foreign keys are off by default; we rely on CASCADE deletes.
        self._conn.execute("PRAGMA foreign_keys = ON")
        # WAL gives us readers concurrent with writers.
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA synchronous = NORMAL")
        self._migrate()

    def close(self) -> None:
        with self._writelock:
            self._conn.close()

    # ---- Schema -------------------------------------------------------------

    def _current_schema_version(self) -> int:
        cur = self._conn.cursor()
        # If schema_meta isn't there yet, this is a fresh DB.
        try:
            row = cur.execute(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'"
            ).fetchone()
        except sqlite3.OperationalError:
            return 0
        if not row:
            return 0
        try:
            return int(row["value"])
        except (KeyError, ValueError):
            return 0

    def _migrate(self) -> None:
        with self._writelock:
            current = self._current_schema_version()
            for target_version, statements in _MIGRATIONS:
                if target_version <= current:
                    continue
                log.info("library.db: migrating to schema v%d", target_version)
                for stmt in statements:
                    self._conn.execute(stmt)
                self._conn.execute(
                    "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
                    (str(target_version),),
                )
                if current == 0:
                    self._conn.execute(
                        "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('initialized_at', ?)",
                        (str(_now()),),
                    )
                self._conn.commit()
                current = target_version

    # ---- Connection helper --------------------------------------------------

    @contextmanager
    def _txn(self) -> Iterator[sqlite3.Cursor]:
        with self._writelock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            finally:
                cur.close()

    # ---- Entry CRUD ---------------------------------------------------------

    def upsert_entry(self, payload: dict[str, Any]) -> None:
        """Insert or update a single entry row from a flattened payload.
        Unknown keys are silently ignored; missing keys keep defaults."""
        now = _now()
        row = {
            "id": str(payload["id"]),
            "kind": str(payload.get("kind") or "audio"),
            "title": str(payload.get("title") or ""),
            "prompt": str(payload.get("prompt") or ""),
            "negative_prompt": str(payload.get("negative_prompt") or ""),
            "model": str(payload.get("model") or ""),
            "duration_sec": float(
                payload.get("duration") or payload.get("duration_sec") or 0.0
            ),
            "steps": int(payload.get("steps") or 0),
            "cfg": float(payload.get("cfg") or 0.0),
            "seed": int(payload.get("seed") or 0),
            "mime": str(payload.get("mime") or payload.get("mime_type") or "audio/wav"),
            "audio_filename": str(payload.get("audio_filename") or ""),
            "file_size_bytes": int(payload.get("file_size_bytes") or 0),
            "source": str(payload.get("source") or "generate"),
            "favorite": 1 if payload.get("favorite") else 0,
            "rating": payload.get("rating")
            if payload.get("rating") in ("like", "dislike")
            else None,
            "notes": str(payload.get("notes") or ""),
            "timestamp": str(payload.get("timestamp") or ""),
            "analysis_status": str(payload.get("analysis_status") or "pending"),
            "stems_status": str(payload.get("stems_status") or "pending"),
            "midi_status": str(payload.get("midi_status") or "pending"),
            "metadata_json": json.dumps(payload.get("metadata_json") or {}),
        }
        with self._txn() as cur:
            existing = cur.execute(
                "SELECT created_at FROM entries WHERE id = ?", (row["id"],)
            ).fetchone()
            created_at = existing["created_at"] if existing else now
            cur.execute(
                """
                INSERT INTO entries (
                    id, kind, title, prompt, negative_prompt, model,
                    duration_sec, steps, cfg, seed, mime, audio_filename,
                    file_size_bytes, source, favorite, rating, notes,
                    timestamp, created_at, updated_at,
                    analysis_status, stems_status, midi_status, metadata_json
                ) VALUES (
                    :id, :kind, :title, :prompt, :negative_prompt, :model,
                    :duration_sec, :steps, :cfg, :seed, :mime, :audio_filename,
                    :file_size_bytes, :source, :favorite, :rating, :notes,
                    :timestamp, :created_at, :updated_at,
                    :analysis_status, :stems_status, :midi_status, :metadata_json
                )
                ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    title = excluded.title,
                    prompt = excluded.prompt,
                    negative_prompt = excluded.negative_prompt,
                    model = excluded.model,
                    duration_sec = excluded.duration_sec,
                    steps = excluded.steps,
                    cfg = excluded.cfg,
                    seed = excluded.seed,
                    mime = excluded.mime,
                    audio_filename = excluded.audio_filename,
                    file_size_bytes = excluded.file_size_bytes,
                    source = excluded.source,
                    favorite = excluded.favorite,
                    rating = excluded.rating,
                    notes = excluded.notes,
                    timestamp = excluded.timestamp,
                    updated_at = excluded.updated_at,
                    analysis_status = excluded.analysis_status,
                    stems_status = excluded.stems_status,
                    midi_status = excluded.midi_status,
                    metadata_json = excluded.metadata_json
                """,
                {**row, "created_at": created_at, "updated_at": now},
            )
            # Refresh tag_index for this entry.
            cur.execute("DELETE FROM tag_index WHERE entry_id = ?", (row["id"],))
            tags = payload.get("tags") or []
            if isinstance(tags, list):
                for tag in tags:
                    if not tag:
                        continue
                    cur.execute(
                        "INSERT OR IGNORE INTO tag_index (entry_id, tag) VALUES (?, ?)",
                        (row["id"], str(tag)),
                    )
            # Refresh prompt_corpus 'positive' + 'negative' rows from row data.
            cur.execute(
                "DELETE FROM prompt_corpus WHERE entry_id = ? AND prompt_kind IN ('positive', 'negative')",
                (row["id"],),
            )
            if row["prompt"]:
                cur.execute(
                    "INSERT INTO prompt_corpus (entry_id, prompt_kind, prompt_text) VALUES (?, 'positive', ?)",
                    (row["id"], row["prompt"]),
                )
            if row["negative_prompt"]:
                cur.execute(
                    "INSERT INTO prompt_corpus (entry_id, prompt_kind, prompt_text) VALUES (?, 'negative', ?)",
                    (row["id"], row["negative_prompt"]),
                )

    def get_entry(self, entry_id: str) -> Optional[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT * FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
            cur.close()
            return dict(row) if row else None

    def list_entries(self) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                "SELECT * FROM entries ORDER BY created_at DESC"
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def list_entries_filtered(
        self,
        *,
        source: Optional[str] = None,
        tag: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        join = ""
        if source:
            clauses.append("e.source = ?")
            params.append(source)
        if tag:
            join = "JOIN tag_index t ON t.entry_id = e.id"
            clauses.append("t.tag = ?")
            params.append(tag)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        limit_sql = f"LIMIT {int(limit)}" if limit else ""
        sql = f"""
            SELECT e.* FROM entries e {join}
            {where}
            ORDER BY e.created_at DESC
            {limit_sql}
        """
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(sql, params).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def list_entries_with_analysis(self) -> list[dict[str, Any]]:
        """Each entry joined with its analysis row (bpm / key / scale / genre /
        loudness). Analysis columns are NULL for entries not yet analyzed. The
        playlist suggester sequences on bpm + harmonic key from this."""
        sql = """
            SELECT
                e.id, e.title, e.prompt, e.model, e.duration_sec, e.source,
                e.favorite, e.play_count, e.last_played_at,
                a.bpm, a.key, a.scale, a.genre, a.loudness_lufs, a.bars_estimated
            FROM entries e
            LEFT JOIN analysis a ON a.entry_id = e.id
            ORDER BY e.created_at DESC
        """
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(sql).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def delete_entry(self, entry_id: str) -> bool:
        with self._txn() as cur:
            cur.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
            deleted = cur.rowcount > 0
            # ``relations`` is polymorphic (from_id / to_id may reference a
            # stem, midi, or even an external source label string) so there's
            # no FK cascade. Wipe edges that reference this entry by id.
            cur.execute(
                "DELETE FROM relations WHERE from_id = ? OR to_id = ?",
                (entry_id, entry_id),
            )
            return deleted

    def all_entry_ids(self) -> list[str]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute("SELECT id FROM entries").fetchall()
            cur.close()
            return [r["id"] for r in rows]

    def count_entries(self) -> int:
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute("SELECT COUNT(*) AS c FROM entries").fetchone()
            cur.close()
            return int(row["c"]) if row else 0

    def increment_play_count(self, entry_id: str) -> Optional[int]:
        """Bump play_count and stamp last_played_at for one entry. Returns the
        new play_count, or None when the entry does not exist. Independent of
        upsert_entry, which never touches play_count, so metadata edits and
        re-analysis leave the count intact."""
        now = _now()
        with self._txn() as cur:
            cur.execute(
                "UPDATE entries SET play_count = play_count + 1, last_played_at = ? WHERE id = ?",
                (now, entry_id),
            )
            if cur.rowcount == 0:
                return None
            row = cur.execute(
                "SELECT play_count FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
            return int(row["play_count"]) if row else None

    # ---- Relations ----------------------------------------------------------

    def add_relation(
        self,
        from_id: str,
        to_id: str,
        kind: str,
        *,
        weight: float = 1.0,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        with self._txn() as cur:
            cur.execute(
                """
                INSERT OR IGNORE INTO relations (from_id, to_id, kind, weight, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    from_id,
                    to_id,
                    kind,
                    weight,
                    json.dumps(metadata or {}),
                    _now(),
                ),
            )

    def list_relations(
        self,
        *,
        from_id: Optional[str] = None,
        to_id: Optional[str] = None,
        kind: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if from_id:
            clauses.append("from_id = ?")
            params.append(from_id)
        if to_id:
            clauses.append("to_id = ?")
            params.append(to_id)
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"SELECT * FROM relations {where} ORDER BY created_at"
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(sql, params).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    # ---- Analysis / stems / midi (lightweight inserts) ----------------------

    def upsert_analysis(self, entry_id: str, payload: dict[str, Any]) -> None:
        row = {
            "entry_id": entry_id,
            "bpm": payload.get("bpm"),
            "beats_json": json.dumps(payload.get("beats") or []),
            "key": payload.get("key"),
            "key_confidence": payload.get("key_confidence"),
            "scale": payload.get("scale"),
            "pitch_mean_hz": payload.get("pitch_mean_hz"),
            "pitch_std_hz": payload.get("pitch_std_hz"),
            "loudness_lufs": payload.get("loudness_lufs"),
            "rms_db": payload.get("rms_db"),
            "bars_estimated": payload.get("bars_estimated"),
            "genre": payload.get("genre"),
            "genre_confidence": payload.get("genre_confidence"),
            "prompt_guess": payload.get("prompt_guess"),
            "prompt_confidence": payload.get("prompt_confidence"),
            "semantic_tags_json": json.dumps(payload.get("semantic_tags") or []),
            "embedded_tags_json": json.dumps(payload.get("embedded_tags") or {}),
            "ffprobe_json": json.dumps(payload.get("ffprobe") or {}),
            "analyzed_at": _now(),
            "version": int(payload.get("version") or 1),
        }
        with self._txn() as cur:
            cur.execute(
                """
                INSERT INTO analysis (
                    entry_id, bpm, beats_json, key, key_confidence, scale,
                    pitch_mean_hz, pitch_std_hz, loudness_lufs, rms_db,
                    bars_estimated, genre, genre_confidence,
                    prompt_guess, prompt_confidence, semantic_tags_json,
                    embedded_tags_json, ffprobe_json, analyzed_at, version
                ) VALUES (
                    :entry_id, :bpm, :beats_json, :key, :key_confidence, :scale,
                    :pitch_mean_hz, :pitch_std_hz, :loudness_lufs, :rms_db,
                    :bars_estimated, :genre, :genre_confidence,
                    :prompt_guess, :prompt_confidence, :semantic_tags_json,
                    :embedded_tags_json, :ffprobe_json, :analyzed_at, :version
                )
                ON CONFLICT(entry_id) DO UPDATE SET
                    bpm = excluded.bpm,
                    beats_json = excluded.beats_json,
                    key = excluded.key,
                    key_confidence = excluded.key_confidence,
                    scale = excluded.scale,
                    pitch_mean_hz = excluded.pitch_mean_hz,
                    pitch_std_hz = excluded.pitch_std_hz,
                    loudness_lufs = excluded.loudness_lufs,
                    rms_db = excluded.rms_db,
                    bars_estimated = excluded.bars_estimated,
                    genre = excluded.genre,
                    genre_confidence = excluded.genre_confidence,
                    prompt_guess = excluded.prompt_guess,
                    prompt_confidence = excluded.prompt_confidence,
                    semantic_tags_json = excluded.semantic_tags_json,
                    embedded_tags_json = excluded.embedded_tags_json,
                    ffprobe_json = excluded.ffprobe_json,
                    analyzed_at = excluded.analyzed_at,
                    version = excluded.version
                """,
                row,
            )

    def get_analysis(self, entry_id: str) -> Optional[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT * FROM analysis WHERE entry_id = ?", (entry_id,)
            ).fetchone()
            cur.close()
            return dict(row) if row else None

    def get_all_analysis(self) -> dict[str, dict[str, Any]]:
        """Return ``{entry_id: analysis_row}`` for every analyzed entry in a
        SINGLE query.

        This is the batched sibling of :meth:`get_analysis`. The library list
        endpoint enriches every entry with its analysis (so the Catalogue
        inspector + library search can read ``entry.analysis``); doing that
        with a per-entry ``get_analysis`` call would be an N+1 query storm on a
        large library. One ``SELECT *`` + a dict keyed by ``entry_id`` keeps the
        enrichment O(1) queries. Rows are returned verbatim (same shape as
        ``get_analysis``); callers parse the ``*_json`` columns themselves."""
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute("SELECT * FROM analysis").fetchall()
            cur.close()
            return {row["entry_id"]: dict(row) for row in rows}

    def add_stem(
        self,
        *,
        stem_id: str,
        entry_id: str,
        stem_name: str,
        audio_path: str,
        file_size_bytes: int = 0,
        model: Optional[str] = None,
        model_variant: Optional[str] = None,
    ) -> None:
        with self._txn() as cur:
            cur.execute(
                """
                INSERT OR REPLACE INTO stems
                    (id, entry_id, stem_name, audio_path, file_size_bytes,
                     model, model_variant, separated_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    stem_id,
                    entry_id,
                    stem_name,
                    audio_path,
                    file_size_bytes,
                    model,
                    model_variant,
                    _now(),
                ),
            )

    def list_stems(self, entry_id: str) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                "SELECT * FROM stems WHERE entry_id = ? ORDER BY stem_name",
                (entry_id,),
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def get_stem(self, stem_id: str) -> Optional[dict[str, Any]]:
        """Look one stem row up by its globally-unique id."""
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute("SELECT * FROM stems WHERE id = ?", (stem_id,)).fetchone()
            cur.close()
            return dict(row) if row else None

    def set_stem_favorite(self, stem_id: str, favorite: bool) -> bool:
        with self._txn() as cur:
            cur.execute(
                "UPDATE stems SET favorite = ? WHERE id = ?",
                (1 if favorite else 0, stem_id),
            )
            return cur.rowcount > 0

    def delete_stem(self, stem_id: str) -> bool:
        """Drop one stem row. Caller is responsible for deleting the file on
        disk (the path lives in ``audio_path``)."""
        with self._txn() as cur:
            cur.execute("DELETE FROM stems WHERE id = ?", (stem_id,))
            deleted = cur.rowcount > 0
            # Polymorphic edges may reference this stem id (stems-of / midi-of).
            cur.execute(
                "DELETE FROM relations WHERE from_id = ? OR to_id = ?",
                (stem_id, stem_id),
            )
            return deleted

    def add_midi(
        self,
        *,
        midi_id: str,
        entry_id: str,
        source: str,
        midi_path: str,
        source_ref: Optional[str] = None,
        engine: str = "",
        engine_version: str = "",
        notes_count: int = 0,
    ) -> None:
        with self._txn() as cur:
            cur.execute(
                """
                INSERT OR REPLACE INTO midis
                    (id, entry_id, source, source_ref, midi_path,
                     engine, engine_version, notes_count, converted_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    midi_id,
                    entry_id,
                    source,
                    source_ref,
                    midi_path,
                    engine,
                    engine_version,
                    notes_count,
                    _now(),
                ),
            )

    def list_midis(self, entry_id: str) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                "SELECT * FROM midis WHERE entry_id = ? ORDER BY converted_at",
                (entry_id,),
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def get_midi(self, midi_id: str) -> Optional[dict[str, Any]]:
        """Look one MIDI row up by its globally-unique id."""
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute("SELECT * FROM midis WHERE id = ?", (midi_id,)).fetchone()
            cur.close()
            return dict(row) if row else None

    def set_midi_favorite(self, midi_id: str, favorite: bool) -> bool:
        with self._txn() as cur:
            cur.execute(
                "UPDATE midis SET favorite = ? WHERE id = ?",
                (1 if favorite else 0, midi_id),
            )
            return cur.rowcount > 0

    def delete_midi(self, midi_id: str) -> bool:
        """Drop one MIDI row. Caller deletes the .mid file on disk
        (path lives in ``midi_path``)."""
        with self._txn() as cur:
            cur.execute("DELETE FROM midis WHERE id = ?", (midi_id,))
            deleted = cur.rowcount > 0
            cur.execute(
                "DELETE FROM relations WHERE from_id = ? OR to_id = ?",
                (midi_id, midi_id),
            )
            return deleted

    def add_notation_artifact(
        self,
        *,
        artifact_id: str,
        entry_id: str,
        kind: str,
        path: str,
        source_ref: Optional[str] = None,
        engine: str = "",
        engine_version: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        with self._txn() as cur:
            cur.execute(
                """
                INSERT OR REPLACE INTO notation_artifacts
                    (id, entry_id, kind, source_ref, path, engine,
                     engine_version, metadata_json, created_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    artifact_id,
                    entry_id,
                    kind,
                    source_ref,
                    path,
                    engine,
                    engine_version,
                    json.dumps(metadata or {}),
                    _now(),
                ),
            )

    def list_notation_artifacts(
        self,
        entry_id: str,
        *,
        kind: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        clauses = ["entry_id = ?"]
        params: list[Any] = [entry_id]
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = " AND ".join(clauses)
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                f"SELECT * FROM notation_artifacts WHERE {where} ORDER BY created_at",
                params,
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def get_notation_artifact(self, artifact_id: str) -> Optional[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT * FROM notation_artifacts WHERE id = ?", (artifact_id,)
            ).fetchone()
            cur.close()
            return dict(row) if row else None

    # ---- Schema info --------------------------------------------------------

    def schema_version(self) -> int:
        return self._current_schema_version()
