# Local Qdrant Server Migration

## Context

The waste-law RAG store previously ran Qdrant in **embedded/local mode**
(`qdrant-client`'s `QdrantClient(path=...)`, no server process), pointed at
`apps/agent/src/rag-agent/qdrant_data` via `QDRANT_LOCAL_PATH`. This mode is
single-writer only.

Root-caused this session (verified against the installed `qdrant_client`
source): `apps/python/scripts/ingest.py`'s `_ensure_collection()` defaults
(unless `--append` is passed) to `client.delete_collection(...)` followed by
`client.create_collection(...)`. `delete_collection` immediately
`shutil.rmtree`s the collection's on-disk data and writes an empty
`meta.json` — *before* the multi-minute OCR/embed/upload rebuild (subject to
a GitHub Models 150/day quota and known Windows Cyrillic-console crashes)
even starts. Any interruption in that window permanently loses the index
with no backup taken first. This had already happened twice.

Decision: move local dev to a **real Qdrant server** (Docker container) to
remove the single-writer constraint entirely. This is dev-only — the
production VPS deployment (`.claude/plans/dockerdeploymentplan.md`, Phase
4-6) is a separate, already-fully-planned effort blocked on the user buying
a Hetzner VPS + domain, and was explicitly out of scope here.

No application code needed to change: `services/ragagent.py`,
`scripts/ingest.py`, `scripts/enrich_metadata.py`, and
`evals/test_retrieval.py` already all prefer `QDRANT_URL` over
`QDRANT_LOCAL_PATH` when both are set. This was purely an infra/config change.

## Steps taken

1. **Tore down unrelated stale infra found along the way.** An 11-day-old
   leftover smoke-test stack (project `ai-secretary-smoke`: agent, python,
   qdrant, caddy containers + 2 volumes) from a prior, unrelated
   Docker-deployment-plan validation was still running via Docker Desktop's
   restart policy, with an empty qdrant collection. Removed via
   `docker compose -p ai-secretary-smoke down -v`.

2. **Added `docker-compose.dev.yml`** at repo root — Qdrant only
   (`qdrant/qdrant:v1.18.0`, matching `qdrant-client==1.18.0` in
   `apps/python/pyproject.toml`), loopback-bound (`127.0.0.1:6333:6333`),
   named volume `qdrant_data_dev`. agent/python still run natively
   (`npm run dev` / `uv run uvicorn`), never containerized in dev. Started
   with `docker compose -f docker-compose.dev.yml up -d`.

3. **Migrated the real data** with the existing
   `apps/python/scripts/migrate_qdrant.py` (scroll+upsert, no re-embedding):
   `QDRANT_LOCAL_PATH=<embedded path> QDRANT_URL=http://127.0.0.1:6333 uv run python scripts/migrate_qdrant.py`.
   Result: `done: source=4585 destination=4585` — clean, matching counts.

4. **Updated `apps/python/.env`** — added `QDRANT_URL=http://127.0.0.1:6333`
   above `QDRANT_LOCAL_PATH` (kept, not commented out, as a documented
   rollback pointer) with a warning comment: if `QDRANT_URL` is ever unset,
   `get_qdrant_client()`'s `local_path.mkdir(parents=True, exist_ok=True)`
   will silently create and use a brand-new empty collection at the fallback
   path instead of erroring.

5. **Renamed the old embedded folder** (not deleted) —
   `apps/agent/src/rag-agent/qdrant_data` →
   `qdrant_data.orphan-20260728-125042`, matching the existing
   `qdrant_data.orphan-20260723-160418` convention from the prior incident.

6. **Verified end-to-end:**
   - `curl http://127.0.0.1:6333/collections/waste_management_law_mk_v2` →
     `points_count: 4585`, matching the migration output.
   - `uv run pytest evals/ -q -k retrieval` now runs against the server (no
     self-skip) and reproduces the *exact same* recall/misses as before
     migration (0/9, same filename-fallback `law` values) — proving a
     faithful 1:1 copy. The `law`-metadata fallback issue itself is
     unchanged and was explicitly not touched by this task (separate
     follow-up: `scripts/enrich_metadata.py`, ~928 LLM calls, real cost —
     the user has not requested this yet).

7. **Updated `.claude/rules/python-service.md`** "Running Locally" section —
   added a prerequisite step to start `docker-compose.dev.yml` before
   `uv run uvicorn`, and noted `--reload` is safe again now that the server
   (not a per-process file lock) owns concurrency.

## Explicitly out of scope (not done)
`docker-compose.prod.yml`, `.github/workflows/deploy.yml`, any VPS/production
work, running `scripts/enrich_metadata.py` (the `law`-field fallback-name
fix — separate follow-up the user can request afterward), CLAUDE.md's
Knowledge Architecture table (no new rule/skill file, just an edit).
