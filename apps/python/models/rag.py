"""Pydantic models for /rag endpoints."""

from pydantic import BaseModel


class IngestRequest(BaseModel):
    pass  # TODO: define fields


class QueryRequest(BaseModel):
    pass  # TODO: define fields


class QueryResponse(BaseModel):
    pass  # TODO: define fields
