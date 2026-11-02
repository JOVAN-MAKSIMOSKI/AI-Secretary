"""Guard tests for the waste-law advisor request: voice mode and message layout.

Pure — no Qdrant, no model, no network: retrieval is stubbed so this runs in the free
offline tier. Covers the split that the Twilio voice path depends on: the same request
must carry the spoken-answer directive when concise=True and omit it otherwise, so a
phone answer stays short while the web answer keeps its full legal format. Also pins
the system/user split: rules only in the system message, data only in the user one.
"""

from llama_index.core.llms import MessageRole

from services.ragagent import (
    DirectQdrantQueryEngine,
    LEGAL_ADVISOR_PROMPT,
    VOICE_ANSWER_DIRECTIVE,
)

QUESTION = "Дали морам да водам евиденција?"


def _engine_with_stubbed_retrieval() -> DirectQdrantQueryEngine:
    engine = DirectQdrantQueryEngine(client=None, collection_name="test", similarity_top_k=3)
    # Bypass the embed model + Qdrant call; build_messages only needs passage dicts.
    engine._retrieve_context = lambda question: [  # type: ignore[method-assign]
        {
            "text": "Секој создавач на отпад води евиденција.",
            "law": "Закон за управување со отпадот",
            "article": "23",
            "valid_from": "2021-09-09",
        }
    ]
    return engine


def test_concise_request_includes_voice_directive() -> None:
    messages = _engine_with_stubbed_retrieval().build_messages(QUESTION, concise=True)
    assert messages is not None
    assert VOICE_ANSWER_DIRECTIVE in messages[0].content


def test_default_request_omits_voice_directive() -> None:
    messages = _engine_with_stubbed_retrieval().build_messages(QUESTION)
    assert messages is not None
    assert all(VOICE_ANSWER_DIRECTIVE not in m.content for m in messages)


def test_voice_directive_forbids_lists_and_markdown() -> None:
    # The directive is the whole point of the feature; assert it actually asks for a
    # short, list-free spoken reply so a reworded edit that guts it fails here.
    lowered = VOICE_ANSWER_DIRECTIVE.lower()
    assert "no markdown" in lowered
    assert "sentences" in lowered


def test_rules_in_system_message_data_in_user_message() -> None:
    messages = _engine_with_stubbed_retrieval().build_messages(QUESTION, tenant_context="Entity type: producer.")
    assert messages is not None
    system, user = messages
    assert system.role == MessageRole.SYSTEM
    assert user.role == MessageRole.USER
    assert system.content == LEGAL_ADVISOR_PROMPT
    assert QUESTION in user.content
    assert "Entity type: producer." in user.content
    assert QUESTION not in system.content


def test_passage_header_names_article_law_and_date() -> None:
    messages = _engine_with_stubbed_retrieval().build_messages(QUESTION)
    assert messages is not None
    assert "Passage 1 — Член 23 — Закон за управување со отпадот — од 2021-09-09" in messages[1].content


def test_no_passages_returns_none() -> None:
    engine = DirectQdrantQueryEngine(client=None, collection_name="test", similarity_top_k=3)
    engine._retrieve_context = lambda question: []  # type: ignore[method-assign]
    assert engine.build_messages(QUESTION) is None


def test_prompt_keeps_the_rules_the_answer_review_needed() -> None:
    # Each phrase guards one failure measured in the 2026-11-02 answer review; a
    # rewording that drops one should fail here, not in production. Whitespace is
    # normalised so re-wrapping the prompt's lines does not trip the guard.
    prompt = " ".join(LEGAL_ADVISOR_PROMPT.split())
    for phrase in (
        "Член N од <source>",
        "Never cite an article number you do not see in the passages",
        "Give numbered steps only for actions a passage actually requires",
        "never transfer it to another party",
        "an English question gets an English answer",
        "Never use Russian or Serbian",
        "Cite nothing",
        "state the condition with it",
        "Do not narrate these instructions",
    ):
        assert phrase in prompt, phrase
