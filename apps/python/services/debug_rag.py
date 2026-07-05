import os
import sys
from pathlib import Path


from ragagent import _configure_llama_index_settings, get_qdrant_client, _sanitize_retrieved_passage, _assert_safe_question

from llama_index.core import Settings


def run_diagnostics(question: str, top_k: int = 5):
    print("=" * 60)
    print("⚡ STARTING RAG RETRIEVAL DIAGNOSTIC ⚡")
    print("=" * 60)

    # 2. Check Environment Variables
    print("\n[1/4] Checking Configured Environment Variables:")
    print(f" -> RAG_LLM_PROVIDER:   {os.getenv('RAG_LLM_PROVIDER', 'auto (default)')}")
    print(f" -> RAG_EMBED_PROVIDER: {os.getenv('RAG_EMBED_PROVIDER', 'ollama (default)')}")
    print(f" -> RAG_EMBED_MODEL:    {os.getenv('RAG_EMBED_MODEL', 'nomic-embed-text (default)')}")
    print(f" -> QDRANT_COLLECTION:  {os.getenv('QDRANT_COLLECTION', 'waste_management_law_mk_v2 (default)')}")
    
    # 3. Initialize Settings & Client using your code
    print("\n[2/4] Initializing LlamaIndex Settings & Qdrant Client...")
    _configure_llama_index_settings()
    client = get_qdrant_client()
    collection_name = os.getenv("QDRANT_COLLECTION", "waste_management_law_mk_v2")
    
    # 4. Run Safety Check on input query
    try:
        _assert_safe_question(question)
        print(" -> Input Question Safety Check: PASSED ✅")
    except ValueError as e:
        print(f" -> Input Question Safety Check: FAILED ❌\nReason: {e}")
        return

    # 5. Generate Query Embedding
    print("\n[3/4] Generating embedding for your query...")
    embed_model = Settings.embed_model
    try:
        # Mirror ragagent.py: query embedding so e5's "query: " prefix applies
        query_vector = embed_model.get_query_embedding(question)
        print(f" -> Successfully generated vector dims: {len(query_vector)}")
    except Exception as e:
        print(f" -> Failed to generate embedding: {e}")
        print("💡 Tip: Is your local Ollama running, or are your API keys correct?")
        return

    # 6. Query Qdrant directly to catch raw scores
    print(f"\n[4/4] Querying Qdrant collection '{collection_name}' directly...")
    try:
        response = client.query_points(
            collection_name=collection_name,
            query=query_vector,
            limit=top_k,
            with_payload=True,
            with_vectors=False,
        )
    except Exception as e:
        print(f" -> Qdrant Query Failed: {e}")
        return

    points = getattr(response, "points", [])
    if not points:
        print("❌ CRITICAL: Qdrant returned 0 points. Your collection might be empty or your vector dimensions mismatch!")
        return

    print(f" -> Found {len(points)} matching points. Analyzing chunks:\n")
    print("-" * 60)

    for idx, point in enumerate(points):
        score = getattr(point, "score", 0.0)
        payload = getattr(point, "payload", {}) or {}
        raw_text = payload.get("text", "")

        print(f"\n📍 NODE {idx + 1} | Similarity Score: {score:.4f}")
        
        if not raw_text:
            print("   ⚠️ WARNING: This point has an empty or missing 'text' payload!")
            continue
            
        # Check if your sanitization function is accidentally deleting the text
        sanitized_text = _sanitize_retrieved_passage(raw_text.strip())
        
        if not sanitized_text:
            print("   ❌ SANITIZATION DROPPED THIS CHUNK!")
            print("   Your prompt-injection regex triggers flag this text as unsafe.")
            print(f"   Raw Text Snippet: {raw_text[:150]}...")
        else:
            print("   ✅ Pass Sanitization Check.")
            # Print the first few lines of the text to verify it's readable Macedonian
            preview = sanitized_text.replace('\n', ' ')
            print(f"   Text Snippet: {preview[:250]}...")
            
        print("-" * 40)


if __name__ == "__main__":
    # Test query using your specific target question
    test_query = "Што е опасен отпад според член 6?"
    run_diagnostics(test_query)