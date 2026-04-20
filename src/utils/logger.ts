/**
 * logger — 최소한의 구조화 로거
 * console.log 대신 이 모듈을 사용한다.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function formatMessage(level: LogLevel, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const metaStr = meta !== undefined ? ` ${JSON.stringify(meta)}` : '';
  return `[${ts}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

export const logger = {
  debug(message: string, meta?: unknown): void {
    if (process.env['LOG_LEVEL'] === 'debug') {
      process.stdout.write(formatMessage('debug', message, meta) + '\n');
    }
  },
  info(message: string, meta?: unknown): void {
    process.stdout.write(formatMessage('info', message, meta) + '\n');
  },
  warn(message: string, meta?: unknown): void {
    process.stderr.write(formatMessage('warn', message, meta) + '\n');
  },
  error(message: string, meta?: unknown): void {
    process.stderr.write(formatMessage('error', message, meta) + '\n');
  },
};
