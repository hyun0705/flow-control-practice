/**
 * TokenBucket — 토큰 버킷 알고리즘
 * refillRate(개/초)로 토큰을 보충하고, consume()으로 소비한다.
 * capacity를 초과하지 않도록 상한을 둔다.
 *
 * v2: consumeAsync(timeoutMs) 추가 — shaping 지원.
 * 토큰이 없으면 pending FIFO 큐에서 refill tick까지 대기.
 */

import { RateTimeoutError, RateQueueFullError } from './errors.js';

export interface TokenBucketMetrics {
  capacity: number;
  available: number;
  refillRate: number;
  totalConsumed: number;
  totalRejected: number;
  // v2 shaping 메트릭
  pending: number;
  pendingCapacity: number;
  avgRateWaitMs: number;
  totalRateTimeouts: number;
}

export interface ITokenBucket {
  readonly capacity: number;
  readonly refillRate: number; // tokens/sec
  available(): number;
  consume(tokens?: number): boolean; // false = 거부
  consumeAsync(timeoutMs: number): Promise<void>;
  readonly pendingCount: number;
  getMetrics(): TokenBucketMetrics;
  destroy(): void; // interval 정리
}

type PendingItem = {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timeoutMs: number;
  timeoutId: ReturnType<typeof setTimeout>;
};

const RATE_WAIT_SAMPLE_SIZE = 20;

export class TokenBucket implements ITokenBucket {
  readonly capacity: number;
  readonly refillRate: number;
  private _tokens: number;
  private _totalConsumed: number = 0;
  private _totalRejected: number = 0;
  private readonly _intervalId: ReturnType<typeof setInterval>;
  private _lastRefillTime: number;

  // v2: pending 큐
  private readonly _pending: PendingItem[] = [];
  private readonly _rateQueueMaxSize: number;
  private _totalRateTimeouts: number = 0;
  private readonly _rateWaitSamples: number[] = [];

  constructor(capacity: number, refillRate: number, rateQueueMaxSize: number = Infinity) {
    if (capacity < 1) {
      throw new Error(`capacity must be >= 1, got ${capacity}`);
    }
    if (refillRate <= 0) {
      throw new Error(`refillRate must be > 0, got ${refillRate}`);
    }
    this.capacity = capacity;
    this.refillRate = refillRate;
    this._tokens = capacity; // 초기 상태: 가득 참
    this._lastRefillTime = Date.now();
    this._rateQueueMaxSize = rateQueueMaxSize;

    // 100ms마다 토큰 보충 + pending 큐 dequeue
    this._intervalId = setInterval(() => {
      this._refillAndDequeue();
    }, 100);
    // Node.js가 interval 때문에 종료되지 않도록 unref
    if (typeof this._intervalId === 'object' && 'unref' in this._intervalId) {
      (this._intervalId as ReturnType<typeof setInterval> & { unref(): void }).unref();
    }
  }

  private _refillAndDequeue(): void {
    const now = Date.now();
    const elapsedSec = (now - this._lastRefillTime) / 1000;
    const toAdd = elapsedSec * this.refillRate;
    this._tokens = Math.min(this.capacity, this._tokens + toAdd);
    this._lastRefillTime = now;

    // pending FIFO dequeue loop
    while (this._tokens >= 1 && this._pending.length > 0) {
      const item = this._pending[0];
      if (item === undefined) break;

      // 이중 타임아웃 체크 (setTimeout이 약간 늦게 fire하는 edge case 방어)
      if (Date.now() - item.enqueuedAt >= item.timeoutMs) {
        this._pending.shift();
        this._totalRateTimeouts += 1;
        item.reject(new RateTimeoutError(Date.now() - item.enqueuedAt));
        continue;
      }

      this._pending.shift();
      clearTimeout(item.timeoutId);
      this._tokens -= 1;
      this._totalConsumed += 1;

      // avgRateWaitMs 슬라이딩 윈도우 (성공 대기만)
      const waitMs = Date.now() - item.enqueuedAt;
      this._rateWaitSamples.push(waitMs);
      if (this._rateWaitSamples.length > RATE_WAIT_SAMPLE_SIZE) {
        this._rateWaitSamples.shift();
      }

      item.resolve();
    }
  }

  private _refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this._lastRefillTime) / 1000;
    const toAdd = elapsedSec * this.refillRate;
    this._tokens = Math.min(this.capacity, this._tokens + toAdd);
    this._lastRefillTime = now;
  }

  available(): number {
    this._refill();
    return Math.floor(this._tokens);
  }

  /**
   * @deprecated shaping 전환 후에는 consumeAsync를 사용하라.
   * flowControl.ts 체인에서는 더 이상 호출하지 않는다.
   * 단위 테스트 호환성 및 직접 policing 용도로만 남긴다.
   */
  consume(tokens: number = 1): boolean {
    this._refill();
    if (this._tokens >= tokens) {
      this._tokens -= tokens;
      this._totalConsumed += tokens;
      return true;
    }
    this._totalRejected += 1;
    return false;
  }

  /**
   * 토큰 1개를 비동기로 소비한다.
   * - 가용 토큰이 있으면 즉시 resolve.
   * - 없으면 pending FIFO 큐에 등록 후 refill tick 때 resolve.
   * - timeoutMs 내에 토큰을 받지 못하면 RateTimeoutError로 reject (429).
   * - pending.length >= rateQueueMaxSize면 즉시 RateQueueFullError로 reject (503).
   */
  consumeAsync(timeoutMs: number): Promise<void> {
    this._refill();

    // 즉시 소비 가능하면 바로 resolve
    if (this._tokens >= 1) {
      this._tokens -= 1;
      this._totalConsumed += 1;
      return Promise.resolve();
    }

    // 큐 용량 초과 체크
    if (this._pending.length >= this._rateQueueMaxSize) {
      return Promise.reject(
        new RateQueueFullError(
          `Rate pending queue full (${this._rateQueueMaxSize})`,
          { pendingCapacity: this._rateQueueMaxSize }
        )
      );
    }

    // pending 큐에 등록
    return new Promise<void>((resolve, reject) => {
      const enqueuedAt = Date.now();

      // 미리 placeholder를 만들어야 timeoutId를 item에 저장 가능
      const item: PendingItem = {
        resolve,
        reject,
        enqueuedAt,
        timeoutMs,
        timeoutId: undefined as unknown as ReturnType<typeof setTimeout>,
      };

      const timeoutId = setTimeout(() => {
        // pending 배열에서 해당 항목 제거
        const idx = this._pending.indexOf(item);
        if (idx !== -1) {
          this._pending.splice(idx, 1);
          this._totalRateTimeouts += 1;
          reject(new RateTimeoutError(Date.now() - enqueuedAt));
        }
      }, timeoutMs);

      item.timeoutId = timeoutId;
      this._pending.push(item);
    });
  }

  get pendingCount(): number {
    return this._pending.length;
  }

  getMetrics(): TokenBucketMetrics {
    this._refill();
    const avgRateWaitMs =
      this._rateWaitSamples.length > 0
        ? Math.round(
            this._rateWaitSamples.reduce((a, b) => a + b, 0) /
              this._rateWaitSamples.length
          )
        : 0;

    return {
      capacity: this.capacity,
      available: Math.floor(this._tokens),
      refillRate: this.refillRate,
      totalConsumed: this._totalConsumed,
      totalRejected: this._totalRejected,
      pending: this._pending.length,
      pendingCapacity: this._rateQueueMaxSize === Infinity ? 0 : this._rateQueueMaxSize,
      avgRateWaitMs,
      totalRateTimeouts: this._totalRateTimeouts,
    };
  }

  destroy(): void {
    clearInterval(this._intervalId);
    // 남은 pending 항목 전부 reject
    const snapshot = this._pending.splice(0);
    for (const item of snapshot) {
      clearTimeout(item.timeoutId);
      item.reject(new RateTimeoutError(Date.now() - item.enqueuedAt));
    }
  }

  /**
   * 카운터/샘플 리셋. 토큰 잔량과 pending 큐는 건드리지 않는다 (in-flight 안전).
   */
  resetCounters(): void {
    this._totalConsumed = 0;
    this._totalRejected = 0;
    this._totalRateTimeouts = 0;
    this._rateWaitSamples.length = 0;
  }
}
