# Law Chat Streaming (SSE)

Goal: stream the waste-law answer token-by-token to the law page, so the ~9s
gpt-4o-mini generation is visible progress instead of a spinner.

Transport: Server-Sent Events over POST fetch (data-only JSON events), piped
through all three services. Non-streaming endpoints stay untouched —
`directResolverChain.ts` (dashboard) and `/rag/query` still use them.

## Protocol

`data: {"delta": "..."}` per chunk → `data: {"done": true}` terminator.
Mid-stream failure: `data: {"error": "..."}` then close. Pre-stream failures
are normal HTTP status codes (nothing has been sent yet).

## Changes

1. **apps/python/services/ragagent.py**
   - Split `DirectQdrantQueryEngine.query()` into `_build_prompt()` (retrieval
     + prompt assembly, shared) and thin `query()` / new `stream()` that uses
     `llm.stream_complete(prompt)` yielding text deltas.
   - New `stream_chat_law_documents(...)` generator mirroring
     `chat_law_documents(...)`.

2. **apps/python/routers/rag.py** — new `POST /rag/chat/stream`.
   Retrieval/prompt build runs first (in executor) so errors surface as HTTP
   codes; then `StreamingResponse` (media_type `text/event-stream`) over a sync
   generator (Starlette iterates it in a threadpool). Same auth + rate limit.

3. **apps/agent** — `runWasteLawChainStream()` in wasteLawChain.ts: same
   prisma/tenant-context lookup, fetches the python stream endpoint, writes the
   audit log once upstream responds OK, returns the body stream. New route
   `POST /agent/waste-law/chat/stream` in server.ts: shares request validation
   with the existing route (extracted helper), sets SSE headers, pipes bytes,
   cancels upstream on client disconnect.

4. **apps/web**
   - `queryLawDocumentsStream()` in connection/supabase-client.ts: fetch +
     ReadableStream reader, parse SSE blocks, invoke `onDelta`, return full text.
   - LawQuestions.tsx: local `streamingText` state renders the in-progress
     bubble (loading dots until first delta); the finished message is committed
     to the persisted store once, including partial text on user abort.

## Not doing

- No change to `/rag/chat`, `/rag/query`, or the dashboard chain.
- No store-level delta updates (sessionStorage churn).
