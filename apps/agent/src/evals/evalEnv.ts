import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';

// EVALAPIKEY is an evaluation-only credential. It is mapped onto OPENAI_API_KEY inside
// this process only, so the resolver stays configured by ordinary production env vars
// and the eval key never becomes the runtime credential for the running service.
const EVAL_KEY_VAR = 'EVALAPIKEY';
const AGENT_ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

// The eval pins its own routing model instead of inheriting ROUTER_LLM_MODEL from .env.
// That var is pinned to gpt-4o in production (matching what routing ran on under the
// retired GitHub Models tier), and dotenv would otherwise pull it in here and bill every
// eval run at ~10x. Override with EVAL_ROUTER_LLM_MODEL to measure a different model.
const EVAL_ROUTER_MODEL_VAR = 'EVAL_ROUTER_LLM_MODEL';
const DEFAULT_EVAL_ROUTER_MODEL = 'gpt-4o-mini';

// Non-eval credentials are cleared so a misconfigured run can never silently bill a
// provider other than the eval key. The retired GitHub Models vars stay listed: an old
// .env may still carry them, and deleting an absent var is a no-op.
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
  process.env.ROUTER_LLM_MODEL = evalRouterModel();

  return { ready: true };
}

export function evalRouterModel(): string {
  return (process.env[EVAL_ROUTER_MODEL_VAR] || '').trim() || DEFAULT_EVAL_ROUTER_MODEL;
}
