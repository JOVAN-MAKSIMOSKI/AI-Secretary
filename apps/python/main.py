"""FastAPI entry point — document generation, RAG, STT, and business auth service.

Run: uvicorn main:app --reload --host 0.0.0.0 --port 8000
Docs: http://localhost:8000/docs
"""

from fastapi import FastAPI

from routers.business import router as business_router
from routers.clients import router as clients_router
from routers.documents import router as documents_router
from routers.rag import router as rag_router
from routers.stt import router as stt_router

app = FastAPI(title="Secretary Python Service", version="0.1.0")

app.include_router(business_router)
app.include_router(clients_router)
app.include_router(documents_router)
app.include_router(rag_router)
app.include_router(stt_router)
