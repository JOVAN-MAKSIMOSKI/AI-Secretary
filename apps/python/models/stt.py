from pydantic import BaseModel, Field


class TranscribeResponse(BaseModel):
    text: str = Field(..., description="Transcribed text")
    language: str = Field(..., description="Detected or forced language code")
    duration: float = Field(..., description="Audio duration in seconds")
