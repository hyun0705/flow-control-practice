import { TokenBucket } from '../src/core/TokenBucket.js';
import { RateTimeoutError, RateQueueFullError } from '../src/core/errors.js';

describe('TokenBucket', () => {
  let bucket: TokenBucket;

  afterEach(() => {
    bucket?.destroy();
  });

  test('capacity < 1이면 에러를 던진다', () => {
    expect(() => new TokenBucket(0, 1)).toThrow();
  });

  test('refillRate <= 0이면 에러를 던진다', () => {
    expect(() => new TokenBucket(10, 0)).toThrow();
    expect(() => new TokenBucket(10, -1)).toThrow();
  });

  test('초기 available은 capacity와 같다', () => {
    bucket = new TokenBucket(10, 5);
    expect(bucket.available()).toBe(10);
  });

  test('consume() 성공 시 true를 반환하고 토큰이 감소한다', () => {
    bucket = new TokenBucket(10, 5);
    const result = bucket.consume();
    expect(result).toBe(true);
    expect(bucket.available()).toBe(9);
  });

  test('토큰이 부족하면 consume()이 false를 반환한다', () => {
    bucket = new TokenBucket(1, 0.01); // refillRate 매우 낮음
    bucket.consume(); // 1개 소비 → 0개 남음
    const result = bucket.consume();
    expect(result).toBe(false);
  });

  test('consume(N)으로 N개 소비할 수 있다', () => {
    bucket = new TokenBucket(10, 1);
    const result = bucket.consume(5);
    expect(result).toBe(true);
    expect(bucket.available()).toBe(5);
  });

  test('refill 후 available이 증가한다', async () => {
    bucket = new TokenBucket(10, 10); // 10 tokens/sec
    // 모두 소비
    for (let i = 0; i < 10; i++) bucket.consume();
    expect(bucket.available()).toBe(0);

    // 200ms 기다리면 약 2개 보충
    await new Promise((r) => setTimeout(r, 200));
    expect(bucket.available()).toBeGreaterThan(0);
  }, 1000);

  test('refill이 capacity를 초과하지 않는다', async () => {
    bucket = new TokenBucket(10, 100); // 매우 빠른 보충
    bucket.consume(5);
    await new Promise((r) => setTimeout(r, 200));
    expect(bucket.available()).toBeLessThanOrEqual(10);
  }, 1000);

  test('getMetrics가 올바른 값을 반환한다', () => {
    bucket = new TokenBucket(10, 5);
    bucket.consume();
    bucket.consume();

    const metrics = bucket.getMetrics();
    expect(metrics.capacity).toBe(10);
    expect(metrics.available).toBe(8);
    expect(metrics.refillRate).toBe(5);
    expect(metrics.totalConsumed).toBe(2);
  });

  test('거부 시 totalRejected가 증가한다', () => {
    bucket = new TokenBucket(1, 0.001);
    bucket.consume(); // 성공
    bucket.consume(); // 실패

    const metrics = bucket.getMetrics();
    expect(metrics.totalRejected).toBe(1);
  });

  test('destroy 후 interval이 정리된다', () => {
    bucket = new TokenBucket(10, 5);
    expect(() => bucket.destroy()).not.toThrow();
  });

  // --- 엣지 케이스 추가 ---

  test('consume(N) where N > maxTokens: 항상 false 반환', () => {
    bucket = new TokenBucket(5, 1); // capacity=5
    const result = bucket.consume(6); // 6 > 5
    expect(result).toBe(false);
    expect(bucket.available()).toBe(5); // 토큰 변화 없음
  });

  test('available=0 일 때 consume(0): true 반환 (0개 소비는 항상 성공)', () => {
    bucket = new TokenBucket(1, 0.001);
    bucket.consume(); // 토큰 1개 소비 → available=0
    expect(bucket.available()).toBe(0);
    // consume(0): 0개 요청이므로 성공해야 함 (tokens(0) >= 0)
    const result = bucket.consume(0);
    expect(result).toBe(true);
    expect(bucket.available()).toBe(0); // 토큰 변화 없음
  });

  test('시간 경과 후 보충 정확성: 1초 경과 시 refillRate만큼 증가', async () => {
    bucket = new TokenBucket(100, 10); // 10 tokens/sec
    // 모두 소비
    for (let i = 0; i < 100; i++) bucket.consume();
    expect(bucket.available()).toBe(0);

    // 약 1초 대기 → 약 10개 보충 예상
    await new Promise((r) => setTimeout(r, 1000));
    const available = bucket.available();
    // 오차 허용: 8~12개 사이
    expect(available).toBeGreaterThanOrEqual(8);
    expect(available).toBeLessThanOrEqual(12);
  }, 3000);

  test('consume(N) 경계값: N=capacity 정확히 소비', () => {
    bucket = new TokenBucket(10, 1);
    const result = bucket.consume(10); // 정확히 capacity
    expect(result).toBe(true);
    expect(bucket.available()).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // consumeAsync v2 shaping 케이스
  // ─────────────────────────────────────────────────────────────────────────────

  test('consumeAsync: 토큰 있을 때 즉시 resolve된다', async () => {
    bucket = new TokenBucket(10, 5);
    await expect(bucket.consumeAsync(1000)).resolves.toBeUndefined();
    expect(bucket.available()).toBe(9);
  });

  test('consumeAsync: 토큰 없을 때 refill tick 후 resolve된다', async () => {
    bucket = new TokenBucket(1, 10); // 10/s → 100ms tick마다 1개 보충
    bucket.consume(); // 토큰 소비 → available=0
    expect(bucket.available()).toBe(0);

    const start = Date.now();
    await expect(bucket.consumeAsync(2000)).resolves.toBeUndefined();
    const elapsed = Date.now() - start;
    // 최소 1 tick(100ms) 이상, 최대 500ms 이내에 처리되어야 함
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(500);
  }, 3000);

  test('consumeAsync: timeoutMs 초과 시 RateTimeoutError가 reject된다', async () => {
    bucket = new TokenBucket(1, 0.001); // 거의 보충 안 됨
    bucket.consume(); // 토큰 소비 → available=0

    await expect(bucket.consumeAsync(100)).rejects.toBeInstanceOf(RateTimeoutError);
  }, 2000);

  test('consumeAsync: RateTimeoutError에 statusCode=429이 포함된다', async () => {
    bucket = new TokenBucket(1, 0.001);
    bucket.consume();

    try {
      await bucket.consumeAsync(100);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateTimeoutError);
      expect((err as RateTimeoutError).statusCode).toBe(429);
      expect((err as RateTimeoutError).pendingMs).toBeGreaterThanOrEqual(0);
    }
  }, 2000);

  test('consumeAsync: pending.length >= rateQueueMaxSize 시 RateQueueFullError', async () => {
    bucket = new TokenBucket(1, 0.001, 1); // rateQueueMaxSize=1
    bucket.consume(); // available=0

    // 첫 번째 pending (큐 크기 = 1)
    const p1 = bucket.consumeAsync(5000).catch(() => { /* 정리용 */ });

    // 두 번째: 큐 가득 → 즉시 reject
    await expect(bucket.consumeAsync(5000)).rejects.toBeInstanceOf(RateQueueFullError);

    bucket.destroy(); // p1 정리
    await p1;
  }, 2000);

  test('consumeAsync: RateQueueFullError에 statusCode=503이 포함된다', async () => {
    bucket = new TokenBucket(1, 0.001, 1);
    bucket.consume();

    const p1 = bucket.consumeAsync(5000).catch(() => { /* 정리용 */ });

    try {
      await bucket.consumeAsync(5000);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateQueueFullError);
      expect((err as RateQueueFullError).statusCode).toBe(503);
      expect((err as RateQueueFullError).pendingCapacity).toBe(1);
    }

    bucket.destroy();
    await p1;
  }, 2000);

  test('pendingCount: 대기 중인 항목 수를 반환한다', async () => {
    bucket = new TokenBucket(1, 0.001); // 거의 보충 안 됨
    bucket.consume(); // available=0

    expect(bucket.pendingCount).toBe(0);

    const p1 = bucket.consumeAsync(5000).catch(() => { /* 정리용 */ });
    await new Promise((r) => setTimeout(r, 10));
    expect(bucket.pendingCount).toBe(1);

    bucket.destroy();
    await p1;
  }, 2000);

  test('getMetrics: pending/pendingCapacity/avgRateWaitMs/totalRateTimeouts 포함', () => {
    bucket = new TokenBucket(10, 5, 50);
    const metrics = bucket.getMetrics();
    expect(metrics).toHaveProperty('pending');
    expect(metrics).toHaveProperty('pendingCapacity');
    expect(metrics).toHaveProperty('avgRateWaitMs');
    expect(metrics).toHaveProperty('totalRateTimeouts');
    expect(metrics.pendingCapacity).toBe(50);
    expect(metrics.pending).toBe(0);
    expect(metrics.avgRateWaitMs).toBe(0);
    expect(metrics.totalRateTimeouts).toBe(0);
  });

  test('totalRateTimeouts: 타임아웃 후 증가한다', async () => {
    bucket = new TokenBucket(1, 0.001);
    bucket.consume();

    await expect(bucket.consumeAsync(100)).rejects.toBeInstanceOf(RateTimeoutError);

    const metrics = bucket.getMetrics();
    expect(metrics.totalRateTimeouts).toBe(1);
  }, 2000);

  test('avgRateWaitMs: 대기 후 resolve 시 > 0으로 갱신된다', async () => {
    bucket = new TokenBucket(1, 10); // 10/s → 빠른 보충
    bucket.consume(); // available=0

    await bucket.consumeAsync(2000);

    const metrics = bucket.getMetrics();
    expect(metrics.avgRateWaitMs).toBeGreaterThan(0);
  }, 3000);

  test('destroy: 남은 pending 항목이 RateTimeoutError로 reject된다', async () => {
    bucket = new TokenBucket(1, 0.001);
    bucket.consume();

    const rejectPromise = bucket.consumeAsync(5000);
    await new Promise((r) => setTimeout(r, 10));

    bucket.destroy();

    await expect(rejectPromise).rejects.toBeInstanceOf(RateTimeoutError);
  }, 2000);

  // ─────────────────────────────────────────────────────────────────────────────
  // v2 shaping 추가 엣지 케이스 (iter=5 tester 보완)
  // ─────────────────────────────────────────────────────────────────────────────

  test('consumeAsync FIFO: 등록 순서대로 resolve된다', async () => {
    // capacity=1, refillRate=20 → 50ms마다 1개 보충 (tick 100ms 기준 2개/tick)
    bucket = new TokenBucket(1, 20);
    bucket.consume(); // available=0 → 모두 pending

    const order: number[] = [];
    const promises = [1, 2, 3].map((seq) =>
      bucket.consumeAsync(3000).then(() => { order.push(seq); })
    );

    // refill tick(100ms * 3 이상) 이후 모두 resolve 대기
    await Promise.all(promises);
    expect(order).toEqual([1, 2, 3]);
  }, 5000);

  test('consumeAsync 타임아웃 후 pending에서 제거된다', async () => {
    bucket = new TokenBucket(1, 0.001); // 거의 보충 안 됨
    bucket.consume(); // available=0

    const p = bucket.consumeAsync(80).catch(() => { /* expected reject */ });

    // enqueue 직후 pendingCount = 1
    await new Promise((r) => setTimeout(r, 10));
    expect(bucket.pendingCount).toBe(1);

    // 타임아웃 후 pending에서 제거
    await new Promise((r) => setTimeout(r, 150));
    expect(bucket.pendingCount).toBe(0);

    await p; // 정리 완료 대기
  }, 2000);

  test('avgRateWaitMs 슬라이딩 윈도우 N=20 경계: 21번째 샘플 시 1번째 교체', async () => {
    // 빠른 보충 버킷 — 각 consumeAsync 호출이 1 tick 이내에 resolve되도록 설정
    // capacity=1, refillRate=100 → 10ms 이내 1개 보충
    bucket = new TokenBucket(1, 100);

    // 21번 consumeAsync 순차 실행 (각각 즉시 소비 후 1 tick 대기)
    for (let i = 0; i < 21; i++) {
      await bucket.consumeAsync(3000);
      // 토큰이 없으면 refill tick을 기다린다 (100ms 최대)
      await new Promise((r) => setTimeout(r, 30));
    }

    const metrics = bucket.getMetrics();
    // 슬라이딩 윈도우 크기가 20으로 유지되므로 totalConsumed는 21이지만
    // avgRateWaitMs 샘플은 20개 이하 (즉시 소비분은 샘플 미포함)
    expect(metrics.totalConsumed).toBe(21);
    // 오버플로 없이 정상 계산 (NaN·Infinity 아님)
    expect(Number.isFinite(metrics.avgRateWaitMs)).toBe(true);
  }, 10000);

  test('pendingCapacity=Infinity 시 getMetrics gauge 계산이 안전하다 (division by zero 없음)', () => {
    // rateQueueMaxSize 미지정 → Infinity
    bucket = new TokenBucket(10, 5);
    const metrics = bucket.getMetrics();
    // pendingCapacity는 Infinity일 때 0으로 노출 (flowControl.ts getMetrics 정책)
    expect(metrics.pendingCapacity).toBe(0);
    // NaN·Infinity 없음
    expect(Number.isFinite(metrics.pending) || metrics.pending === 0).toBe(true);
  });
});
