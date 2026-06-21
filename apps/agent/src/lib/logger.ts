// Structured logger — wraps console with level tagging and JSON context

type LogData = Record<string, unknown>;

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
      JSON.stringify(data),
    );
  }
}

export const logger = {
  info: (data: LogData | string, msg?: string) => formatEntry('info', data, msg),
  warn: (data: LogData | string, msg?: string) => formatEntry('warn', data, msg),
  error: (data: LogData | string, msg?: string) => formatEntry('error', data, msg),
};
