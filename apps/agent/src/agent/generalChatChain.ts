// General conversation chain — the catch-all behind `general_chat`.
// Channel-agnostic on purpose: the dashboard (directResolverChain) and the phone
// path (twilio/callHandler) both call runGeneralChat, so the two can never drift
// the way the voice-only generateConversationalReply had begun to. Only the
// presentation differs, and that is expressed as a `channel` argument here rather
// than as a second copy of the request logic.
//
// Provider note: this is the one user-facing prose call in apps/agent that is not
// Claude. The hosted web_search tool lives on OpenAI's Responses API and has no
// GitHub Models equivalent, and only an OpenAI credential is available — see
// .claude/rules/agent-service.md ("General chat provider exception").

import { detectPromptInjection } from '../lib/promptSanitizer.js';
import { logger } from '../lib/logger.js';

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses';

// gpt-5-nano is the cheapest model that actually supports the hosted web_search
// tool — verified by probe, gpt-4.1-nano rejects the tool outright. Being a
// gpt-5 reasoning model it also bills searches at the $10/1k tier rather than
// the $25/1k non-reasoning tier, so it is the cheaper choice on both axes.
const DEFAULT_GENERAL_CHAT_MODEL = 'gpt-5-nano';

// Search calls dominate the cost of this feature: one search runs $0.01–0.025,
// against roughly $0.0003 for an entire chat turn. This caps how far a single
// ambiguous question can fan out.
const MAX_WEB_SEARCHES_PER_TURN = 2;

// max_output_tokens on a reasoning model covers reasoning tokens *and* the
// visible answer. A voice-sized cap of ~150 would be swallowed whole by
// reasoning and return empty text, so the budget stays generous and brevity is
// enforced through the system prompt instead. Keep it that way.
const MAX_OUTPUT_TOKENS_WEB = 2_000;
const MAX_OUTPUT_TOKENS_VOICE = 800;

// Cheapest reasoning setting; this chain answers small talk and looks things up,
// neither of which benefits from deeper deliberation.
const REASONING_EFFORT = 'low';

const REQUEST_TIMEOUT_MS = 60_000;

// History is untrusted at the transport edge and re-capped here so a direct
// caller cannot bypass the route-level limit.
const MAX_HISTORY_MESSAGES = 20;

export type GeneralChatChannel = 'web' | 'voice';

export interface GeneralChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GeneralChatResult {
  answer: string;
  // Surfaced so callers can log/meter search spend without re-parsing the payload.
  searched: boolean;
}

const SHARED_PROMPT =
  'LANGUAGE RULE, ABOVE ALL ELSE: reply in the same language the user wrote their ' +
  'latest message in. English message means an English reply; Macedonian message ' +
  'means a Macedonian reply. The business context below is Macedonian, but that ' +
  'never overrides the language the user actually chose. ' +
  'You are the general-conversation assistant inside an AI secretary used by ' +
  'waste-management businesses in North Macedonia. You handle greetings, small ' +
  'talk, general knowledge, and open-ended questions, including ones that need ' +
  'you to look something up on the web. ' +
  'Use the web_search tool only when the answer depends on current or external ' +
  'information you do not already know; answer directly otherwise. ' +
  "You do not have access to this business's own records. If the user asks about " +
  'their stored firms, tasks, calendar, invoices, or waste forms, reply with one ' +
  'short sentence telling them to ask for it directly (for example "what tasks do ' +
  'I have left") so the request reaches the right part of the system. Do not ' +
  'invent such data, and do not offer generic advice about how to track it ' +
  'elsewhere — one sentence, then stop.';

const WEB_PROMPT =
  `${SHARED_PROMPT} ` +
  'You are writing into a chat panel. Markdown is fine. Keep answers tight — a ' +
  'few sentences for simple questions, and short paragraphs or a brief list only ' +
  'when the question genuinely needs them. When you used a search, mention the ' +
  'source inline.';

const VOICE_PROMPT =
  `${SHARED_PROMPT} ` +
  'Your reply will be read aloud over a phone call by a text-to-speech voice. ' +
  'Answer in 1-2 short sentences. Write plain spoken prose only: no markdown, no ' +
  'lists, no bullet points, no URLs, no special characters, no emoji. Never read ' +
  'out a link — summarise what it said instead. Be concise and natural.';

// Narrow view of the Responses API payload — only the fields this chain reads.
interface ResponsesApiOutputContent {
  type?: string;
  text?: string;
}

interface ResponsesApiOutputItem {
  type?: string;
  content?: ResponsesApiOutputContent[];
}

interface ResponsesApiPayload {
  output?: ResponsesApiOutputItem[];
  // Convenience field the API also returns; used as a fallback when the output
  // array shape changes underneath us.
  output_text?: string;
  error?: { message?: string };
}

export class GeneralChatUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneralChatUnavailableError';
  }
}

function getApiKey(): string {
  // Deliberately its own variable rather than OPENAI_API_KEY: the resolver's auto
  // mode prefers OPENAI_API_KEY over the free GitHub Models tier, so reusing that
  // name here would silently move every routing call onto paid billing.
  return (process.env.GENERAL_CHAT_API_KEY || '').trim();
}

function getModel(): string {
  return (process.env.GENERAL_CHAT_MODEL || '').trim() || DEFAULT_GENERAL_CHAT_MODEL;
}

function systemPromptFor(channel: GeneralChatChannel): string {
  const today = new Date().toISOString().slice(0, 10);
  const base = channel === 'voice' ? VOICE_PROMPT : WEB_PROMPT;
  return `${base}\nToday's date is ${today}.`;
}

// Pulls the assistant text out of the output array. A reasoning model returns
// interleaved reasoning/web_search_call/message items, so the message items are
// selected explicitly rather than by position.
function extractAnswer(payload: ResponsesApiPayload): string {
  const fromOutput = (payload.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((block) => block.type === 'output_text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();

  return fromOutput || (payload.output_text ?? '').trim();
}

function didSearch(payload: ResponsesApiPayload): boolean {
  return (payload.output ?? []).some((item) => (item.type ?? '').includes('web_search'));
}

// Strips anything a text-to-speech voice would read out as gibberish. The voice
// system prompt already forbids markdown and links, but after a web search the
// model reliably appends "([domain](url))" citations anyway — a probe caught it
// reading a full tracking URL down the phone. Prompt wording cannot be trusted
// for this, so the guarantee is made deterministically here instead.
export function sanitizeForSpeech(text: string): string {
  return (
    text
      // Whole parenthesised citation groups: "([oilmarketcap.com](https://...))"
      .replace(/\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, '')
      // Remaining inline links keep their label, drop the target.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^\s*[-*+•]\s+/gm, '')
      .replace(/^\s*#{1,6}\s+/gm, '')
      .replace(/[*_`#>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export async function runGeneralChat(input: {
  message: string;
  history?: GeneralChatMessage[];
  channel: GeneralChatChannel;
}): Promise<GeneralChatResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new GeneralChatUnavailableError('GENERAL_CHAT_API_KEY is not configured.');
  }

  // The chain has no tools that touch tenant data, but its output is shown to the
  // user verbatim, so the same injection gate the RAG path uses applies here.
  if (detectPromptInjection(input.message)) {
    throw new GeneralChatUnavailableError('Message rejected by the prompt-injection filter.');
  }

  const history = (input.history ?? []).slice(-MAX_HISTORY_MESSAGES);
  const conversation = [
    ...history.map((entry) => ({ role: entry.role, content: entry.content })),
    { role: 'user' as const, content: input.message },
  ];

  const response = await fetch(RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getModel(),
      instructions: systemPromptFor(input.channel),
      input: conversation,
      tools: [{ type: 'web_search' }],
      // auto, not required: small talk must not pay for a search it does not need.
      tool_choice: 'auto',
      max_tool_calls: MAX_WEB_SEARCHES_PER_TURN,
      reasoning: { effort: REASONING_EFFORT },
      max_output_tokens:
        input.channel === 'voice' ? MAX_OUTPUT_TOKENS_VOICE : MAX_OUTPUT_TOKENS_WEB,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payload = (await response.json().catch(() => ({}))) as ResponsesApiPayload;

  if (!response.ok) {
    const detail = payload.error?.message || `General chat request failed (${response.status}).`;
    throw new GeneralChatUnavailableError(detail);
  }

  const rawAnswer = extractAnswer(payload);
  const answer = input.channel === 'voice' ? sanitizeForSpeech(rawAnswer) : rawAnswer;
  const searched = didSearch(payload);

  if (!answer) {
    // Reaching the token ceiling during reasoning is the realistic cause, and it
    // returns HTTP 200 with no message item — so it must be caught here or the
    // caller ships an empty bubble.
    throw new GeneralChatUnavailableError('General chat returned an empty response.');
  }

  logger.info({ channel: input.channel, searched, model: getModel() }, 'general chat answered');

  return { answer, searched };
}
