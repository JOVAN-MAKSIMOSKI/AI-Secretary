const PY_SERVICE_URL = process.env.PY_SERVICE_URL ?? "http://localhost:8000";
const STT_TIMEOUT_MS = 30_000;

export interface TranscribeResult {
  text: string;
  language: string;
  duration: number;
}

export async function transcribeAudio(
  _tenantId: string,
  audioBuffer: Buffer,
  _filename: string
): Promise<TranscribeResult> {
  const serviceSecret = process.env.INTER_SERVICE_SECRET ?? "";
  if (!serviceSecret) {
    throw new Error("INTER_SERVICE_SECRET is not configured.");
  }

  const form = new FormData();
  // Intentionally do NOT send tenant_id or filename to Python — the service
  // authenticates via service secret and derives a safe suffix internally.
  form.append("audio", new Blob([audioBuffer]), "recording.webm");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  try {
    const response = await fetch(`${PY_SERVICE_URL}/stt/transcribe`, {
      method: "POST",
      headers: { "X-Service-Secret": serviceSecret },
      body: form,
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
