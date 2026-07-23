// TTS dispatcher — routes to ElevenLabs or the Azure+RVC pipeline based on
// VOICE_TTS_PROVIDER. Default is 'elevenlabs' so existing deployments are unaffected.
// Switch providers by setting VOICE_TTS_PROVIDER=azure_rvc in apps/agent/.env.

import { ElevenLabsClient } from 'elevenlabs';
import type { Readable } from 'stream';

// Flash v2.5 is ElevenLabs' low-latency model (~75ms generation latency) and is
// multilingual (incl. Macedonian) — markedly faster than eleven_multilingual_v2 for
// telephony. Override with ELEVENLABS_MODEL_ID if higher voice fidelity is needed.
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';

const PY_SERVICE_URL = process.env.PY_SERVICE_URL ?? 'http://127.0.0.1:8000';

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

async function elevenLabsSpeech(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    throw new Error('ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID must be set to use TTS.');
  }

  const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;
  const client = new ElevenLabsClient({ apiKey });

  // ulaw_8000 is Twilio's native telephony format: no transcoding on Twilio's side
  // and ~half the bytes of mp3_44100_128, which lowers <Play> fetch+playback latency.
  const stream = await client.textToSpeech.convert(voiceId, {
    text,
    model_id: modelId,
    output_format: 'ulaw_8000',
  });

  return readableToBuffer(stream as Readable);
}

async function azureRvcSpeech(text: string): Promise<Buffer> {
  const secret = process.env.INTER_SERVICE_SECRET;
  if (!secret) {
    throw new Error('INTER_SERVICE_SECRET must be set to use the azure_rvc TTS provider.');
  }

  const response = await fetch(`${PY_SERVICE_URL}/tts/speak`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Secret': secret,
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Azure RVC TTS request failed (${response.status}): ${detail}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function generateSpeech(text: string): Promise<Buffer> {
  const provider = process.env.VOICE_TTS_PROVIDER ?? 'elevenlabs';
  return provider === 'azure_rvc' ? azureRvcSpeech(text) : elevenLabsSpeech(text);
}
