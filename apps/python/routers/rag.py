"""RAG router — POST /rag/query (stateless), /rag/chat and /rag/chat/stream (history + profile)."""

# NOTE: no `from __future__ import annotations` here — stringified annotations
# make FastAPI misread the Pydantic request models as query parameters
# (ForwardRef resolution fails under the current fastapi/pydantic pair) and
# break OpenAPI generation.

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from models.rag import LawChatRequest, LawChatResponse
from services.auth import get_current_user_id, get_current_user_id_or_service

logger = logging.getLogger(__name__)

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
    _current_user_id: str = Depends(get_current_user_id_or_service),
) -> LawChatResponse:
    """Waste-law advisor chat: conversation history + tenant profile context.

    tenant_context arrives pre-formatted from apps/agent (which resolves the
    tenant from the JWT and reads businesses.tenantprofilecontext) — this
    service never reads the businesses table or raw auth data itself.

    Dual auth (get_current_user_id_or_service): web sends a Bearer JWT, the
    Twilio voice path authenticates service-to-service with X-Service-Secret +
    X-Tenant-Id. The buffered endpoint is the one the voice path uses; the
    streaming variant below stays JWT-only (browser-only surface).
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
                concise=payload.concise,
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


@router.post("/chat/stream")
@limiter.limit("20/minute")
async def rag_chat_stream(
    request: Request,
    payload: LawChatRequest,
    _current_user_id: str = Depends(get_current_user_id),
):
    """SSE variant of /rag/chat — streams the answer as it is generated.

    Events are data-only JSON: {"delta": "..."} per chunk, then {"done": true}.
    A failure after streaming has started (HTTP 200 already sent) is reported
    as an {"error": "..."} event instead of a status code.
    """
    import asyncio

    try:
        from services.ragagent import stream_chat_law_documents
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"RAG service unavailable (llama_index failed to load): {exc}",
        )

    history = [{"role": m.role, "content": m.content} for m in payload.history]

    # Retrieval + prompt build run here (eagerly, off the event loop), so their
    # errors still map to proper HTTP status codes — only token generation streams.
    loop = asyncio.get_event_loop()
    try:
        delta_generator = await loop.run_in_executor(
            _executor,
            lambda: stream_chat_law_documents(
                question=payload.question,
                history=history,
                tenant_context=payload.tenant_context,
                similarity_top_k=payload.top_k,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"RAG chat failed: {exc}",
        )

    def sse_events():
        # Sync generator — Starlette iterates it in a threadpool, keeping the
        # blocking OpenAI stream off the event loop.
        try:
            for delta in delta_generator:
                yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as exc:
            logger.error("RAG chat stream failed mid-generation: %s", exc)
            yield f"data: {json.dumps({'error': 'Answer generation failed. Please retry.'})}\n\n"

    return StreamingResponse(
        sse_events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
