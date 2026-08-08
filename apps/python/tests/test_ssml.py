"""Guards for tts/ssml.py — the default must stay the unmodified Azure voice.

The dialect tuning is opinionated (it shifts pitch/rate/volume and rewrites whole
words), so "off by default" is a behavioural contract, not an implementation
detail. These are pure-function tests: no Azure call, no network.
"""

import pytest

from tts.ssml import build_ssml, dialect_tuning_enabled

VOICE = "mk-MK-MarijaNeural"
# Contains four words present in the dialect lexicon.
SAMPLE = "Здраво, каде ќе правиме состанок?"


@pytest.fixture(autouse=True)
def _clear_tuning_env(monkeypatch):
    monkeypatch.delenv("AZURE_TTS_DIALECT_TUNING", raising=False)


def test_default_has_no_prosody_and_no_substitutions():
    ssml = build_ssml(SAMPLE, VOICE)

    assert "<prosody" not in ssml
    assert "<sub " not in ssml
    assert "кај си море муце" not in ssml
    # The original words survive untouched.
    assert "Здраво" in ssml and "каде" in ssml and "ќе" in ssml
    assert f'<voice name="{VOICE}">' in ssml


def test_explicit_tuned_flag_restores_the_dialect_layer():
    ssml = build_ssml(SAMPLE, VOICE, tuned=True)

    assert "<prosody" in ssml
    assert 'alias="кај си море муце"' in ssml


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes"])
def test_env_var_enables_tuning(monkeypatch, value):
    monkeypatch.setenv("AZURE_TTS_DIALECT_TUNING", value)
    assert dialect_tuning_enabled() is True
    assert "<prosody" in build_ssml(SAMPLE, VOICE)


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off"])
def test_env_var_absent_or_falsy_keeps_voice_plain(monkeypatch, value):
    monkeypatch.setenv("AZURE_TTS_DIALECT_TUNING", value)
    assert dialect_tuning_enabled() is False
    assert "<prosody" not in build_ssml(SAMPLE, VOICE)


def test_xml_escaping_still_applies_when_untuned():
    ssml = build_ssml('5 < 6 & "quoted"', VOICE)

    assert "&lt;" in ssml and "&amp;" in ssml
    # A raw unescaped angle bracket would break the SSML document.
    assert "5 < 6" not in ssml
