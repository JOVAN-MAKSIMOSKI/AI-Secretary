# Code Style & Naming Conventions

## TypeScript / JavaScript

- **Variables & functions:** `camelCase`
- **Types & interfaces:** `PascalCase`
- **Classes:** `PascalCase`
- **Constants:** `SCREAMING_SNAKE_CASE`

```typescript
// Variables
const userName = "Jovan";
const isActive = true;

// Functions
function getUserData() {}
const fetchTenantConfig = async () => {};

// Types & Interfaces
interface UserProfile {}
type DocumentStatus = "draft" | "sent" | "approved";
class DocumentGenerator {}

// Constants
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 5000;
```

---

## Python

- **Everything:** `snake_case`
- **Classes:** `PascalCase`
- **Constants:** `SCREAMING_SNAKE_CASE`

```python
# Variables & functions
user_name = "Jovan"
is_active = True

def get_user_data():
    pass

async def fetch_tenant_config():
    pass

# Classes
class DocumentGenerator:
    pass

# Constants
MAX_RETRIES = 3
DEFAULT_TIMEOUT_MS = 5000
```

---

## Database

- **Table names:** `snake_case`, plural
  - `clients`, `documents`, `interactions`, `audit_logs`
- **Column names:** `snake_case`
  - `tenant_id`, `client_id`, `created_at`, `sent_at`
- **Foreign keys:** `{table_singular}_id`
  - `client_id` (references clients table)
- **Boolean columns:** prefix with `is_` or `has_`
  - `is_active`, `has_approved`
- **Tenant identity naming:** never confuse `tenant_id` with `owner_auth_id`
  - `owner_auth_id` is the Supabase Auth user id used to resolve the business owner
  - `tenant_id` is the business-scoped tenant key used for filtering, storage paths, and document ownership
  - If both appear in the same flow, resolve `owner_auth_id` first and only then derive or validate the tenant-scoped identity

---

## Environment Variables

- **Format:** `SCREAMING_SNAKE_CASE`
- **Scope prefix:** Use service abbreviation if needed
  - `TS_SERVICE_PORT=3000`
  - `PY_SERVICE_PORT=8000`

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

### TypeScript
```
src/
├── agents/
│   └── documentAgent.ts
├── tools/
│   ├── generateInvoice.ts
│   └── sendEmail.ts
├── schemas/
│   └── types.ts
├── utils/
│   └── tenantFilter.ts
└── index.ts
```

### Python
```
app/
├── routes/
│   ├── documents.py
│   ├── rag.py
│   └── stt.py
├── services/
│   ├── document_generator.py
│   ├── rag_service.py
│   └── stt_service.py
├── models/
│   └── schemas.py
├── config.py
└── main.py
```

---

## Commenting Style

### TypeScript
```typescript
// Single-line comment for brief explanations
const userName = "Jovan"; // inline comment for clarification

/**
 * Multi-line JSDoc for functions
 * @param tenantId - The tenant identifier
 * @returns Promise<Client[]>
 */
async function getClients(tenantId: string): Promise<Client[]> {
  // Implementation
}
```

### Python
```python
# Single-line comment for brief explanations
user_name = "Jovan"  # inline comment for clarification

def get_clients(tenant_id: str) -> list[Client]:
    """
    Multi-line docstring for functions.
    
    Args:
        tenant_id: The tenant identifier
    
    Returns:
        List of clients for the tenant
    """
    # Implementation
```

---

## API Route Naming

- **Resource-based:** `/api/{resource}/{action}`
- **HTTP verbs:** GET (read), POST (create), PUT/PATCH (update), DELETE (remove)

### Python Service Routes
```
POST   /api/documents/invoice       # Create invoice
POST   /api/documents/offer         # Create offer
POST   /api/stt/transcribe          # Transcribe audio
POST   /api/rag/index               # Add to RAG
POST   /api/rag/query               # Query RAG
GET    /api/rag/client/{tenant_id}/{client_id}  # Get client history
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
import json
from datetime import datetime

# 2. External dependencies
from fastapi import FastAPI, Depends
from pydantic import BaseModel

# 3. Internal modules
from .services import document_generator
from .models import schemas
from .config import get_settings
```

---

## Git Commit Messages

- **Format:** `{type}: {subject}`
- **Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
- **Subject:** lowercase, imperative mood, no period

```
feat: add invoice generation endpoint
fix: tenant isolation filter in RAG queries
refactor: extract document generation logic
docs: update database schema
test: add multi-tenancy tests
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
