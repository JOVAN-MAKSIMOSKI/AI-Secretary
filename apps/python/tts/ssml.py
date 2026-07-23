"""SSML construction for Azure TTS — applies the Bitola-dialect voice tuning.

Plain LLM text carries none of the tuning captured in Azure Audio Content
Creation. That tuning is two things: a fixed <prosody> envelope, and a set of
<sub alias> word substitutions that re-voice standard Macedonian words into the
target Bitola dialect. build_ssml() re-applies both to arbitrary runtime text.

The substitution map lives here as an in-repo lexicon rather than a hosted PLS
lexicon file: simplest for the single-voice test phase. Migrate to a hosted
lexicon later if the map grows large or must be shared across services.
"""

from __future__ import annotations

import re
from xml.sax.saxutils import escape, quoteattr

_SSML_LANG = "mk-MK"

# Global prosody envelope applied to the whole utterance. These are the
# body-speech values tuned in Audio Content Creation. The tool also had a
# louder/faster greeting-only block, but per-span prosody cannot be reproduced
# on arbitrary LLM text, so the body settings are used as the single global one.
_PROSODY_RATE = "+10.00%"
_PROSODY_VOLUME = "+11.00%"
_PROSODY_PITCH = "+20.00%"

# Standard Macedonian -> Bitola-dialect substitutions, spoken via <sub alias>.
# Matched whole-word and case-insensitively. Extend this map as more words are
# found to mispronounce or to need dialect conversion during call testing.
# NOTE: "каде" -> "кај" was exported from Audio Content Creation as the corrupted
# token "к ј" (a stray space); it is restored to the intended dialect word here.
_DIALECT_ALIASES: dict[str, str] = {
    "здраво": "кај си море муце",
    "добар": "арен",
    "добра": "арна",
    "каде": "кај",
    "ќе": "че",
    "правиме": "прајмо",
    "стави": "клај",
}


def _build_substitution_pattern() -> "re.Pattern[str]":
    # Longest keys first so a longer key wins over any shorter one it contains.
    keys = sorted(_DIALECT_ALIASES, key=len, reverse=True)
    alternation = "|".join(re.escape(key) for key in keys)
    return re.compile(rf"\b(?:{alternation})\b", re.IGNORECASE | re.UNICODE)


_SUB_PATTERN = _build_substitution_pattern()


def _apply_aliases(escaped_text: str) -> str:
    """Wrap each dialect keyword in <sub alias="...">. Input must already be
    XML-escaped; matched keywords contain no special chars so they pass through
    unchanged, and only the static alias values are attribute-quoted here."""

    def _replace(match: "re.Match[str]") -> str:
        original = match.group(0)  # already XML-escaped by the caller
        alias = _DIALECT_ALIASES[original.lower()]
        return f"<sub alias={quoteattr(alias)}>{original}</sub>"

    return _SUB_PATTERN.sub(_replace, escaped_text)


def build_ssml(text: str, voice: str) -> str:
    """Wrap plain text in the dialect prosody envelope + <sub alias> tags.

    text is XML-escaped first (LLM output may contain & < > "), then keyword
    substitution runs on the escaped string in a single pass so inserted alias
    markup is never re-matched.
    """
    body = _apply_aliases(escape(text))
    return (
        '<speak version="1.0" '
        f'xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{_SSML_LANG}">'
        f"<voice name={quoteattr(voice)}>"
        f'<prosody rate="{_PROSODY_RATE}" volume="{_PROSODY_VOLUME}" '
        f'pitch="{_PROSODY_PITCH}">'
        f"{body}"
        "</prosody></voice></speak>"
    )
