# Docker Deployment Plan — AI-Secretary on Hetzner

## Context

The goal is to deploy AI-Secretary to Docker on a Hetzner Cloud VPS. A readiness investigation confirmed the current `docker-compose.yml` is a non-functional placeholder: no Dockerfiles or `.dockerignore` exist, the compose file references a fake `supabase/supabase-local` image, the agent's `tsc` build output is not runnable under plain Node (moduleResolution `bundler`, `@/*` aliases, raw-`.ts` workspace dep `@secretary/shared-types`), inter-service URLs default to localhost, and the RAG vector store lives in a gitignored local path.

Two findings from the earlier report are now stale and were corrected during verification:
- Python is **uv-managed** (`pyproject.toml` fully pinned + committed `uv.lock`); `requirements.txt` no longer exists. Docker uses `uv sync --frozen`.
- Remote Qdrant is **already supported** via `QDRANT_URL` in `services/ragagent.py` (~line 360) — no code change needed there.

Two **new** findings not in the original report:
- `apps/agent/src/server.ts:4` imports `dotenv/config` but `dotenv` is not in agent dependencies (works only via pnpm hoisting) — would crash a production container.
- `uv.lock` resolves `torch==2.12.1` on Linux to the **CUDA** wheel (~532 MB + `nvidia-*` deps → ~10 GB image). Must be repointed to the CPU wheel index.

**User decisions (locked):**
- Frontend (`apps/web`) hosts on Vercel/Netlify — NOT containerized. Backend CORS must allow its origin; web sets `VITE_AGENT_API_BASE_URL` / `VITE_PYTHON_API_BASE_URL` to absolute URLs at build time.
- Qdrant runs as a container on the same VPS with a volume (`QDRANT_URL=http://qdrant:6333`).
- Images built by GitHub Actions → GHCR; VPS runs `docker compose pull && up -d`.
- Supabase stays hosted (DB/auth/storage) — the local supabase compose service is deleted.

---

## Phase 1 — Code fixes required before containerization

### 1.1 Pin package manager — root `package.json`
Add `"packageManager": "pnpm@<local pnpm version>"` (check `pnpm --version`; lockfile is v9.0). Required for corepack in Docker/CI.

### 1.2   `dotenv` dependency — `apps/agent/package.json`
`server.ts:4` does `import 'dotenv/config'` but `dotenv` isn't declared. Add `"dotenv": "^16"` to dependencies. In containers env comes from compose `env_file`; dotenv is a harmless no-op with no `.env` file.

### 1.3 Unify Python-service URL env var (agent)
Standardize on **`PY_SERVICE_URL`** (it's the one zod-validated in `src/lib/env.ts:33` and the majority usage). Edit the two `PYTHON_SERVICE_URL` readers to fall back:
```ts
const PYTHON_SERVICE_URL =
  process.env.PY_SERVICE_URL || process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
```
- `apps/agent/src/agent/directResolverChain.ts:8`
- `apps/agent/src/agent/wasteLawChain.ts:11`

(`PY_SERVICE_URL` readers unchanged: `twilio/callHandler.ts:35`, `tools/sttTool.ts:1`, `twilio/tts.ts:13`.) Prod env sets **both** vars to `http://python:8000` as belt-and-braces.

### 1.4 `trust proxy` — `apps/agent/src/server.ts`
Not currently set; behind Caddy, `express-rate-limit` would key every client on Caddy's container IP. Add right after `const app = express()`:
```ts
app.set('trust proxy', 1); // one hop: Caddy
```

### 1.5 Add `GET /healthz` — `apps/python/main.py`
No health endpoint exists (agent has one at `server.ts:225`). Add, unauthenticated:
```python
@app.get("/healthz")
async def healthz():
    return {"ok": True, "service": "python"}
```

### 1.6 Real client IPs for slowapi (python)
No code change — run uvicorn with `--proxy-headers --forwarded-allow-ips "*"` in the Dockerfile CMD (python is never publicly exposed; only Caddy reaches it on the internal network).

### 1.7 Agent build → **esbuild bundle** (chosen over NodeNext migration)
NodeNext would require touching every import in the agent; esbuild fixes everything in one script and is already in `pnpm-workspace.yaml` allowBuilds.

`apps/agent/package.json`:
- add devDependency `"esbuild": "^0.25.0"`
- build script:
```json
"build": "esbuild src/server.ts --bundle --platform=node --format=esm --target=node22 --packages=external --alias:@secretary/shared-types=../../packages/shared-types/src/index.ts --outfile=dist/server.js"
```
- `--packages=external`: node_modules deps stay external (runtime image ships production `node_modules` via `pnpm deploy`) — avoids CJS/ESM bundling surprises with googleapis/twilio/prisma.
- `--alias`: bundles the raw-`.ts` workspace package directly.
- esbuild natively resolves the `@/*` tsconfig paths.
- Keep `tsc --noEmit` as `type-check`; `start` stays `node dist/server.js`.

**Prisma:** the agent uses Prisma 7 + `@prisma/adapter-pg` (JS driver adapter, `src/lib/prisma.ts`) — no Rust engine binary, no `binaryTargets` needed. `prisma generate` runs as an explicit Dockerfile step. Schema at `apps/agent/prisma/schema.prisma`.

### 1.8 Port standardization — **3000**
Agent default is `PORT || 3000` (`server.ts:940`). Everything (EXPOSE, healthcheck, Caddyfile, `GOOGLE_REDIRECT_URL`) uses 3000; set `PORT=3000` explicitly in `agent.env`. The stale 3001 compose mapping disappears with the rewrite.

### 1.9 CPU-only torch for Linux — `apps/python/pyproject.toml` (**critical**)
Add:
```toml
[[tool.uv.index]]
name = "pytorch-cpu"
url = "https://download.pytorch.org/whl/cpu"
explicit = true

[tool.uv.sources]
torch = [{ index = "pytorch-cpu", marker = "sys_platform == 'linux'" }]
```
Then `uv lock` (Windows dev resolution untouched due to the marker). Verify the lock now shows `torch +cpu` linux wheels and no `nvidia-*` linux deps. If 2.12.1+cpu isn't published for cp312, pin the nearest available cpu build.

### 1.10 CORS — no code change
Both services already read env (`AGENT_CORS_ALLOW_ORIGINS` at `server.ts:167`, `CORS_ALLOW_ORIGINS` at `main.py:78`). Only prod values change (Phase 5).

---

## Phase 2 — New files

### 2.1 Root `.dockerignore`
```
.git
node_modules
**/node_modules
**/dist
**/.venv
**/__pycache__
**/qdrant_data
apps/web
supabase
.env
**/.env
**/.env.*
!**/.env.example
*.log
.claude
```

### 2.2 `apps/agent/Dockerfile` (build context = **repo root**, workspace-aware)
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" CI=true
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter agent...
COPY packages/shared-types packages/shared-types
COPY apps/agent apps/agent
RUN pnpm --filter agent exec prisma generate \
 && pnpm --filter agent build
RUN pnpm --filter agent deploy --legacy --prod /prod/agent \
 && cd /prod/agent \
 && npx --yes prisma@7.8 generate --schema prisma/schema.prisma

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /srv/agent
COPY --from=build /prod/agent/node_modules ./node_modules
COPY --from=build /prod/agent/package.json ./package.json
COPY --from=build /repo/apps/agent/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
```
Why `pnpm deploy` (vs `pnpm fetch`): produces a self-contained hoisted production `node_modules`, required because the esbuild bundle keeps packages external. The second `prisma generate` regenerates the client inside the deploy dir (the deploy copy doesn't inherit the workspace-generated client).

### 2.3 `apps/python/Dockerfile` (build context = **apps/python**, uv multi-stage)
```dockerfile
# syntax=docker/dockerfile:1.7
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project
COPY . .

FROM python:3.12-slim-bookworm AS runtime
# libsndfile1: soundfile; libgomp1: ctranslate2/onnxruntime OpenMP
# NO tesseract-ocr / NO ffmpeg: pytesseract+PyMuPDF are ingest-only (scripts/ingest.py,
# runs on the dev machine); faster-whisper decodes via PyAV (bundles ffmpeg libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
      libsndfile1 libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 appuser \
    && mkdir -p /data/hf-cache && chown -R appuser:appuser /data
WORKDIR /app
COPY --from=builder --chown=appuser:appuser /app /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 HF_HOME=/data/hf-cache
USER appuser
EXPOSE 8000
# generous start-period: first boot downloads e5-large (~2.2GB) + whisper large-v3 (~3GB)
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=5 \
  CMD python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4); sys.exit(0 if r.status==200 else 1)"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
```
**Model caching decision:** persistent HF cache volume (`HF_HOME=/data/hf-cache` → named volume `hf_cache`), not baked into the image. Image stays ~2.5–3 GB; models download once on first boot and survive redeploys. One volume covers both e5-large and faster-whisper — but LlamaIndex's `HuggingFaceEmbedding` ignores `HF_HOME` (defaults to `~/.cache/llama_index`), so `LLAMA_INDEX_CACHE_DIR=/data/hf-cache/llama_index` must also be set (found during the local smoke test).
`rvc-python`: NOT installed (matches pyproject comment; only needed if `RVC_MODEL_PATH` set) — out of scope initially. The Windows-only `pywin32==311` constraint is harmless on Linux.

### 2.4 `docker-compose.prod.yml` (repo root — **delete** the stale `docker-compose.yml`)
```yaml
name: ai-secretary

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks: [web, internal]
    depends_on:
      agent: { condition: service_healthy }
      python: { condition: service_healthy }

  agent:
    image: ghcr.io/<OWNER>/ai-secretary-agent:${IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file: /opt/ai-secretary/agent.env
    environment: { PORT: "3000" }
    networks: [internal]
    depends_on:
      python: { condition: service_healthy }

  python:
    image: ghcr.io/<OWNER>/ai-secretary-python:${IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file: /opt/ai-secretary/python.env
    environment:
      QDRANT_URL: http://qdrant:6333
      HF_HOME: /data/hf-cache
    volumes: [hf_cache:/data/hf-cache]
    networks: [internal]
    depends_on:
      qdrant: { condition: service_healthy }

  qdrant:
    image: qdrant/qdrant:v1.18.0   # pair with qdrant-client 1.18; verify exact tag exists
    restart: unless-stopped
    ports: ["127.0.0.1:6333:6333"]  # loopback only — SSH-tunnel admin/migration, not public
    volumes: [qdrant_data:/qdrant/storage]
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "bash -c ':> /dev/tcp/127.0.0.1/6333' || exit 1"]
      interval: 15s
      timeout: 3s
      retries: 5
      start_period: 20s

networks: { web: {}, internal: {} }
volumes: { caddy_data: {}, caddy_config: {}, qdrant_data: {}, hf_cache: {} }
```
Only Caddy publishes 80/443. Agent/python healthchecks come from their Dockerfiles; both run non-root.

### 2.5 `deploy/Caddyfile` (repo copy; deployed to `/opt/ai-secretary/Caddyfile`)
```
api.YOURDOMAIN.com {
    reverse_proxy agent:3000
}
py.YOURDOMAIN.com {
    reverse_proxy python:8000
}
```
Subdomain routing (not path routing) so Express/FastAPI route prefixes stay untouched. Caddy auto-provisions Let's Encrypt certs once DNS A records point at the VPS. `api.` is also the Twilio webhook host (`AGENT_PUBLIC_URL`); `py.` is called directly by the Vercel web app (`VITE_PYTHON_API_BASE_URL`).

### 2.6 `.github/workflows/deploy.yml`
Build both images with buildx + GHA cache, push `latest` + `${{ github.sha }}` tags to GHCR on push to `main` (agent: context `.`, file `apps/agent/Dockerfile`; python: context `apps/python`); then a `deploy` job SSHes to the VPS (`appleboy/ssh-action`, secrets `VPS_HOST` + `VPS_SSH_KEY`, user `deploy`) and runs:
```
cd /opt/ai-secretary && docker compose pull && docker compose up -d && docker image prune -f
```

### 2.7 `apps/python/scripts/migrate_qdrant.py` — one-off data migration (see Phase 6)

---

## Phase 3 — Reverse proxy / TLS consequences
- `AGENT_PUBLIC_URL=https://api.YOURDOMAIN.com` — **mandatory**: Twilio signature validation is silently skipped when unset (`twilio/twilioAuth.ts:15`). Repoint Twilio voice webhooks.
- `GOOGLE_REDIRECT_URL=https://api.YOURDOMAIN.com/auth/google/gmail/callback` — also add to the Google Cloud OAuth client's authorized redirect URIs.
- DNS: A records for `api` and `py` → VPS IP.

## Phase 4 — Hetzner provisioning
1. **Server: CPX41** (8 vCPU, 16 GB RAM, 240 GB NVMe), Ubuntu 24.04. 16 GB is the floor: whisper large-v3 int8 ~3 GB (loaded at import even if voice unused) + e5-large ~2.5 GB + torch/onnx overhead + qdrant + agent + OS ≈ 9–11 GB peak.
2. Hetzner Cloud Firewall: inbound 22, 80, 443 only.
3. `adduser deploy`; SSH key auth only (`PasswordAuthentication no`); later `usermod -aG docker deploy`.
4. Install Docker: `curl -fsSL https://get.docker.com | sh`.
5. `mkdir -p /opt/ai-secretary` (owned by deploy); scp `docker-compose.prod.yml` (as `docker-compose.yml`) + `Caddyfile`; create `agent.env` / `python.env` (chmod 600).
6. GHCR login on VPS: PAT with `read:packages` → `docker login ghcr.io`.
7. Docker log rotation: `/etc/docker/daemon.json` → json-file, max-size 10m, max-file 3.

## Phase 5 — Env files (on VPS only, never committed, chmod 600)

`/opt/ai-secretary/agent.env` — dev values carried over, with these **production changes**:
```
PORT=3000
PY_SERVICE_URL=http://python:8000
PYTHON_SERVICE_URL=http://python:8000
AGENT_CORS_ALLOW_ORIGINS=https://<web-app>.vercel.app
GOOGLE_REDIRECT_URL=https://api.YOURDOMAIN.com/auth/google/gmail/callback
GMAIL_OAUTH_FALLBACK_BASE_URL=https://<web-app>.vercel.app
GMAIL_OAUTH_ALLOWED_REDIRECT_ORIGINS=https://<web-app>.vercel.app
AGENT_PUBLIC_URL=https://api.YOURDOMAIN.com
```
Plus required carry-overs: `DATABASE_URL` (Supabase **pooled** string), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (**rotate at go-live** — it sat in a dev .env), `INTER_SERVICE_SECRET` (identical in both files), `GMAIL_TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID/SECRET`, `GMAIL_OAUTH_STATE_SECRET`, `GOOGLE_REFRESH_TOKEN`, `SMTP_*`, `TWILIO_*`, `VOICE_TTS_PROVIDER`, `ROUTER_*` (keep `ROUTER_ALLOW_KEYWORD_FALLBACK=false` and `ROUTER_LLM_PROVIDER=openai`), `RAG_*`, `OPENAI_API_KEY`, `GENERAL_CHAT_API_KEY`.

> GitHub Models was retired 2026-08 — `GITHUB_MODELS_TOKEN` is gone and `ROUTER_LLM_PROVIDER=github` now throws at startup. Routing needs `OPENAI_API_KEY` on the box.

`/opt/ai-secretary/python.env`:
```
CORS_ALLOW_ORIGINS=https://<web-app>.vercel.app
QDRANT_URL=http://qdrant:6333
QDRANT_COLLECTION=waste_management_law_mk_v2
INTER_SERVICE_SECRET=<same as agent>
SUPABASE_URL=... / SUPABASE_SERVICE_ROLE_KEY=...
RAG_EMBED_PROVIDER=huggingface
RAG_EMBED_MODEL=intfloat/multilingual-e5-large
RAG_LLM_* / OPENAI_API_KEY as in dev
AZURE_TTS_KEY / AZURE_TTS_REGION / AZURE_TTS_VOICE
STT_MODEL_SIZE=large-v3   # drop to distil-large-v3/medium if RAM is tight
STT_DEVICE=cpu
STT_COMPUTE_TYPE=int8
```
Leave `QDRANT_LOCAL_PATH`, `TESSERACT_CMD`, `RVC_*` unset.

## Phase 6 — Qdrant data migration
The 47 MB store at `apps/agent/src/rag-agent/qdrant_data` is qdrant-client **embedded-local** format — not directly loadable by the server container, and local mode has no snapshot API.

**Recommended: scroll + upsert script** (`apps/python/scripts/migrate_qdrant.py`) — copies exact vectors + payloads, no re-embedding:
```python
import os
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

SRC = QdrantClient(path=os.environ["QDRANT_LOCAL_PATH"])
DST = QdrantClient(url=os.environ["QDRANT_URL"])
COLL = os.getenv("QDRANT_COLLECTION", "waste_management_law_mk_v2")

DST.recreate_collection(COLL, vectors_config=VectorParams(size=1024, distance=Distance.COSINE))
offset = None
while True:
    points, offset = SRC.scroll(COLL, limit=256, offset=offset, with_payload=True, with_vectors=True)
    if not points:
        break
    DST.upsert(COLL, points=[PointStruct(id=p.id, vector=p.vector, payload=p.payload) for p in points])
    if offset is None:
        break
print("done:", DST.count(COLL))
```
Run from the dev machine through an SSH tunnel (qdrant is loopback-bound on the VPS):
`ssh -L 16333:127.0.0.1:6333 deploy@VPS`, then
`QDRANT_LOCAL_PATH=<abs path> QDRANT_URL=http://127.0.0.1:16333 uv run python scripts/migrate_qdrant.py`.

Fallback: re-run `apps/python/scripts/ingest.py` against `QDRANT_URL` via the same tunnel (it already supports `QDRANT_URL`, ~line 97) — needs source docs + tesseract + re-embedding time.

Post-check: `curl http://127.0.0.1:16333/collections/waste_management_law_mk_v2` shows the expected point count.

## Phase 7 — Verification
Local, before first deploy:
1. `docker build -f apps/agent/Dockerfile .` and `docker build -f apps/python/Dockerfile apps/python` succeed.
2. `docker compose -f docker-compose.prod.yml up` with local env files (Caddyfile sites swapped to `:80`); all services reach healthy.
3. `curl` agent + python `/healthz` → `{ok:true,...}`.

On the VPS after first CI deploy:
4. `docker compose ps` all healthy; python logs show RAG warmup finished (first boot: HF downloads).
5. `curl https://api.YOURDOMAIN.com/healthz` and `https://py.YOURDOMAIN.com/healthz` over TLS.
6. `/agent/resolve-and-run` with a real Supabase JWT → 200.
7. Waste-law RAG question end-to-end (agent → python → qdrant → cited answer).
8. From the Vercel site: one agent call + one direct python call, no browser CORS errors.
9. Twilio test call — signature validation passes (`AGENT_PUBLIC_URL` matches the public origin exactly).
10. Rate limits key on real client IPs (trust proxy / proxy-headers verified via `X-RateLimit-*`).

**Rollback:** images are tagged by commit SHA — `IMAGE_TAG=<previous-sha> docker compose up -d` on the VPS (compose reads `${IMAGE_TAG:-latest}`).

## Phase 8 — Out of scope (later)
GPU inference; horizontal scaling; zero-downtime deploys; centralized logging/metrics; automated qdrant volume backups (interim: cron tar of the volume); rvc-python in prod; a **deployed** staging environment (see Phase 9 — CI groundwork for `test` exists, but no test server); image vulnerability scanning.

## Phase 9 — Test environment (CI groundwork only, no infra yet)

**User decision (locked):** stand up the branch + env-file convention now; defer standing up an actual test server (second VPS vs. shared VPS vs. anything else) until later.

### 9.1 `test` branch
Long-lived branch off `main`. Pushes to `test` run CI (build + image push) but never deploy anywhere yet — there is no server to SSH into. Promote `test` → `main` via normal PR/merge once ready for prod.

### 9.2 `test.env` naming convention (documented now, not created)
Same shape as `agent.env` / `python.env` (Phase 5): gitignored, chmod 600, one per service, created directly on whatever host eventually runs the test stack. No file exists yet — this just reserves the naming so Phase 5's env docs and `.github/workflows/deploy.yml` agree on it once a target exists.

### 9.3 `.github/workflows/deploy.yml` — branch-conditional behavior
Single workflow, branching on which ref triggered it. The implemented file also has
(beyond the sketch below): a `check` job gating `build` (agent `tsc --noEmit` +
python `uv sync --frozen` / `compileall` — no unit-test suites exist yet, slot them
in there when written), and post-deploy `curl /healthz` smoke checks that activate
once the `AGENT_PUBLIC_URL` / `PYTHON_PUBLIC_URL` repository **variables** are set
(i.e. once a domain exists):

```yaml
name: deploy

on:
  push:
    branches: [main, test]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set image tag prefix
        id: vars
        run: |
          if [ "${{ github.ref_name }}" = "main" ]; then
            echo "tag=latest" >> "$GITHUB_OUTPUT"
          else
            echo "tag=test-${{ github.ref_name }}" >> "$GITHUB_OUTPUT"
          fi

      - uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/agent/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/ai-secretary-agent:${{ steps.vars.outputs.tag }}
            ghcr.io/${{ github.repository_owner }}/ai-secretary-agent:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - uses: docker/build-push-action@v6
        with:
          context: apps/python
          file: apps/python/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/ai-secretary-python:${{ steps.vars.outputs.tag }}
            ghcr.io/${{ github.repository_owner }}/ai-secretary-python:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    if: github.ref_name == 'main'   # test branch stops after build — no deploy target yet
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: deploy
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/ai-secretary && docker compose pull && docker compose up -d && docker image prune -f
```

Pushing to `test` builds and pushes `ai-secretary-agent:test-test` / `:<sha>` images to GHCR and stops — `deploy` is skipped by the `if:` guard. Pushing to `main` does the same build, then proceeds to the SSH deploy step exactly as in Phase 2.6. When a real test server exists later, add a second `deploy-test` job gated on `if: github.ref_name == 'test'`, pointed at new `VPS_HOST_TEST` / `VPS_SSH_KEY_TEST` secrets and its own `/opt/ai-secretary` path — the `build` job above does not change.

## Key risks
1. **torch CUDA wheels in current uv.lock** — Phase 1.9 relock is mandatory or the python image is ~10 GB.
2. **First-boot model download (~5.5 GB)** gates the python healthcheck (start-period 600s covers it); optional pre-warm: `docker compose run --rm python python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('intfloat/multilingual-e5-large')"`.
3. **`pnpm deploy --legacy` + `npx prisma generate` in the deploy dir** are the most fragile Dockerfile steps — validate in the local build first. Fallback: full esbuild bundle (drop `--packages=external`, keep only `@prisma/client` external).
4. **Secrets hygiene**: rotate `SUPABASE_SERVICE_ROLE_KEY` (ideally also `INTER_SERVICE_SECRET`, Google client secret) at go-live.
5. `GOOGLE_REFRESH_TOKEN` / `SMTP_*` aren't zod-validated — easy to forget in `agent.env`.
6. 16 GB RAM floor; if voice isn't live yet, `STT_MODEL_SIZE=small` saves ~2.5 GB.

## Implementation order
1. Phase 1 code fixes → verify `pnpm --filter agent build` + `node apps/agent/dist/server.js` boots locally; `uv lock` clean.
2. Phase 2 files → local docker builds → local compose smoke test.
3. Phase 4 VPS provisioning + Phase 5 env files.
4. Phase 6 qdrant migration.
5. Phase 2.6 GitHub Actions → first CI deploy → Phase 7 checks 4–10.
6. Phase 9 whenever ready: cut the `test` branch, push once to confirm CI builds/pushes images and correctly skips the deploy job.

## Critical files
- `apps/agent/package.json` — esbuild build script, `dotenv` + `esbuild` deps
- `apps/agent/src/server.ts` — trust proxy (healthz + PORT already fine)
- `apps/agent/src/agent/directResolverChain.ts`, `apps/agent/src/agent/wasteLawChain.ts` — env var fallback
- `apps/python/main.py` — add `/healthz`
- `apps/python/pyproject.toml` + `uv.lock` — CPU torch index + relock
- `package.json` (root) — packageManager pin
- New: `apps/agent/Dockerfile`, `apps/python/Dockerfile`, `.dockerignore`, `docker-compose.prod.yml`, `deploy/Caddyfile`, `.github/workflows/deploy.yml` (branch-conditional: builds `main`+`test`, deploys only `main` — see Phase 9), `apps/python/scripts/migrate_qdrant.py`
- Delete: `docker-compose.yml` (stale placeholder)
