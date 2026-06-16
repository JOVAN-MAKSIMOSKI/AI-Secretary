# Naming, Imports & Commit Conventions

---

## Naming — TypeScript / JavaScript

- Variables & functions: `camelCase`
- Types & interfaces: `PascalCase`
- Classes: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE`

```typescript
const userName = "Jovan";
const MAX_RETRIES = 3;
interface UserProfile {}
type DocumentStatus = "draft" | "sent" | "approved";
class DocumentGenerator {}
```

---

## Naming — Python

- Variables & functions: `snake_case`
- Classes: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE`

```python
user_name = "Jovan"
MAX_RETRIES = 3
class DocumentGenerator: pass
```

---

## Naming — Database

- Table names: `snake_case`, plural (`clients`, `documents`, `audit_logs`)
- Column names: `snake_case` (`tenant_id`, `created_at`, `sent_at`)
- Foreign keys: `{table_singular}_id` (`client_id` references `clients`)
- Boolean columns: prefix with `is_` or `has_` (`is_active`, `has_approved`)

---

## Environment Variables

Format: `SCREAMING_SNAKE_CASE`

```
SUPABASE_URL=
SUPABASE_KEY=
ANTHROPIC_API_KEY=
DATABASE_URL=
MCP_TRANSPORT=http
TS_SERVICE_PORT=3000
PY_SERVICE_PORT=8000
```

---

## File & Folder Structure

### TypeScript (`apps/agent/src/`)
```
agents/        # LangGraph graph definitions
tools/         # Tool node implementations
schemas/       # Shared TypeScript types
utils/         # Pure utility functions
repositories/  # Prisma repository classes (tenant-scoped)
```

### Python (`apps/python/`)
```
routes/        # FastAPI route handlers
services/      # Business logic & document generation
models/        # Pydantic schemas
config.py
main.py
```

---

## Import Organization

### TypeScript
```typescript
// 1. External dependencies
import { z } from "zod";
import { Prisma } from "@prisma/client";

// 2. Internal modules
import { generateInvoice } from "../tools/generateInvoice";
import { type ClientData } from "../schemas/types";

// 3. Constants & utilities
import { TEMPLATES_PATH } from "../config";
```

### Python
```python
# 1. Standard library
import os
from datetime import datetime

# 2. External dependencies
from fastapi import FastAPI, Depends
from pydantic import BaseModel

# 3. Internal modules
from .services import document_generator
from .config import get_settings
```

---

## Git Commit Messages

Format: `{type}: {subject}`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

Subject: lowercase, imperative mood, no trailing period

```
feat: add invoice generation endpoint
fix: tenant isolation filter in RAG queries
refactor: extract document generation logic
chore: bump dependencies
```

---

## No Magic Numbers

All numeric constants must be named:

```typescript
// WRONG
setTimeout(() => {}, 5000);

// RIGHT
const REQUEST_TIMEOUT_MS = 5000;
setTimeout(() => {}, REQUEST_TIMEOUT_MS);
```

---

## API Route Naming

Pattern: `/api/{resource}/{action}` using standard HTTP verbs.

```
POST   /api/documents/invoice
POST   /api/documents/offer
POST   /api/stt/transcribe
POST   /api/rag/index
POST   /api/rag/query
GET    /api/rag/client/{tenant_id}/{client_id}
```

---

## Comments

Default: no comments. Only add one when the WHY is non-obvious.

- Do not describe what the code does — well-named identifiers do that
- Do not reference the current task, issue, or caller — those belong in the PR description
