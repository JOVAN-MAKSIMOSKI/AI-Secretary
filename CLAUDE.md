# AI-Secretary — Claude Code Context

## How This Repo Works

Two backend services run in parallel and communicate over HTTP:

- **`apps/agent`** — TypeScript, LangGraph orchestrator, MCP servers, Claude API. Always the orchestrator. All LLM calls happen here exclusively.
- **`apps/python`** — Python, FastAPI. Document generation (Excel/Word), RAG, STT only. Never calls Claude.
- **`apps/web`** — React/Vite frontend. Calls `apps/agent` via Axios. Never queries the database directly.

Data flow is strictly one-directional:
```
apps/web → apps/agent → Prisma/Supabase
                      → apps/python (via fetch)
                      → MCP servers (Gmail, Google Calendar)
```

Full repo structure: see `.github/architecture.md`. Note: the architecture doc is slightly behind the actual codebase — `apps/agent/src/agent/directResolverChain.ts`, `apps/python/routers/business.py`, `apps/python/routers/clients.py`, and the `tasks` + `gmail_oauth_connections` tables all exist but are not in that doc. Trust the actual code over the doc.

---

## Skill Routing

This project uses custom Claude Code skills stored in `.claude/skills/`. Load the relevant skill before making changes in its domain — do not rely on memory alone.

| Task | Skill to load |
|---|---|
| Any MCP work (client, transport, sampling, agent loop, approval gates) | `.claude/skills/mcp-architecture/` |
| Creating/editing skills, expanding any .md file, post-session skill review, skill audits | `.claude/skills/skill-management/` |

**How skills activate:** Claude reads the skill's `SKILL.md` before proceeding when the task matches its description. If you are unsure whether a skill applies, read the `SKILL.md` description — it lists its own trigger conditions explicitly.

**Adding new skills:** When a new skill is created, add a row to this table in the same commit. The skill directory name and the row must stay in sync.

---

## Knowledge Architecture

Project rules are split across scoped files so context only loads when relevant. Here is where to find what:

| File | Scope | Contains |
|---|---|---|
| `CLAUDE.md` — you are here | Always | Repo overview, skill routing, key rules |
| `.claude/rules/database.md` | Always | Prisma patterns, RLS, multi-tenancy, migration workflow |
| `.claude/rules/guardrails.md` | Always | Critical never-do's, security constraints |
| `.claude/rules/conventions.md` | Always | Naming, imports, commit messages, file structure |
| `.claude/rules/frontend.md` | `apps/web/**` | React rules, state management, shadcn/ui, routing |
| `.claude/rules/agent-service.md` | `apps/agent/**` | LangGraph patterns, tool nodes, approval gate, caching |
| `.claude/rules/python-service.md` | `apps/python/**` | FastAPI routes, openpyxl, python-docx, RAG, STT |
| `.claude/skills/mcp-architecture/` | On demand | MCP client, transport, sampling, elicitation |
| `.claude/skills/skill-management/` | On demand | Skill creation, testing, post-session review, auditing |
| `.github/architecture.md` | Reference | Full repo tree, service boundaries, LLM resolver contract |
| `.claude/plans/` | Reference | Implementation plans for in-progress or upcoming features |

When in doubt about which rule applies, check the relevant scoped file. Do not guess.

**This table must be kept current.** Any time a new rule file or skill is added, update this table in the same commit. If this table is out of date, the knowledge architecture is broken.

---

## Post-Use Protocol (Mandatory)

These steps execute automatically after any session that involved a skill. They are defined in full inside `.claude/skills/skill-management/` — load that skill to see the complete procedural steps. The triggers are listed here so they fire even if the skill was not explicitly loaded:

| Situation | Protocol | Where defined |
|---|---|---|
| Any `.md` instruction file was expanded or edited | Knowledge Re-Sync (Protocol 1) | `skill-management` skill |
| A new skill was just created | Trigger Test (Protocol 2) | `skill-management` skill |
| A session that used a skill has ended | Enhancement Review (Protocol 3) | `skill-management` skill |
| A new skill passed its trigger test | Skill Audit (Protocol 4) | `skill-management` skill |

Do not skip these. If a situation above applies, load `skill-management` and execute the matching protocol before closing the session.

---

## Key Working Rules

These apply to every task in every file, no exceptions.

### Collaboration
- **Question mark = answer only.** If a prompt ends with `?`, respond — do not write code or take action.
- **Plan before large changes.** Provide a brief implementation plan before any non-trivial code update.
- **Save plans to `.claude/plans/`.** Whenever a plan is created or approved, write it to `.claude/plans/<feature-slug>.md` so it persists across sessions.
- **No changes with missing context.** If the relevant file, schema, or prior decision is not in context, ask before proceeding.
- **Suggest alternatives explicitly.** If a better solution exists outside the current scope, say so, explain why, and wait for approval. Do not implement it unilaterally.
- **Comment your changes.** When modifying code, include comments that describe what changed and why.

### Security & Multi-Tenancy
- `tenant_id` always comes from the **JWT token** in `apps/agent` middleware — never from the request body.
- Every Prisma query must include `where: { tenantId }` — no exceptions.
- The frontend must never query Supabase for client data directly. All data goes through `apps/agent`.
- Supabase Auth (`@supabase/supabase-js`) in `apps/web` is the only permitted direct Supabase call from the frontend.
- All Supabase Storage paths must be namespaced: `/{tenant_id}/outputs/{type}/{filename}`.

### LLM & Agent
- **Development model:** `claude-haiku-4-5-20251001` — always, until final QA.
- **Production QA model:** `claude-sonnet-4-6` — only for final quality validation.
- Never use Opus models.
- Always cache the system prompt using `cache_control: { type: "ephemeral" }` — skipping this wastes ~90% of token cost.
- Never send an email or save a file without a human approval gate (`interrupt_before`).
- Never call the Claude API from `apps/python`.

### Code Quality
- Never write raw SQL — use Prisma in TypeScript.
- Never use `paragraph.text = "..."` in python-docx — always manipulate `runs`.
- Never use `any` in TypeScript without explicit justification.
- Never leave `console.log()` in committed code.
- Never hardcode magic numbers — name all constants (`SCREAMING_SNAKE_CASE`).
- Never prop-drill beyond 2 levels in React.

### File Storage
- Supabase Storage is the single source of truth for all generated files.
- Never use Google Drive MCP for file storage.
- Python generates the file → uploads to Supabase → returns URL to `apps/agent` → agent stores URL in `invoices` or `offers` table via Prisma.
- `storagePath` is `@unique` on both `invoices` and `offers` — always generate unique filenames.

### Tasks & Calendar
- Tasks are a first-class resource: `GET/POST/PATCH/DELETE /tasks` in `server.ts`, stored in the `tasks` Prisma table.
- Calendar events are managed via Google Calendar MCP (`mcp/calendar.ts`) — `GET/POST/DELETE /calendar/events` in `server.ts`.
- Both require Gmail OAuth to be connected first (`gmail_oauth_connections` table).

### Packages
- `packages/shared-types` — shared TS interfaces (`Business`, `Client`, `Invoice`, `Offer`, `Task`) mirroring the real schema, import from `@secretary/shared-types`
- Env validation lives per-service, not in a shared package: `apps/agent/src/lib/env.ts` (`validateAgentEnv`, called at startup in `server.ts`) and the env guard at the top of `apps/python/main.py`.
- Logging lives per-service: `apps/agent/src/lib/logger.ts`. There is no shared logger package.
