// ElevenLabs TTS — voice and dialect are configured entirely via env vars.
// To change voice/dialect: set ELEVENLABS_VOICE_ID to a different voice ID.
// Swap ELEVENLABS_MODEL_ID to change the model (default: eleven_multilingual_v2).

import { ElevenLabsClient } from 'elevenlabs';
import type { Readable } from 'stream';

const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

export async function generateSpeech(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    throw new Error('ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID must be set to use TTS.');
  }

  const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;
  const client = new ElevenLabsClient({ apiKey });

  const stream = await client.textToSpeech.convert(voiceId, {
    text,
    model_id: modelId,
    output_format: 'mp3_44100_128',
  });

  return readableToBuffer(stream as Readable);
}
