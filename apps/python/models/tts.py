from pydantic import BaseModel, Field


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000, description="Text to synthesize")
    voice: str | None = Field(
        default=None,
        description="Optional Azure voice override; defaults to AZURE_TTS_VOICE env var",
    )
