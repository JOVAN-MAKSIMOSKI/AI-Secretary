"""One-off migration: embedded-local Qdrant store -> remote Qdrant server.

The dev vector store (apps/agent/src/rag-agent/qdrant_data) is qdrant-client
embedded-local format, which the server container cannot load and which has no
snapshot API. This copies exact vectors + payloads point-by-point — no
re-embedding needed.

Run from the dev machine through an SSH tunnel (qdrant is loopback-bound on
the VPS):

    ssh -L 16333:127.0.0.1:6333 deploy@VPS

    QDRANT_LOCAL_PATH=<abs path to qdrant_data> \
    QDRANT_URL=http://127.0.0.1:16333 \
    uv run python scripts/migrate_qdrant.py

Post-check: curl http://127.0.0.1:16333/collections/<collection> shows the
expected point count.
"""

import os
import sys

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

SCROLL_BATCH_SIZE = 256
# multilingual-e5-large embedding dimension
VECTOR_SIZE = 1024


def main() -> None:
    local_path = os.environ.get("QDRANT_LOCAL_PATH")
    remote_url = os.environ.get("QDRANT_URL")
    if not local_path or not remote_url:
        sys.exit("Set QDRANT_LOCAL_PATH and QDRANT_URL (see module docstring)")

    collection = os.getenv("QDRANT_COLLECTION", "waste_management_law_mk_v2")

    src = QdrantClient(path=local_path)
    dst = QdrantClient(url=remote_url)

    if dst.collection_exists(collection):
        dst.delete_collection(collection)
    dst.create_collection(
        collection,
        vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
    )

    migrated = 0
    offset = None
    while True:
        points, offset = src.scroll(
            collection,
            limit=SCROLL_BATCH_SIZE,
            offset=offset,
            with_payload=True,
            with_vectors=True,
        )
        if not points:
            break
        dst.upsert(
            collection,
            points=[
                PointStruct(id=p.id, vector=p.vector, payload=p.payload)
                for p in points
            ],
        )
        migrated += len(points)
        print(f"migrated {migrated} points...")
        if offset is None:
            break

    src_count = src.count(collection).count
    dst_count = dst.count(collection).count
    print(f"done: source={src_count} destination={dst_count}")
    if src_count != dst_count:
        sys.exit("point counts differ — migration incomplete")


if __name__ == "__main__":
    main()
