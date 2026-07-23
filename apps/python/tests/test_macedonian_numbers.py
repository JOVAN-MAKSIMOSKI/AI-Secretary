"""Layer 3 — deterministic Macedonian amount-in-words.

The round-trip tests are the load-bearing ones: they prove the words encode the value
unambiguously without depending on the author's Macedonian being idiomatic. The explicit
string tests below cover forms worth pinning, and are the ones a native speaker should
review.
"""

from decimal import Decimal

import pytest

from services.invoices.macedonian_numbers import (
    MAX_SUPPORTED,
    amount_to_words,
    int_to_words,
    words_to_int,
)


@pytest.mark.parametrize("value", list(range(0, 1001)))
def test_round_trip_small_values(value: int) -> None:
    assert words_to_int(int_to_words(value)) == value


@pytest.mark.parametrize(
    "value",
    [
        1_001, 1_100, 1_500, 2_000, 2_001, 10_000, 11_000, 14_250, 21_000, 22_000,
        99_999, 100_000, 123_456, 999_999, 1_000_000, 1_000_001, 2_000_000,
        21_000_000, 123_456_789, MAX_SUPPORTED,
    ],
)
def test_round_trip_large_values(value: int) -> None:
    assert words_to_int(int_to_words(value)) == value


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0, "нула"),
        (1, "еден"),
        (5, "пет"),
        (10, "десет"),
        (16, "шеснаесет"),
        (20, "дваесет"),
        (21, "дваесет и еден"),
        (100, "сто"),
        (105, "сто и пет"),
        (120, "сто и дваесет"),
        (125, "сто дваесет и пет"),
        (500, "петстотини"),
        (1_000, "илјада"),
        (1_500, "илјада и петстотини"),
        (2_000, "две илјади"),
        (14_250, "четиринаесет илјади двесте и педесет"),
        (21_000, "дваесет и една илјада"),
        (1_000_000, "еден милион"),
    ],
)
def test_known_forms(value: int, expected: str) -> None:
    assert int_to_words(value) == expected


def test_amount_phrase_whole_denars() -> None:
    assert amount_to_words(Decimal("14250.00")) == "четиринаесет илјади двесте и педесет денари"


def test_amount_phrase_with_minor_units() -> None:
    phrase = amount_to_words(Decimal("1500.50"))
    assert phrase == "илјада и петстотини денари и педесет дени"


def test_amount_phrase_zero() -> None:
    assert amount_to_words(Decimal("0.00")) == "нула денари"


def test_output_contains_no_digits() -> None:
    # A stray digit means a code path fell back to str(value) somewhere.
    for value in (7, 42, 1_500, 14_250, 123_456_789):
        assert not any(ch.isdigit() for ch in int_to_words(value))


def test_conversion_is_deterministic() -> None:
    assert int_to_words(14_250) == int_to_words(14_250)


def test_rejects_out_of_range_and_negative() -> None:
    with pytest.raises(ValueError):
        int_to_words(-1)
    with pytest.raises(ValueError):
        int_to_words(MAX_SUPPORTED + 1)


def test_parser_rejects_unknown_words() -> None:
    with pytest.raises(ValueError, match="Unrecognised"):
        words_to_int("сто и банана")
