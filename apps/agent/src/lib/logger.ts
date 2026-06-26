// Structured logger — wraps console with level tagging and JSON context

type LogData = Record<string, unknown>;

// Error message/name/stack are non-enumerable, so a plain JSON.stringify of
// { err: someError } yields "{}" and hides the actual failure. This replacer
// extracts them (anywhere in the data, including nested) so errors are readable.
function errorAwareReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function formatEntry(level: string, data: LogData | string, msg?: string): void {
  const timestamp = new Date().toISOString();
  if (typeof data === 'string') {
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      `[${timestamp}] [${level.toUpperCase()}] ${data}`,
    );
  } else {
    const message = msg ?? '';
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      `[${timestamp}] [${level.toUpperCase()}] ${message}`,
      JSON.stringify(data, errorAwareReplacer),
    );
  }
}

export const logger = {
  info: (data: LogData | string, msg?: string) => formatEntry('info', data, msg),
  warn: (data: LogData | string, msg?: string) => formatEntry('warn', data, msg),
  error: (data: LogData | string, msg?: string) => formatEntry('error', data, msg),
};
