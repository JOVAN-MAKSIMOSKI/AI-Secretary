# Macedonian Waste Law RAG Advisor — Upgrade Plan

## Context

The current system is a stateless single-turn RAG endpoint (`POST /rag/query`) with no tenant
awareness, no conversation history, and generic character-level chunking. This plan upgrades it
to a fully stateful, profile-guided legal advisor grounded in North Macedonia's waste management
legislation.

**What already exists:**
- Two Qdrant collections on disk (`waste_management_law_e3small_1536` and `waste_management_law_nomic_768`)
  — different embedding models, incompatible. A new unified collection replaces both.
- `scripts/ingest.py` (moving from `services/`) — CLI ingestion script using fitz + SentenceSplitter. Needs OCR + article parsing.
- `services/ragagent.py` — retrieval + LLM synthesis. Needs history + upgraded prompt.
- `routers/rag.py` — `POST /rag/query` (stateless). Will be extended with a new `/rag/chat` endpoint.
- `models/rag.py` — three stub Pydantic models (`pass` bodies). Will be filled in.
- `directResolverChain.ts` — active agent loop, stateless. Dispatches via `llmResolver.ts`.
- `llmResolver.ts` — LLM intent router (Anthropic / GitHub Models). Keyword fallback currently allowed — being disabled.
- `chainRegistry.ts` — three registered chains. `waste_law_query` being added.
- `callState.ts` — shows the correct conversation history pattern to replicate for the web path.

**What does not exist yet:**
- `tenantprofilecontext` JSONB column on `businesses` table
- `waste_law_query` chain in the registry
- Conversation history in the web chat path
- New agent route for waste law queries
- Article-level metadata on indexed law chunks

---

## Phase 1 — Ingestion Pipeline Overhaul

> **Why this comes first:** Everything downstream depends on retrieval quality.
> If chunks are malformed or OCR text is garbage, no prompt engineering fixes it.
> The current data in Qdrant is placeholder — the real corpus is ~600 pages arriving later.
> This phase builds the pipeline that will correctly process those 600 pages.

### 1a — Move ingest.py to scripts/

```
apps/python/
├── scripts/
│   ├── ingest.py          ← moved from services/
│   └── check_new_laws.py  ← new (Phase 6)
├── services/
│   ├── ragagent.py        ← stays (runs during live requests)
│   └── debug_rag.py       ← stays (dev diagnostic)
```

`services/` is for code that runs as part of the live FastAPI server. `scripts/` is for tools
you run manually from the command line. `ingest.py` is a one-time CLI tool, not a server module.

### 1b — OCR layer

Add to `requirements.txt`: `pytesseract` (Pillow already present).
**Deviation from original plan:** `pdf2image` is not used — fitz renders scanned pages
to pixmaps directly (`page.get_pixmap(dpi=300)`), avoiding the poppler system
dependency on Windows.

Update `scripts/ingest.py`:
- Open each PDF page with fitz, check if it has selectable text (`page.get_text().strip()`)
- If the page has no selectable text (it's a scanned image), render with fitz and run pytesseract with `lang="mkd"` (Macedonian language pack)
- This handles the mix of selectable and scanned pages common in Official Gazette PDFs
- **System prerequisite:** Tesseract binary + `mkd` traineddata installed; `TESSERACT_CMD` env var if not on PATH

**Added:** DOCX support (`python-docx` — paragraphs + table cells), since the corpus
mixes Word documents with PDFs. Raw source documents live in
`apps/agent/src/rag-agent/resources/` (git-kept folder; `qdrant_data/` is git-ignored).

### 1c — Article-level chunking with metadata

> **Why this matters:** Legal reasoning requires whole articles, not arbitrary 1024-character windows.
> A chunk cut mid-article loses the context that makes a provision legally enforceable.
> The LLM also cannot cite "Article 23" if the chunk doesn't know which article it is.

Replace `SentenceSplitter(chunk_size=1024, overlap=100)` with an article parser:
- Split raw text on the Macedonian article boundary: `r"(?=Член\s+\d+)"` (splits before every "Член N")
- Each chunk = one complete article

After splitting, call a lightweight LLM (GitHub Models `gpt-4o-mini`) once per article at ingest
time to extract structured metadata. This costs a tiny amount at ingest and saves work at every
query:

```python
# Metadata extracted per article during ingest
{
    "text": "...",                        # full article text
    "law": "Law on Waste Management 216/2021",
    "article": "23",
    "title": "Obligations of waste generators",
    "waste_types": ["hazardous", "general"],
    "entity_types": ["business"],
    "valid_from": "2021-01-01"            # for corpus versioning (Phase 6)
}
```

### 1d — Embedding model

> **DECIDED (2026-07-05): `multilingual-e5-large`** — chosen over `text-embedding-3-small`
> because embedding cost is local compute (ingest once + one short query per request),
> not a per-user API cost, and it retrieves significantly better for Macedonian Cyrillic.
> 1024 dims, via `sentence-transformers`, provider `RAG_EMBED_PROVIDER=huggingface`.
>
> **Critical:** e5 is asymmetric — documents embed with `"passage: "` prefix
> (`scripts/ingest.py`), queries with `"query: "` (`services/ragagent.py` via
> `HuggingFaceEmbedding(query_instruction=..., text_instruction=...)` and
> `get_query_embedding()`). Skipping prefixes badly degrades retrieval.
>
> e5's 512-token window means very long articles are sub-split with sentence-aware
> overlap; each part keeps the parent article metadata (`part` payload field).

### 1e — Unified collection name

Create new collection: `waste_management_law_mk_v2`

Point both `scripts/ingest.py` and `services/ragagent.py` to this collection via:
```
QDRANT_COLLECTION=waste_management_law_mk_v2
```

This env var exists in both files already — it just wasn't documented in `.env.example`. Fix that.

**Verification gate:** Run `services/debug_rag.py` after ingesting. Confirm similarity scores > 0.75
and that chunks contain full readable articles, not mid-sentence fragments.

---

## Phase 2 — Tenant Profile Context

> **Design decision:** Rather than a separate `TenantWasteProfile` table, the profile is stored
> as a single JSONB column `tenantprofilecontext` on the existing `businesses` table. One column,
> one migration, no new FK relationships.

### 2a — Prisma schema change

Add to `apps/agent/prisma/schema.prisma` on the `businesses` model:

```prisma
model businesses {
  // ... existing fields ...
  tenantprofilecontext  Json?  @db.JsonB
}
```

Run: `prisma migrate dev --name add_tenantprofilecontext`

The column stores a structured JSON object:
```json
{
  "entity_type": "small_business",
  "business_sector": "construction",
  "waste_types": ["construction", "packaging"],
  "annual_volume": "5t_plus",
  "location": "Skopje",
  "has_permits": false,
  "permit_types": []
}
```

### 2b — Profile collection at signup (structured dropdowns)

> **Why dropdowns instead of free text:** Structured selections go directly into the LLM prompt
> with no parsing needed. Free text requires extraction, which introduces errors.

Add waste profile fields to the business settings page (`/portal/settings`) using:
- `react-hook-form` + `zod` + shadcn Form components

| Field | Input type | Options |
|---|---|---|
| Entity type | Select | Individual / Small Business / Large Company / Municipality |
| Business sector | Select | Construction / Healthcare / Automotive / Retail / Food / Other |
| Waste types generated | Multi-select checkboxes | Hazardous / Construction / Packaging / Electronic / Municipal / Paper & Textile / Other |
| Annual waste volume | Select | Under 200kg / 200kg–5 tons / Over 5 tons |
| Location | Text field | Municipality name |
| Already holds permits | Toggle | Yes / No |
| Permit types held | Text field | Conditional — only shown when toggle = Yes |

On save: `PATCH /business/profile` (existing endpoint) — extend it to accept and store
`tenantprofilecontext` alongside the existing business fields.

### 2c — TypeScript interface

Add `tenantprofilecontext` field to the `Business` interface in `packages/shared-types/src/index.ts`.

---

## Phase 3 — Enhanced RAG Service

### 3a — New `/rag/chat` endpoint

> **Keep `/rag/query` unchanged** — backward compatible until the frontend migration is complete.

Add to `apps/python/routers/rag.py`:

```python
class ChatMessage(BaseModel):
    role: str   # "user" | "assistant"
    content: str

class LawChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    history: list[ChatMessage] = []    # all prior conversation turns
    tenant_context: str = ""           # pre-formatted profile string, injected by apps/agent
    top_k: int = Field(default=10, ge=1, le=20)
    # ge = minimum value (greater than or equal), le = maximum value (less than or equal)

class LawChatResponse(BaseModel):
    answer: str
```

Fill in the three stub models in `apps/python/models/rag.py` to match these shapes.

> **Note on profile filtering:** An earlier design applied a hard Qdrant filter to restrict
> retrieval to chunks matching the tenant's waste types. This was removed. If a construction
> company asks about paper waste regulations, a hard filter would return zero results.
> Instead, the tenant profile is passed as LLM context only — the LLM reads it and naturally
> says "while your primary category is construction waste, regarding paper waste the law states..."
> Full retrieval, profile-aware reasoning.

### 3b — Conversation history in the LLM prompt

> "Injecting into the prompt" means: build one large text string that includes the conversation
> history, the tenant profile, the retrieved law articles, and the current question — then send
> that whole string to the LLM in a single call. The LLM has no memory between calls, so you
> give it memory by pasting the prior conversation into each new request.

In `DirectQdrantQueryEngine.query()` in `services/ragagent.py`:

```python
history_block = ""
if history:
    formatted = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
        for m in history[-6:]   # last 3 turns — avoids bloating the prompt
    )
    history_block = f"Previous conversation:\n{formatted}\n\n"
```

Build the full prompt in this order:
1. System prompt (legal advisor role)
2. Tenant profile context (`tenant_context` string from apps/agent)
3. Prior conversation (`history_block`)
4. Retrieved law passages
5. Current question

### 3c — Upgraded system prompt

Replace the generic prompt in `services/ragagent.py` (lines 126–131):

```python
LEGAL_ADVISOR_PROMPT = """
You are a specialist legal advisor for waste management law in North Macedonia.
You have deep knowledge of the Law on Waste Management (Official Gazette 216/2021)
and all subordinate regulations.

You will be given:
1. The user's business profile (pre-loaded from their account)
2. Relevant legal provisions retrieved from the official corpus
3. The conversation history
4. The user's current question

Your response must always:
- State what specific obligations apply to THIS user based on their profile
- List concrete steps they should take (numbered, actionable)
- Cite the specific article number for every claim (e.g., "per Член 23")
- Flag relevant deadlines, volume thresholds, or penalties where present
- End with a note to consult a licensed lawyer if the situation involves
  penalties, permits, or significant financial exposure

Do not give generic summaries. Every answer must be specific to the user's situation.
If you cannot be specific with the available passages, ask one targeted clarifying question.

Respond in the same language the user writes in (Macedonian Cyrillic or English).
"""
```

---

## Phase 4 — Intent Router Update (LLM-only)

> **Current state:** `llmResolver.ts` already uses an LLM (Anthropic or GitHub Models) as the
> primary resolver. However, keyword fallback is currently allowed as a safety net — if the LLM
> fails, it silently routes based on keyword matching, which can produce wrong results.
> This phase disables that fallback entirely and adds the waste law chain.

### 4a — Disable keyword fallback

Set in `apps/agent/.env` (and document in `.env.example`):
```
ROUTER_LLM_PROVIDER=anthropic
ROUTER_ALLOW_KEYWORD_FALLBACK=false
```

With `ROUTER_ALLOW_KEYWORD_FALLBACK=false`, if the LLM fails for any reason (bad response,
network error), the resolver throws a hard error rather than silently returning a keyword guess.
`ANTHROPIC_API_KEY` is already required at startup (`env.ts`), so this path is always available.

### 4b — Add waste_law_query to chain registry

Update `apps/agent/src/agent/nodes/chainRegistry.ts`:

```typescript
export type ChainId =
  | 'invoice_extraction'
  | 'offer_extraction'
  | 'calendar_event_extraction'
  | 'waste_law_query';   // ← new

// Add to CHAIN_REGISTRY:
{
  id: 'waste_law_query',
  displayName: 'Waste Law Query',
  description: 'Answers questions about North Macedonia waste management law — legal obligations, required permits, penalties, deadlines, and regulatory procedures.',
  keywords: [],   // unused — LLM routing reads description only, never keywords
}
```

> **Why `keywords: []`:** The LLM router sends only `id: description` pairs to the LLM for
> classification. The `keywords[]` array is only ever used by the keyword fallback, which is
> now disabled. Empty array is intentional.

### 4c — Handle waste_law_query in directResolverChain.ts

Add a case to the `switch(decision.chainId)` dispatch in `directResolverChain.ts`:

```typescript
case 'waste_law_query':
  return runWasteLawChain({ tenantId, message, history: [] });
  // history comes from the dedicated /agent/waste-law/chat route; see Phase 5
```

---

## Phase 5 — New Agent Service Route

> **Why route through apps/agent instead of calling Python directly:**
> Tenant ID must come from the JWT (apps/agent middleware). Python receives only the pre-validated
> tenant context string — it never sees raw auth tokens. This is the required architecture pattern.

### 5a — wasteLawChain.ts

New file: `apps/agent/src/agent/wasteLawChain.ts`

```typescript
export async function runWasteLawChain(input: {
  tenantId: string;
  message: string;
  history: Array<{ role: string; content: string }>;
}): Promise<{ answer: string }> {
  // Read tenantprofilecontext from the businesses table
  const business = await prisma.businesses.findUnique({
    where: { owner_auth_id: input.tenantId },
    select: { tenantprofilecontext: true },
  });

  // Format the JSONB profile into a plain text string for the LLM prompt
  const tenantContext = business?.tenantprofilecontext
    ? buildTenantContext(business.tenantprofilecontext)
    : "";
  // buildTenantContext converts JSON → "Entity: small_business. Sector: construction. Waste types: construction, packaging..."

  const response = await callPythonService("/rag/chat", {
    question: input.message,
    history: input.history,
    tenant_context: tenantContext,
    top_k: 10,
  });
  // callPythonService reuses the same HTTP pattern as callPythonExtraction() in directResolverChain.ts

  await prisma.audit_logs.create({
    data: {
      tenant_id: input.tenantId,
      user_auth_id: input.tenantId,
      action_type: "law_query",
      meta: { question: input.message },
    },
  });

  return { answer: response.answer };
}
```

### 5b — New route in server.ts

```typescript
app.post("/agent/waste-law/chat", requireAuth, async (req, res) => {
  const tenantId = await getTenantForUser(req.userAuthId);
  const { message, history } = req.body;
  const result = await runWasteLawChain({ tenantId, message, history });
  res.json(result);
});
```

---

## Phase 6 — Frontend Update

### 6a — Route through agent service

Update `apps/web/src/connection/supabase-client.ts` — change `queryLawDocuments()` to call
`POST /agent/waste-law/chat` via `lib/axios.ts` (the pre-configured Axios instance that includes
the auth token automatically) instead of calling the Python service directly.

### 6b — Send conversation history

`LawQuestions.tsx` already maintains `messages` via `useLawChat()`. Pass the existing messages
array as `history` in the request body. The hook already has the right shape — no restructuring needed.

### 6c — Waste profile setup on settings page

Extend `/portal/settings` with the waste profile dropdown fields described in Phase 2b.
On first visit to the law questions page, if `tenantprofilecontext` is null, show a non-blocking
banner: "Set your business waste profile for more specific legal advice →" linking to settings.

> **Why non-blocking:** The advisor still works without a profile — it just gives general answers
> rather than situation-specific ones. Blocking first-time users before they've set up anything
> creates unnecessary friction.

---

## Phase 7 — Corpus Maintenance

> **"Corpus"** = the entire collection of law documents indexed in Qdrant.
> Laws change. Parliament amends articles, adds new bylaws. Without maintenance, the system
> gives answers based on outdated text.

- **`valid_from` date on every chunk** — tagged at ingest time (already in Phase 1c metadata).
  If Article 23 is amended in 2024, you ingest the new version with `"valid_from": "2024-03-01"`.
  Both old and new versions coexist in Qdrant — you always know which version you're citing.

- **`scripts/check_new_laws.py`** — a simple script that checks `slvesnik.com.mk` for new
  gazette entries tagged "отпад" (waste). Compares against a local `last_checked.json` file.
  Prints new entries for manual review — does NOT auto-ingest. You review, download the PDF,
  then run `scripts/ingest.py` on the affected articles only.

- **Selective re-ingestion** — already the default in `ingest.py` as of 2026-07-28: point
  ids are content-addressed, so re-running it on individual files upserts those chunks and
  leaves every other document untouched. No flag, no full re-index. (The old `--append`
  flag is gone; the destructive path is now the opt-in `--recreate`, which snapshots first.)

- **Add `--law-name` and `--valid-from` CLI flags** to `scripts/ingest.py` so every ingestion
  run is tagged with which law and which version it came from.

---

## Files to Create

| File | Purpose |
|---|---|
| `apps/agent/src/agent/wasteLawChain.ts` | Profile read + Python call + audit log |
| `apps/python/scripts/ingest.py` | Moved from services/, with OCR + article chunking |
| `apps/python/scripts/check_new_laws.py` | Corpus monitoring script |

## Files to Modify

| File | Change |
|---|---|
| `apps/agent/prisma/schema.prisma` | Add `tenantprofilecontext Json? @db.JsonB` to `businesses` |
| `apps/agent/src/agent/nodes/chainRegistry.ts` | Add `waste_law_query` chain |
| `apps/agent/src/agent/nodes/directResolverChain.ts` | Add `waste_law_query` case |
| `apps/agent/src/server.ts` | Add `POST /agent/waste-law/chat` route |
| `apps/python/services/ragagent.py` | History support + upgraded system prompt |
| `apps/python/routers/rag.py` | Add `/rag/chat` endpoint |
| `apps/python/models/rag.py` | Fill in the 3 stub models |
| `apps/web/src/connection/supabase-client.ts` | Point `queryLawDocuments` at agent service |
| `apps/web/src/pages/portal/LawQuestions.tsx` | Send `history` array in request body |
| `apps/web/src/pages/portal/Settings.tsx` | Add waste profile dropdown fields |
| `packages/shared-types/src/index.ts` | Add `tenantprofilecontext` to `Business` interface |
| `apps/python/.env.example` | Document all `RAG_*` and `QDRANT_*` vars |
| `apps/agent/.env.example` | Document `ROUTER_LLM_PROVIDER=anthropic` and `ROUTER_ALLOW_KEYWORD_FALLBACK=false` |
| `.claude/rules/guardrails.md` | Update ROUTER_ALLOW_KEYWORD_FALLBACK rule |

---

## Build Order

1. Move `ingest.py` to `scripts/`, add OCR layer + article chunking + metadata → ingest real corpus into `waste_management_law_mk_v2`
2. Run `services/debug_rag.py` — verify article-level chunks retrieve correctly before building anything else
3. `tenantprofilecontext` Prisma migration + extend business profile PATCH endpoint + frontend dropdown fields in settings
4. New `/rag/chat` endpoint with history support and upgraded system prompt
5. Test with `curl` — ask a conditional question with a sample tenant_context string, verify numbered steps with article citations
6. `wasteLawChain.ts` + `POST /agent/waste-law/chat` route in server.ts
7. Frontend: route through agent, send history, add non-blocking profile banner
8. Corpus maintenance scripts

---

## Verification

| Step | How to test |
|---|---|
| After step 1–2 | `python services/debug_rag.py` — confirm readable full articles and scores > 0.75 |
| After step 4 | `curl -X POST /rag/chat -d '{"question": "If my company generates 5 tons of construction waste, what permits do I need?", "tenant_context": "Entity: small_business. Sector: construction. Waste types: construction, packaging. Volume: 5t_plus.", "top_k": 10}'` — expect numbered steps citing specific articles |
| After step 6 | Same question via `POST /agent/waste-law/chat` with auth header — identical answer |
| After step 7 | Ask follow-up on the law questions page: "What is the deadline for applying?" — expect the answer to reference the prior exchange without re-explaining context |
