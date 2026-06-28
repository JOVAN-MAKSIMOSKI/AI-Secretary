# Azure TTS + RVC Voice Pipeline

> **Do not execute yet** — the user will run this after unrelated project bugs are fixed.

## Context

The Twilio voice agent currently speaks with a single fixed **ElevenLabs** voice
(`apps/agent/src/twilio/tts.ts`). The goal is a custom **female Bitola-dialect**
voice that is **derived from a real 30-minute recording** the user controls.

No cloud cloning service satisfies all three constraints at once (Macedonian
pronunciation + female output + "must be my own recording"). The solution is to
**decouple language from identity**:

- **Language** → Azure Cognitive Services native Macedonian neural voice
  (`mk-MK-MarijaNeural`, female) produces correct pronunciation/timing.
- **Identity** → a self-hosted **RVC v2** model, trained once on the 30-min file,
  re-skins the Azure audio into the target Bitola voice (timbre only).

The current call flow is **turn-based with a polling loop** (`<Record>` → download
→ Whisper STT → LLM → TTS → cache buffer → `<Play>`), **not** a live media stream.
This is important: we generate a **full utterance**, convert it, transcode to
`ulaw_8000`, and cache it — exactly like the existing ElevenLabs buffer. **No
streaming-RVC complexity is required.**

### Prerequisites (must be settled before implementation)

1. **Consent/rights on the 30-min voice file** — voice is biometric/personal data
   under GDPR and NMK law; self-hosting removes vendor verification, not legal
   liability. If it is the user's own voice or a consenting voice actor, proceed.
2. **One-time quality + latency spike** — confirm `mk-MK-MarijaNeural` → RVC →
   8 kHz µ-law sounds acceptable **over an actual phone call** (telephony
   band-limits to ~3.4 kHz, eroding much of RVC's texture advantage).

---

## Architecture decisions (confirmed with user)

- **Azure TTS + RVC both run inside `apps/python`** (the media/ML service — it
  already hosts Whisper and the torch stack, and never calls Claude). The agent
  sends only **text**; Python returns ready-to-play **`ulaw_8000` bytes** in one
  hop.
- **RVC runs in-process** as an import-time singleton, mirroring
  `apps/python/stt/whisper.py`. Realistically wants a **GPU host**; CPU works but
  is slow (~seconds/utterance).
- **ElevenLabs stays behind a feature flag.** `generateSpeech()` becomes a
  dispatcher driven by `VOICE_TTS_PROVIDER` (`elevenlabs` | `azure_rvc`), so the
  two voices can be A/B'd on real calls and rolled back instantly.

### Runtime pipeline (per turn)

```
LLM text ─▶ apps/agent generateSpeech()
            │  (VOICE_TTS_PROVIDER === 'azure_rvc')
            ▼  POST /tts/speak  { text }   (X-Service-Secret)
        apps/python
            │ 1. Azure TTS  → 24kHz 16-bit mono PCM WAV   (mk-MK-MarijaNeural)
            │ 2. RVC        → re-skin to Bitola target     (in-process singleton)
            │ 3. resample 8kHz + audioop.lin2ulaw → µ-law bytes
            ▼ return audio/basic (raw ulaw_8000)
        apps/agent  → audioCache.set(id, buffer) → <Play> /calls/audio/{id}
```

---

## Build-time (one-time, offline — not part of the service code)

1. Clean the 30-min recording (mono WAV, denoise, normalize, remove silence).
2. Train an **RVC v2** model (RVC-WebUI or `rvc-python` training) → produces a
   `.pth` weights file + a `.index` (faiss) retrieval file.
3. Place both where the Python service can load them (local path via env; optionally
   downloaded from Supabase Storage at startup later). Record the chosen
   `f0` method / `index_rate` settings used during the quality spike.

---

## Implementation

### apps/python (new code)

**`models/tts.py`** — request model (mirror `models/stt.py` style):
```python
class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    voice: str | None = None   # optional Azure voice override; defaults to env
```

**`tts/azure_tts.py`** — Azure call, returns 24kHz 16-bit mono PCM WAV bytes.
- Use `azure-cognitiveservices-speech` (`SpeechSynthesizer`,
  `Riff24Khz16BitMonoPcm` output, in-memory `PullAudioOutputStream`/result bytes).
- Voice from `AZURE_TTS_VOICE` (default `mk-MK-MarijaNeural`); key/region from env.
- **Lazy config validation**: raise a clear error only when invoked (do not add
  Azure keys to the `main.py` boot guard — keep non-voice deploys booting).

**`tts/rvc.py`** — RVC singleton + `convert(wav_bytes) -> wav_bytes`.
- Mirror `stt/whisper.py`: load `.pth` + `.index` once at import, with a `_warmup()`
  best-effort pass so the first caller doesn't pay init cost.
- Config via env: `RVC_MODEL_PATH`, `RVC_INDEX_PATH`, `RVC_DEVICE` (`cuda`/`cpu`),
  `RVC_INDEX_RATE`, `RVC_F0_METHOD`, `RVC_F0_UP_KEY`.
- Prefer the `rvc-python` package for a programmatic inference API (MIT). If its API
  proves unstable, fall back to vendoring the inference path from RVC-WebUI.

**`services/audio/pipeline.py`** — orchestration + transcode:
- `synthesize_ulaw(text, voice) -> bytes`: Azure WAV → `rvc.convert` → resample to
  8 kHz mono 16-bit (`numpy`/`soundfile` or `librosa`) → `audioop.lin2ulaw(pcm, 2)`
  → raw µ-law bytes. (`audioop` is stdlib in 3.11.)
- Name all constants (`TARGET_SAMPLE_RATE_HZ = 8000`, etc.) per conventions.

**`routers/tts.py`** — `POST /tts/speak`, mirror `routers/stt.py`:
- `Depends(verify_service_secret)` (agent-only, `services/auth.py`).
- `@limiter.limit(...)`, structured logging of per-stage wall-ms (Azure / RVC /
  transcode) and total — matches the STT logging style for latency tuning.
- Return `fastapi.Response(content=ulaw, media_type="audio/basic")`.

**`main.py`** — register the router next to the others:
```python
from routers.tts import router as tts_router
app.include_router(tts_router)
```

**`requirements.txt`** — add: `azure-cognitiveservices-speech`, `rvc-python`,
`soundfile`, and `librosa` if not already pulled in (torch/numpy already present).

### apps/agent (modify one file)

**`src/twilio/tts.ts`** — turn `generateSpeech()` into a dispatcher; keep the
existing ElevenLabs body as `elevenLabsSpeech()`:
```typescript
export async function generateSpeech(text: string): Promise<Buffer> {
  const provider = process.env.VOICE_TTS_PROVIDER || 'elevenlabs';
  return provider === 'azure_rvc' ? azureRvcSpeech(text) : elevenLabsSpeech(text);
}
```
- `azureRvcSpeech(text)`: `POST ${PY_SERVICE_URL}/tts/speak` with headers
  `X-Service-Secret: INTER_SERVICE_SECRET` and JSON `{ text }`; read the binary
  body into a `Buffer` (`Buffer.from(await res.arrayBuffer())`). Reuse the same
  `PY_SERVICE_URL` / secret pattern already in `callHandler.ts`.
- No changes needed to `callHandler.ts` or `serveAudio()` — both already treat the
  result as an opaque `ulaw_8000` buffer.

**`src/lib/env.ts`** — when `VOICE_TTS_PROVIDER === 'azure_rvc'`, require
`PY_SERVICE_URL` + `INTER_SERVICE_SECRET` (and not the ElevenLabs vars). Keep
ElevenLabs vars required only when that provider is selected.

### Environment variables (new)

`apps/python/.env`:
``
AZURE_TTS_KEY=
AZURE_TTS_REGION=
AZURE_TTS_VOICE=mk-MK-MarijaNeural
RVC_MODEL_PATH=./models/bitola.pth
RVC_INDEX_PATH=./models/bitola.index
RVC_DEVICE=cuda
RVC_INDEX_RATE=0.75
RVC_F0_METHOD=rmvpe
RVC_F0_UP_KEY=0
```
`apps/agent/.env`:
```
VOICE_TTS_PROVIDER=azure_rvc   # or elevenlabs to roll back
```

---

## Verification (end-to-end)

1. **Build-time sanity**: run `tts/rvc.py` warmup standalone; confirm `.pth`/`.index`
   load without error on the target device.
2. **Unit / curl**: with the Python service running and `RVC_DEVICE` set, call
   `POST /tts/speak` with `X-Service-Secret` and a Macedonian sentence; save the
   returned µ-law bytes, wrap as 8 kHz WAV, and listen. Confirm it is the **target
   voice speaking intelligible Macedonian**.
3. **Latency**: read the per-stage log line (Azure / RVC / transcode / total).
   Target total ≪ the existing polling cadence (`POLL_PAUSE_SECONDS = 1`). Record
   GPU vs CPU numbers.
4. **Phone test**: set `VOICE_TTS_PROVIDER=azure_rvc`, place a real Twilio call,
   confirm the greeting + a reply play in the Bitola voice and remain intelligible
   **over the phone codec**.
5. **Rollback test**: set `VOICE_TTS_PROVIDER=elevenlabs`, confirm the original
   path still works unchanged.

## Out of scope / explicitly deferred

- Live WebSocket media streaming (current flow is turn-based; not needed).
- Per-tenant voices (single global Bitola voice for now).
- Loading RVC models from Supabase Storage at startup (local path for v1).
- The build-time RVC training itself is a manual, offline step, not service code.

## Risks

- **RVC swaps timbre, not accent** — Bitola cadence comes from Azure (standard
  Macedonian); the "phonetic spelling" trick is unreliable. Validate in the spike.
- **GPU/concurrency** — in-process RVC ties GPU to the Python service; size for
  peak concurrent calls, not total volume.
- **`rvc-python` is community software** — API stability/maintenance varies; the
  fallback is vendoring RVC-WebUI's inference path.
