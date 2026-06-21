// Prompt injection detection — rejects messages that contain jailbreak patterns.
// Mirror of the Python-side _PROMPT_INJECTION_PATTERNS in services/ragagent.py.

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(the\s+)?(system|developer|safety)\s+instructions?/i,
  /reveal\s+(the\s+)?(system|developer)\s+prompt/i,
  /you\s+are\s+now\s+(an?|the)/i,
  /act\s+as\s+(an?|the)/i,
  /jailbreak|do\s+anything\s+now|\bdan\b/i,
  /tool\s*call|function\s*call/i,
  /<(system|assistant|developer)>|```(system|assistant|developer)/i,
];

export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}
