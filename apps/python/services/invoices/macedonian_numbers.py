"""Deterministic Macedonian number-to-words conversion for invoice amounts.

Replaces an LLM call. Number-to-words is a closed, solved problem: an LLM adds latency,
cost, a provider dependency, and — critically — no way to verify that the words it wrote
match the digits on the same invoice.

`words_to_int` exists so the conversion can be verified mechanically: for any n,
`words_to_int(int_to_words(n)) == n`. That proves the wording encodes the value
unambiguously. It does **not** prove the phrasing is idiomatic — the vocabulary tables
below need a native speaker's review.
"""

from __future__ import annotations

from decimal import Decimal

# Masculine forms — денар is masculine ("еден денар", "два денари").
ONES: dict[int, str] = {
    0: "нула",
    1: "еден",
    2: "два",
    3: "три",
    4: "четири",
    5: "пет",
    6: "шест",
    7: "седум",
    8: "осум",
    9: "девет",
}

# Feminine forms, required before илјада ("една илјада", "две илјади").
ONES_FEMININE: dict[int, str] = {1: "една", 2: "две"}

TEENS: dict[int, str] = {
    10: "десет",
    11: "единаесет",
    12: "дванаесет",
    13: "тринаесет",
    14: "четиринаесет",
    15: "петнаесет",
    16: "шеснаесет",
    17: "седумнаесет",
    18: "осумнаесет",
    19: "деветнаесет",
}

TENS: dict[int, str] = {
    20: "дваесет",
    30: "триесет",
    40: "четириесет",
    50: "педесет",
    60: "шеесет",
    70: "седумдесет",
    80: "осумдесет",
    90: "деведесет",
}

HUNDREDS: dict[int, str] = {
    100: "сто",
    200: "двесте",
    300: "триста",
    400: "четиристотини",
    500: "петстотини",
    600: "шестотини",
    700: "седумстотини",
    800: "осумстотини",
    900: "деветстотини",
}

CONJUNCTION = "и"
CURRENCY_MAJOR = "денари"
CURRENCY_MINOR = "дени"

MAX_SUPPORTED = 999_999_999


def _group_components(value: int, feminine: bool) -> list[str]:
    """Words for 1..999 as separate components, most significant first."""
    components: list[str] = []
    remainder = value

    hundreds = (remainder // 100) * 100
    if hundreds:
        components.append(HUNDREDS[hundreds])
        remainder -= hundreds

    if remainder >= 20:
        tens = (remainder // 10) * 10
        components.append(TENS[tens])
        remainder -= tens
    elif remainder >= 10:
        components.append(TEENS[remainder])
        remainder = 0

    if remainder:
        if feminine and remainder in ONES_FEMININE:
            components.append(ONES_FEMININE[remainder])
        else:
            components.append(ONES[remainder])

    return components


def _join(components: list[str]) -> str:
    """Macedonian places `и` before the final component of the whole number.

    сто и пет / сто дваесет и пет / четиринаесет илјади двесте и педесет
    """
    if len(components) <= 1:
        return "".join(components)
    return f"{' '.join(components[:-1])} {CONJUNCTION} {components[-1]}"


def _scale_component(count: int, singular_word: str, plural_word: str, feminine: bool) -> str:
    """One component covering a whole scale group, e.g. 'дваесет и една илјада'.

    The count and its scale word must stay a single component: `_join` inserts `и`
    between components, and splitting them yields 'дваесет една и илјада'.
    """
    # Numbers ending in 1 (but not 11) take the singular scale word.
    singular = count % 10 == 1 and count % 100 != 11
    counted = _join(_group_components(count, feminine=feminine))
    return f"{counted} {singular_word if singular else plural_word}"


def int_to_words(value: int) -> str:
    """Convert a non-negative integer to Macedonian words."""
    if value < 0:
        raise ValueError("Negative amounts are not supported.")
    if value > MAX_SUPPORTED:
        raise ValueError(f"Amounts above {MAX_SUPPORTED} are not supported.")
    if value == 0:
        return ONES[0]

    components: list[str] = []

    millions = value // 1_000_000
    if millions:
        components.append(_scale_component(millions, "милион", "милиони", feminine=False))
        value -= millions * 1_000_000

    thousands = value // 1_000
    if thousands:
        if thousands == 1:
            # "илјада", not "една илјада" — the bare form is standard for exactly 1000.
            components.append("илјада")
        else:
            components.append(_scale_component(thousands, "илјада", "илјади", feminine=True))
        value -= thousands * 1_000

    if value:
        components.extend(_group_components(value, feminine=False))

    return _join(components)


def amount_to_words(amount: Decimal) -> str:
    """Full invoice money phrase, e.g. 'четиринаесет илјади двесте и педесет денари'."""
    if amount < 0:
        raise ValueError("Negative amounts are not supported.")

    whole = int(amount)
    minor = int((amount - whole) * 100).__abs__()

    phrase = f"{int_to_words(whole)} {CURRENCY_MAJOR}"
    if minor:
        phrase = f"{phrase} {CONJUNCTION} {int_to_words(minor)} {CURRENCY_MINOR}"
    return phrase


# --- Verification helpers -------------------------------------------------------------

_WORD_VALUES: dict[str, int] = {
    **{word: number for number, word in ONES.items()},
    **{word: number for number, word in ONES_FEMININE.items()},
    **{word: number for number, word in TEENS.items()},
    **{word: number for number, word in TENS.items()},
    **{word: number for number, word in HUNDREDS.items()},
}

_SCALES: dict[str, int] = {
    "илјада": 1_000,
    "илјади": 1_000,
    "милион": 1_000_000,
    "милиони": 1_000_000,
}


def words_to_int(text: str) -> int:
    """Parse Macedonian number words back to an integer.

    Exists to verify `int_to_words` mechanically rather than by asserting strings a
    non-native author believed were correct.
    """
    total = 0
    current = 0

    for token in text.split():
        if token == CONJUNCTION:
            continue
        if token in _SCALES:
            # A bare scale word means one of it: "илјада" == 1000.
            current = (current or 1) * _SCALES[token]
            total += current
            current = 0
        elif token in _WORD_VALUES:
            current += _WORD_VALUES[token]
        else:
            raise ValueError(f"Unrecognised Macedonian number word: {token!r}")

    return total + current
