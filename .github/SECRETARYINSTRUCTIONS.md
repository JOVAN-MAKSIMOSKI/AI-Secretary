# Virtual Secretary — Copilot Instructions

## Project overview
A multi-tenant AI secretary agent that generates invoices and offer documents,
sends emails, manages calendar events, and stores all files in Supabase Storage.
Businesses log in separately and their data is fully isolated by tenant.

---

## Architecture
Two services running in parallel, communicating over HTTP:

1. **TypeScript service** — LangGraph agent, MCP servers, Claude API (orchestrator)
2. **Python service** — FastAPI, document generation (Excel/Word), RAG, STT

The TypeScript service is always the orchestrator.
The Python service exposes HTTP endpoints that the TS agent calls as tools.
All LLM calls happen exclusively in the TypeScript service — never in Python.

---

## TypeScript service stack

- Runtime: Node.js, TypeScript strict mode
- Agent framework: `@langchain/langgraph`
- LLM: `@anthropic-ai/sdk`
  - Model for all development and testing: `claude-haiku-4-5-20251001`
  - Model for final production quality checks only: `claude-sonnet-4-6`
  - Never use Opus — unnecessary cost for this use case
- MCP SDK: `@modelcontextprotocol/sdk`
- MCP servers connected: Gmail, Google Calendar
- ORM: Prisma (`prisma`, `@prisma/client`)
- Database: Supabase Postgres (all tables require `tenant_id` UUID column)
- Auth: Supabase Auth (`@supabase/supabase-js`)
- Storage: Supabase Storage (all generated files, per-tenant buckets)

---

## Python service stack

- Runtime: Python 3.11+
- Framework: FastAPI with uvicorn (ASGI server)
- Excel generation: `openpyxl`
- Word generation: `python-docx`
- STT (Speech to Text): `faster-whisper`
- RAG (retrieval): LlamaIndex with metadata filtering by `tenant_id`
- Dependencies managed via uv (`pyproject.toml` + `uv.lock`, environment in `.venv`)
- Never call Claude API from this service

---

## API routes — Python service

All routes prefixed with `/api/`:

```
POST /api/documents/invoice        # Fill Excel invoice from template
POST /api/documents/offer          # Fill Word offer from template  
POST /api/stt/transcribe           # Transcribe audio → text (faster-whisper)
POST /api/rag/index                # Add interaction to LlamaIndex
POST /api/rag/query                # Retrieve relevant past interactions
GET  /api/rag/client/{tenant_id}/{client_id}  # All history for one client
```

Every route receives and validates `tenant_id` on every request — no exceptions.

---

## Multi-tenancy rules

See [DATABASE.md](DATABASE.md) for complete multi-tenancy guidelines, including:
- Database table structure requirements
- Prisma query patterns  
- Supabase Storage path namespacing
- RLS policy enforcement
- RAG metadata filtering

---

## LangGraph agent patterns

- Use `StateGraph` with a fully typed state interface
- Agent loop order for every action:
  1. Resolve client from Prisma (structured data)
  2. Retrieve RAG context from Python `/api/rag/query` (past interactions)
  3. Inject both into LLM context
  4. Execute tool (document generation or comms)
  5. Write audit log entry to Supabase
- Always use `interrupt_before` on any send or save action — human approval gate is mandatory before emails are sent or files are saved
- MCP servers (Gmail, Google Calendar) are registered as LangGraph tools
- Python service endpoints are called via `fetch()` inside LangGraph tool nodes

---

## Document generation rules (Python)

### Excel — openpyxl
- Open templates with `data_only=True`
- Always compute totals in Python and write as literal values — never rely on Excel formula recalculation on save
- Write to a new file, never overwrite the template
- Use named cell ranges for placeholder cells, not hardcoded coordinates

### Word — python-docx
- Replace `{{placeholder}}` tokens by iterating over `run` objects inside paragraphs
- Never use `paragraph.text = "..."` directly — this destroys all formatting
- Always manipulate `runs` to preserve existing styles
- For table cells, iterate `cell.paragraphs` then `paragraph.runs`

---

## Storage flow for generated files

1. Python service generates file in memory or `/tmp/`
2. Python service uploads to Supabase Storage at `/{tenant_id}/outputs/{type}/{filename}`
3. Python service returns the Supabase Storage URL to the TS agent
4. TS agent stores the URL in the `documents` table in Prisma
5. Human approval gate presents the URL before any further action

Google Drive MCP is not used — Supabase Storage is the single source of truth for all files.

---

See [DATABASE.md](DATABASE.md) for complete Prisma schema and multi-tenancy rules.

---

## Cost management — Claude API

- **Always use `claude-haiku-4-5-20251001` during development and testing**
- Only switch to `claude-sonnet-4-6` for final production quality validation
- Cache the system prompt and tenant context using `cache_control` — these are identical on every agent call and caching reduces cost by 90%
- Use the Batch API for any non-interactive test runs (50% discount)
- Never use Opus models

---

See [CONVENTIONS.md](CONVENTIONS.md) for complete naming conventions and code style guidelines.

---

## What never to do

- Never write raw SQL — use Prisma in TS
- Never call the Claude API from the Python service
- Never use `paragraph.text =` in python-docx — always use runs
- Never skip `tenant_id` filter on any database, storage, or RAG query
See [GUARDRAILS.md](GUARDRAILS.md) for complete list of critical constraints and mandatory rules.

---

## Planned RAG Extension (Saved Context)

- A new RAG agent is planned as a separate tab from the existing assistant flow.
- The new tab should reuse the same base system prompt strategy already used by the main assistant.
- Its domain focus is legal Q&A for waste management law.
- The implementation target is the Python RAG module under `apps/python/rag/` with routing that supports isolated tab behavior.
- Keep tenant isolation rules unchanged: every retrieval and index operation must remain scoped by authenticated tenant identity.