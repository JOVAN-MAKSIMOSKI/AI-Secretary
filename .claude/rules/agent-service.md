# Agent Service Rules — apps/agent

Applies when Claude touches any file under `apps/agent/**`.

---

## Stack

- Runtime: Node.js, TypeScript strict mode
- Agent framework: `@langchain/langgraph`
- LLM: `@anthropic-ai/sdk`
- MCP SDK: `@modelcontextprotocol/sdk`
- ORM: Prisma (`prisma`, `@prisma/client`)
- Database: Supabase Postgres
- Auth: Supabase Auth (`@supabase/supabase-js`)
- Storage: Supabase Storage
- HTTP server: Express (`server.ts` — entry point)

---

## Model Selection

- **Development / testing:** `claude-haiku-4-5-20251001` — always, until final QA
- **Production QA only:** `claude-sonnet-4-6` — final quality validation only
- Never use Opus models

### General chat provider exception

`src/agent/generalChatChain.ts` is the **one** user-facing prose call in this service
that is not Claude. It runs OpenAI `gpt-5-nano` against the Responses API
(`GENERAL_CHAT_API_KEY`, overridable with `GENERAL_CHAT_MODEL`).

Two reasons, both binding:

1. Only an OpenAI credential exists for this project. `ANTHROPIC_API_KEY` is not set,
   which is also why the pre-existing voice fallback had been silently returning its
   canned error on every call before this chain replaced it.
2. The feature requires live web search. The hosted `web_search` tool is a provider
   feature, and there is no GitHub Models equivalent — doing it on the existing
   routing credential would mean a separate search vendor plus a hand-rolled tool loop.

Model choice is not arbitrary and should not be changed casually: `gpt-5-nano` is the
cheapest model that actually supports the hosted tool (`gpt-4.1-nano` rejects it —
verified by probe), and being a gpt-5 reasoning model it bills searches at $10/1k
rather than the $25/1k non-reasoning tier. Any replacement must support `web_search`
on the Responses API.

Scope of the exception, precisely:

- It covers `generalChatChain.ts` only. Every other LLM call in `apps/agent` stays on
  Claude per the rule above.
- It does **not** loosen the "never call an LLM from `apps/python`" rule.
- `cache_control: { type: "ephemeral" }` does not apply here — it is Anthropic syntax.
  OpenAI caches prompt prefixes automatically, so the mandatory-caching rule is met by
  keeping the system prompt prefix stable, not by a parameter.

`GENERAL_CHAT_API_KEY` is deliberately **not** named `OPENAI_API_KEY`: the resolver's
auto mode ranks OpenAI above the free GitHub Models tier, so reusing that name would
silently move every routing call onto paid billing.

Two behaviours in that module are deliberate and were driven by measured failures —
do not "simplify" them away:

- **Voice answers are run through `sanitizeForSpeech()`.** The voice prompt forbids
  markdown and links, but after a web search the model reliably appends
  `([domain](url))` citations anyway. A probe caught it reading a tracking URL down
  the phone. The guarantee is deterministic, not prompt-based.
- **`max_output_tokens` is generous even on the voice path.** On a reasoning model that
  ceiling covers reasoning tokens *and* the visible answer, so a voice-sized cap of
  ~150 gets consumed entirely by reasoning and returns empty text. Brevity is enforced
  through the system prompt instead.

---

## System Prompt Caching (Mandatory)

Always cache the system prompt and tenant context using `cache_control: { type: "ephemeral" }`. Skipping this wastes ~90% of token cost.

```typescript
const response = await anthropic.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1024,
  system: [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `Tenant context: ${tenantContext}`,
      cache_control: { type: "ephemeral" },
    },
  ],
  messages: userMessages,
});
```

---

## LangGraph Patterns

### State Definition

Always use TypeScript strict types:

```typescript
interface AgentState {
  tenantId: string;
  clientId: string;
  messages: Array<{ role: string; content: string }>;
  currentAction: "generating" | "sending" | "idle";
  approvalGate: {
    pending: boolean;
    action: string;
    details: Record<string, unknown>;
    approvedAt?: Date;
  };
  errors: string[];
}
```

### Agent Loop Order (Every Action)

1. Resolve client from Prisma (structured data)
2. Retrieve RAG context from Python `/api/rag/query` (past interactions)
3. Inject both into LLM context
4. Execute tool (document generation or comms)
5. Write audit log entry to Supabase

### Tool Node Pattern

```typescript
async function generateInvoiceTool(state: AgentState) {
  const { tenantId, clientId } = state;

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.tenantId !== tenantId) {
    return { ...state, errors: [...state.errors, "Client not found or access denied"] };
  }

  const ragContext = await fetch("http://localhost:8000/api/rag/query", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenantId, client_id: clientId, query: "past interactions" }),
  }).then(r => r.json());

  const { file_url, file_path } = await fetch("http://localhost:8000/api/documents/invoice", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenantId, client_id: clientId, amount: calculateAmount(client, ragContext) }),
  }).then(r => r.json());

  const document = await prisma.document.create({
    data: { tenantId, clientId, type: "invoice", filePath: file_path, fileUrl: file_url, status: "draft" },
  });

  await prisma.auditLog.create({
    data: { tenantId, actionType: "file_created", clientId, fileUrl: file_url, status: "pending_approval" },
  });

  return {
    ...state,
    currentAction: "idle",
    approvalGate: { pending: true, action: "send_invoice", details: { documentId: document.id, fileUrl: file_url } },
  };
}
```

---

## Approval Gate (Mandatory)

Never send an email or save a file without a human approval gate. Use `interrupt_before` on any send or save node.

```typescript
workflow.addNode("approval", approvalNode);
workflow.addEdge("generateInvoice", "approval");
// Only proceed to sendEmail after approval is confirmed
```

---

## MCP Server Integration

- MCP servers (Gmail, Google Calendar) are registered as LangGraph tools
- Use MCP Streamable HTTP transport (`MCP_TRANSPORT=http`)
- Client transport: `StreamableHTTPClientTransport`
- Always use `@modelcontextprotocol/sdk` from npm
- Initialize client with capabilities for `sampling` and `roots`

### Host-Driven Agent Rules

- The host (agent) owns: LLM calls, tool-use decisions, orchestration, memory
- The MCP server owns: capability exposure and deterministic execution
- Only `agentLoop.ts` (or a single equivalent) is allowed to interpret tool calls, call tools, re-prompt the LLM, and stop loops
- Transport modules must not contain business rules
- Server prompts are templates — the host injects them into LLM context at runtime

---

## TypeScript Patterns

### Tenant Isolation at Query Time

```typescript
// Always filter by tenantId
const clients = await prisma.client.findMany({ where: { tenantId: currentTenantId } });
```

### Avoiding N+1 Queries

```typescript
// Use include for relations needed immediately
const clients = await prisma.client.findMany({
  where: { tenantId },
  include: { documents: true },
});
```

### Custom Error Classes

```typescript
export class TenantMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantMismatchError";
  }
}
```

### Structured Logging

```typescript
logger.info("Invoice generated", { tenantId, clientId, documentId, duration: Date.now() - startTime });
// Never: logger.info(`Generated invoice for ${clientName}`)
```

---

## File Storage Flow

1. Call Python service to generate file
2. Python uploads to Supabase Storage at `/{tenant_id}/outputs/{type}/{filename}`
3. Python returns Supabase Storage URL
4. Store URL in `invoices` or `offers` table via Prisma (not a generic `documents` table — see actual schema)
5. Human approval gate before any further action

Never use Google Drive MCP for file storage.

---

## Actual Server Routes (server.ts)

The Express entry point exposes these routes — all require `Authorization: Bearer <token>` except `/healthz`:

```
GET  /healthz                          # Health check (no auth)

GET  /auth/google/gmail/connect        # Start Gmail OAuth flow
GET  /auth/google/gmail/status         # Check Gmail connection status
GET  /auth/google/gmail/callback       # OAuth callback handler
POST /auth/google/gmail/disconnect     # Disconnect Gmail

GET  /calendar/events                  # List calendar events (query: timeMin, timeMax, maxResults)
POST /calendar/events                  # Create event (body: title, startTime, endTime, description, attendeeEmails[])
DELETE /calendar/events/:eventId       # Delete event

GET  /tasks                            # List tasks (query: status=pending|completed)
POST /tasks                            # Create task (body: title, notes?, dueAt?)
PATCH /tasks/:taskId                   # Update task (body: title?, notes?, dueAt?, status?)
DELETE /tasks/:taskId                  # Delete task

POST /agent/resolve-and-run            # Main agent endpoint (body: message)
```

The `/agent/resolve-and-run` endpoint calls `runDirectResolverChain()` and returns:
```typescript
{ tenantId, userAuthId, resolvedChainId, resolverConfidence, resolverReason, resolverMissingInfo, result }
```

---

## LLM Resolver — How It Actually Works

`llmResolver.ts` supports three routing providers, selected via env vars:

| Env var | Values | Behavior |
|---|---|---|
| `ROUTER_LLM_PROVIDER` | `openai`, `anthropic`, `github`, `keyword`, `auto` | Selects routing backend |
| `ROUTER_ALLOW_KEYWORD_FALLBACK` | `true`/`1` | Falls back to keyword matching if LLM fails — **policy: keep `false`**, see `guardrails.md` Router LLM Env Vars |
| `ROUTER_LLM_MODEL` | model name | Overrides default model for either provider |
| `ROUTER_GITHUB_MODELS_TOKEN` | token | Required for GitHub Models provider |
| `OPENAI_API_KEY` | key | Required for the OpenAI provider |
| `ANTHROPIC_MODEL` | model name | Override for Anthropic routing model |

**Auto mode priority:** OpenAI → GitHub Models → Anthropic → keyword fallback (if allowed).

GitHub Models and OpenAI share one implementation (`resolveWithOpenAiCompatible`) because
both speak the same `/chat/completions` protocol — they differ only by base URL, token,
and model. Add any future OpenAI-compatible backend as another thin wrapper rather than a
fourth copy of the request logic.

Keyword fallback returns confidence `0.55` (keyword match) or `0.35` (no match) — it is
disabled by policy (`ROUTER_ALLOW_KEYWORD_FALLBACK=false`); the mechanics remain documented
here only so the code path is understood.

The resolver always returns a `ResolverDecision`:
```typescript
interface ResolverDecision {
  chainId: ChainId;   // see CHAIN_REGISTRY in chainRegistry.ts — the source of truth
  confidence: number; // 0–1
  reason: string;
  missingInfo: string[];
}
```

`ChainId` is deliberately not enumerated here. It has grown to ten members and any
copy in this file goes stale the next time a chain is added — read
`chainRegistry.ts`. `general_chat` is the catch-all and must stay last-resort: see
the false-positive gate in `src/evals/routing.eval.ts`, which fails the build if it
poaches a request belonging to another chain.

**When adding a new chain:** update `chainRegistry.ts` with the new `ChainDefinition` (id, displayName, description, keywords) in the same commit as any other changes. `llmResolver.ts` reads the registry dynamically — no changes needed there.

---

## AgentState Fields

```typescript
interface AgentState {
  tenantId: string;
  clientId: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  currentAction: 'idle' | 'planning' | 'resolving' | 'executing' | 'auditing';
  resolvedChainId?: ChainId; // see chainRegistry.ts — do not re-enumerate here
  resolverConfidence?: number;
  resolverReason?: string;
  resolverMissingInfo?: string[];
  approvalGate: { pending: boolean; action: string; details: Record<string, unknown>; approvedAt?: string };
  ragContext: string;
  errors: string[];
}
```

---

## Shared Packages & Local Modules

The only shared workspace package is:

- `packages/shared-types` — `Business`, `Client`, `Invoice`, `Offer`, `Task` interfaces (mirror the real Prisma schema, `snake_case` to match the API contract)

Env validation and logging are **local agent modules**, not shared packages:

- `src/lib/env.ts` — `validateAgentEnv()`, called once at startup in `server.ts`; fails the boot on missing/malformed env vars
- `src/lib/logger.ts` — structured logger; use this instead of `console.log`

Import example:
```typescript
import type { Client } from '@secretary/shared-types';
import { logger } from './lib/logger.js';
import { validateAgentEnv } from './lib/env.js';
```
