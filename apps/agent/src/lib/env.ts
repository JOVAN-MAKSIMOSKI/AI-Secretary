// Startup environment validation — fails the boot with one clear error if any
// required variable is missing or malformed, instead of throwing lazily the
// first time a feature (STT, OAuth) is used. Call validateAgentEnv() once,
// before the server starts listening.

import { z } from 'zod';

// Mirrors getEncryptionKey() in ./gmailOAuth.ts: a 32-byte key supplied either
// as 64 hex chars or as base64 that decodes to 32 bytes.
const encryptionKey = z
  .string()
  .min(1)
  .refine(
    (value) => /^[0-9a-fA-F]{64}$/.test(value) || Buffer.from(value, 'base64').length === 32,
    { message: 'must be a 32-byte base64 or 64-char hex key' },
  );

// INTER_SERVICE_SECRET gates agent→python internal calls (STT). Both services
// must share the identical value; the agent throws before the call and python
// rejects with 503/403 when it is missing or mismatched.
const agentEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    INTER_SERVICE_SECRET: z.string().min(16, { message: 'must be at least 16 characters' }),
    GMAIL_TOKEN_ENCRYPTION_KEY: encryptionKey,
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GMAIL_OAUTH_STATE_SECRET: z.string().min(1).optional(),
    GOOGLE_OAUTH_STATE_SECRET: z.string().min(1).optional(),
    PORT: z.coerce.number().int().positive().optional(),
    PY_SERVICE_URL: z.string().url().optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_PRIVATE_KEY_PEM: z.string().min(1).optional(),
    TWILIO_RECORDING_KEY_SID: z.string().startsWith('CR').optional(),
    ELEVENLABS_API_KEY: z.string().optional(),
    ELEVENLABS_VOICE_ID: z.string().optional(),
    ELEVENLABS_MODEL_ID: z.string().default('eleven_multilingual_v2'),
    AGENT_PUBLIC_URL: z.string().url().optional(),
  })
  .refine((env) => Boolean(env.GMAIL_OAUTH_STATE_SECRET || env.GOOGLE_OAUTH_STATE_SECRET), {
    message: 'GMAIL_OAUTH_STATE_SECRET (or GOOGLE_OAUTH_STATE_SECRET) is required',
    path: ['GMAIL_OAUTH_STATE_SECRET'],
  });

export type AgentEnv = z.infer<typeof agentEnvSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

export function validateAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  const result = agentEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Invalid agent environment configuration:\n${formatIssues(result.error)}\n` +
        `Set the missing variables in apps/agent/.env (INTER_SERVICE_SECRET must match apps/python/.env).`,
    );
  }
  return result.data;
}
