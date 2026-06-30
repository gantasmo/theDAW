"""Canonical vocal artifact.

The single contract the vocal engine produces and that singing-synthesis models
(SoulX and others) later consume. This is ONE reconciled schema, merging the
metadata.json and VocalPlan specs. ALL timing is project-relative MILLISECONDS,
never seconds and never project-global, fixed here so every analyzer and the
meta-to-MIDI round-trip agree on units.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

ARTIFACT_VERSION = 1
TIMING_UNIT = "ms_project_relative"


class Word(BaseModel):
    """One lyric word, timed to the audio and optionally tied to a sung note."""

    text: str
    start_ms: int
    end_ms: int
    phonemes: list[str] = Field(default_factory=list)
    note_index: Optional[int] = None


class Phrase(BaseModel):
    text: str
    start_ms: int
    end_ms: int


class Lyrics(BaseModel):
    language: str = "en"
    text: str = ""
    words: list[Word] = Field(default_factory=list)
    phrases: list[Phrase] = Field(default_factory=list)
    # "transcribed" | "manual" | "" — phoneme/word alignment is carried here,
    # never in the SMF, so a round-trip through MIDI does not lose it.
    source: str = ""


class Note(BaseModel):
    """One sung note. `word_index` ties it back to a lyric word when known."""

    start_ms: int
    end_ms: int
    pitch: int
    velocity: int = 96
    word_index: Optional[int] = None


class Segment(BaseModel):
    id: int
    start_ms: int
    end_ms: int
    kind: str = "phrase"  # phrase | silence


class F0Curve(BaseModel):
    """Dense per-frame pitch. `hz` is 0.0 where unvoiced; `voiced` is the mask."""

    hop_ms: float
    hz: list[float] = Field(default_factory=list)
    voiced: list[bool] = Field(default_factory=list)


class Section(BaseModel):
    name: str  # verse | chorus | bridge | ...
    start_ms: int
    end_ms: int


class Timing(BaseModel):
    unit: str = TIMING_UNIT
    tempo_bpm: Optional[float] = None
    time_signature: str = "4/4"


class Source(BaseModel):
    asset_id: str = ""
    sample_rate: int = 44100
    duration_ms: int = 0
    isolation: str = ""  # vocal_isolate | demucs | none


class Review(BaseModel):
    """Auto alignment can harm quality, so a render-consuming model should only
    trust a reviewed artifact. Set true once a human confirms notes and lyrics."""

    reviewed: bool = False
    notes: str = ""


class VocalArtifact(BaseModel):
    version: int = ARTIFACT_VERSION
    timing_unit: str = TIMING_UNIT
    source: Source = Field(default_factory=Source)
    timing: Timing = Field(default_factory=Timing)
    segments: list[Segment] = Field(default_factory=list)
    lyrics: Lyrics = Field(default_factory=Lyrics)
    notes: list[Note] = Field(default_factory=list)
    f0: Optional[F0Curve] = None
    sections: list[Section] = Field(default_factory=list)
    review: Review = Field(default_factory=Review)
