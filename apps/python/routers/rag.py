"""RAG router — POST /rag/query."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from services.auth import get_current_user_id

router = APIRouter(prefix="/rag", tags=["rag"])

_executor = ThreadPoolExecutor(max_workers=2)


class RagQueryRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    top_k: Optional[int] = Field(default=5, ge=1, le=20)


class RagQueryResponse(BaseModel):
    answer: str


@router.post("/query", response_model=RagQueryResponse)
async def rag_query(
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
