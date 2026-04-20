/**
 * errors.ts — flow-control-practice 도메인 에러 타입
 * 모든 typed 에러는 이 파일에서 관리한다.
 */

/** Rate pending 큐에서 타임아웃. statusCode=429 (Too Many Requests). */
export class RateTimeoutError extends Error {
  readonly statusCode = 429 as const;
  readonly pendingMs: number;

  constructor(pendingMs: number) {
    super(`Rate timeout after ${pendingMs}ms`);
    this.name = 'RateTimeoutError';
    this.pendingMs = pendingMs;
  }
}

/** Rate pending 큐가 rateQueueMaxSize에 도달. statusCode=503. */
export class RateQueueFullError extends Error {
  readonly statusCode = 503 as const;
  readonly pendingCapacity: number;

  constructor(message: string, opts: { pendingCapacity: number }) {
    super(message);
    this.name = 'RateQueueFullError';
    this.pendingCapacity = opts.pendingCapacity;
  }
}
