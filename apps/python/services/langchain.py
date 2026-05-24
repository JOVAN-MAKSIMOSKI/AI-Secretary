"""LangChain utilities and Ollama integration."""

import os
from langchain_community.llms import Ollama
from langchain.prompts import ChatPromptTemplate
from langchain.chains import LLMChain

def get_ollama_llm():
    """Initialize and return Ollama LLM.
    
    Make sure Ollama is running: ollama serve
    Pull a model first: ollama pull mistral (or llama2, neural-chat, etc.)
    """
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
    prompt = ChatPromptTemplate.from_template(prompt_template)
    chain = LLMChain(llm=llm, prompt=prompt)
    return chain
