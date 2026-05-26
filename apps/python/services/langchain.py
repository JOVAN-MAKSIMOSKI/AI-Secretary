"""LangChain utilities for future workflow chains."""

from __future__ import annotations

import os

from langchain_community.llms import Ollama
from langchain_core.prompts import PromptTemplate


def get_ollama_llm():
    """Initialize and return an Ollama LLM."""
    ollama_base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    model = os.getenv("OLLAMA_MODEL", "mistral")

    return Ollama(
        base_url=ollama_base_url,
        model=model,
        temperature=0.7,
    )


def create_simple_chain(prompt_template: str):
    """Create a simple LLM chain with a prompt template."""
    llm = get_ollama_llm()
    prompt = PromptTemplate.from_template(prompt_template)
    return prompt | llm
