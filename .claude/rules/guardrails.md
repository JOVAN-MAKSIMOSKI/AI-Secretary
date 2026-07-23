# Critical Guardrails — Never Do's

The core principle: **Data isolation + human approval gates + type safety.**
Every rule below serves one of these three.

---

## Database & Multi-Tenancy

- Never write raw SQL — use Prisma in TypeScript
- Never skip `tenant_id` filter on any database query
- Never trust `tenant_id` from the request body — always source it from the JWT token in middleware
- Never let the frontend query Supabase for client data directly — all client data must go through `apps/agent`
- Never expose interactions or files across tenant boundaries
- Never skip RLS policies on Supabase tables

---

## Python Service

- Never call the Claude API from the Python service
- Python must only expose HTTP endpoints — it does not run the agent loop
- Never hardcode credentials in Python code
- Never skip `tenant_id` validation on any route

---

## Document Generation — Excel (openpyxl)

- Never hardcode cell coordinates — use named cell ranges
- Never overwrite a template file — always write to a new output file
- Never rely on Excel formula recalculation on save — compute all totals in Python as literal values
- Never open templates without `data_only=True`

---

## Document Generation — Word (python-docx)

- Never use `paragraph.text = "..."` directly — this destroys all formatting
- Always manipulate `runs` to preserve existing styles
- For table cells, iterate `cell.paragraphs` then `paragraph.runs` — never assume flat structure

---

## LLM & Agent

- Never use Opus models — unnecessary cost
- Never use Sonnet during development — Haiku only until final QA
- Never call the Claude API from Python — only from TypeScript (`apps/agent`)
- Never send an email or save a file without a human approval gate (`interrupt_before`)
- Never skip system prompt caching — reduces cost by ~90%

---

## File Storage

- Never use Google Drive MCP — Supabase Storage is the single source of truth
- Never store files locally without backing them up to Supabase
- Never use paths without tenant namespacing (`/{tenant_id}/...`)
- Never store plaintext credentials in Supabase Storage
- Never expose sensitive directories (`.env`, `node_modules`, `.git`)

---

## MCP / Agent Architecture

- Never keep MCP protocol logic inside React components or hooks
- Never treat MCP client as a UI concern
- Never call MCP tools directly from React
- Never run the agent loop in Python — TypeScript orchestrates everything

---

## Type Safety & Validation

- Never use `any` in TypeScript without explicit justification
- Never return raw form data — always cast strings to correct types (numbers, booleans, enums)
- Never trust user input without validation at system boundaries
- Never ignore errors silently
- Never return partial data on error

---

## Code Quality

- Never commit code with `console.log()` left in
- Never prop-drill beyond 2 levels in React
- Never skip dependency array in `useEffect`
- Never hardcode magic numbers — name all constants (`SCREAMING_SNAKE_CASE`)
- Never create circular dependencies

---

## Security & Data Isolation

- Never expose system paths in error messages
- Never log sensitive data (passwords, API keys, tokens)
- Never send unencrypted data over HTTP in production (always HTTPS)
- Never allow one tenant to query another tenant's data
- Never use secrets directly in code — always use environment variables

---

## Deployment & Infrastructure

- Never hardcode API URLs or keys
- Never deploy without environment variables configured
- Never delete migration files
- Never bypass database migrations
- Never use `prisma db push` in production

---

## Schema-Specific Rules (from actual Prisma schema)

- `invoices.storagePath` and `offers.storagePath` are `@unique` — never insert a duplicate path, always generate a unique filename
- `businesses.owner_auth_id` is the FK target for all tenant relations — not `businesses.id`. Use `owner_auth_id` when joining to `businesses`
- `tasks.status` is only `"pending"` or `"completed"` — never insert another string value
- `invoices.invoice_type` is an enum (`InvoiceType.goods` or `InvoiceType.transport`) — never use a raw string
- `gmail_oauth_connections` has a unique constraint on `(tenant_id, user_auth_id)` — upsert, never blind insert
- OAuth tokens in `gmail_oauth_connections` are stored encrypted (`_enc` suffix) — never store plaintext tokens

---

## Router LLM Env Vars

The LLM resolver reads several env vars. The LLM is the only permitted resolver — routing decisions must never come from keyword matching:

- `ROUTER_ALLOW_KEYWORD_FALLBACK=false` always (Phase 4 of the waste-law RAG plan). A resolver failure must surface as a hard error, never degrade to a silent keyword guess.
- Never set `ROUTER_LLM_PROVIDER=keyword`.
- Prefer `ROUTER_LLM_PROVIDER=openai` with `OPENAI_API_KEY` set. `github` (GitHub Models) is the acceptable free-tier alternative but has daily request caps — a quota error there fails a build for a reason unrelated to code quality. `anthropic` remains supported. Either way an LLM provider key must be present at startup so the LLM path is always available.
- `EVALAPIKEY` is evaluation-only. It is mapped onto `OPENAI_API_KEY` inside the eval process by `src/evals/evalEnv.ts` and must never be used as the running service's routing credential.
- The `keywords[]` arrays in `chainRegistry.ts` are dead weight under this policy — LLM routing reads chain descriptions only. Leave them empty for new chains (e.g. `waste_law_query`).
