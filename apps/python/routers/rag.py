"""RAG router — POST /rag/query (stateless) and POST /rag/chat (history + profile)."""

# NOTE: no `from __future__ import annotations` here — stringified annotations
# make FastAPI misread the Pydantic request models as query parameters
# (ForwardRef resolution fails under the current fastapi/pydantic pair) and
# break OpenAPI generation.

from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from models.rag import LawChatRequest, LawChatResponse
from services.auth import get_current_user_id

limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/rag", tags=["rag"])

_executor = ThreadPoolExecutor(max_workers=2)


class RagQueryRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    top_k: Optional[int] = Field(default=5, ge=1, le=20)


class RagQueryResponse(BaseModel):
    answer: str


@router.post("/query", response_model=RagQueryResponse)
@limiter.limit("20/minute")
async def rag_query(
    request: Request,
    payload: RagQueryRequest,
    _current_user_id: str = Depends(get_current_user_id),
) -> RagQueryResponse:
    """Query the law documents collection with a natural-language question."""
    import asyncio

    try:
        from services.ragagent import query_law_documents
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"RAG service unavailable (llama_index failed to load): {exc}",
        )

    loop = asyncio.get_event_loop()
    try:
        answer = await loop.run_in_executor(
            _executor,
            lambda: query_law_documents(
                question=payload.question,
                similarity_top_k=payload.top_k or 5,
            ),
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"RAG query failed: {exc}",
        )

    return RagQueryResponse(answer=answer)


@router.post("/chat", response_model=LawChatResponse)
@limiter.limit("20/minute")
async def rag_chat(
    request: Request,
    payload: LawChatRequest,
    _current_user_id: str = Depends(get_current_user_id),
) -> LawChatResponse:
    """Waste-law advisor chat: conversation history + tenant profile context.

    tenant_context arrives pre-formatted from apps/agent (which resolves the
    tenant from the JWT and reads businesses.tenantprofilecontext) — this
    service never reads the businesses table or raw auth data itself.
    """
    import asyncio

    try:
        from services.ragagent import chat_law_documents
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"RAG service unavailable (llama_index failed to load): {exc}",
        )

    history = [{"role": m.role, "content": m.content} for m in payload.history]

    loop = asyncio.get_event_loop()
    try:
        answer = await loop.run_in_executor(
            _executor,
            lambda: chat_law_documents(
                question=payload.question,
                history=history,
                tenant_context=payload.tenant_context,
                similarity_top_k=payload.top_k,
            ),
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"RAG chat failed: {exc}",
        )

    return LawChatResponse(answer=answer)
