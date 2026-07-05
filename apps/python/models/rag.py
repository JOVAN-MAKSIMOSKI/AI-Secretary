"""Pydantic models for /rag endpoints (waste-law advisor)."""

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., min_length=1, max_length=8000)


class LawChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    # Prior conversation turns from the law questions page — the LLM has no
    # memory between calls, so the caller supplies the history each time
    history: list[ChatMessage] = Field(default_factory=list, max_length=50)
    # Pre-formatted profile string built by apps/agent from tenantprofilecontext;
    # Python never sees raw auth tokens or reads the businesses table itself
    tenant_context: str = Field(default="", max_length=2000)
    top_k: int = Field(default=10, ge=1, le=20)


class LawChatResponse(BaseModel):
    answer: str
