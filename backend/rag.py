"""
Mini RAG system — indexes theDAW markdown docs into ChromaDB.

On startup, scans docs/, CLAUDE.md, and frontend/public/USER_GUIDE.md.
Chunks by markdown ## headers. Embeds with all-MiniLM-L6-v2.
Retrieves top-5 chunks per query with source citations.
"""

import hashlib
import logging
import re
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAG_INDEX_DIR = PROJECT_ROOT / "backend" / "rag_index"

DOC_PATHS = [
    PROJECT_ROOT / "CLAUDE.md",
    # User-facing project overview for the assistant. Lives under docs/ so it is
    # shipped in the packaged desktop build (which bundles docs/**/*.md but not
    # the repo-root CLAUDE.md), keeping the assistant's project framing intact
    # without exposing internal dev guidance to end users.
    PROJECT_ROOT / "docs" / "guides" / "about-thedaw.md",
    PROJECT_ROOT / "docs" / "SHOWCASE.md",
    PROJECT_ROOT / "docs" / "USER_GUIDE.md",
    PROJECT_ROOT / "docs" / "DESIGN_PRINCIPLES.md",
    PROJECT_ROOT / "docs" / "guides" / "prompting.md",
    PROJECT_ROOT / "docs" / "guides" / "SUNO_EXTERNAL_API.md",
    PROJECT_ROOT / "docs" / "guides" / "ui-controls-guide.md",
    PROJECT_ROOT / "docs" / "guides" / "model-overview.md",
    PROJECT_ROOT / "docs" / "guides" / "dj-and-genealogy.md",
    PROJECT_ROOT / "docs" / "guides" / "notation-and-score.md",
    PROJECT_ROOT / "docs" / "UI" / "hover-text-guide.md",
    PROJECT_ROOT / "docs" / "workflows" / "lora.md",
    PROJECT_ROOT / "docs" / "workflows" / "inference.md",
    PROJECT_ROOT / "docs" / "workflows" / "autoencoder.md",
    PROJECT_ROOT / "docs" / "windows" / "setup-guide.md",
    PROJECT_ROOT / "docs" / "windows" / "troubleshooting.md",
    PROJECT_ROOT / "frontend" / "public" / "USER_GUIDE.md",
]

_collection = None
_last_indexed_hash: Optional[str] = None
# Serializes lazy first-use init so concurrent assistant queries don't each build
# the index / load the embedding model.
_init_lock = threading.Lock()


_INDEX_VERSION = 2  # bump to force re-index after chunking logic changes


def _compute_docs_hash() -> str:
    h = hashlib.md5()
    h.update(f"v{_INDEX_VERSION}:chunk{MAX_CHUNK_CHARS}".encode())
    for p in sorted(DOC_PATHS):
        if p.exists():
            h.update(f"{p}:{p.stat().st_mtime}".encode())
    return h.hexdigest()


MAX_CHUNK_CHARS = 800


def _force_split(text: str, limit: int) -> list[str]:
    """Hard split text into pieces of at most `limit` characters on word boundaries."""
    words = text.split()
    pieces: list[str] = []
    current = ""
    for word in words:
        if current and len(current) + 1 + len(word) > limit:
            pieces.append(current)
            current = word
        elif not current:
            current = word[:limit] if len(word) > limit else word
        else:
            current += " " + word
    if current:
        pieces.append(current)
    return pieces


def _split_long_chunk(text: str, source: str, section: str) -> list[dict]:
    if len(text) <= MAX_CHUNK_CHARS:
        return [{"text": text, "source": source, "section": section}]

    paragraphs = text.split("\n\n")
    chunks: list[dict] = []
    current = ""
    part_num = 0

    def _flush(buf: str) -> None:
        nonlocal part_num
        buf = buf.strip()
        if not buf:
            return
        if len(buf) <= MAX_CHUNK_CHARS:
            part_num += 1
            chunks.append(
                {
                    "text": buf,
                    "source": source,
                    "section": f"{section} (part {part_num})",
                }
            )
        else:
            for piece in _force_split(buf, MAX_CHUNK_CHARS):
                part_num += 1
                chunks.append(
                    {
                        "text": piece,
                        "source": source,
                        "section": f"{section} (part {part_num})",
                    }
                )

    for para in paragraphs:
        if current and len(current) + len(para) + 2 > MAX_CHUNK_CHARS:
            _flush(current)
            current = ""

        if len(para) > MAX_CHUNK_CHARS:
            _flush(current)
            current = ""
            sentences = re.split(r"(?<=[.!?])\s+", para)
            for sentence in sentences:
                if current and len(current) + len(sentence) + 1 > MAX_CHUNK_CHARS:
                    _flush(current)
                    current = ""
                current += sentence + " "
        else:
            current += para + "\n\n"

    if current.strip():
        if not chunks:
            chunks.append(
                {"text": current.strip(), "source": source, "section": section}
            )
        else:
            _flush(current)

    return chunks


def _chunk_markdown(text: str, source: str) -> list[dict]:
    sections = re.split(r"^(#{1,3}\s+.+)$", text, flags=re.MULTILINE)
    chunks = []
    current_heading = source
    current_body = ""

    for part in sections:
        part = part.strip()
        if not part:
            continue
        if re.match(r"^#{1,3}\s+", part):
            if current_body.strip():
                raw = f"# {current_heading}\n\n{current_body.strip()}"
                chunks.extend(_split_long_chunk(raw, source, current_heading))
            current_heading = part.lstrip("#").strip()
            current_body = ""
        else:
            current_body += part + "\n"

    if current_body.strip():
        raw = f"# {current_heading}\n\n{current_body.strip()}"
        chunks.extend(_split_long_chunk(raw, source, current_heading))

    return chunks


def initialize_rag(force: bool = False) -> int:
    global _collection, _last_indexed_hash

    import os

    os.environ["HF_HUB_OFFLINE"] = "1"

    import chromadb
    from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction

    current_hash = _compute_docs_hash()
    if not force and _last_indexed_hash == current_hash and _collection is not None:
        logger.info("[RAG] Index is current, skipping re-index")
        return 0

    logger.info("[RAG] Indexing documentation...")
    ef = SentenceTransformerEmbeddingFunction(
        model_name="all-MiniLM-L6-v2",
        device="cpu",
    )
    client = chromadb.PersistentClient(path=str(RAG_INDEX_DIR))

    try:
        client.delete_collection("thedaw_docs")
    except Exception:
        pass

    _collection = client.get_or_create_collection(
        name="thedaw_docs",
        embedding_function=ef,
        metadata={"hnsw:space": "cosine"},
    )

    all_chunks = []
    for doc_path in DOC_PATHS:
        if not doc_path.exists():
            logger.warning("[RAG] Skipping missing doc: %s", doc_path)
            continue
        text = doc_path.read_text(encoding="utf-8", errors="replace")
        rel_path = str(doc_path.relative_to(PROJECT_ROOT))
        chunks = _chunk_markdown(text, rel_path)
        all_chunks.extend(chunks)

    if not all_chunks:
        logger.warning("[RAG] No chunks to index")
        return 0

    _collection.add(
        ids=[f"chunk_{i}" for i in range(len(all_chunks))],
        documents=[c["text"] for c in all_chunks],
        metadatas=[
            {"source": c["source"], "section": c["section"]} for c in all_chunks
        ],
    )

    _last_indexed_hash = current_hash
    logger.info(
        "[RAG] Indexed %d chunks from %d documents", len(all_chunks), len(DOC_PATHS)
    )
    return len(all_chunks)


def retrieve(query: str, n_results: int = 5) -> list[dict]:
    if _collection is None:
        # Lazy first-use init: the ~all-MiniLM embedding model + chroma client are
        # only loaded when the assistant actually needs RAG context, not at
        # startup, so a session that never asks the assistant pays nothing.
        with _init_lock:
            if _collection is None:
                try:
                    initialize_rag()
                except Exception as e:  # noqa: BLE001 — retrieval is best-effort
                    logger.warning("[RAG] lazy init failed: %s", e)
    if _collection is None:
        return []

    results = _collection.query(query_texts=[query], n_results=n_results)

    chunks = []
    for i in range(len(results["documents"][0])):
        chunks.append(
            {
                "text": results["documents"][0][i],
                "source": results["metadatas"][0][i]["source"],
                "section": results["metadatas"][0][i]["section"],
                "distance": results["distances"][0][i]
                if results.get("distances")
                else None,
            }
        )
    return chunks


def format_context(chunks: list[dict]) -> str:
    if not chunks:
        return ""

    parts = ["## Relevant Documentation\n"]
    for chunk in chunks:
        parts.append(f"### [{chunk['source']}] {chunk['section']}\n{chunk['text']}\n")
    return "\n".join(parts)
