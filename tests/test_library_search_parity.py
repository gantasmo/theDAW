"""Library search: what it finds, and how its index survives other builds.

The paged library moved search from the browser to SQL. Before that, main's
client matcher (``getFiltered`` in frontend/src/state/libraryStore.ts at
851f6a0) tested the query as a case-insensitive substring of every text field
an entry carries -- analysis values such as BPM and key, embedded file tags
such as artist and album -- plus the duration in seconds or minutes. The
first paged build matched word prefixes in five columns, so a search for a
BPM, an artist or a fragment inside a word found nothing.

The index also has to survive the file being written by builds that do not
maintain it. main (schema 6) and the first paged build (schema 12) both keep
opening the same ``library.db``. Those tests replay the real order of events
with the real code of those builds, kept under ``tests/fixtures`` exactly as
it was at 851f6a0 and 8039b45.
"""

from __future__ import annotations

import importlib.util
import math
import sqlite3
import sys
import threading
import time
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import ModuleType
from typing import Any, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import db as library_db_module
from backend.modules.library import router as library_router_module
from backend.modules.library.db import (
    FTS_BACKFILL_ROWID_KEY,
    LEGACY_FTS_BACKFILL_KEY,
    SEARCH_SHORT_VALUE_MAX,
    SEARCH_STATE_KEY,
    EntryFilters,
    LibraryDB,
    SearchIndexFailed,
    short_grams,
)
from tests.test_library_store import _seed_generate_entry
from tests.test_security_b12 import real_app_context
from tests.timing_bounds import prompt_seconds

FIXTURES = Path(__file__).parent / "fixtures"


def _load_build(module_name: str, file_name: str) -> ModuleType:
    """Import one of the kept ``db.py`` sources as a module of its own."""
    cached = sys.modules.get(module_name)
    if cached is not None:
        return cached
    loader = SourceFileLoader(module_name, str(FIXTURES / file_name))
    spec = importlib.util.spec_from_loader(module_name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses look their module up in sys.modules while the class body
    # runs, so it has to be registered before it executes.
    sys.modules[module_name] = module
    loader.exec_module(module)
    return module


def _main_build() -> ModuleType:
    """main's library DB at 851f6a0 (schema 6): knows no search index."""
    return _load_build(
        "tests._library_db_main_851f6a0", "library_db_main_851f6a0.py.txt"
    )


def _first_paged_build() -> ModuleType:
    """The first paged build's library DB at 8039b45 (schema 12), with its
    contentless ``entries_fts``. Imported inside the package, because it
    imports ``.provider`` relatively."""
    return _load_build(
        "backend.modules.library._db_pr207_8039b45", "library_db_pr207_8039b45.py.txt"
    )


def _payload(entry_id: str, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": entry_id,
        "kind": "audio",
        "title": entry_id,
        "prompt": "",
        "notes": "",
        "source": "generate",
        "favorite": False,
        "duration": 1.0,
        "audio_filename": "output.wav",
        "timestamp": "2026-09-18T00:00:00Z",
        "metadata_json": {},
    }
    payload.update(overrides)
    return payload


def _found(db: LibraryDB, q: str) -> set[str]:
    return {str(r["id"]) for r in db.list_entries_page(EntryFilters(q=q), limit=500)}


def _assert_search_index_intact(db: LibraryDB) -> None:
    """fts5's integrity check against the content view: a delete that handed
    fts5 values it never indexed fails here. The one- and two-character index
    is contentless, so fts5 can only check its structure; it is also compared,
    term by term, with the grams of the text the entries hold now."""
    if not db.fts_enabled:
        return
    db._conn.execute(
        "INSERT INTO entries_search(entries_search, rank) VALUES('integrity-check', 1)"
    )
    db._conn.execute(
        "INSERT INTO entries_search_short(entries_search_short) "
        "VALUES('integrity-check')"
    )
    expected: dict[str, set[int]] = {}
    for row in db._conn.execute("SELECT rid, head, body FROM entries_search_text"):
        for token in short_grams(row["head"], row["body"]).split():
            expected.setdefault(token, set()).add(int(row["rid"]))
    # Every term the index holds, so a row left behind under a term no live
    # entry has is caught too.
    db._conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS temp.short_terms "
        "USING fts5vocab(main, entries_search_short, row)"
    )
    held = {str(r[0]) for r in db._conn.execute("SELECT term FROM short_terms")}
    for token in held | set(expected):
        indexed = {
            int(r[0])
            for r in db._conn.execute(
                "SELECT rowid FROM entries_search_short "
                "WHERE entries_search_short MATCH ?",
                (token,),
            )
        }
        assert indexed == expected.get(token, set()), (
            f"short index disagrees with the text on {token}"
        )


def _meta(db: LibraryDB, key: str) -> Optional[str]:
    row = db._conn.execute(
        "SELECT value FROM schema_meta WHERE key = ?", (key,)
    ).fetchone()
    return None if row is None else str(row["value"])


# ---------------------------------------------------------------------------
# What a search finds: main's matcher, ported
# ---------------------------------------------------------------------------


def _js_string(value: Any) -> str:
    """JavaScript's ``String(v)`` for the JSON values a record carries."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, list):
        return ",".join(_js_string(v) for v in value)
    return str(value)


def _js_round(value: float) -> int:
    return math.floor(value + 0.5)


def _js_parse_float(text: str) -> Optional[float]:
    import re

    match = re.match(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?", text)
    return float(match.group(0)) if match else None


def _main_matches(record: dict[str, Any], query: str) -> bool:
    """``getFiltered``'s search test at 851f6a0, over one API record."""
    q = query.strip().lower()
    haystack = [
        record.get("title") or "",
        record.get("prompt") or "",
        record.get("negative_prompt") or "",
        record.get("model") or "",
        record.get("notes") or "",
        record.get("source") or "",
        record.get("mime_type") or "",
        record.get("rating") or "",
        *record.get("tags", []),
        *record.get("chimera_sources", []),
    ]
    for blob in (record.get("analysis") or {}, record.get("embedded_tags") or {}):
        haystack.extend(_js_string(v) for v in blob.values() if v is not None)
    if q in " ​ ".join(haystack).lower():
        return True
    num = _js_parse_float(q)
    if num is not None:
        duration = float(record.get("duration") or 0)
        if _js_round(duration) == _js_round(num):
            return True
        if _js_round(duration / 60) == _js_round(num):
            return True
    return False


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def _seed_varied(root: Path) -> None:
    _seed_generate_entry(
        root,
        "jobA",
        0,
        extra_meta={
            "title": "Sunshine Avenue",
            "prompt": "warm synthwave chase",
            "negative_prompt": "harsh distortion",
            "duration": 185.0,
            "model": "small-rf",
            "notes": "second verse needs work",
            "tags": ["summer"],
        },
    )
    _seed_generate_entry(
        root,
        "jobB",
        0,
        extra_meta={"title": "Harbor Nights", "prompt": "dusty lofi", "duration": 62.0},
    )
    _seed_generate_entry(
        root,
        "jobC",
        0,
        extra_meta={"title": "Untitled 7", "prompt": "", "duration": 300.0},
    )
    _seed_generate_entry(
        root,
        "jobD",
        0,
        extra_meta={"title": "Long Take", "prompt": LONG_PROMPT, "duration": 44.0},
    )


#: A prompt past ``SEARCH_SHORT_VALUE_MAX``, the way Suno prompts that carry
#: lyrics are, ending in words of one and two characters.
LONG_PROMPT = (
    "slow cinematic build over rolling timpani, distant choir swelling under "
    "bowed strings, a lonely trumpet line answering the melody, rain on "
    "glass, tape hiss and warm room tone, the second half opening into a "
    "wide chorus of layered voices before everything falls away with a 4k "
    "shimmer and a zq tail"
)


#: An ``analyzed_at`` none of the queries below can be found in. The analysis
#: timestamp is one of the values the search reads, like the BPM and the key,
#: so on the wall clock some runs stamped it with "185" or "123" inside and a
#: track nobody asked for answered: one CI run in a few hundred failed on
#: ``assert {'Harbor Nights', 'Sunshine Avenue'} == {'Sunshine Avenue'}``.
_QUIET_ANALYZED_AT = 1700000000.0

#: Where the second case starts the library's clock: every stamp it hands out
#: carries the digits of three of the queries ("185", "123" and "88.5").
_LOUD_CLOCK_START = 1851230088.5185


@pytest.mark.parametrize(
    "loud_clock", [False, True], ids=["wall clock", "clock full of queried digits"]
)
def test_search_finds_everything_main_found(
    client: TestClient, tmp_path: Path, monkeypatch, loud_clock: bool
):
    """The paged search and main's client matcher agree, field by field, on a
    library carrying analysis and embedded tags: BPM, key, artist, album, the
    duration, fragments inside words, and short words inside long values.

    The answer must not depend on when the test runs, so it is asked twice:
    on the wall clock, and on a clock whose every stamp is full of the digits
    the numeric queries look for."""
    assert len(LONG_PROMPT) > SEARCH_SHORT_VALUE_MAX
    if loud_clock:
        ticks = iter(range(1_000_000))
        monkeypatch.setattr(
            library_db_module,
            "_clock",
            lambda: _LOUD_CLOCK_START + next(ticks) * 1e-4,
        )
    _seed_varied(tmp_path)
    store = library_router_module.get_store()
    # Discover the entries first, so the analysis rows have an entry to name.
    records = client.get("/api/library/entries").json()["entries"]
    by_title = {r["title"]: r["id"] for r in records}
    with monkeypatch.context() as pinned:
        pinned.setattr(library_db_module, "_now", lambda: _QUIET_ANALYZED_AT)
        store.db.upsert_analysis(
            by_title["Untitled 7"],
            {
                "bpm": 123.0,
                # Every listing carries the tempo detector's confidence, so the
                # client matcher reads it like any other analysis value.
                "bpm_confidence": 0.231,
                "key": "F#",
                "scale": "minor",
                "genre": "ambient",
                "embedded_tags": {
                    "artist": "Aphex Twin",
                    "album": "Selected Ambient Works",
                },
            },
        )
        store.db.upsert_analysis(by_title["Harbor Nights"], {"bpm": 88.5, "key": "Bb"})
    records = client.get("/api/library/entries").json()["entries"]

    queries = {
        "123": {"Untitled 7"},  # a BPM
        "f#": {"Untitled 7"},  # a key
        "aphex": {"Untitled 7"},  # an embedded artist
        "ambient works": {"Untitled 7"},  # an embedded album, two words
        "phex": {"Untitled 7"},  # inside a word
        "88.5": {"Harbor Nights"},  # a fractional BPM
        "0.231": {"Untitled 7"},  # the BPM's confidence
        "bb": {"Harbor Nights"},  # a two-letter key
        "small-rf": {"Sunshine Avenue"},  # the model, punctuation and all
        "distortion": {"Sunshine Avenue"},  # the negative prompt
        "verse": {"Sunshine Avenue"},  # the notes
        "shine": {"Sunshine Avenue"},  # inside the title
        "3": None,  # a duration in minutes (300 s), and every "3" in text
        "185": {"Sunshine Avenue"},  # a duration in seconds
        "summer": {"Sunshine Avenue"},  # a tag
        # One- and two-character words inside a value past 200 characters.
        "zq": {"Long Take"},
        "4k": {"Long Take"},
        "zq tail": {"Long Take"},
        "4k shimmer": {"Long Take"},
        "k": None,
    }
    for q, titles in queries.items():
        paged = client.get("/api/library/entries", params={"limit": 100, "q": q}).json()
        got = {e["title"] for e in paged["entries"]}
        main = {r["title"] for r in records if _main_matches(r, q)}
        assert main <= got, f"{q!r}: main found {main - got} and this build does not"
        if titles is not None:
            assert got == titles, q
            assert main == titles, f"the port of main's matcher disagrees on {q!r}"
        assert paged["total"] == len(paged["entries"]), q


@pytest.mark.parametrize("enable_fts", [True, False])
def test_short_words_reach_every_value_on_both_paths(tmp_path: Path, enable_fts: bool):
    """A word of one or two characters is looked for in every value, long or
    short, with the fts5 indexes and with the ``instr`` fallback alike."""
    db = LibraryDB(tmp_path / "library.db", enable_fts=enable_fts)
    db.upsert_entry(_payload("long", title="Long Take", prompt=LONG_PROMPT))
    db.upsert_entry(_payload("short", title="Short Take", prompt="a zq tail"))
    db.upsert_entry(_payload("none", title="Plain", prompt="nothing to see"))
    assert _found(db, "zq") == {"long", "short"}
    assert _found(db, "4k") == {"long"}
    assert _found(db, "4k shimmer") == {"long"}
    assert _found(db, "zq take") == {"long", "short"}
    assert _found(db, "kz") == set()
    assert db.count_entries_filtered(EntryFilters(q="zq")) == 2
    assert db.entry_stats(EntryFilters(q="4k"))["count"] == 1
    db.upsert_entry(_payload("long", title="Long Take", prompt="rewritten"))
    assert _found(db, "4k") == set()
    assert _found(db, "zq") == {"short"}
    _assert_search_index_intact(db)
    db.close()


# ---------------------------------------------------------------------------
# The index across builds
# ---------------------------------------------------------------------------


def test_a_row_main_writes_is_found_and_its_edit_keeps_the_index_intact(
    tmp_path: Path,
):
    """main writes the file this build indexed -- a new row, and an edit of a
    row this build had indexed -- then this build opens it, finds both, edits
    both, and the index still passes fts5's integrity check. main opening the
    file again afterwards can still write to it."""
    path = tmp_path / "library.db"
    ours = LibraryDB(path)
    ours.upsert_entry(_payload("a", title="Sunshine Avenue"))
    ours.close()

    main = _main_build().LibraryDB(path)
    # An edit of an indexed row: main's upsert is INSERT ... ON CONFLICT DO
    # UPDATE, which must not be failed by anything this build stored.
    main.upsert_entry(_payload("a", title="Rainy Avenue"))
    main.upsert_entry(_payload("b", title="Harbor Nights", prompt="dusty lofi"))
    main.upsert_analysis("b", {"bpm": 97.0, "key": "Eb"})
    main.upsert_entry(_payload("l", title="Long Take", prompt=LONG_PROMPT))
    main.close()

    ours = LibraryDB(path)
    assert _found(ours, "harbor") == {"b"}
    assert _found(ours, "97") == {"b"}
    assert _found(ours, "rain") == {"a", "l"}
    assert _found(ours, "zq") == {"l"}
    assert _found(ours, "eb") == {"b"}
    # What main renamed away is gone from the index, not a phantom hit.
    assert _found(ours, "sunshine") == set()
    _assert_search_index_intact(ours)

    ours.upsert_entry(_payload("b", title="Harbor Days", prompt="dusty lofi"))
    ours.upsert_entry(_payload("a", title="Rainy Street"))
    ours.upsert_entry(_payload("l", title="Long Take", prompt="short now"))
    assert _found(ours, "zq") == set()
    assert _found(ours, "nights") == set()
    assert _found(ours, "days") == {"b"}
    assert _found(ours, "street") == {"a"}
    _assert_search_index_intact(ours)
    ours.delete_entry("a")
    assert _found(ours, "street") == set()
    _assert_search_index_intact(ours)
    ours.close()

    main = _main_build().LibraryDB(path)
    main.upsert_entry(_payload("c", title="Crimson Tide"))
    main.delete_entry("b")
    main.close()
    ours = LibraryDB(path)
    assert _found(ours, "crimson") == {"c"}
    assert _found(ours, "harbor") == set()
    _assert_search_index_intact(ours)
    ours.close()


def test_the_first_paged_builds_index_is_retired_so_it_rebuilds_its_own(
    tmp_path: Path,
):
    """8039b45 filled ``entries_fts`` once, flagged it done, and trusted it
    from then on. This build drops the table and the flag, so rows that build
    never indexed are found here, and when that build opens the file again it
    rebuilds its own index from scratch instead of trusting a stale one."""
    first = _first_paged_build()
    path = tmp_path / "library.db"
    old = first.LibraryDB(path)
    if not old.fts_enabled:
        pytest.skip("build has no FTS5")
    old.upsert_entry(_payload("p", title="Paper Lanterns"))
    assert _meta(old, LEGACY_FTS_BACKFILL_KEY) == "1"
    old.close()

    # main writes a row the first paged build's index never sees.
    main = _main_build().LibraryDB(path)
    main.upsert_entry(_payload("m", title="Marble Hall"))
    main.close()

    ours = LibraryDB(path)
    assert _found(ours, "marble") == {"m"}
    assert _found(ours, "lantern") == {"p"}
    assert (
        ours._conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'entries_fts'"
        ).fetchone()
        is None
    )
    assert _meta(ours, LEGACY_FTS_BACKFILL_KEY) is None
    ours.close()

    again = first.LibraryDB(path)
    rows = again.list_entries_page(first.EntryFilters(q="marble"), limit=10)
    assert [r["id"] for r in rows] == ["m"]
    again._conn.execute(
        "INSERT INTO entries_fts(entries_fts) VALUES('integrity-check')"
    )
    again.close()


def test_an_interrupted_index_build_resumes_from_its_cursor(
    tmp_path: Path, monkeypatch
):
    """A (re)build commits its cursor with every batch. Killed part way, the
    next open carries on after the last committed row."""
    path = tmp_path / "library.db"
    db = LibraryDB(path)
    db.upsert_entries_bulk(
        [_payload(f"r{i:05d}", title=f"Quartz Canyon {i}") for i in range(4500)]
    )
    # What a text-version bump leaves behind: the index is not the one this
    # build keeps, so the next open rebuilds it.
    db._conn.execute("DELETE FROM schema_meta WHERE key = ?", (SEARCH_STATE_KEY,))
    db._conn.commit()
    db.close()

    real_sync = LibraryDB._sync_search
    calls: list[list[int]] = []

    def dying_sync(self, cur, rids):
        calls.append(sorted(int(r) for r in rids))
        if len(calls) == 2:
            raise RuntimeError("power cut")
        return real_sync(self, cur, rids)

    monkeypatch.setattr(LibraryDB, "_sync_search", dying_sync)
    with pytest.raises(RuntimeError, match="power cut"):
        LibraryDB(path)
    monkeypatch.setattr(LibraryDB, "_sync_search", real_sync)

    probe = sqlite3.connect(path)
    cursor = probe.execute(
        "SELECT value FROM schema_meta WHERE key = ?", (FTS_BACKFILL_ROWID_KEY,)
    ).fetchone()
    probe.close()
    assert cursor is not None, "the first batch's cursor was committed"
    assert int(cursor[0]) == calls[0][-1]

    resumed: list[list[int]] = []

    def recording_sync(self, cur, rids):
        resumed.append(sorted(int(r) for r in rids))
        return real_sync(self, cur, rids)

    monkeypatch.setattr(LibraryDB, "_sync_search", recording_sync)
    db = LibraryDB(path)
    monkeypatch.setattr(LibraryDB, "_sync_search", real_sync)
    assert resumed, "the build carried on"
    assert min(resumed[0]) > int(cursor[0]), "rows already indexed were not redone"
    assert db.count_entries_filtered(EntryFilters(q="quartz")) == 4500
    assert _meta(db, FTS_BACKFILL_ROWID_KEY) is None
    _assert_search_index_intact(db)
    db.close()


def test_a_background_build_that_stops_fails_searches_until_the_next_open(
    tmp_path: Path, monkeypatch
):
    """A background build dies part way. The library still reads, a search
    raises instead of answering from part of the library with nothing left to
    fill in the rest, and the next open finishes the build from its cursor. A
    store closed while its build is still running stops the build and leaves
    it to the next open too."""
    path = tmp_path / "library.db"
    db = LibraryDB(path)
    db.upsert_entries_bulk(
        [_payload(f"r{i:05d}", title=f"Quartz Canyon {i}") for i in range(4500)]
    )
    db._conn.execute("DELETE FROM schema_meta WHERE key = ?", (SEARCH_STATE_KEY,))
    db._conn.commit()
    db.close()

    real_sync = LibraryDB._sync_search
    calls: list[int] = []

    def dying_sync(self, cur, rids):
        calls.append(len(rids))
        if len(calls) == 2:
            raise RuntimeError("power cut")
        return real_sync(self, cur, rids)

    monkeypatch.setattr(LibraryDB, "_sync_search", dying_sync)
    db = LibraryDB(path, build_search_in_background=True)
    # A search no longer waits for the build, so wait here for it to stop.
    assert db._search_built.wait(timeout=60)
    with pytest.raises(SearchIndexFailed, match="could not be built"):
        db.count_entries_filtered(EntryFilters(q="quartz"))
    assert db.search_status()["complete"] is False
    assert db.progress.snapshot()["phase"] == "failed"
    assert db.count_entries() == 4500
    db.close()
    monkeypatch.setattr(LibraryDB, "_sync_search", real_sync)

    release = threading.Event()
    real_index = LibraryDB._index_search_rows

    def held_index(self, *args, **kwargs):
        release.wait(timeout=60)
        return real_index(self, *args, **kwargs)

    monkeypatch.setattr(LibraryDB, "_index_search_rows", held_index)
    db = LibraryDB(path, build_search_in_background=True)
    db.close()
    release.set()
    monkeypatch.setattr(LibraryDB, "_index_search_rows", real_index)

    db = LibraryDB(path)
    assert db.count_entries_filtered(EntryFilters(q="quartz")) == 4500
    assert _meta(db, FTS_BACKFILL_ROWID_KEY) is None
    _assert_search_index_intact(db)
    db.close()


def test_the_backend_starts_while_the_index_of_mains_library_is_built(
    tmp_path: Path, monkeypatch
):
    """main's library, which has no search index, is opened by this build's
    backend. The startup built the whole index on the event loop before the
    lifespan yielded, so /api/health and every other route waited for it: on
    200,000 rows, minutes of a boot screen. The startup now returns with the
    build still to run; the library lists, a write lands, and a search answers
    at once from what is indexed -- the written row -- and says the index is
    incomplete, where it used to hold its thread until the build ended. Once
    the build finishes the same search finds every row."""
    from backend.modules.library.db import SEARCH_BUILD_THREAD

    root = tmp_path / "app-generations"
    root.mkdir()
    path = root / "library.db"
    main = _main_build().LibraryDB(path)
    for i in range(2500):
        main.upsert_entry(_payload(f"q{i:05d}", title=f"Quartz Canyon {i}"))
    main.close()

    release = threading.Event()
    real_index = getattr(LibraryDB, "_index_search_rows", None)

    def held_index(self, *args, **kwargs):
        # Held off the write lock, so the library stays readable meanwhile.
        if threading.current_thread().name == SEARCH_BUILD_THREAD:
            release.wait(timeout=60)
        return real_index(self, *args, **kwargs)

    if real_index is not None:
        monkeypatch.setattr(LibraryDB, "_index_search_rows", held_index)

    try:
        with (
            real_app_context(tmp_path, monkeypatch) as app,
            TestClient(app, client=("127.0.0.1", 51000)) as client,
        ):
            probe = sqlite3.connect(path)
            state = probe.execute(
                "SELECT value FROM schema_meta WHERE key = ?", (SEARCH_STATE_KEY,)
            ).fetchone()
            probe.close()
            assert state is None, "the startup waited for the whole index build"
            assert client.get("/api/health").status_code == 200

            listed = client.get("/api/library/entries", params={"limit": 5})
            assert listed.status_code == 200
            assert listed.json()["total"] == 2500

            db = library_router_module._store.db
            db.upsert_entry(_payload("z", title="Quartz Zircon"))

            began = time.perf_counter()
            during = client.get(
                "/api/library/entries", params={"limit": 5, "q": "quartz"}
            )
            took = time.perf_counter() - began
            assert during.status_code == 200
            assert took < prompt_seconds(1.0), (
                f"a search during the build took {took:.2f} s"
            )
            body = during.json()
            # Only the row the write indexed is in the index yet. (Its page
            # row is hidden: it has no folder on disk, like every row here.)
            assert body["total"] == 1
            assert _found(db, "zircon") == {"z"}
            assert body["search_index"]["complete"] is False
            assert body["search_index"]["total"] == 2500
            status = client.get("/api/library/index-status").json()
            assert status["phase"] == "index"
            assert status["total"] == 2500
            # Acting on every match of a partial search is refused, not guessed.
            refused = client.get("/api/library/entries/ids", params={"q": "quartz"})
            assert refused.status_code == 409

            release.set()
            assert db._search_built.wait(timeout=60)
            assert db.count_entries_filtered(EntryFilters(q="quartz")) == 2501
            finished = client.get(
                "/api/library/entries", params={"limit": 5, "q": "quartz"}
            ).json()
            assert finished["total"] == 2501
            assert finished["search_index"] == {"complete": True}
            assert client.get("/api/library/index-status").json()["phase"] == "ready"
            assert _found(db, "zircon") == {"z"}
            assert _meta(db, SEARCH_STATE_KEY) is not None
            _assert_search_index_intact(db)
    finally:
        release.set()


# ---------------------------------------------------------------------------
# Totals and references over the whole library
# ---------------------------------------------------------------------------


def test_stats_total_the_whole_query_not_a_page(client: TestClient, tmp_path: Path):
    for i in range(7):
        _seed_generate_entry(
            tmp_path,
            f"job{i}",
            0,
            extra_meta={
                "title": f"Song {i}",
                "duration": 10.0 * (i + 1),
                "favorite": i % 3 == 0,
            },
        )
    records = client.get("/api/library/entries").json()["entries"]
    # One row per page, so a client summing its pages would see one row.
    page = client.get("/api/library/entries", params={"limit": 1}).json()
    assert len(page["entries"]) == 1

    stats = client.get("/api/library/entries/stats").json()
    assert stats["count"] == 7
    assert stats["favorites"] == sum(1 for r in records if r["favorite"])
    assert stats["size_bytes"] == sum(r["file_size_bytes"] for r in records)
    assert stats["duration_sec"] == pytest.approx(sum(r["duration"] for r in records))
    assert isinstance(stats["revision"], int)

    narrowed = client.get(
        "/api/library/entries/stats", params={"q": "song", "favorite": "true"}
    ).json()
    # Songs 0, 3 and 6 are the favourites: 10 + 40 + 70 seconds.
    assert narrowed["count"] == 3
    assert narrowed["favorites"] == 3
    assert narrowed["duration_sec"] == pytest.approx(120.0)


def test_resolve_names_an_entry_no_page_holds(client: TestClient, tmp_path: Path):
    for i in range(3):
        _seed_generate_entry(
            tmp_path, f"job{i}", 0, extra_meta={"title": f"Filler {i}"}
        )
    _seed_generate_entry(
        tmp_path, "jobZ", 0, extra_meta={"title": "Night_Drive-Final.wav"}
    )
    records = client.get("/api/library/entries").json()["entries"]
    target = next(r["id"] for r in records if r["title"].startswith("Night"))

    def resolve(ref: str) -> Optional[str]:
        return client.get("/api/library/entries/resolve", params={"ref": ref}).json()[
            "id"
        ]

    assert resolve(target) == target
    assert resolve(target[:8]) == target
    assert resolve("night drive final") == target
    assert resolve("night drive") == target
    assert resolve("drive") == target
    assert resolve("nothing like it") is None


def test_the_search_text_follows_an_analysis_write(tmp_path: Path):
    """The analysis engine writes BPM and tags long after the entry: the
    search follows that write, not only the entry's own."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("x", title="Plain Title"))
    assert _found(db, "140") == set()
    db.upsert_analysis("x", {"bpm": 140.0, "embedded_tags": {"artist": "Boards"}})
    assert _found(db, "140") == {"x"}
    assert _found(db, "boards") == {"x"}
    db.upsert_analysis("x", {"bpm": 90.0})
    assert _found(db, "140") == set()
    assert _found(db, "boards") == set()
    _assert_search_index_intact(db)
    # The stored text is what the entry says, spelled as main's matcher saw it.
    head = db._conn.execute(
        "SELECT head FROM entries_search_head WHERE rid = "
        "(SELECT rowid FROM entries WHERE id = 'x')"
    ).fetchone()["head"]
    assert "90" in head.split("\n")
    assert "90.0" not in head.split("\n")
