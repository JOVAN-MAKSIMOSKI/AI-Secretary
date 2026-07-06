#!/usr/bin/env python3
"""Corpus freshness watcher for the waste-law RAG advisor (Phase 7).

Checks the MOEPP waste-regulation page for documents that are not yet in the
local state file and prints them for manual review. It never auto-ingests —
you review the list, download what matters, then run scripts/ingest.py --append.

**Deviation from the original plan:** the plan named slvesnik.com.mk, but that
site is a client-rendered Angular app with no scrapeable HTML or RSS. The MOEPP
regulation page is the actual source of the current corpus (same filenames),
is server-rendered, and is already filtered to waste legislation.

Usage:
    python scripts/check_new_laws.py                      # report new documents
    python scripts/check_new_laws.py --seed-from-resources  # initialize state from
                                                            # the local corpus folder
    python scripts/check_new_laws.py --mark-seen          # accept current page state

State lives in scripts/last_checked.json (local, not committed).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

SOURCE_URL = "https://www.moepp.gov.mk/mk-MK/regulativa/upravuvanje-so-otpadot"
REQUEST_TIMEOUT_SECONDS = 60
STATE_PATH = Path(__file__).resolve().parent / "last_checked.json"

_REPO_ROOT = Path(__file__).resolve().parents[3]
RESOURCES_DIR = _REPO_ROOT / "apps" / "agent" / "src" / "rag-agent" / "resources"

DOC_LINK_RE = re.compile(
    r'<a\b[^>]*href="(?P<url>[^"]+\.(?:pdf|docx?|xlsx?))"[^>]*>(?P<inner>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
TAG_RE = re.compile(r"<[^>]+>")


def _fetch_documents() -> dict[str, str]:
    """Return {url: link title} for every document linked on the source page."""
    response = requests.get(
        SOURCE_URL,
        timeout=REQUEST_TIMEOUT_SECONDS,
        headers={"User-Agent": "AI-Secretary corpus watcher (manual run)"},
    )
    response.raise_for_status()
    documents: dict[str, str] = {}
    for match in DOC_LINK_RE.finditer(response.text):
        url = match.group("url").strip()
        title = TAG_RE.sub(" ", match.group("inner"))
        title = re.sub(r"\s+", " ", title).strip()
        documents[url] = title or Path(url).name
    if not documents:
        # The page markup changed or the request was blocked — make that loud
        # instead of silently reporting "no new laws".
        raise RuntimeError(
            "No document links found on the MOEPP page — its markup may have "
            "changed. Inspect the page and update DOC_LINK_RE."
        )
    return documents


def _load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {"seen": {}, "last_run": None}


def _save_state(state: dict) -> None:
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Report new waste-law documents on the MOEPP page.")
    parser.add_argument(
        "--seed-from-resources",
        action="store_true",
        help="mark page documents whose filename already exists in the local corpus folder as seen",
    )
    parser.add_argument(
        "--mark-seen",
        action="store_true",
        help="record everything currently on the page as seen (run after ingesting)",
    )
    args = parser.parse_args()

    print(f"[check] Fetching {SOURCE_URL} ...")
    documents = _fetch_documents()
    print(f"[check] {len(documents)} documents on the page")

    state = _load_state()
    seen: dict = state["seen"]

    if args.seed_from_resources:
        # A file counts as seen if we already downloaded it (extension may differ:
        # .doc sources were converted to .docx locally)
        local_stems = {p.stem for p in RESOURCES_DIR.iterdir() if p.is_file()}
        seeded = 0
        for url, title in documents.items():
            if Path(url).stem in local_stems and url not in seen:
                seen[url] = {"title": title, "first_seen": "seeded-from-local-corpus"}
                seeded += 1
        _save_state(state)
        print(f"[check] Seeded {seeded} documents as already-ingested.")

    new_documents = {url: title for url, title in documents.items() if url not in seen}

    if not new_documents:
        print("[check] No new documents since last check.")
    else:
        print(f"\n[check] {len(new_documents)} NEW document(s) for manual review:\n")
        for url, title in sorted(new_documents.items()):
            print(f"  • {title}\n    {url}\n")
        print(
            "[check] Review the list, download what is relevant, then ingest with:\n"
            '  python scripts/ingest.py --append <downloaded files...>\n'
            "  python scripts/check_new_laws.py --mark-seen   # after ingesting"
        )

    if args.mark_seen:
        now = datetime.now(timezone.utc).isoformat()
        for url, title in documents.items():
            if url not in seen:
                seen[url] = {"title": title, "first_seen": now}
        _save_state(state)
        print("[check] All current page documents marked as seen.")
    elif args.seed_from_resources:
        pass  # state already saved above
    else:
        _save_state(state)  # refresh last_run timestamp only


if __name__ == "__main__":
    main()
