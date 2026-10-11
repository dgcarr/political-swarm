type Level = 'debug' | 'info' | 'warn' | 'error';

// MCP stdio servers must never write to stdout outside the protocol channel — logs go to stderr.
function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), level, msg, ...meta };
  process.stderr.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
};
