/**
 * Queue — FIFO 대기열
 * EventEmitter를 상속하여 enqueue/dequeue 이벤트를 emit한다.
 */
import { EventEmitter } from 'node:events';
import { WaitingInfo, type IWaitingInfo } from './WaitingInfo.js';

export type QueueItem = {
  resolve: (info: IWaitingInfo) => void;
  reject: (err: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
  /** 큐에 진입한 시각 (Date.now()). dequeue 시 대기 시간 계산에 사용한다. */
  enqueuedAt: number;
};

export interface IQueue {
  enqueue(item: QueueItem): IWaitingInfo;
  dequeue(): QueueItem | undefined;
  /**
   * predicate를 만족하는 첫 번째 항목을 큐에서 제거한다.
   * 제거된 항목을 반환하며, 없으면 undefined를 반환한다.
   * 외부에서 items 배열에 직접 splice하는 것을 대체한다.
   */
  remove(predicate: (item: QueueItem) => boolean): QueueItem | undefined;
  readonly size: number;
  readonly capacity: number;
  readonly items: ReadonlyArray<QueueItem>;
  on(event: 'enqueue' | 'dequeue', cb: (info: IWaitingInfo) => void): this;
}

/** Queue가 maxSize에 도달했을 때 throw되는 에러 */
export class QueueFullError extends Error {
  readonly statusCode = 503;

  constructor(maxSize: number) {
    super(`Queue is full: maxSize=${maxSize}`);
    this.name = 'QueueFullError';
  }
}

export class Queue extends EventEmitter implements IQueue {
  private readonly _items: QueueItem[] = [];
  private readonly _maxSize: number;

  /** @param maxSize 최대 큐 크기. 기본값 100. */
  constructor(maxSize: number = 100) {
    super();
    if (maxSize < 1) {
      throw new Error(`maxSize must be >= 1, got ${maxSize}`);
    }
    this._maxSize = maxSize;
  }

  enqueue(item: QueueItem): IWaitingInfo {
    if (this._items.length >= this._maxSize) {
      throw new QueueFullError(this._maxSize);
    }
    // enqueuedAt을 큐 진입 시각으로 설정한다
    item.enqueuedAt = Date.now();
    this._items.push(item);
    const info = new WaitingInfo(this._items.length - 1);
    this.emit('enqueue', info);
    return info;
  }

  dequeue(): QueueItem | undefined {
    const item = this._items.shift();
    if (item !== undefined) {
      const info = new WaitingInfo(0);
      this.emit('dequeue', info);
    }
    return item;
  }

  /**
   * predicate를 만족하는 첫 번째 항목을 큐에서 제거한다.
   * 외부에서 items 배열에 직접 splice하는 것을 금지하기 위한 안전한 대안이다.
   * @returns 제거된 항목 또는 undefined (없으면 무동작)
   */
  remove(predicate: (item: QueueItem) => boolean): QueueItem | undefined {
    const idx = this._items.findIndex(predicate);
    if (idx === -1) return undefined;
    const [removed] = this._items.splice(idx, 1);
    return removed;
  }

  get size(): number {
    return this._items.length;
  }

  get capacity(): number {
    return this._maxSize;
  }

  get items(): ReadonlyArray<QueueItem> {
    return this._items;
  }

  /** 대기 중인 첫 번째 항목이 언제 진입했는지 반환 (없으면 undefined) */
  oldestEnqueuedAt(): number | undefined {
    return this._items.length > 0 ? this._items[0]?.enqueuedAt : undefined;
  }
}
