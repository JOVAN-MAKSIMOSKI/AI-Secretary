# Secretary Architecture

## Repository Structure

```text
secretary/
├── .github/
│   ├── copilot-instructions.md
│   └── workflows/
│       ├── lint.yml
│       ├── test.yml
│       └── deploy.yml
├── apps/
│   ├── agent/                         # TypeScript — LangGraph orchestrator
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   │   ├── graph.ts           # StateGraph definition
│   │   │   │   ├── state.ts           # Typed agent state interface
│   │   │   │   ├── nodes/
│   │   │   │   │   ├── planner.ts     # Interprets user command
│   │   │   │   │   ├── resolver.ts    # Fetches client + RAG context
│   │   │   │   │   ├── executor.ts    # Calls document/comms tools
│   │   │   │   │   └── auditor.ts     # Writes audit log entry
│   │   │   │   └── edges/
│   │   │   │       └── router.ts      # Conditional edge logic
│   │   │   ├── repository/
│   │   │   │   ├── clients.ts
│   │   │   │   ├── documents.ts
│   │   │   │   ├── interactions.ts
│   │   │   │   └── auditLogs.ts
│   │   │   ├── mcp/
│   │   │   │   ├── gmail.ts           # Gmail MCP tool wrapper
│   │   │   │   └── calendar.ts        # Google Calendar MCP tool wrapper
│   │   │   ├── tools/
│   │   │   │   ├── invoiceTool.ts     # Calls Python /api/documents/invoice
│   │   │   │   ├── offerTool.ts       # Calls Python /api/documents/offer
│   │   │   │   ├── ragTool.ts         # Calls Python /api/rag/query
│   │   │   │   └── sttTool.ts         # Calls Python /api/stt/transcribe
│   │   │   ├── lib/
│   │   │   │   ├── prisma.ts          # Prisma client singleton
│   │   │   │   ├── supabase.ts        # Supabase client singleton
│   │   │   │   └── claude.ts          # Anthropic client singleton
│   │   │   └── server.ts              # Express entry point, JWT middleware
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   ├── types/
│   │   │   └── api.ts                 # Auto-generated from Python openapi.json
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── python/                        # Python — FastAPI microservice
│   │   ├── main.py                    # FastAPI app entry point
│   │   ├── routers/
│   │   │   ├── documents.py           # /api/documents/invoice, /offer
│   │   │   ├── rag.py                 # /api/rag/index, /query, /client
│   │   │   └── stt.py                 # /api/stt/transcribe
│   │   ├── services/
│   │   │   ├── excel.py               # openpyxl invoice logic
│   │   │   ├── word.py                # python-docx offer logic
│   │   │   └── storage.py             # Supabase Storage upload helper
│   │   ├── rag/
│   │   │   ├── index.py               # LlamaIndex setup + indexing
│   │   │   └── query.py               # Retrieval with tenant_id filter
│   │   ├── stt/
│   │   │   └── whisper.py             # faster-whisper model loader
│   │   ├── templates/                 # .xlsx and .docx base templates
│   │   │   ├── invoice_template.xlsx
│   │   │   └── offer_template.docx
│   │   ├── models/                    # Pydantic request/response models
│   │   │   ├── documents.py
│   │   │   ├── rag.py
│   │   │   └── stt.py
│   │   ├── requirements.txt
│   │   └── venv/
│   │
│   └── web/                           # React — Vite frontend
│       ├── src/
│       │   ├── pages/
│       │   │   ├── auth/
│       │   │   │   ├── Login.tsx
│       │   │   │   └── Callback.tsx
│       │   │   ├── admin/
│       │   │   │   ├── Dashboard.tsx
│       │   │   │   ├── Tenants.tsx
│       │   │   │   ├── Templates.tsx
│       │   │   │   └── AuditLogs.tsx
│       │   │   └── portal/
│       │   │       ├── Dashboard.tsx
│       │   │       ├── Documents.tsx
│       │   │       ├── Approvals.tsx  # Human approval gate UI
│       │   │       ├── Clients.tsx
│       │   │       └── Settings.tsx
│       │   ├── components/
│       │   │   ├── ui/                # shadcn/ui primitives (do not edit)
│       │   │   ├── admin/             # Admin-specific components
│       │   │   ├── portal/            # Portal-specific components
│       │   │   └── shared/            # Used in both admin and portal
│       │   ├── layouts/
│       │   │   ├── AppLayout.tsx      # Root layout wrapper
│       │   │   ├── AdminLayout.tsx    # Admin sidebar + header
│       │   │   └── PortalLayout.tsx   # Client portal sidebar + header
│       │   ├── router/
│       │   │   ├── index.tsx          # React Router route definitions
│       │   │   └── guards.tsx         # AdminGuard, PortalGuard components
│       │   ├── hooks/
│       │   │   ├── useSession.ts      # Reads user + tenant_id from Supabase
│       │   │   ├── useApprovals.ts    # Supabase Realtime subscription
│       │   │   └── useAgent.ts        # Calls agent service via axios
│       │   ├── store/
│       │   │   └── session.ts         # Zustand — user, tenantId, role
│       │   ├── lib/
│       │   │   ├── supabase.ts        # Supabase browser client
│       │   │   └── axios.ts           # Axios instance pointed at agent service
│       │   ├── types/
│       │   │   └── index.ts           # Re-exports from packages/shared-types
│       │   ├── App.tsx
│       │   ├── main.tsx
│       │   └── globals.css            # Tailwind base + CSS variable overrides
│       ├── index.html
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       └── package.json
│
├── packages/
│   ├── shared-types/                  # TypeScript types shared across apps
│   │   ├── src/
│   │   │   ├── tenant.ts
│   │   │   ├── client.ts
│   │   │   ├── document.ts
│   │   │   ├── interaction.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── config/                        # Shared env validation
│   │   ├── src/
│   │   │   └── env.ts                 # Zod env schemas per service
│   │   └── package.json
│   └── logger/                        # Shared pino logger config
│       ├── src/
│       │   └── index.ts
│       └── package.json
│
├── supabase/                          # Supabase local dev config
│   ├── config.toml
│   ├── migrations/                    # RLS policies, storage buckets, auth config
│   └── seed.sql
│
├── docker-compose.yml                 # Runs agent + python + supabase locally
├── pnpm-workspace.yaml
├── package.json                       # Root — dev scripts only
└── .env                               # Single env file at root
```

## Runtime Architecture

Two backend services run in parallel and communicate over HTTP:

1. apps/agent — TypeScript, LangGraph orchestrator, MCP servers, Claude API
2. apps/python — Python, FastAPI, document generation, RAG, STT

## Service Boundaries

- The agent service is always the orchestrator.
- The Python service exposes HTTP endpoints that the agent calls as tools.
- All LLM calls happen exclusively in apps/agent, never in apps/python.
- The React frontend in apps/web calls apps/agent directly via Axios.
