# Code Implementation Instructions

## TypeScript Development

### Setup & Environment

```bash
# Install dependencies
npm install

# Enable strict mode in tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

### Type Definitions

Always define types for external data:

```typescript
// ❌ WRONG: Using implicit any
const response = await fetch(url);

// ✅ RIGHT: Explicit types
interface InvoiceData {
  clientId: string;
  amount: number;
  dueDate: Date;
}

const response = await fetch(url);
const invoiceData: InvoiceData = await response.json();
```

### Prisma Query Patterns

Always include tenant filter:

```typescript
// ✅ CORRECT: Tenant-scoped query
const client = await prisma.client.findUnique({
  where: { id: clientId },
});
// Verify tenant ownership
if (client?.tenantId !== currentTenantId) {
  throw new UnauthorizedError("Access denied");
}

// ✅ CORRECT: Bulk operations with tenant filter
const documents = await prisma.document.findMany({
  where: {
    tenantId: currentTenantId,
    clientId: clientId,
  },
});

// ✅ CORRECT: Create with tenant
const newDoc = await prisma.document.create({
  data: {
    tenantId: currentTenantId, // Always explicit
    clientId: clientId,
    type: "invoice",
    filePath: storagePath,
    fileUrl: publicUrl,
  },
});
```

---

## Python Development

### Virtual Environment (uv)

```bash
# Create/update .venv exactly from uv.lock
uv sync

# Run commands inside the environment (no manual activation needed)
uv run <command>

# Add or remove dependencies (updates pyproject.toml + uv.lock together)
uv add <package>
uv remove <package>
```

Dependencies live in `pyproject.toml` (fully pinned) + `uv.lock` — never
`pip install` directly and never create a `requirements.txt`.

### Running Python Service Locally

```bash
# Start development server with auto-reload
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# With environment variables
PYTHON_ENV=development uvicorn main:app --reload

# Production mode (no auto-reload)
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
```

**Interactive API Documentation:**
- **Swagger UI:** `http://localhost:8000/docs`
- **ReDoc:** `http://localhost:8000/redoc`
- **OpenAPI JSON:** `http://localhost:8000/openapi.json`

Use the `/docs` endpoint to test all routes without writing client code — FastAPI auto-generates interactive documentation from your route signatures.

### Auto-Generating TypeScript Types from Python API

```bash
# Install openapi-typescript globally
npm install -g openapi-typescript

# Generate TypeScript types from Python service
openapi-typescript http://localhost:8000/openapi.json -o src/types/python-api.ts

# Now use the generated types in your TS service
import type { paths, components } from './types/python-api';

// Fully typed API calls
type InvoiceRequest = components['schemas']['InvoiceRequest'];
type InvoiceResponse = paths['/api/documents/invoice']['post']['responses']['200']['content']['application/json'];
```

### FastAPI Route Pattern

```python
from fastapi import FastAPI, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import Optional
import uuid

app = FastAPI()

# Request schema with tenant_id
class InvoiceRequest(BaseModel):
    tenant_id: str = Field(..., description="Tenant identifier")
    client_id: str = Field(..., description="Client identifier")
    amount: float = Field(..., gt=0)
    
    class Config:
        example = {
            "tenant_id": "123e4567-e89b-12d3-a456-426614174000",
            "client_id": "client-123",
            "amount": 1500.00
        }

# Response schema
class InvoiceResponse(BaseModel):
    file_url: str
    file_path: str
    created_at: str

@app.post("/api/documents/invoice", response_model=InvoiceResponse)
async def create_invoice(request: InvoiceRequest):
    """
    Generate an invoice document.
    
    Every route must:
    1. Receive tenant_id
    2. Validate tenant_id is not empty
    3. Pass tenant_id to all service layers
    4. Store generated file in {tenant_id}/outputs/invoices/
    """
    
    # Validate tenant_id
    if not request.tenant_id or not isinstance(request.tenant_id, str):
        raise HTTPException(status_code=400, detail="Invalid tenant_id")
    
    try:
        # Call service layer
        file_url, file_path = await generate_invoice_file(
            tenant_id=request.tenant_id,
            client_id=request.client_id,
            amount=request.amount
        )
        
        return InvoiceResponse(
            file_url=file_url,
            file_path=file_path,
            created_at=datetime.now().isoformat()
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail="Internal server error")
```

### Service Layer Pattern

```python
# services/document_generator.py
from typing import Tuple
import os
from datetime import datetime

async def generate_invoice_file(
    tenant_id: str,
    client_id: str,
    amount: float
) -> Tuple[str, str]:
    """
    Generate invoice and upload to Supabase Storage.
    
    Returns:
        (public_url, storage_path)
    """
    
    # Validate inputs
    if not tenant_id or not client_id:
        raise ValueError("tenant_id and client_id required")
    
    # 1. Load template
    template_path = f"templates/{tenant_id}/invoice_template.xlsx"
    
    # 2. Generate in memory or temp file
    output_data = {
        "client_id": client_id,
        "amount": amount,
        "total": amount,  # Computed in Python, not Excel
        "date": datetime.now().strftime("%Y-%m-%d")
    }
    
    # 3. Write to temp file
    temp_file = f"/tmp/{client_id}_invoice_{datetime.now().timestamp()}.xlsx"
    
    # 4. Upload to Supabase Storage
    # Path format: /{tenant_id}/outputs/{document_type}/{yyyy-mm}/{filename}
    date_folder = datetime.now().strftime("%Y-%m")
    storage_path = f"{tenant_id}/outputs/invoices/{date_folder}/{os.path.basename(temp_file)}"
    
    public_url = await upload_to_supabase(temp_file, storage_path)
    
    # 5. Clean up temp file
    os.remove(temp_file)
    
    return public_url, storage_path
```

---

## LangGraph Agent Implementation

### State Definition

Always use TypeScript strict types:

```typescript
import { StateGraph, MessageState } from "@langchain/langgraph";

interface AgentState {
  tenantId: string;
  clientId: string;
  messages: Array<{ role: string; content: string }>;
  currentAction: "generating" | "sending" | "idle";
  approvalGate: {
    pending: boolean;
    action: string;
    details: Record<string, any>;
    approvedAt?: Date;
  };
  errors: string[];
}

const workflow = new StateGraph<AgentState>({
  channels: {
    tenantId: { value: "" },
    clientId: { value: "" },
    messages: { value: [] },
    currentAction: { value: "idle" },
    approvalGate: { value: {} },
    errors: { value: [] },
  },
});
```

### Tool Node Pattern

```typescript
// Always wrap tool calls with tenant validation
async function generateInvoiceTool(state: AgentState) {
  const { tenantId, clientId, messages } = state;
  
  // Validate tenant context
  if (!tenantId || !clientId) {
    return {
      ...state,
      errors: [...state.errors, "Missing tenant or client context"],
    };
  }
  
  // 1. Fetch client from Prisma
  const client = await prisma.client.findUnique({
    where: { id: clientId },
  });
  
  if (!client || client.tenantId !== tenantId) {
    return {
      ...state,
      errors: [...state.errors, "Client not found or access denied"],
    };
  }
  
  // 2. Query RAG for context
  const ragContext = await fetch(`http://localhost:8000/api/rag/query`, {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenantId,
      client_id: clientId,
      query: "past interactions and preferences",
    }),
  }).then(r => r.json());
  
  // 3. Call Python service to generate file
  const { file_url, file_path } = await fetch(
    "http://localhost:8000/api/documents/invoice",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        client_id: clientId,
        amount: calculateAmount(client, ragContext),
      }),
    }
  ).then(r => r.json());
  
  // 4. Store in database
  const document = await prisma.document.create({
    data: {
      tenantId,
      clientId,
      type: "invoice",
      filePath: file_path,
      fileUrl: file_url,
      status: "draft",
    },
  });
  
  // 5. Log to audit trail
  await prisma.auditLog.create({
    data: {
      tenantId,
      actionType: "file_created",
      clientId,
      fileUrl: file_url,
      status: "pending_approval",
    },
  });
  
  // 6. Present to user for approval
  return {
    ...state,
    currentAction: "idle",
    approvalGate: {
      pending: true,
      action: "send_invoice",
      details: {
        documentId: document.id,
        fileUrl: file_url,
        clientName: client.name,
      },
    },
  };
}

// Add to workflow
workflow.addNode("generateInvoice", generateInvoiceTool);
```

### Approval Gate Pattern

```typescript
// Only send/save after human approval
async function approvalNode(state: AgentState) {
  const { approvalGate } = state;
  
  if (!approvalGate.pending) {
    return state;
  }
  
  // Wait for human feedback
  // (In real implementation, this would pause the graph)
  const approved = await getUserApproval(approvalGate.details);
  
  if (!approved) {
    return {
      ...state,
      approvalGate: { ...approvalGate, pending: false },
      errors: [...state.errors, "User rejected action"],
    };
  }
  
  // Proceed with action
  const { documentId } = approvalGate.details;
  
  // Send email or perform other action
  await sendInvoiceEmail(documentId);
  
  // Update audit log
  await prisma.auditLog.updateMany({
    where: { fileUrl: approvalGate.details.fileUrl },
    data: {
      status: "approved",
      approvedBy: getCurrentUserId(),
    },
  });
  
  return {
    ...state,
    approvalGate: { ...approvalGate, pending: false, approvedAt: new Date() },
    currentAction: "idle",
  };
}

// Use interrupt_before
workflow.addNode("approval", approvalNode);
workflow.addEdge("generateInvoice", "approval");
workflow.addEdge(
  "approval",
  "sendEmail",
  { source: "approval", target: "sendEmail", condition: "approved" }
);
```

---

## Error Handling Patterns

### TypeScript

```typescript
// Define custom errors
export class TenantMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantMismatchError";
  }
}

export class DocumentGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentGenerationError";
  }
}

// In service layer
try {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  
  if (!client) {
    throw new Error("Client not found");
  }
  
  if (client.tenantId !== currentTenantId) {
    throw new TenantMismatchError(
      `Client ${clientId} does not belong to tenant ${currentTenantId}`
    );
  }
  
  // Process...
} catch (error) {
  if (error instanceof TenantMismatchError) {
    logger.warn(error.message);
    throw new UnauthorizedError("Access denied");
  }
  
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    logger.error("Database error", { code: error.code, meta: error.meta });
    throw new DatabaseError("Database operation failed");
  }
  
  // Unknown error
  logger.error("Unexpected error", error);
  throw new InternalServerError("An unexpected error occurred");
}
```

### Python

```python
from fastapi import HTTPException
from typing import Optional

class TenantMismatchError(Exception):
    pass

class DocumentGenerationError(Exception):
    pass

# In route handler
@app.post("/api/documents/invoice")
async def create_invoice(request: InvoiceRequest):
    try:
        file_url, file_path = await generate_invoice_file(
            tenant_id=request.tenant_id,
            client_id=request.client_id,
            amount=request.amount
        )
        return InvoiceResponse(file_url=file_url, file_path=file_path)
        
    except TenantMismatchError as e:
        raise HTTPException(status_code=403, detail="Access denied")
        
    except DocumentGenerationError as e:
        raise HTTPException(status_code=400, detail=str(e))
        
    except Exception as e:
        logger.exception("Unexpected error in create_invoice")
        raise HTTPException(status_code=500, detail="Internal server error")
```

---

## Testing Strategy

### Unit Tests (TypeScript)

```typescript
import { test, expect } from "vitest";
import { generateInvoiceTool } from "../tools";

test("generateInvoiceTool respects tenant isolation", async () => {
  const state: AgentState = {
    tenantId: "tenant-1",
    clientId: "client-1",
    messages: [],
    currentAction: "idle",
    approvalGate: { pending: false },
    errors: [],
  };
  
  // Mock Prisma to return wrong tenant
  const client = { id: "client-1", tenantId: "tenant-2" };
  
  const result = await generateInvoiceTool(state);
  
  // Should fail
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]).toContain("access denied");
});
```

### Integration Tests (Python)

```python
import pytest
from httpx import AsyncClient
from main import app

@pytest.mark.asyncio
async def test_invoice_route_requires_tenant_id():
    async with AsyncClient(app=app, base_url="http://test") as client:
        # Missing tenant_id
        response = await client.post(
            "/api/documents/invoice",
            json={"client_id": "123", "amount": 1000}
        )
        
        assert response.status_code == 422  # Validation error
        
        # With tenant_id
        response = await client.post(
            "/api/documents/invoice",
            json={
                "tenant_id": "tenant-1",
                "client_id": "123",
                "amount": 1000
            }
        )
        
        assert response.status_code == 200
```

---

## Logging Best Practices

### Structured Logging

```typescript
import { Logger } from "winston";

const logger = new Logger("VirtualSecretary");

// ✅ GOOD: Structured logging with context
logger.info("Invoice generated", {
  tenantId,
  clientId,
  documentId,
  fileSize: fileBuffer.length,
  duration: Date.now() - startTime,
});

// ❌ BAD: Unstructured logging
logger.info(`Generated invoice for ${clientName} in ${duration}ms`);

// ✅ GOOD: Log errors with stack trace and context
logger.error("Document generation failed", {
  error: error.message,
  stack: error.stack,
  tenantId,
  clientId,
  attemptNumber: retryCount,
});
```

### Python Logging

```python
import logging

logger = logging.getLogger(__name__)

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)

# Use logger
logger.info(
    "Invoice generation started",
    extra={
        "tenant_id": tenant_id,
        "client_id": client_id,
        "file_type": "xlsx",
    }
)

# Error logging
try:
    ...
except Exception as e:
    logger.exception(
        "Invoice generation failed",
        extra={"tenant_id": tenant_id, "client_id": client_id}
    )
```

---

## Performance Optimization

### Database Queries

```typescript
// ❌ N+1 problem: Multiple queries
const clients = await prisma.client.findMany({
  where: { tenantId },
});
for (const client of clients) {
  const documents = await prisma.document.findMany({
    where: { clientId: client.id },
  });
}

// ✅ GOOD: Single query with relation
const clients = await prisma.client.findMany({
  where: { tenantId },
  include: {
    documents: true,
  },
});

// ✅ GOOD: Lazy load only if needed
const client = await prisma.client.findUnique({
  where: { id: clientId },
  select: {
    id: true,
    name: true,
    email: true,
    // Don't load documents unless needed
  },
});
```

### Caching Strategy

```typescript
// Cache system prompt and tenant context
const { model } = await anthropic.messages.create({
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
