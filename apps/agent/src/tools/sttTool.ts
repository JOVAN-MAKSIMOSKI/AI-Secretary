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
  form.append("audio", new Blob([audioBuffer]), filename);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  try {
    const response = await fetch(`${PY_SERVICE_URL}/stt/transcribe`, {
      method: "POST",
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
