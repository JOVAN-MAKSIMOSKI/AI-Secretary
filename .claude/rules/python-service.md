# Python Service Rules — apps/python

Applies when Claude touches any file under `apps/python/**`.

---

## Stack

- Runtime: Python 3.12 (pinned via `requires-python = ">=3.12,<3.13"` — the frozen dependency set is only mutually compatible on 3.12)
- Framework: FastAPI with uvicorn (ASGI server)
- Excel generation: `openpyxl`
- Word generation: `python-docx`
- STT: `faster-whisper`
- RAG: LlamaIndex with metadata filtering by `tenant_id`
- Dependencies: **uv** — `pyproject.toml` (fully pinned) + `uv.lock` (committed), environment in `.venv`. There is no `requirements.txt`; never recreate one.

Never call the Claude API from this service. Never run the agent loop here.

---

## Running Locally

```bash
uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Interactive docs
# Swagger UI: http://localhost:8000/docs
# ReDoc:      http://localhost:8000/redoc
```

Startup note: a FastAPI lifespan hook warms the RAG models at boot (~10s) on top
of the Whisper model load (~27s at import). The service does not accept requests
until both finish — budget ~40s before the port answers, and set Docker
healthcheck `start_period` accordingly.

---

## API Routes

All routes registered in `main.py` with 5 routers:

```
# Business (routers/business.py)
POST /business/register            # Register new business/tenant
GET  /business/profile             # Get business profile
PATCH /business/profile            # Update business profile

# Clients (routers/clients.py)
GET  /clients                      # List clients for tenant
POST /clients                      # Create client (duplicate-name check per tenant)
PATCH /clients/{client_id}         # Update client
DELETE /clients/{client_id}        # Delete client

# Documents (routers/documents.py)
POST /documents/extract            # LangChain extraction → invoice structured data
POST /documents/extract-offer      # LangChain extraction → offer structured data
POST /documents/extract-calendar   # LangChain extraction → calendar event data
POST /documents/invoice            # Render Excel template → upload to Supabase
POST /documents/offer              # Render Word template → upload to Supabase
POST /documents/template           # Upload invoice/offer template

# RAG (routers/rag.py)
POST /rag/query                    # Retrieve relevant past interactions

# STT (routers/stt.py) — stub, not yet implemented
POST /stt/transcribe               # Transcribe audio → text (faster-whisper)
```

Every route receives and validates `tenant_id` — no exceptions.

---

## FastAPI Route Pattern

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

class InvoiceRequest(BaseModel):
    tenant_id: str = Field(..., description="Tenant identifier")
    client_id: str = Field(..., description="Client identifier")
    amount: float = Field(..., gt=0)

class InvoiceResponse(BaseModel):
    file_url: str
    file_path: str
    created_at: str

@app.post("/api/documents/invoice", response_model=InvoiceResponse)
async def create_invoice(request: InvoiceRequest):
    if not request.tenant_id or not isinstance(request.tenant_id, str):
        raise HTTPException(status_code=400, detail="Invalid tenant_id")
    try:
        file_url, file_path = await generate_invoice_file(
            tenant_id=request.tenant_id,
            client_id=request.client_id,
            amount=request.amount,
        )
        return InvoiceResponse(file_url=file_url, file_path=file_path, created_at=datetime.now().isoformat())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        raise HTTPException(status_code=500, detail="Internal server error")
```

---

## Service Layer Pattern

```python
async def generate_invoice_file(tenant_id: str, client_id: str, amount: float) -> tuple[str, str]:
    if not tenant_id or not client_id:
        raise ValueError("tenant_id and client_id required")

    # Storage path format: /{tenant_id}/outputs/{document_type}/{yyyy-mm}/{filename}
    date_folder = datetime.now().strftime("%Y-%m")
    storage_path = f"{tenant_id}/outputs/invoices/{date_folder}/{filename}"

    public_url = await upload_to_supabase(temp_file, storage_path)
    os.remove(temp_file)  # Clean up temp file

    return public_url, storage_path
```

---

## Document Generation — Excel (openpyxl)

- Open templates with `data_only=True`
- Always compute totals in Python and write as literal values — never rely on Excel formula recalculation
- Write to a new file — never overwrite the template
- Use named cell ranges for placeholder cells — never hardcode coordinates

---

## Document Generation — Word (python-docx)

- Replace `{{placeholder}}` tokens by iterating `run` objects inside paragraphs
- Never use `paragraph.text = "..."` — this destroys all formatting
- Always manipulate `runs` to preserve existing styles
- For table cells: iterate `cell.paragraphs` then `paragraph.runs` — never assume flat structure

---

## RAG Rules

- Always include `MetadataFilter(key="tenant_id", value=current_tenant_id)` on all LlamaIndex queries
- Never expose interactions across tenant boundaries
- Index route adds interactions; query route retrieves them

---

## Error Handling

```python
class TenantMismatchError(Exception): pass
class DocumentGenerationError(Exception): pass

# In route handler
try:
    ...
except TenantMismatchError:
    raise HTTPException(status_code=403, detail="Access denied")
except DocumentGenerationError as e:
    raise HTTPException(status_code=400, detail=str(e))
except Exception:
    logger.exception("Unexpected error")
    raise HTTPException(status_code=500, detail="Internal server error")
```

---

## Structured Logging

```python
import logging
logger = logging.getLogger(__name__)

logger.info(
    "Invoice generation started",
    extra={"tenant_id": tenant_id, "client_id": client_id, "file_type": "xlsx"},
)
```

---

## Tests and Evals

pytest is configured in `pyproject.toml` (`[tool.pytest.ini_options]`, `pythonpath=["."]`
so tests import `services.*` the way the app does). Two separate suites:

```bash
uv run pytest -q          # fast guards — pure functions, ~2s, runs in CI on every push
uv run pytest evals/ -q   # paid/heavy evals: retrieval (needs Qdrant + e5 model) and
                          # extraction accuracy (needs EVALAPIKEY; ~20s, real LLM calls)
```

- `tests/` — pure-function guards only. No Qdrant, no model load, no network. Keep it
  fast; it is the half that gates every push.
- `evals/` — the waste-law retrieval eval. Scored as recall@k against
  `evals/baseline.json`, with golden cases in `evals/golden/retrieval.jsonl`. Self-skips
  when no Qdrant collection is reachable, so CI degrades to a skip rather than a failure.

When adding a retrieval case, author it against measured output and skip questions whose
correct source is genuinely ambiguous — several laws carry penalty and reporting
provisions, so a single `expect_law` for those would test nothing.

**Windows note:** local Qdrant (path mode) needs `pywin32` wired onto `sys.path`. uv
installs the wheel but does not run pywin32's postinstall, so
`.venv/Lib/site-packages/pywin32.pth` must exist containing `win32`, `win32\lib`, and
`Pythonwin`. Without it `import pywintypes` fails and local Qdrant cannot open at all.

---

## Type Generation for TypeScript

When route schemas change, regenerate TypeScript types:

```bash
openapi-typescript http://localhost:8000/openapi.json -o apps/agent/src/types/python-api.ts
```

---

## LangChain Extraction Chains

The `/documents/extract*` endpoints use LangChain extraction chains — not direct LLM calls. These chains live in `apps/python` and call whatever LLM is configured there (not Claude). Key points:

- Extraction runs in Python, returns structured JSON to the agent
- The agent (`apps/agent`) then passes that structured data into the document rendering endpoints
- Never add LLM routing logic to extraction chains — they are data extraction only

The extraction chain result feeds directly into the document tool call sequence:
```
user message → /agent/resolve-and-run → extract-* → /documents/invoice or /documents/offer
```

---

## Pydantic Validation (models/documents.py)

The `InvoiceRequest` model enforces heavy validation — key constraints:
- `tax_percentage` must be a valid Decimal
- `invoice_date` and `value_date` must be parseable date strings
- `price_per_unit` and `units` are required for amount calculation
- `tenant_id` is required and must be a non-empty string

When adding new fields to an extraction chain output, update both the Pydantic model and the corresponding Excel/Word service to consume it.

---

## Invoice-Specific: Macedonian Text

`services/invoices/invoice_text.py` generates the written-out Macedonian text for invoice totals (e.g., "илјада петстотини денари"). This runs in Python and stores the result in `price_after_tax_text` on the `invoices` table. Never generate this text in TypeScript — it belongs here.

---

## Environment Setup (uv)

```bash
uv sync                      # create/update .venv exactly from uv.lock
uv run <command>             # run anything inside the project environment
uv add <package>             # add a dependency (updates pyproject.toml + uv.lock)
uv remove <package>          # remove a dependency
uv lock                      # re-resolve after manual pyproject.toml edits
```

Rules:
- `pyproject.toml` + `uv.lock` are the single source of dependency truth. Both are committed. Never `pip install` into `.venv` directly and never regenerate a `requirements.txt`.
- All dependencies are pinned `==` in `pyproject.toml` — when adding a package, pin the version uv resolves.
- `rvc-python` (optional RVC voice conversion) is deliberately unlisted: `tts/rvc.py` imports it lazily and it is unused unless `RVC_MODEL_PATH` is set. Install manually with `uv pip install rvc-python` if needed.
- `pywin32` is constrained to the installed version in `[tool.uv]` so `uv sync` never swaps its DLLs under a running service (Windows locks loaded DLLs); it is Windows-only and never installs in Linux/Docker builds.
- Docker installs with `uv sync --frozen` — fails the build if `uv.lock` is out of date instead of silently re-resolving.
