/**
 * flowControl — 조합 미들웨어 팩토리
 * 체인 순서 (v2 shaping):
 *   TokenBucket.consumeAsync(rateWaitTimeout)
 *     → RateQueueFullError (503)
 *     → RateTimeoutError (429)
 *   ConcurrencyLimiter.acquire() → 타임아웃이면 503
 *   next() 실행
 *   ConcurrencyLimiter.release()
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConcurrencyLimiter, type ConcurrencyMetrics } from '../core/ConcurrencyLimiter.js';
import { TokenBucket, type TokenBucketMetrics } from '../core/TokenBucket.js';
import { QueueFullError } from '../core/Queue.js';
import { RateTimeoutError, RateQueueFullError } from '../core/errors.js';
import { writeSecureHead } from '../server/responseHelpers.js';

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void | Promise<void>
) => void | Promise<void>;

export interface FlowControlOptions {
  concurrency: { max: number };
  tokenBucket: { capacity: number; refillRate: number };
  queue?: { maxSize: number }; // 기본값: concurrency.max * 10 (최소 100)
  queueTimeout?: number; // ms, 기본 30000
  rateWaitTimeout?: number; // Rate 대기 타임아웃 ms, 기본 5000 (v2 신규)
  rateQueueMaxSize?: number; // Rate 큐 최대 크기, 기본 concurrency.max * 10 (v2 신규)
}

export interface RateMetrics {
  pending: number;
  pendingCapacity: number;
  avgRateWaitMs: number;
  totalRateTimeouts: number;
}

export interface DashboardMetrics {
  concurrency: ConcurrencyMetrics;
  tokenBucket: TokenBucketMetrics;
  rate: RateMetrics; // v2 신규
  queue: { size: number; capacity: number; oldestWaitMs: number };
  totals: {
    processed: number; // 완료 (200)
    rejected: number; // 실패 (429 + 503)
    rateTimeout: number; // 429 세부
    rateQueueFull: number; // 503 세부
    queueFull: number; // 503 세부
    queueTimeout: number; // 503 세부
  };
  timestamp: number;
}

export function createFlowControl(options: FlowControlOptions): {
  middleware: RequestHandler;
  getMetrics(): DashboardMetrics;
  destroy(): void;
  resetCounters(): void;
} {
  const rateQueueMaxSize =
    options.rateQueueMaxSize ?? Math.max(100, options.concurrency.max * 10);
  const rateWaitTimeout = options.rateWaitTimeout ?? 5_000;

  const limiter = new ConcurrencyLimiter(options.concurrency.max, options.queue?.maxSize);
  const bucket = new TokenBucket(
    options.tokenBucket.capacity,
    options.tokenBucket.refillRate,
    rateQueueMaxSize
  );
  const timeoutMs = options.queueTimeout ?? 30_000;

  // 미들웨어 레벨 실패 카운터 (TokenBucket.totalRateTimeouts 외에 503 도 집계)
  let _rateQueueFull = 0;
  let _queueFull = 0;
  let _queueTimeout = 0;

  const middleware: RequestHandler = async (req, res, next) => {
    // 1. 토큰 버킷 — shaping (대기 후 처리, 타임아웃 시 429, 큐 가득 시 503)
    try {
      await bucket.consumeAsync(rateWaitTimeout);
    } catch (err) {
      if (err instanceof RateQueueFullError) {
        _rateQueueFull += 1;
        writeSecureHead(res, 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Service Unavailable (rate queue full)',
            statusCode: 503,
          })
        );
        return;
      }
      if (err instanceof RateTimeoutError) {
        // (totalRateTimeouts는 TokenBucket 내부에서 증가)
        writeSecureHead(res, 429, {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil(rateWaitTimeout / 1000)),
        });
        res.end(
          JSON.stringify({
            error: 'Too Many Requests (rate timeout)',
            statusCode: 429,
            pendingMs: err.pendingMs,
          })
        );
        return;
      }
      throw err; // 예상 외 에러는 상위로
    }

    // 2. 동시성 슬롯 획득 (큐 대기 포함)
    let acquired = false;
    try {
      await limiter.acquire(timeoutMs);
      acquired = true;
    } catch (err) {
      const isQueueFull = err instanceof QueueFullError;
      if (isQueueFull) _queueFull += 1;
      else _queueTimeout += 1;
      const message = isQueueFull
        ? 'Service Unavailable (queue full)'
        : 'Service Unavailable (queue timeout)';
      writeSecureHead(res, 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message, statusCode: 503 }));
      return;
    }

    // 3. 실제 핸들러 실행
    try {
      await next();
    } finally {
      // 4. 슬롯 반납
      if (acquired) {
        limiter.release();
      }
    }
  };

  const getMetrics = (): DashboardMetrics => {
    const concMetrics = limiter.getMetrics();
    const oldestEnqueuedAt = limiter.oldestEnqueuedAt();
    const oldestWaitMs =
      oldestEnqueuedAt !== undefined ? Math.max(0, Date.now() - oldestEnqueuedAt) : 0;
    const bucketMetrics = bucket.getMetrics();
    const rateTimeout = bucketMetrics.totalRateTimeouts;
    const rejected = rateTimeout + _rateQueueFull + _queueFull + _queueTimeout;
    return {
      concurrency: concMetrics,
      tokenBucket: bucketMetrics,
      rate: {
        pending: bucketMetrics.pending,
        pendingCapacity: bucketMetrics.pendingCapacity,
        avgRateWaitMs: bucketMetrics.avgRateWaitMs,
        totalRateTimeouts: rateTimeout,
      },
      queue: {
        size: concMetrics.queueSize,
        capacity: limiter.queueCapacity,
        oldestWaitMs,
      },
      totals: {
        processed: concMetrics.totalProcessed,
        rejected,
        rateTimeout,
        rateQueueFull: _rateQueueFull,
        queueFull: _queueFull,
        queueTimeout: _queueTimeout,
      },
      timestamp: Date.now(),
    };
  };

  const destroy = (): void => {
    bucket.destroy();
  };

  const resetCounters = (): void => {
    bucket.resetCounters();
    limiter.resetCounters();
    _rateQueueFull = 0;
    _queueFull = 0;
    _queueTimeout = 0;
  };

  return { middleware, getMetrics, destroy, resetCounters };
}
