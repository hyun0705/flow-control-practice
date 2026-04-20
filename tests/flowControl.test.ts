import { createFlowControl } from '../src/middleware/flowControl.js';
import { resetGlobalSequence } from '../src/core/WaitingInfo.js';
import { SECURITY_HEADERS } from '../src/server/responseHelpers.js';
import type * as http from 'node:http';

// 테스트용 req/res mock
function makeMockReq(): http.IncomingMessage {
  return {} as http.IncomingMessage;
}

function makeMockRes(): {
  res: http.ServerResponse;
  statusCode: number | null;
  body: string;
  headers: Record<string, string | number>;
} {
  let statusCode: number | null = null;
  let body = '';
  const headers: Record<string, string | number> = {};

  const res = {
    writeHead(code: number, hdrs?: Record<string, string | number>) {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    },
    end(data?: string) {
      body = data ?? '';
    },
  } as unknown as http.ServerResponse;

  return { res, get statusCode() { return statusCode; }, get body() { return body; }, headers };
}

describe('createFlowControl', () => {
  beforeEach(() => {
    resetGlobalSequence();
  });

  test('토큰이 있으면 next()가 호출된다', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 2 },
      tokenBucket: { capacity: 10, refillRate: 5 },
    });

    const req = makeMockReq();
    const { res } = makeMockRes();
    const next = jest.fn().mockResolvedValue(undefined);

    await new Promise<void>((resolve) => {
      void middleware(req, res, async () => {
        await next();
        resolve();
      });
    });

    expect(next).toHaveBeenCalledTimes(1);
    destroy();
  });

  // v2 shaping: 토큰 고갈 시 대기 후 타임아웃 → 429
  test('Rate 타임아웃 초과 시 429를 반환한다', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 5 },
      tokenBucket: { capacity: 1, refillRate: 0.001 }, // 매우 낮은 보충
      rateWaitTimeout: 50, // 50ms 타임아웃
    });

    const req = makeMockReq();

    // 1번째: 토큰 소비
    const mock1 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock1.res, async () => {
        mock1.res.writeHead(200, { 'Content-Type': 'application/json' });
        mock1.res.end(JSON.stringify({ ok: true }));
        resolve();
      });
    });

    // 2번째: 토큰 없음 → 대기 후 타임아웃 → 429
    const mock2 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock2.res, async () => {
        resolve(); // next가 불리면 안 됨
      });
      setTimeout(resolve, 200);
    });

    expect(mock2.statusCode).toBe(429);
    destroy();
  }, 1000);

  // v2 shaping: Rate 큐 가득 시 즉시 503
  test('Rate 큐 가득 시 503을 반환한다', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 5 },
      tokenBucket: { capacity: 1, refillRate: 0.001 }, // 매우 낮은 보충
      rateWaitTimeout: 5000,
      rateQueueMaxSize: 1, // 큐 크기 1
    });

    const req = makeMockReq();

    // 1번째: 토큰 소비
    const mock1 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock1.res, async () => {
        mock1.res.writeHead(200, { 'Content-Type': 'application/json' });
        mock1.res.end(JSON.stringify({ ok: true }));
        resolve();
      });
    });

    // 2번째: 큐에 대기 (rateQueueMaxSize=1이므로 ok)
    const mock2 = makeMockRes();
    void middleware(req, mock2.res, async () => { /* 대기 중 */ });

    await new Promise((r) => setTimeout(r, 10));

    // 3번째: 큐 가득 → 즉시 503
    const mock3 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock3.res, async () => { resolve(); });
      setTimeout(resolve, 100);
    });

    expect(mock3.statusCode).toBe(503);
    const parsed = JSON.parse(mock3.body) as { error: string; statusCode: number };
    expect(parsed.statusCode).toBe(503);
    expect(parsed.error).toContain('rate queue full');

    destroy();
  }, 2000);

  // v2 shaping: 대기 후 처리됨 (refill tick → resolve → 200)
  test('대기 후 토큰 보충 시 요청이 처리된다 (shaping)', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 5 },
      tokenBucket: { capacity: 1, refillRate: 10 }, // 10/s → 100ms마다 1개 보충
      rateWaitTimeout: 2000,
    });

    const req = makeMockReq();

    // 1번째: 토큰 소비
    const mock1 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock1.res, async () => {
        mock1.res.writeHead(200, {});
        mock1.res.end('ok');
        resolve();
      });
    });

    // 2번째: 토큰 없음 → 대기 후 처리됨
    const mock2 = makeMockRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      void middleware(req, mock2.res, async () => {
        nextCalled = true;
        mock2.res.writeHead(200, {});
        mock2.res.end('ok');
        resolve();
      });
      setTimeout(resolve, 1500); // 최대 1.5초 대기
    });

    expect(nextCalled).toBe(true);
    expect(mock2.statusCode).toBe(200);
    destroy();
  }, 3000);

  test('슬롯 초과 + 타임아웃 시 503을 반환한다', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 1 },
      tokenBucket: { capacity: 100, refillRate: 100 },
      queueTimeout: 50,
    });

    const req = makeMockReq();

    // 슬롯 점유 (해제하지 않음)
    let releaseOccupied: (() => void) | undefined;
    const occupyPromise = new Promise<void>((resolve) => {
      void middleware(req, makeMockRes().res, async () => {
        await new Promise<void>((r) => {
          releaseOccupied = r;
        });
        resolve();
      });
    });

    // 잠시 대기 후 두 번째 요청 → 503
    await new Promise((r) => setTimeout(r, 10));
    const mock2 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock2.res, async () => {
        resolve();
      });
      setTimeout(resolve, 200);
    });

    expect(mock2.statusCode).toBe(503);

    releaseOccupied?.();
    await occupyPromise;
    destroy();
  }, 2000);

  test('getMetrics가 올바른 구조를 반환한다 (rate 필드 포함)', () => {
    const { getMetrics, destroy } = createFlowControl({
      concurrency: { max: 3 },
      tokenBucket: { capacity: 10, refillRate: 5 },
    });

    const metrics = getMetrics();
    expect(metrics).toHaveProperty('concurrency');
    expect(metrics).toHaveProperty('tokenBucket');
    expect(metrics).toHaveProperty('rate');
    expect(metrics).toHaveProperty('queue');
    expect(metrics).toHaveProperty('timestamp');
    expect(metrics.concurrency.maxConcurrent).toBe(3);
    expect(metrics.tokenBucket.capacity).toBe(10);
    // rate 필드 구조 확인
    expect(metrics.rate).toHaveProperty('pending');
    expect(metrics.rate).toHaveProperty('pendingCapacity');
    expect(metrics.rate).toHaveProperty('avgRateWaitMs');
    expect(metrics.rate).toHaveProperty('totalRateTimeouts');
    destroy();
  });

  test('destroy 후 에러 없이 종료된다', () => {
    const { destroy } = createFlowControl({
      concurrency: { max: 2 },
      tokenBucket: { capacity: 10, refillRate: 5 },
    });
    expect(() => destroy()).not.toThrow();
  });

  // --- 엣지 케이스 추가 ---

  test('429 응답에 Retry-After 헤더가 포함된다', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 5 },
      tokenBucket: { capacity: 1, refillRate: 0.001 },
      rateWaitTimeout: 50,
    });

    const req = makeMockReq();
    // 1번째: 토큰 소비
    const mock1 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock1.res, async () => {
        mock1.res.writeHead(200, {});
        mock1.res.end('ok');
        resolve();
      });
    });

    // 2번째: 타임아웃 → 429 + Retry-After 헤더
    const mock2 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock2.res, async () => { resolve(); });
      setTimeout(resolve, 200);
    });

    expect(mock2.statusCode).toBe(429);
    expect(mock2.headers['Retry-After']).toBeDefined();
    destroy();
  }, 1000);

  test('503 응답 body에 statusCode:503 포함', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 1 },
      tokenBucket: { capacity: 100, refillRate: 100 },
      queueTimeout: 50,
    });

    const req = makeMockReq();
    let releaseOccupied: (() => void) | undefined;
    const occupyPromise = new Promise<void>((resolve) => {
      void middleware(req, makeMockRes().res, async () => {
        await new Promise<void>((r) => { releaseOccupied = r; });
        resolve();
      });
    });

    await new Promise((r) => setTimeout(r, 10));
    const mock2 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock2.res, async () => { resolve(); });
      setTimeout(resolve, 200);
    });

    expect(mock2.statusCode).toBe(503);
    const parsed = JSON.parse(mock2.body) as { statusCode: number };
    expect(parsed.statusCode).toBe(503);

    releaseOccupied?.();
    await occupyPromise;
    destroy();
  }, 2000);

  test('queue.maxSize 초과 시 503을 반환한다 (QueueFullError 경로)', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 1 },
      tokenBucket: { capacity: 100, refillRate: 100 },
      queue: { maxSize: 1 },   // 대기열 최대 1개
      queueTimeout: 5000,
    });

    const req = makeMockReq();

    // 슬롯 점유 (해제하지 않음)
    let releaseOccupied: (() => void) | undefined;
    const occupyPromise = new Promise<void>((resolve) => {
      void middleware(req, makeMockRes().res, async () => {
        await new Promise<void>((r) => { releaseOccupied = r; });
        resolve();
      });
    });

    await new Promise((r) => setTimeout(r, 10));

    // 2번째 요청 → 큐 대기 (maxSize=1이므로 ok)
    const mock2 = makeMockRes();
    void middleware(req, mock2.res, async () => { /* 대기 중 */ });

    await new Promise((r) => setTimeout(r, 10));

    // 3번째 요청 → 큐 full → 즉시 503
    const mock3 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock3.res, async () => { resolve(); });
      setTimeout(resolve, 100);
    });

    expect(mock3.statusCode).toBe(503);
    const parsed = JSON.parse(mock3.body) as { error: string; statusCode: number };
    expect(parsed.statusCode).toBe(503);
    expect(parsed.error).toContain('queue full');

    releaseOccupied?.();
    await occupyPromise;
    destroy();
  }, 3000);

  test('getMetrics에 queue.capacity가 포함된다', () => {
    const { getMetrics, destroy } = createFlowControl({
      concurrency: { max: 2 },
      tokenBucket: { capacity: 10, refillRate: 5 },
      queue: { maxSize: 50 },
    });

    const metrics = getMetrics();
    expect(metrics.queue).toHaveProperty('capacity');
    expect(metrics.queue.capacity).toBe(50);
    destroy();
  });

  test('queue.maxSize 기본값은 concurrency.max * 10 (최소 100)', () => {
    const { getMetrics, destroy } = createFlowControl({
      concurrency: { max: 5 },
      tokenBucket: { capacity: 10, refillRate: 5 },
      // queue 옵션 미지정 → 기본값 max(100, 5*10)=100
    });

    const metrics = getMetrics();
    expect(metrics.queue.capacity).toBe(100);
    destroy();
  });

  test('getMetrics queue.size가 대기 중 요청 수를 정확히 반영', async () => {
    const { middleware, getMetrics, destroy } = createFlowControl({
      concurrency: { max: 1 },
      tokenBucket: { capacity: 100, refillRate: 100 },
      queueTimeout: 5000,
    });

    const req = makeMockReq();
    let releaseFirst: (() => void) | undefined;

    // 슬롯 점유 (해제 않음)
    void middleware(req, makeMockRes().res, async () => {
      await new Promise<void>((r) => { releaseFirst = r; });
    });

    // 2번째 요청 → 큐 대기
    let resolved2 = false;
    const p2 = middleware(req, makeMockRes().res, async () => { resolved2 = true; });

    await new Promise((r) => setTimeout(r, 20));
    const metrics = getMetrics();
    expect(metrics.queue.size).toBe(1); // 대기 1명

    releaseFirst?.();
    await p2;
    expect(resolved2).toBe(true);
    destroy();
  }, 3000);

  // ─────────────────────────────────────────────────────────────────────────────
  // 보안 헤더 — 503 응답에도 4개 보안 헤더가 포함되어야 한다
  // ─────────────────────────────────────────────────────────────────────────────

  test('503(타임아웃) 응답에도 4개 보안 헤더가 포함된다', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 1 },
      tokenBucket: { capacity: 100, refillRate: 100 },
      queueTimeout: 50,
    });

    const req = makeMockReq();

    // 슬롯 점유 (해제하지 않음)
    let releaseOccupied: (() => void) | undefined;
    const occupyPromise = new Promise<void>((resolve) => {
      void middleware(req, makeMockRes().res, async () => {
        await new Promise<void>((r) => { releaseOccupied = r; });
        resolve();
      });
    });

    await new Promise((r) => setTimeout(r, 10));

    // 2번째 요청 → 타임아웃으로 503
    const mock2 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock2.res, async () => { resolve(); });
      setTimeout(resolve, 200);
    });

    expect(mock2.statusCode).toBe(503);
    // 4개 보안 헤더 모두 존재해야 한다
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(mock2.headers[key]).toBe(value);
    }

    releaseOccupied?.();
    await occupyPromise;
    destroy();
  }, 2000);

  test('503(QueueFullError) 응답에도 4개 보안 헤더가 포함된다', async () => {
    const { middleware, destroy } = createFlowControl({
      concurrency: { max: 1 },
      tokenBucket: { capacity: 100, refillRate: 100 },
      queue: { maxSize: 1 },
      queueTimeout: 5000,
    });

    const req = makeMockReq();

    // 슬롯 점유
    let releaseOccupied: (() => void) | undefined;
    const occupyPromise = new Promise<void>((resolve) => {
      void middleware(req, makeMockRes().res, async () => {
        await new Promise<void>((r) => { releaseOccupied = r; });
        resolve();
      });
    });

    await new Promise((r) => setTimeout(r, 10));

    // 2번째 요청 → 큐 대기 (maxSize=1이므로 ok)
    void middleware(req, makeMockRes().res, async () => { /* 대기 중 */ });
    await new Promise((r) => setTimeout(r, 10));

    // 3번째 요청 → QueueFullError → 즉시 503
    const mock3 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock3.res, async () => { resolve(); });
      setTimeout(resolve, 100);
    });

    expect(mock3.statusCode).toBe(503);
    // 4개 보안 헤더 모두 존재해야 한다
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(mock3.headers[key]).toBe(value);
    }

    releaseOccupied?.();
    await occupyPromise;
    destroy();
  }, 3000);

  // ─────────────────────────────────────────────────────────────────────────────
  // oldestWaitMs 실계산 테스트
  // ─────────────────────────────────────────────────────────────────────────────

  test('대기 중인 요청이 없으면 queue.oldestWaitMs가 0이다', () => {
    const { getMetrics, destroy } = createFlowControl({
      concurrency: { max: 5 },
      tokenBucket: { capacity: 100, refillRate: 100 },
    });
    const metrics = getMetrics();
    expect(metrics.queue.oldestWaitMs).toBe(0);
    destroy();
  });

  test('대기 중인 요청이 있으면 queue.oldestWaitMs가 0보다 크다', async () => {
    const { middleware, getMetrics, destroy } = createFlowControl({
      concurrency: { max: 1 },
      tokenBucket: { capacity: 100, refillRate: 100 },
      queueTimeout: 5000,
    });

    const req = makeMockReq();
    let releaseFirst: (() => void) | undefined;

    // 슬롯 점유
    void middleware(req, makeMockRes().res, async () => {
      await new Promise<void>((r) => { releaseFirst = r; });
    });

    // 2번째 요청 → 큐 대기
    void middleware(req, makeMockRes().res, async () => { /* 대기 중 */ });

    // 충분히 대기해 enqueuedAt 경과 시간이 발생하도록 한다
    await new Promise((r) => setTimeout(r, 30));

    const metrics = getMetrics();
    expect(metrics.queue.oldestWaitMs).toBeGreaterThan(0);

    releaseFirst?.();
    // cleanup — 큐 해소
    await new Promise((r) => setTimeout(r, 10));
    destroy();
  }, 3000);

  // ─────────────────────────────────────────────────────────────────────────────
  // v2 shaping 메트릭 테스트
  // ─────────────────────────────────────────────────────────────────────────────

  test('Rate 타임아웃 후 totalRateTimeouts가 증가한다', async () => {
    const { middleware, getMetrics, destroy } = createFlowControl({
      concurrency: { max: 5 },
      tokenBucket: { capacity: 1, refillRate: 0.001 },
      rateWaitTimeout: 50,
    });

    const req = makeMockReq();

    // 1번째: 토큰 소비
    const mock1 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock1.res, async () => {
        mock1.res.writeHead(200, {});
        mock1.res.end('ok');
        resolve();
      });
    });

    // 2번째: 타임아웃 대기
    const mock2 = makeMockRes();
    await new Promise<void>((resolve) => {
      void middleware(req, mock2.res, async () => { resolve(); });
      setTimeout(resolve, 200);
    });

    const metrics = getMetrics();
    expect(metrics.rate.totalRateTimeouts).toBeGreaterThanOrEqual(1);
    destroy();
  }, 1000);

  test('rateQueueMaxSize 기본값은 concurrency.max * 10 (최소 100)', () => {
    const { getMetrics, destroy } = createFlowControl({
      concurrency: { max: 5 },
      tokenBucket: { capacity: 10, refillRate: 5 },
      // rateQueueMaxSize 미지정 → max(100, 5*10)=100
    });

    const metrics = getMetrics();
    expect(metrics.rate.pendingCapacity).toBe(100);
    destroy();
  });
});
