#!/usr/bin/env python3
"""
Ingest law PDFs into Qdrant using text-embedding-3-small via GitHub Models.

Usage:
    python services/ingest.py <file.pdf> [<file2.pdf> ...]
    python services/ingest.py --append <file.pdf>   # add to existing collection

Required env vars (loaded from apps/python/.env):
    GITHUB_MODELS_TOKEN   GitHub PAT with model:read scope
    QDRANT_LOCAL_PATH     local Qdrant storage directory
    QDRANT_COLLECTION     target collection name (default: waste_management_law_e3small_1536)
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

_ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
if _ENV_PATH.exists():
    from dotenv import load_dotenv
    load_dotenv(_ENV_PATH)

import fitz  # PyMuPDF
from llama_index.core.node_parser import SentenceSplitter
from openai import OpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMS = 1536
GITHUB_MODELS_BASE_URL = "https://models.inference.ai.azure.com"
DEFAULT_COLLECTION = "waste_management_law_e3small_1536"
CHUNK_SIZE = 1024
CHUNK_OVERLAP = 100
EMBED_BATCH_SIZE = 50
UPSERT_BATCH_SIZE = 100

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_QDRANT_PATH = _REPO_ROOT / "apps" / "agent" / "src" / "rag-agent" / "qdrant_data"


def _build_qdrant_client() -> QdrantClient:
    qdrant_url = os.getenv("QDRANT_URL", "").strip()
    qdrant_api_key = os.getenv("QDRANT_API_KEY", "").strip()
    if qdrant_url:
        return QdrantClient(url=qdrant_url, api_key=qdrant_api_key or None)
    local_path = Path(os.getenv("QDRANT_LOCAL_PATH", str(_DEFAULT_QDRANT_PATH))).resolve()
    local_path.mkdir(parents=True, exist_ok=True)
    return QdrantClient(path=str(local_path))


def _build_openai_client() -> OpenAI:
    token = os.getenv("GITHUB_MODELS_TOKEN", os.getenv("RAG_GITHUB_MODELS_TOKEN", "")).strip()
    if not token:
        raise RuntimeError("GITHUB_MODELS_TOKEN is required")
    return OpenAI(api_key=token, base_url=GITHUB_MODELS_BASE_URL)


def _ensure_collection(client: QdrantClient, collection_name: str, *, append: bool) -> None:
    existing = {c.name for c in client.get_collections().collections}
    if collection_name in existing:
        if append:
            print(f"[ingest] Appending to existing collection '{collection_name}'.")
            return
        print(f"[ingest] Collection '{collection_name}' exists — recreating for fresh index.")
        client.delete_collection(collection_name)
    client.create_collection(
        collection_name=collection_name,
        vectors_config=VectorParams(size=EMBED_DIMS, distance=Distance.COSINE),
    )
    print(f"[ingest] Collection '{collection_name}' created ({EMBED_DIMS}-dim Cosine).")


def _extract_pdf_text(pdf_path: Path) -> str:
    doc = fitz.open(str(pdf_path))
    pages = [doc[i].get_text() for i in range(len(doc))]
    return "\n\n".join(pages)


def _load_and_chunk(pdf_paths: list[Path]) -> list[dict]:
    splitter = SentenceSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
    chunks: list[dict] = []
    for pdf_path in pdf_paths:
        print(f"[ingest] Reading {pdf_path.name} ...")
        full_text = _extract_pdf_text(pdf_path)
        texts = splitter.split_text(full_text)
        file_chunks = [
            {
                "text": text,
                "source_file": pdf_path.name,
                "chunk_index": len(chunks) + i,
            }
            for i, text in enumerate(texts)
        ]
        chunks.extend(file_chunks)
        print(f"[ingest]   -> {len(texts)} chunks extracted")
    return chunks


def _embed_batches(openai_client: OpenAI, texts: list[str]) -> list[list[float]]:
    total_batches = -(-len(texts) // EMBED_BATCH_SIZE)
    vectors: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = texts[i : i + EMBED_BATCH_SIZE]
        batch_num = i // EMBED_BATCH_SIZE + 1
        print(f"[ingest] Embedding batch {batch_num}/{total_batches} ({len(batch)} chunks) ...")
        response = openai_client.embeddings.create(model=EMBED_MODEL, input=batch)
        vectors.extend(item.embedding for item in response.data)
    return vectors


def _upsert(client: QdrantClient, collection_name: str, chunks: list[dict], vectors: list[list[float]]) -> None:
    points = [
        PointStruct(id=str(uuid.uuid4()), vector=vectors[i], payload=chunks[i])
        for i in range(len(chunks))
    ]
    for i in range(0, len(points), UPSERT_BATCH_SIZE):
        client.upsert(collection_name=collection_name, points=points[i : i + UPSERT_BATCH_SIZE])
    print(f"[ingest] Upserted {len(points)} points into '{collection_name}'.")


def main() -> None:
    args = sys.argv[1:]
    append_mode = "--append" in args
    pdf_args = [a for a in args if not a.startswith("--")]

    if not pdf_args:
        print("Usage: python services/ingest.py [--append] <file.pdf> [<file2.pdf> ...]", file=sys.stderr)
        sys.exit(1)

    pdf_paths = [Path(p).resolve() for p in pdf_args]
    missing = [p for p in pdf_paths if not p.exists()]
    if missing:
        for p in missing:
            print(f"[ingest] File not found: {p}", file=sys.stderr)
        sys.exit(1)

    collection_name = os.getenv("QDRANT_COLLECTION", DEFAULT_COLLECTION)

    qdrant = _build_qdrant_client()
    openai_client = _build_openai_client()

    _ensure_collection(qdrant, collection_name, append=append_mode)

    chunks = _load_and_chunk(pdf_paths)
    if not chunks:
        print("[ingest] No chunks extracted — aborting.", file=sys.stderr)
        sys.exit(1)

    print(f"[ingest] Total chunks: {len(chunks)}")
    vectors = _embed_batches(openai_client, [c["text"] for c in chunks])
    _upsert(qdrant, collection_name, chunks, vectors)
    print("[ingest] Done.")


if __name__ == "__main__":
    main()
