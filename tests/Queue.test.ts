import { Queue, QueueFullError, type QueueItem } from '../src/core/Queue.js';
import { resetGlobalSequence } from '../src/core/WaitingInfo.js';

describe('Queue', () => {
  beforeEach(() => {
    resetGlobalSequence();
  });

  function makeItem(): QueueItem {
    return {
      resolve: jest.fn(),
      reject: jest.fn(),
      enqueuedAt: 0,
    };
  }

  test('초기 size는 0이다', () => {
    const q = new Queue();
    expect(q.size).toBe(0);
  });

  test('enqueue 후 size가 1 증가한다', () => {
    const q = new Queue();
    q.enqueue(makeItem());
    expect(q.size).toBe(1);
  });

  test('enqueue가 WaitingInfo를 반환한다', () => {
    const q = new Queue();
    const info = q.enqueue(makeItem());
    expect(info.id).toBe(1);
    expect(info.position).toBe(0);
  });

  test('dequeue는 FIFO 순서를 유지한다', () => {
    const q = new Queue();
    const item1 = makeItem();
    const item2 = makeItem();
    const item3 = makeItem();
    q.enqueue(item1);
    q.enqueue(item2);
    q.enqueue(item3);

    expect(q.dequeue()).toBe(item1);
    expect(q.dequeue()).toBe(item2);
    expect(q.dequeue()).toBe(item3);
  });

  test('빈 큐에서 dequeue하면 undefined를 반환한다', () => {
    const q = new Queue();
    expect(q.dequeue()).toBeUndefined();
  });

  test('dequeue 후 size가 감소한다', () => {
    const q = new Queue();
    q.enqueue(makeItem());
    q.enqueue(makeItem());
    q.dequeue();
    expect(q.size).toBe(1);
  });

  test('items는 현재 큐 내용의 읽기 전용 뷰다', () => {
    const q = new Queue();
    const item = makeItem();
    q.enqueue(item);
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toBe(item);
  });

  test('enqueue 이벤트가 emit된다', () => {
    const q = new Queue();
    const cb = jest.fn();
    q.on('enqueue', cb);
    q.enqueue(makeItem());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('dequeue 이벤트가 emit된다', () => {
    const q = new Queue();
    const cb = jest.fn();
    q.on('dequeue', cb);
    q.enqueue(makeItem());
    q.dequeue();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('빈 큐에서 dequeue 시 dequeue 이벤트가 emit되지 않는다', () => {
    const q = new Queue();
    const cb = jest.fn();
    q.on('dequeue', cb);
    q.dequeue();
    expect(cb).not.toHaveBeenCalled();
  });

  // --- 엣지 케이스 추가 ---

  test('여러 번 enqueue 후 일괄 dequeue — FIFO 순서 정확히 유지', () => {
    const q = new Queue();
    const items = Array.from({ length: 10 }, () => makeItem());
    items.forEach((item) => q.enqueue(item));
    expect(q.size).toBe(10);

    const dequeued: QueueItem[] = [];
    while (q.size > 0) {
      const item = q.dequeue();
      if (item !== undefined) dequeued.push(item);
    }

    expect(dequeued).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(dequeued[i]).toBe(items[i]); // FIFO 순서 보장
    }
    expect(q.size).toBe(0);
  });

  test('빈 큐에서 dequeue 반복 호출해도 항상 undefined 반환', () => {
    const q = new Queue();
    expect(q.dequeue()).toBeUndefined();
    expect(q.dequeue()).toBeUndefined();
    expect(q.dequeue()).toBeUndefined();
  });

  test('enqueue 반환 WaitingInfo의 position은 0-based 인덱스와 일치', () => {
    const q = new Queue();
    const info0 = q.enqueue(makeItem()); // position=0 (첫 번째)
    const info1 = q.enqueue(makeItem()); // position=1
    const info2 = q.enqueue(makeItem()); // position=2
    expect(info0.position).toBe(0);
    expect(info1.position).toBe(1);
    expect(info2.position).toBe(2);
  });

  // --- maxSize 관련 테스트 ---

  test('capacity getter는 생성자에 전달한 maxSize를 반환한다', () => {
    const q = new Queue(5);
    expect(q.capacity).toBe(5);
  });

  test('기본 capacity는 100이다', () => {
    const q = new Queue();
    expect(q.capacity).toBe(100);
  });

  test('maxSize 미만까지는 enqueue가 성공한다 (경계값: size === maxSize-1)', () => {
    const q = new Queue(3);
    q.enqueue(makeItem()); // size=1
    q.enqueue(makeItem()); // size=2 (maxSize-1)
    // 3번째는 maxSize 도달 전 — 성공해야 함
    expect(() => q.enqueue(makeItem())).not.toThrow();
    expect(q.size).toBe(3);
  });

  test('maxSize 초과 시 QueueFullError를 throw한다 (size === maxSize fail)', () => {
    const q = new Queue(2);
    q.enqueue(makeItem()); // size=1
    q.enqueue(makeItem()); // size=2 (= maxSize) — 이미 꽉 참
    expect(() => q.enqueue(makeItem())).toThrow(QueueFullError);
  });

  test('QueueFullError에 statusCode 503이 있다', () => {
    const q = new Queue(1);
    q.enqueue(makeItem()); // size=1 = maxSize
    let caught: unknown;
    try {
      q.enqueue(makeItem());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueueFullError);
    expect((caught as QueueFullError).statusCode).toBe(503);
  });

  test('maxSize=1 생성자는 정상 동작한다', () => {
    const q = new Queue(1);
    expect(q.capacity).toBe(1);
    q.enqueue(makeItem());
    expect(q.size).toBe(1);
    expect(() => q.enqueue(makeItem())).toThrow(QueueFullError);
  });

  test('maxSize < 1 생성자는 에러를 throw한다', () => {
    expect(() => new Queue(0)).toThrow();
  });

  test('dequeue 후 다시 enqueue하면 성공한다 (슬롯 회복)', () => {
    const q = new Queue(1);
    q.enqueue(makeItem()); // full
    q.dequeue();           // 비움
    expect(() => q.enqueue(makeItem())).not.toThrow();
  });

  // --- Queue.remove() 테스트 ---

  test('remove(predicate): 매칭 항목 1개를 제거하고 반환한다', () => {
    const q = new Queue();
    const item1 = makeItem();
    const item2 = makeItem();
    const item3 = makeItem();
    q.enqueue(item1);
    q.enqueue(item2);
    q.enqueue(item3);

    const removed = q.remove((i) => i === item2);
    expect(removed).toBe(item2);
    expect(q.size).toBe(2);
    // item1, item3만 남아야 한다
    expect(q.dequeue()).toBe(item1);
    expect(q.dequeue()).toBe(item3);
  });

  test('remove(predicate): 매칭 없으면 undefined 반환 + 큐 불변', () => {
    const q = new Queue();
    const item1 = makeItem();
    q.enqueue(item1);

    const removed = q.remove((i) => i === makeItem()); // 절대 매칭 안 됨
    expect(removed).toBeUndefined();
    expect(q.size).toBe(1); // 큐 불변
  });

  test('remove(predicate): 빈 큐에서 호출하면 undefined 반환', () => {
    const q = new Queue();
    const removed = q.remove(() => true);
    expect(removed).toBeUndefined();
    expect(q.size).toBe(0);
  });

  test('remove(predicate): 첫 번째 항목 제거 후 FIFO 순서 유지', () => {
    const q = new Queue();
    const item1 = makeItem();
    const item2 = makeItem();
    const item3 = makeItem();
    q.enqueue(item1);
    q.enqueue(item2);
    q.enqueue(item3);

    const removed = q.remove((i) => i === item1); // 첫 번째 항목 제거
    expect(removed).toBe(item1);
    expect(q.size).toBe(2);
    // item2, item3이 FIFO 순서로 남아야 한다
    expect(q.dequeue()).toBe(item2);
    expect(q.dequeue()).toBe(item3);
  });

  test('remove(predicate): 마지막 항목 제거 후 FIFO 순서 유지', () => {
    const q = new Queue();
    const item1 = makeItem();
    const item2 = makeItem();
    const item3 = makeItem();
    q.enqueue(item1);
    q.enqueue(item2);
    q.enqueue(item3);

    const removed = q.remove((i) => i === item3); // 마지막 항목 제거
    expect(removed).toBe(item3);
    expect(q.size).toBe(2);
    // item1, item2가 FIFO 순서로 남아야 한다
    expect(q.dequeue()).toBe(item1);
    expect(q.dequeue()).toBe(item2);
  });

  test('enqueue 후 enqueuedAt이 설정된다', () => {
    const q = new Queue();
    const item = makeItem();
    const before = Date.now();
    q.enqueue(item);
    const after = Date.now();
    expect(item.enqueuedAt).toBeGreaterThanOrEqual(before);
    expect(item.enqueuedAt).toBeLessThanOrEqual(after);
  });

  test('oldestEnqueuedAt은 첫 번째 항목의 enqueuedAt을 반환한다', () => {
    const q = new Queue();
    const item1 = makeItem();
    const item2 = makeItem();
    q.enqueue(item1);
    q.enqueue(item2);
    expect(q.oldestEnqueuedAt()).toBe(item1.enqueuedAt);
  });

  test('oldestEnqueuedAt은 빈 큐에서 undefined를 반환한다', () => {
    const q = new Queue();
    expect(q.oldestEnqueuedAt()).toBeUndefined();
  });
});
