"""Guard tests for the voice-mode (concise) waste-law prompt.

Pure — no Qdrant, no model, no network: retrieval is stubbed so this runs in the free
offline tier. Covers the split that the Twilio voice path depends on: the same chat
prompt must carry the spoken-answer directive when concise=True and omit it otherwise,
so a phone answer stays short while the web answer keeps its full legal format.
"""

from services.ragagent import DirectQdrantQueryEngine, VOICE_ANSWER_DIRECTIVE


def _engine_with_stubbed_retrieval() -> DirectQdrantQueryEngine:
    engine = DirectQdrantQueryEngine(client=None, collection_name="test", similarity_top_k=3)
    # Bypass the embed model + Qdrant call; build_prompt only needs passage dicts.
    engine._retrieve_context = lambda question: [  # type: ignore[method-assign]
        {"text": "Секој создавач на отпад води евиденција.", "law": "216/2021", "article": "23"}
    ]
    return engine


def test_concise_prompt_includes_voice_directive() -> None:
    prompt = _engine_with_stubbed_retrieval().build_prompt("Дали морам да водам евиденција?", concise=True)
    assert prompt is not None
    assert VOICE_ANSWER_DIRECTIVE in prompt


def test_default_prompt_omits_voice_directive() -> None:
    prompt = _engine_with_stubbed_retrieval().build_prompt("Дали морам да водам евиденција?")
    assert prompt is not None
    assert VOICE_ANSWER_DIRECTIVE not in prompt


def test_voice_directive_forbids_lists_and_markdown() -> None:
    # The directive is the whole point of the feature; assert it actually asks for a
    # short, list-free spoken reply so a reworded edit that guts it fails here.
    lowered = VOICE_ANSWER_DIRECTIVE.lower()
    assert "no markdown" in lowered
    assert "sentences" in lowered
