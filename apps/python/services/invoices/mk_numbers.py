"""Deterministic Macedonian number-word normalization.

Whisper transcribes spoken Macedonian amounts as words ("пет парчиња по илјада
денари"), and the local extraction LLM cannot reliably convert Cyrillic number
words to numeric values — so units/price_per_unit silently go missing from the
extraction payload. This module rewrites Cyrillic number-word sequences into
digits ("5 парчиња по 1000 денари") so the existing digit-based fallback regexes
in excel.py can match them.

Cyrillic-only by design: Latin transliterations are ambiguous ("sto" is both
100 and the transliteration of "што"), while STT output — the main producer of
number words — is always Cyrillic.
"""

from __future__ import annotations

import re

# Simple additive values: 0-19, tens, and hundreds.
_SIMPLE_VALUES: dict[str, int] = {
    "нула": 0,
    "еден": 1,
    "една": 1,
    "едно": 1,
    "два": 2,
    "две": 2,
    "три": 3,
    "четири": 4,
    "пет": 5,
    "шест": 6,
    "седум": 7,
    "осум": 8,
    "девет": 9,
    "десет": 10,
    "единаесет": 11,
    "дванаесет": 12,
    "тринаесет": 13,
    "четиринаесет": 14,
    "петнаесет": 15,
    "шеснаесет": 16,
    "седумнаесет": 17,
    "осумнаесет": 18,
    "деветнаесет": 19,
    "дваесет": 20,
    "триесет": 30,
    "четириесет": 40,
    "педесет": 50,
    "шеесет": 60,
    "седумдесет": 70,
    "осумдесет": 80,
    "деведесет": 90,
    "сто": 100,
    "двесте": 200,
    "триста": 300,
    "четиристотини": 400,
    "петстотини": 500,
    "шестотини": 600,
    "шестстотини": 600,
    "седумстотини": 700,
    "осумстотини": 800,
    "деветстотини": 900,
}

# Scale words: multiply the accumulated value (or 1 when standalone, e.g. "илјада" = 1000).
_MULTIPLIER_VALUES: dict[str, int] = {
    "илјада": 1000,
    "илјади": 1000,
    "милион": 1_000_000,
    "милиони": 1_000_000,
}

# Longest-first alternation so "петстотини" is never partially matched as "пет".
_NUMBER_WORDS_ALTERNATION = "|".join(
    sorted((*_SIMPLE_VALUES, *_MULTIPLIER_VALUES), key=len, reverse=True)
)

_DIGIT_TOKEN = r"\d+(?:[.,]\d+)?"

# A sequence is: an optional leading digit token ("5 илјади"), then one or more
# number words, optionally joined by "и" ("две илјади и петстотини"). "и" is only
# consumed when a number word follows, so "пет и Јован" matches just "пет". Plain
# digits are never merged with each other ("5 и 6" stays untouched) — only a digit
# directly followed by a number word joins a sequence.
_NUMBER_SEQUENCE = re.compile(
    rf"\b(?:{_DIGIT_TOKEN}\s+)?"
    rf"(?:{_NUMBER_WORDS_ALTERNATION})"
    rf"(?:\s+(?:и\s+)?(?:{_NUMBER_WORDS_ALTERNATION}))*\b",
    re.IGNORECASE,
)

_DIGIT_TOKEN_FULLMATCH = re.compile(_DIGIT_TOKEN)

_ANY_NUMBER_WORD = re.compile(
    rf"\b(?:{_NUMBER_WORDS_ALTERNATION})\b",
    re.IGNORECASE,
)


def contains_mk_number_words(text: str) -> bool:
    """True when ``text`` contains at least one Macedonian number word.

    Used by the extraction fallback to decide when the deterministic parse should
    override LLM-provided numeric fields: on number-word input the local model is
    known to convert unreliably (e.g. "две илјади и петстотини" -> 2000).
    """
    return _ANY_NUMBER_WORD.search(text) is not None


def _sequence_to_number(tokens: list[str]) -> float:
    """Accumulate a token run into one number (standard word-number algorithm)."""
    total = 0.0
    current = 0.0

    for token in tokens:
        if token == "и":
            continue
        if _DIGIT_TOKEN_FULLMATCH.fullmatch(token):
            current += float(token.replace(",", "."))
        elif token in _SIMPLE_VALUES:
            current += _SIMPLE_VALUES[token]
        elif token in _MULTIPLIER_VALUES:
            # "илјада" alone means 1000; "две илјади" means 2 * 1000.
            total += (current or 1) * _MULTIPLIER_VALUES[token]
            current = 0.0

    return total + current


def _format_number(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:g}"


def normalize_mk_number_words(text: str) -> str:
    """Rewrite Macedonian number-word sequences in ``text`` as digit strings.

    Examples:
        "пет парчиња по илјада денари"  -> "5 парчиња по 1000 денари"
        "две илјади и петстотини"       -> "2500"
        "5 илјади денари"               -> "5000 денари"

    Non-number text is preserved verbatim; a match that somehow contains no
    number word is returned unchanged.
    """

    def _replace(match: re.Match[str]) -> str:
        tokens = match.group(0).lower().split()
        has_word = any(t in _SIMPLE_VALUES or t in _MULTIPLIER_VALUES for t in tokens)
        if not has_word:
            return match.group(0)
        return _format_number(_sequence_to_number(tokens))

    return _NUMBER_SEQUENCE.sub(_replace, text)
