#!/usr/bin/env python3
"""Enrich Qdrant payload metadata for chunks whose LLM metadata fell back to
regex during ingest (GitHub Models daily quota ran out mid-run).

Payload-only (`set_payload`) — vectors are never touched, so this is cheap and
safe to re-run. Uses OpenAI gpt-4o-mini directly.

What it fixes:
  1. `law` == filename stem  -> detect real law title + valid_from per file
     (from that file's first chunks)
  2. missing `waste_types`/`entity_types` -> extract once per (file, article)
     and apply to every part of that article

Usage:
    python scripts/enrich_metadata.py            # run
    python scripts/enrich_metadata.py --dry-run  # count work, no LLM calls
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

_ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
if _ENV_PATH.exists():
    from dotenv import load_dotenv
    load_dotenv(_ENV_PATH)

from openai import OpenAI
from qdrant_client import QdrantClient

def _build_qdrant_client() -> QdrantClient:
    """Resolve QDRANT_URL first, then a local path — matching ingest.py and ragagent.py.

    This script previously only ever opened a local path, so it silently missed
    the server after dev moved to one. It refuses to create a missing local
    directory rather than falling back to an empty store: this is a repair tool,
    and an empty store means "cannot find your data", never "start a new one".
    """
    qdrant_url = os.getenv("QDRANT_URL", "").strip()
    if qdrant_url:
        return QdrantClient(url=qdrant_url, api_key=os.getenv("QDRANT_API_KEY", "").strip() or None)

    local_path = Path(os.getenv("QDRANT_LOCAL_PATH", str(_DEFAULT_QDRANT_PATH))).resolve()
    if not local_path.exists():
        sys.exit(
            f"[enrich] No QDRANT_URL set and local path does not exist: {local_path}\n"
            "[enrich] Start the dev server (docker compose -f docker-compose.dev.yml up -d) "
            "and set QDRANT_URL."
        )
    return QdrantClient(path=str(local_path))


MODEL = "gpt-4o-mini"
DEFAULT_COLLECTION = "waste_management_law_mk_v2"
SCROLL_BATCH = 500
MAX_CONSECUTIVE_FAILURES = 5

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_QDRANT_PATH = _REPO_ROOT / "apps" / "agent" / "src" / "rag-agent" / "qdrant_data"

# Prompts mirror scripts/ingest.py so enriched metadata matches ingest-time metadata
_DOC_INFO_PROMPT = """From the first page of a North Macedonian legal document (Macedonian Cyrillic), extract:

Return ONLY a JSON object:
- "law": official short title + gazette number if visible, e.g. "Закон за управување со отпадот 216/2021" (empty string if not identifiable)
- "valid_from": ISO date (YYYY-MM-DD) the act was published/took effect, or null if not visible

First page text:
"""

_METADATA_PROMPT = """You extract metadata from one article of a North Macedonian waste-management law (Macedonian Cyrillic text).

Return ONLY a JSON object with these keys:
- "title": short title/subject of the article in English (max 10 words)
- "waste_types": array from ["hazardous", "construction", "packaging", "electronic", "municipal", "paper_textile", "general"] — only types this article concerns; [] if none specifically
- "entity_types": array from ["individual", "business", "municipality", "government"] — who the article applies to; [] if unclear

Article text:
"""


def _scroll_all(client: QdrantClient, collection: str) -> list:
    points = []
    offset = None
    while True:
        batch, offset = client.scroll(
            collection, limit=SCROLL_BATCH, offset=offset,
            with_payload=True, with_vectors=False,
        )
        points.extend(batch)
        if offset is None:
            return points


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key and not args.dry_run:
        print("OPENAI_API_KEY is required", file=sys.stderr)
        sys.exit(1)
    llm = OpenAI(api_key=api_key) if api_key else None

    collection = os.getenv("QDRANT_COLLECTION", DEFAULT_COLLECTION)
    qdrant = _build_qdrant_client()

    points = _scroll_all(qdrant, collection)
    print(f"[enrich] {len(points)} points in '{collection}'")

    # --- Work discovery -----------------------------------------------------
    by_file: dict[str, list] = defaultdict(list)
    for p in points:
        by_file[p.payload.get("source_file", "?")].append(p)

    files_needing_law = {}
    articles_needing_meta: dict[tuple, list] = defaultdict(list)
    for source_file, pts in by_file.items():
        stem = Path(source_file).stem
        if any(p.payload.get("law") == stem for p in pts):
            files_needing_law[source_file] = pts
        for p in pts:
            # Enriched chunks have waste_types/entity_types lists; regex-fallback
            # ones have empty lists AND an untrimmed Macedonian first-line title.
            if not p.payload.get("waste_types") and not p.payload.get("entity_types"):
                articles_needing_meta[(source_file, p.payload.get("article"))].append(p)

    total_calls = len(files_needing_law) + len(articles_needing_meta)
    print(f"[enrich] files needing law detection: {len(files_needing_law)}")
    print(f"[enrich] (file, article) groups needing metadata: {len(articles_needing_meta)}")
    print(f"[enrich] estimated LLM calls: {total_calls}")
    if args.dry_run:
        return

    usage_tokens = {"in": 0, "out": 0}
    consecutive_failures = 0

    def _call(prompt: str) -> dict | None:
        nonlocal consecutive_failures
        try:
            r = llm.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                temperature=0,
            )
            usage_tokens["in"] += r.usage.prompt_tokens
            usage_tokens["out"] += r.usage.completion_tokens
            consecutive_failures = 0
            return json.loads(r.choices[0].message.content)
        except Exception as exc:  # noqa: BLE001
            consecutive_failures += 1
            print(f"[enrich] ! LLM call failed: {exc}", file=sys.stderr)
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                print("[enrich] too many consecutive failures — aborting", file=sys.stderr)
                sys.exit(1)
            return None

    # --- 1. Law title + valid_from per file ---------------------------------
    for i, (source_file, pts) in enumerate(sorted(files_needing_law.items()), 1):
        first_chunks = sorted(pts, key=lambda p: p.payload.get("chunk_index", 0))[:2]
        first_text = "\n".join(p.payload.get("text", "") for p in first_chunks)[:4000]
        parsed = _call(_DOC_INFO_PROMPT + first_text)
        if not parsed:
            continue
        law = str(parsed.get("law", "")).strip()
        valid_from = parsed.get("valid_from")
        if isinstance(valid_from, str):
            try:
                date.fromisoformat(valid_from)
            except ValueError:
                valid_from = None
        else:
            valid_from = None
        if not law:
            continue
        qdrant.set_payload(
            collection,
            payload={"law": law, "valid_from": valid_from},
            points=[p.id for p in pts],
        )
        print(f"[enrich] law {i}/{len(files_needing_law)}: {source_file[-30:]} -> {law[:60]}")

    # --- 2. Article metadata per (file, article) ----------------------------
    total = len(articles_needing_meta)
    for i, ((source_file, article), pts) in enumerate(sorted(
        articles_needing_meta.items(), key=lambda kv: str(kv[0])
    ), 1):
        # Reassemble the article from its parts, in order
        parts = sorted(pts, key=lambda p: (p.payload.get("part") or 0))
        article_text = "\n".join(p.payload.get("text", "") for p in parts)[:6000]
        parsed = _call(_METADATA_PROMPT + article_text)
        if not parsed:
            continue
        payload = {
            "title": str(parsed.get("title", ""))[:200],
            "waste_types": [str(w) for w in parsed.get("waste_types", []) if isinstance(w, str)],
            "entity_types": [str(e) for e in parsed.get("entity_types", []) if isinstance(e, str)],
        }
        qdrant.set_payload(collection, payload=payload, points=[p.id for p in pts])
        if i % 50 == 0 or i == total:
            # gpt-4o-mini pricing: $0.15/M input, $0.60/M output
            cost = usage_tokens["in"] / 1e6 * 0.15 + usage_tokens["out"] / 1e6 * 0.60
            print(f"[enrich] metadata {i}/{total} | tokens in={usage_tokens['in']} out={usage_tokens['out']} | est ${cost:.3f}")

    cost = usage_tokens["in"] / 1e6 * 0.15 + usage_tokens["out"] / 1e6 * 0.60
    print(f"[enrich] DONE. Total estimated cost: ${cost:.3f}")


if __name__ == "__main__":
    main()
