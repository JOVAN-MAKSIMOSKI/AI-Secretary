import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';

// EVALAPIKEY is an evaluation-only credential. It is mapped onto OPENAI_API_KEY inside
// this process only, so the resolver stays configured by ordinary production env vars
// and the eval key never becomes the runtime credential for the running service.
const EVAL_KEY_VAR = 'EVALAPIKEY';
const AGENT_ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

// Free-tier tokens are cleared so a misconfigured run can never silently spend the
// GitHub Models daily quota instead of using the paid eval key.
const NON_EVAL_CREDENTIAL_VARS = [
  'GITHUB_MODELS_TOKEN',
  'ROUTER_GITHUB_MODELS_TOKEN',
  'RAG_GITHUB_MODELS_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

export interface EvalEnvStatus {
  ready: boolean;
  reason?: string;
}

export function configureEvalEnv(): EvalEnvStatus {
  // dotenv does not override already-set variables, so CI secrets win over the local file.
  loadDotenv({ path: AGENT_ENV_FILE });

  const evalKey = (process.env[EVAL_KEY_VAR] || process.env.OPENAI_API_KEY || '').trim();
  if (evalKey === '') {
    return {
      ready: false,
      reason: `No ${EVAL_KEY_VAR} (or OPENAI_API_KEY) in env — live routing eval skipped, offline gate still enforced.`,
    };
  }

  for (const key of NON_EVAL_CREDENTIAL_VARS) {
    delete process.env[key];
  }

  process.env.OPENAI_API_KEY = evalKey;
  process.env.ROUTER_LLM_PROVIDER = 'openai';
  process.env.ROUTER_ALLOW_KEYWORD_FALLBACK = 'false';

  return { ready: true };
}

export function evalRouterModel(): string {
  return (process.env.ROUTER_LLM_MODEL || '').trim() || 'gpt-4o-mini (resolver default)';
}
