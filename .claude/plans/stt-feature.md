# STT Feature — Implementation Plan

## Overview

Implement speech-to-text using faster-whisper in the Python service. Users speak
Macedonian voice commands, the audio is transcribed locally, and the text feeds
into the agent pipeline as a normal user message.

**Tech:** faster-whisper, medium model, CPU, language forced to "mk"
**Privacy:** Audio never leaves our infrastructure — no third-party API calls.

---

## Data Flow

```
Frontend (MediaRecorder, audio/webm)
  → POST apps/agent /agent/transcribe (multipart/form-data)
  → apps/agent forwards to apps/python POST /stt/transcribe
  → faster-whisper transcribes with language="mk"
  → text returned to apps/agent
  → agent returns text to frontend
  → frontend populates chat input with transcribed text
```

---

## Current State

- `apps/python/routers/stt.py` — router stub exists, prefix is `/stt`, already registered in `main.py`
- `apps/agent/src/tools/sttTool.ts` — stub exists (empty export)
- No model loader, no Pydantic models, no transcribe logic yet
- `main.py` already imports and registers `stt_router` — Step 4 is done

---

## Implementation Order

Build bottom-up so each layer can be tested before adding the next.

---

### Step 1 — Python: Add faster-whisper dependency

**File:** `apps/python/requirements.txt`

Add:
```
faster-whisper
```

Install:
```bash
cd apps/python
.\venv\Scripts\activate   # Windows
pip install faster-whisper
pip freeze > requirements.txt
```

faster-whisper also requires ffmpeg for audio format conversion. Add to Dockerfile:
```dockerfile
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
```

---

### Step 2 — Python: Model Loader Singleton

**File:** `apps/python/stt/whisper.py` (new file)
**File:** `apps/python/stt/__init__.py` (new empty file — makes it a package)

The model must load ONCE at app startup and stay in memory. Loading per-request takes 30+ seconds.

```python
from faster_whisper import WhisperModel

MODEL_SIZE = "medium"
DEVICE = "cpu"
COMPUTE_TYPE = "int8"  # Reduces RAM from ~3GB to ~1.5GB on CPU, minimal accuracy loss

# Singleton — loaded once at import time, cached for all requests
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
```

Key decisions:
- `compute_type="int8"` — cuts RAM in half on CPU, negligible accuracy loss
- `device="cpu"` — production target is Hetzner CX32 (no GPU)
- Model downloads automatically on first run (~1.5GB), then cached in `~/.cache/huggingface/`

---

### Step 3 — Python: Pydantic Response Model

**File:** `apps/python/models/stt.py` (new file)

```python
from pydantic import BaseModel, Field

class TranscribeResponse(BaseModel):
    text: str = Field(..., description="Transcribed text")
    language: str = Field(..., description="Detected or forced language code")
    duration: float = Field(..., description="Audio duration in seconds")
```

No request model needed — the route receives `multipart/form-data` (audio file + tenant_id form field), not JSON.

---

### Step 4 — Python: Implement Transcribe Route

**File:** `apps/python/routers/stt.py` (replace the stub)

The existing stub already sets `prefix="/stt"` — the route path will be `/stt/transcribe`.

Requirements:
- Receive `tenant_id` as a Form field — validate non-empty (mandatory on every route)
- Receive `audio` as UploadFile
- Write to temp file (faster-whisper needs a file path, not bytes)
- Force `language="mk"` — never auto-detect
- Enable `vad_filter=True` — strips silence, improves accuracy and speed
- Always delete temp file in `finally` block

```python
import os
import tempfile
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from ..models.stt import TranscribeResponse
from ..stt.whisper import model

router = APIRouter(prefix="/stt", tags=["stt"])

@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    tenant_id: str = Form(...),
    audio: UploadFile = File(...),
):
    if not tenant_id or not isinstance(tenant_id, str):
        raise HTTPException(status_code=400, detail="Invalid tenant_id")

    suffix = os.path.splitext(audio.filename or ".webm")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language="mk",      # Force Macedonian — never auto-detect
            beam_size=5,
            vad_filter=True,    # Strip silence before transcribing
        )
        text = " ".join(segment.text for segment in segments)
        return TranscribeResponse(
            text=text.strip(),
            language=info.language,
            duration=info.duration,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
```

Note: `main.py` already registers this router — no change needed there.

---

### Step 5 — Test Python Service in Isolation

Before touching TypeScript or React, verify the Python route with curl.

Start the service:
```bash
cd apps/python
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Test (record a short .webm or .wav in Macedonian first):
```bash
curl -X POST http://localhost:8000/stt/transcribe \
  -F "tenant_id=test-tenant-123" \
  -F "audio=@test_audio.webm"
```

Expected response:
```json
{
  "text": "направи фактура за ...",
  "language": "mk",
  "duration": 5.2
}
```

Do not proceed to Step 6 until this returns correct results.

---

### Step 6 — TypeScript: Implement sttTool

**File:** `apps/agent/src/tools/sttTool.ts` (replace the stub)

Receives audio buffer from Express, forwards to Python as multipart, returns transcribed text.

```typescript
import FormData from "form-data";
import { logger } from "@secretary/logger";

const PY_SERVICE_URL = process.env.PY_SERVICE_URL ?? "http://localhost:8000";
const STT_TIMEOUT_MS = 30_000;

export interface TranscribeResult {
  text: string;
  language: string;
  duration: number;
}

export async function transcribeAudio(
  tenantId: string,
  audioBuffer: Buffer,
  filename: string
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append("tenant_id", tenantId);
  form.append("audio", audioBuffer, { filename });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  try {
    const response = await fetch(`${PY_SERVICE_URL}/stt/transcribe`, {
      method: "POST",
      body: form as unknown as BodyInit,
      headers: form.getHeaders(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`STT service ${response.status}: ${detail}`);
    }

    return (await response.json()) as TranscribeResult;
  } finally {
    clearTimeout(timeout);
  }
}
```

---

### Step 7 — TypeScript: Express Route in server.ts

**File:** `apps/agent/src/server.ts`

Add `/agent/transcribe` after the existing auth routes. `tenantId` comes from the JWT via `requireAuth` + `getTenantForUser` — never from the request body.

Install multer if not present:
```bash
cd apps/agent
npm install multer @types/multer
```

Add to server.ts:
```typescript
import multer from "multer";
import { transcribeAudio } from "./tools/sttTool.js";

const upload = multer({ storage: multer.memoryStorage() });

app.post(
  "/agent/transcribe",
  requireAuth,
  upload.single("audio"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = await getTenantForUser(req.userAuthId!);
      const file = req.file;

      if (!file) {
        res.status(400).json({ error: "No audio file provided" });
        return;
      }

      const result = await transcribeAudio(
        tenantId,
        file.buffer,
        file.originalname || "recording.webm"
      );

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Transcription failed",
      });
    }
  }
);
```

---

### Step 8 — Frontend: useSTT Hook

**File:** `apps/web/src/hooks/useSTT.ts` (new file)

Handles mic access, recording via MediaRecorder, and posting to `/agent/transcribe`.
Uses the existing `axiosInstance` from `lib/axios.ts` — no ad-hoc axios instances.

```typescript
import { useState, useRef, useCallback } from "react";
import axiosInstance from "../lib/axios";

interface UseSTTReturn {
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  isRecording: boolean;
  isTranscribing: boolean;
  transcript: string | null;
  error: string | null;
}

export function useSTT(): UseSTTReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    setError(null);
    setTranscript(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("audio", blob, "recording.webm");

        setIsTranscribing(true);
        try {
          const response = await axiosInstance.post<{ text: string }>(
            "/agent/transcribe",
            formData
          );
          setTranscript(response.data.text);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Transcription failed");
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch {
      setError("Microphone access denied");
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      setIsRecording(false);
    }
  }, []);

  return { startRecording, stopRecording, isRecording, isTranscribing, transcript, error };
}
```

---

### Step 9 — Frontend: Mic Button in Dashboard.tsx

Wire the hook into the existing chat UI in `apps/web/src/pages/portal/Dashboard.tsx`.

The mic button sits beside the send button. On transcript arrival, populate the chat input and let the user review/edit before sending.

```tsx
import { useSTT } from "../../hooks/useSTT";
import { useEffect } from "react";

// Inside the component:
const { startRecording, stopRecording, isRecording, isTranscribing, transcript, error } = useSTT();

// Populate input when transcript arrives — user can edit before sending
useEffect(() => {
  if (transcript) {
    setInput(transcript); // setInput = existing state setter for chat input
  }
}, [transcript]);

// Button JSX — add next to the existing send button:
<button
  type="button"
  onClick={isRecording ? stopRecording : startRecording}
  disabled={isTranscribing}
  aria-label={isRecording ? "Stop recording" : "Start voice input"}
>
  {isTranscribing ? <Spinner /> : isRecording ? <MicOff /> : <Mic />}
</button>
```

Exact component structure depends on the current chat UI — adapt to match existing patterns.

---

## Environment Variables

Add to `apps/agent/.env`:
```
PY_SERVICE_URL=http://localhost:8000
```

No API keys needed — faster-whisper runs locally.

---

## Testing Checklist

- [ ] `pip install faster-whisper` succeeds in venv
- [ ] Python route returns correct Macedonian text from a curl test with a real audio file
- [ ] `GET /docs` shows the `/stt/transcribe` route in Swagger UI
- [ ] Agent `/agent/transcribe` route correctly forwards audio and returns transcript
- [ ] `tenantId` in agent route comes from JWT, verified by checking req.userAuthId
- [ ] Frontend records audio, sends it, receives transcript
- [ ] Mic button shows correct state: idle (Mic icon) / recording (MicOff icon) / transcribing (Spinner)
- [ ] Transcribed text populates chat input — user can edit before sending
- [ ] Temp files deleted after every transcription (check OS temp dir)
- [ ] Error states handled: mic permission denied, empty audio, Python service down
- [ ] No `console.log` left in committed code
