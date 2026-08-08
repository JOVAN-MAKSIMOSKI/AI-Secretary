"""SSML construction for Azure TTS.

Default behaviour is the **stock Azure voice with no modification**: the text is
XML-escaped and wrapped in <speak><voice>, nothing else.

An optional Bitola-dialect tuning layer is preserved here but is OFF unless
AZURE_TTS_DIALECT_TUNING is truthy. That tuning is two things: a fixed <prosody>
envelope, and a set of <sub alias> word substitutions that re-voice standard
Macedonian words into the target Bitola dialect, both captured in Azure Audio
Content Creation.

The tuning is opt-in rather than deleted so the Audio Content Creation work is
recoverable, but note it is opinionated — it changes pitch/rate/volume and
rewrites whole words (e.g. "здраво" is spoken as "кај си море муце"). Do not
enable it expecting a neutral voice.

The substitution map lives here as an in-repo lexicon rather than a hosted PLS
lexicon file: simplest for the single-voice test phase. Migrate to a hosted
lexicon later if the map grows large or must be shared across services.
"""

from __future__ import annotations

import os
import re
from xml.sax.saxutils import escape, quoteattr

_SSML_LANG = "mk-MK"
_DIALECT_TUNING_ENV = "AZURE_TTS_DIALECT_TUNING"

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


def dialect_tuning_enabled() -> bool:
    """True only when AZURE_TTS_DIALECT_TUNING is explicitly turned on.

    Read per call rather than cached at import so the setting can be flipped in a
    test or a running process without a restart.
    """
    return os.getenv(_DIALECT_TUNING_ENV, "").strip().lower() in {"1", "true", "yes"}


def build_ssml(text: str, voice: str, tuned: bool | None = None) -> str:
    """Wrap text in SSML for the given voice.

    By default this is the plain, unmodified Azure voice — no prosody envelope and
    no word substitutions. Pass tuned=True (or set AZURE_TTS_DIALECT_TUNING) to
    re-apply the Bitola-dialect layer.

    text is XML-escaped first (LLM output may contain & < > "). When tuning is on,
    keyword substitution runs on the escaped string in a single pass so inserted
    alias markup is never re-matched.
    """
    if tuned is None:
        tuned = dialect_tuning_enabled()

    body = escape(text)
    if tuned:
        body = _apply_aliases(body)
        body = (
            f'<prosody rate="{_PROSODY_RATE}" volume="{_PROSODY_VOLUME}" '
            f'pitch="{_PROSODY_PITCH}">{body}</prosody>'
        )

    return (
        '<speak version="1.0" '
        f'xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{_SSML_LANG}">'
        f"<voice name={quoteattr(voice)}>"
        f"{body}"
        "</voice></speak>"
    )
