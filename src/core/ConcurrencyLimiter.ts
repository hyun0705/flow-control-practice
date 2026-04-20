/**
 * ConcurrencyLimiter — 슬롯 카운터 + Queue 조합
 * 동시 처리 가능 최대 수를 초과하면 Queue에서 대기한다.
 */
import { Queue, type QueueItem } from './Queue.js';
export { QueueFullError } from './Queue.js';
import { WaitingInfo, type IWaitingInfo } from './WaitingInfo.js';

/** avgWaitMs 계산에 사용할 슬라이딩 윈도우 크기 */
const WAIT_WINDOW_SIZE = 20;

export interface ConcurrencyMetrics {
  maxConcurrent: number;
  activeCount: number;
  queueSize: number;
  totalProcessed: number;
  avgWaitMs: number;
}

export interface IConcurrencyLimiter {
  readonly maxConcurrent: number;
  readonly activeCount: number;
  readonly queueSize: number;
  readonly queueCapacity: number;
  /** 대기열에서 가장 오래된 항목의 enqueuedAt 시각 (없으면 undefined). */
  oldestEnqueuedAt(): number | undefined;
  acquire(timeoutMs?: number): Promise<IWaitingInfo>;
  release(): void;
  getMetrics(): ConcurrencyMetrics;
}

export class ConcurrencyLimiter implements IConcurrencyLimiter {
  readonly maxConcurrent: number;
  private _activeCount: number = 0;
  private readonly _queue: Queue;
  private _totalProcessed: number = 0;

  /**
   * 슬라이딩 윈도우(최근 WAIT_WINDOW_SIZE=20개) 대기 시간 샘플.
   * 오래된 데이터가 자연스럽게 만료되어 avgWaitMs가 현재 상황을 반영한다.
   */
  private readonly _waitWindowMs: number[] = [];

  /**
   * @param maxConcurrent 동시 처리 슬롯 수 (>= 1)
   * @param queueMaxSize  대기열 최대 크기. 기본값 = maxConcurrent * 10 (최소 100)
   */
  constructor(maxConcurrent: number, queueMaxSize?: number) {
    if (maxConcurrent < 1) {
      throw new Error(`maxConcurrent must be >= 1, got ${maxConcurrent}`);
    }
    this.maxConcurrent = maxConcurrent;
    const resolvedMaxSize = queueMaxSize ?? Math.max(100, maxConcurrent * 10);
    this._queue = new Queue(resolvedMaxSize);
  }

  get activeCount(): number {
    return this._activeCount;
  }

  get queueSize(): number {
    return this._queue.size;
  }

  get queueCapacity(): number {
    return this._queue.capacity;
  }

  /** 대기열에서 가장 오래된 항목의 enqueuedAt 시각 (없으면 undefined). */
  oldestEnqueuedAt(): number | undefined {
    return this._queue.oldestEnqueuedAt();
  }

  /**
   * 슬롯을 확보한다.
   * 슬롯이 남아있으면 즉시 resolve.
   * 슬롯이 가득 찼으면 Queue에서 대기.
   * timeoutMs 이내 슬롯을 못 얻으면 reject(503).
   */
  acquire(timeoutMs: number = 30_000): Promise<IWaitingInfo> {
    if (this._activeCount < this.maxConcurrent) {
      this._activeCount += 1;
      const info = new WaitingInfo(0, 0);
      this._totalProcessed += 1;
      return Promise.resolve(info);
    }

    return new Promise<IWaitingInfo>((resolve, reject) => {
      const item: QueueItem = {
        resolve,
        reject,
        enqueuedAt: 0, // Queue.enqueue()에서 설정된다
      };

      const timeoutId = setTimeout(() => {
        // 큐에서 해당 항목을 안전하게 제거 (직접 splice 금지)
        this._queue.remove((q) => q === item);
        reject(new QueueTimeoutError('Queue timeout: no slot available'));
      }, timeoutMs);

      item.timeoutId = timeoutId;

      try {
        this._queue.enqueue(item);
      } catch (err) {
        // QueueFullError: 타임아웃 취소 후 즉시 reject
        clearTimeout(timeoutId);
        reject(err as Error);
      }
    });
  }

  /**
   * 슬롯을 반납한다.
   *
   * ### 슬롯 직접 이전(slot hand-off) 의도
   * 대기 중인 항목이 있으면 activeCount를 **감소시키지 않고** 곧바로 다음 주자에게
   * 슬롯을 이전한다. 즉 "release → activeCount-- → acquire → activeCount++"의
   * 두 번 카운터를 거치지 않고 한 번에 넘긴다. 이 방식은:
   * - 슬롯이 순간적으로 비어있다고 잘못 노출되는 race condition을 방지한다.
   * - activeCount가 항상 실제 처리 중인 요청 수와 일치하도록 보장한다.
   *
   * 대기 항목이 없으면 activeCount를 정상 감소시킨다.
   */
  release(): void {
    const next = this._queue.dequeue();
    if (next !== undefined) {
      // 슬롯 직접 이전: activeCount는 변경하지 않는다
      if (next.timeoutId !== undefined) {
        clearTimeout(next.timeoutId);
      }
      // dequeue 시점에서 실제 대기 시간을 측정해 슬라이딩 윈도우에 기록한다
      const waitMs = Date.now() - next.enqueuedAt;
      this._recordWait(waitMs);
      this._totalProcessed += 1;
      const info = new WaitingInfo(0, 0);
      next.resolve(info);
    } else {
      // 대기 항목 없음 — 슬롯을 실제로 반납한다
      this._activeCount = Math.max(0, this._activeCount - 1);
    }
  }

  /**
   * 슬라이딩 윈도우(N=20)에 대기 시간 샘플을 추가한다.
   * 윈도우가 꽉 차면 가장 오래된 샘플을 제거한다.
   */
  private _recordWait(waitMs: number): void {
    this._waitWindowMs.push(waitMs);
    if (this._waitWindowMs.length > WAIT_WINDOW_SIZE) {
      this._waitWindowMs.shift();
    }
  }

  getMetrics(): ConcurrencyMetrics {
    const avgWaitMs =
      this._waitWindowMs.length > 0
        ? Math.round(
            this._waitWindowMs.reduce((sum, v) => sum + v, 0) /
              this._waitWindowMs.length
          )
        : 0;
    return {
      maxConcurrent: this.maxConcurrent,
      activeCount: this._activeCount,
      queueSize: this._queue.size,
      totalProcessed: this._totalProcessed,
      avgWaitMs,
    };
  }

  /**
   * 카운터/샘플 리셋. 활성 슬롯과 큐는 건드리지 않는다 (in-flight 안전).
   */
  resetCounters(): void {
    this._totalProcessed = 0;
    this._waitWindowMs.length = 0;
  }
}

export class QueueTimeoutError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = 'QueueTimeoutError';
  }
}
