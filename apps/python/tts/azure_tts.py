"""Azure Cognitive Services TTS — returns 24 kHz 16-bit mono PCM WAV bytes.

Lazy config validation: Azure credentials are checked only when synthesize() is
called so non-voice deploys can boot without AZURE_TTS_KEY configured.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_AZURE_TTS_VOICE_DEFAULT = "mk-MK-MarijaNeural"


def synthesize(text: str, voice: str | None = None) -> bytes:
    """Call Azure Cognitive Services TTS and return 24 kHz 16-bit mono PCM WAV bytes."""
    try:
        import azure.cognitiveservices.speech as speechsdk
    except ImportError as exc:
        raise RuntimeError(
            "azure-cognitiveservices-speech is not installed. "
            "Run: pip install azure-cognitiveservices-speech"
        ) from exc

    key = os.getenv("AZURE_TTS_KEY")
    region = os.getenv("AZURE_TTS_REGION")
    if not key or not region:
        raise RuntimeError(
            "AZURE_TTS_KEY and AZURE_TTS_REGION must be set to use the azure_rvc TTS provider."
        )

    resolved_voice = voice or os.getenv("AZURE_TTS_VOICE", _AZURE_TTS_VOICE_DEFAULT)

    speech_config = speechsdk.SpeechConfig(subscription=key, region=region)
    speech_config.speech_synthesis_voice_name = resolved_voice
    # Riff24Khz16BitMonoPcm: standard WAV container, 24 kHz 16-bit mono PCM.
    # This format feeds directly into the RVC conversion stage without pre-resampling.
    speech_config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm
    )

    synthesizer = speechsdk.SpeechSynthesizer(
        speech_config=speech_config,
        audio_config=None,  # in-memory output — no speaker or file
    )
    result = synthesizer.speak_text_async(text).get()

    if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
        return bytes(result.audio_data)

    cancellation = result.cancellation_details
    raise RuntimeError(
        f"Azure TTS failed ({cancellation.reason}): {cancellation.error_details}"
    )
