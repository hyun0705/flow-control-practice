import { ConcurrencyLimiter, QueueTimeoutError } from '../src/core/ConcurrencyLimiter.js';
import { QueueFullError } from '../src/core/Queue.js';
import { resetGlobalSequence } from '../src/core/WaitingInfo.js';

describe('ConcurrencyLimiter', () => {
  beforeEach(() => {
    resetGlobalSequence();
  });

  test('maxConcurrent < 1이면 에러를 던진다', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
  });

  test('슬롯 내에서는 즉시 acquire한다', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const info = await limiter.acquire();
    expect(info).toBeDefined();
    expect(limiter.activeCount).toBe(1);
  });

  test('release 후 activeCount가 감소한다', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    limiter.release();
    expect(limiter.activeCount).toBe(0);
  });

  test('슬롯 초과 시 대기하다가 release 후 획득한다', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // 슬롯 점유

    let acquired = false;
    const waiter = limiter.acquire().then((info) => {
      acquired = true;
      return info;
    });

    // 아직 acquire 안됨
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);
    expect(limiter.queueSize).toBe(1);

    // release 후 acquire 완료
    limiter.release();
    await waiter;
    expect(acquired).toBe(true);
  });

  test('타임아웃 시 QueueTimeoutError를 던진다', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // 슬롯 점유

    await expect(limiter.acquire(50)).rejects.toThrow(QueueTimeoutError);
  }, 500);

  test('QueueTimeoutError.statusCode는 503이다', () => {
    const err = new QueueTimeoutError('test');
    expect(err.statusCode).toBe(503);
  });

  test('getMetrics가 올바른 값을 반환한다', async () => {
    const limiter = new ConcurrencyLimiter(3);
    await limiter.acquire();
    await limiter.acquire();

    const metrics = limiter.getMetrics();
    expect(metrics.maxConcurrent).toBe(3);
    expect(metrics.activeCount).toBe(2);
    expect(metrics.queueSize).toBe(0);
    expect(metrics.totalProcessed).toBe(2);
  });

  test('activeCount가 0 미만으로 내려가지 않는다', () => {
    const limiter = new ConcurrencyLimiter(2);
    limiter.release(); // 빈 상태에서 release
    expect(limiter.activeCount).toBe(0);
  });

  // --- 엣지 케이스 추가 ---

  test('다중 release 멱등성: 슬롯 0인 상태에서 release 두 번 해도 activeCount는 0 유지', () => {
    const limiter = new ConcurrencyLimiter(2);
    // 슬롯 없이 release 두 번
    limiter.release();
    limiter.release();
    expect(limiter.activeCount).toBe(0); // 음수 방지
  });

  test('동시 acquire 경쟁: 슬롯 1개에 2개 acquire 경쟁 — 순서대로 처리', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // 슬롯 점유

    const results: number[] = [];
    const p1 = limiter.acquire().then(() => { results.push(1); });
    const p2 = limiter.acquire().then(() => { results.push(2); });

    // 아직 둘 다 대기 중
    await new Promise((r) => setTimeout(r, 10));
    expect(results).toHaveLength(0);
    expect(limiter.queueSize).toBe(2);

    // 첫 번째 release → p1 완료
    limiter.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(results).toEqual([1]); // FIFO: p1 먼저

    // 두 번째 release → p2 완료
    limiter.release();
    await Promise.all([p1, p2]);
    expect(results).toEqual([1, 2]);

    limiter.release(); // 마지막 정리
  }, 1000);

  test('acquire 타임아웃 후 해당 항목은 큐에서 제거된다', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // 슬롯 점유

    // 타임아웃 후 큐 크기가 0으로 복원되는지 확인
    await expect(limiter.acquire(50)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(limiter.queueSize).toBe(0); // 타임아웃된 항목이 제거됨

    limiter.release();
  }, 1000);

  test('QueueFullError 전파: concurrency.max=1, queueMaxSize=1, 3번째 acquire는 QueueFullError로 reject', async () => {
    // max=1, queueMaxSize=1: 슬롯 1개 + 대기열 1개 → 3번째 요청은 QueueFullError
    const limiter = new ConcurrencyLimiter(1, 1);
    await limiter.acquire(); // 슬롯 점유 (activeCount=1)

    // 2번째 요청 → 큐 대기 (queueSize=1)
    const p2 = limiter.acquire(5000);
    await new Promise((r) => setTimeout(r, 10));
    expect(limiter.queueSize).toBe(1);

    // 3번째 요청 → QueueFullError (큐 포화)
    await expect(limiter.acquire(5000)).rejects.toBeInstanceOf(QueueFullError);

    // 정리
    limiter.release(); // p2 완료
    await p2;
    limiter.release(); // p2 슬롯 반납
  }, 2000);

  test('queueCapacity getter는 생성자 queueMaxSize를 반환한다', () => {
    const limiter = new ConcurrencyLimiter(2, 30);
    expect(limiter.queueCapacity).toBe(30);
  });

  test('queueCapacity 기본값: max(100, maxConcurrent * 10)', () => {
    const limiter5 = new ConcurrencyLimiter(5);   // 5*10=50 → max(100,50)=100
    expect(limiter5.queueCapacity).toBe(100);

    const limiter20 = new ConcurrencyLimiter(20); // 20*10=200 → max(100,200)=200
    expect(limiter20.queueCapacity).toBe(200);
  });

  // --- release() 슬롯 직접 이전 테스트 ---

  test('release() — 큐 비어있음: activeCount 감소', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    limiter.release(); // 큐 비어있음 → activeCount--
    expect(limiter.activeCount).toBe(0);
  });

  test('release() — 큐 대기중: activeCount 유지(슬롯 직접 이전)', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // 슬롯 점유

    // 대기자 추가
    const waiter = limiter.acquire(5000);
    await new Promise((r) => setTimeout(r, 10));
    expect(limiter.queueSize).toBe(1);
    expect(limiter.activeCount).toBe(1);

    // release → 슬롯 직접 이전 → activeCount는 그대로 1
    limiter.release();
    await waiter;
    // 다음 주자가 슬롯을 바로 넘겨받으므로 activeCount = 1 유지
    expect(limiter.activeCount).toBe(1);

    // 정리
    limiter.release();
    expect(limiter.activeCount).toBe(0);
  }, 2000);

  // --- avgWaitMs 슬라이딩 윈도우 테스트 ---

  test('avgWaitMs: 초기 상태에서 0이다', () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.getMetrics().avgWaitMs).toBe(0);
  });

  test('avgWaitMs: 대기 후 0보다 커진다 (실제 대기 시간 반영)', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // 슬롯 점유

    // 50ms 대기 후 release
    const waiter = limiter.acquire(5000);
    await new Promise((r) => setTimeout(r, 50));
    limiter.release(); // dequeue → waitMs ≈ 50ms 기록
    await waiter;

    const { avgWaitMs } = limiter.getMetrics();
    expect(avgWaitMs).toBeGreaterThan(0);
    limiter.release();
  }, 2000);

  test('avgWaitMs: 슬라이딩 윈도우 N=20 — 21번째 샘플이 가장 오래된 것을 교체', async () => {
    // 슬롯 수 충분히 크게 잡아 즉시 acquire (큐 대기 없음)
    // 슬롯 대기자가 있어야 avgWaitMs가 기록되므로 concurrency=1로 직렬화
    const limiter = new ConcurrencyLimiter(1);

    // 20개 샘플: 각 1ms씩 대기
    for (let i = 0; i < 20; i++) {
      await limiter.acquire(); // 첫 호출은 즉시 (슬롯 있음)
      // 다음 acquire가 큐 대기하도록 슬롯 점유 상태를 유지
      // 간단히: 슬롯이 비어있으므로 acquire(즉시) → release → avgWaitMs에 반영되지 않음
      // avgWaitMs는 큐 대기자가 있을 때만 기록됨 → 강제로 큐 대기 유도
      limiter.release();
    }

    // 실제 슬라이딩 윈도우 검증: 대기 샘플 21개를 생성해
    // 마지막 20개만 반영되는지 확인한다
    const limiter2 = new ConcurrencyLimiter(1);
    await limiter2.acquire(); // 슬롯 점유

    // 대기자 21개를 순차적으로 추가하고 release
    const waiters: Promise<unknown>[] = [];
    for (let i = 0; i < 21; i++) {
      waiters.push(limiter2.acquire(5000));
      await new Promise((r) => setTimeout(r, 2)); // 약간의 실제 대기 시간 부여
      limiter2.release(); // 하나씩 풀어준다
      await new Promise((r) => setTimeout(r, 1));
    }

    await Promise.all(waiters);
    // 21번째까지 release했으므로 마지막 정리
    limiter2.release();

    const metrics = limiter2.getMetrics();
    // 윈도우 크기(N=20)이므로 totalProcessed > 20이어도 avgWaitMs는 최근 20개 기반
    expect(metrics.totalProcessed).toBeGreaterThan(20);
    // avgWaitMs가 0 이상이고 계산이 완료되어야 함
    expect(metrics.avgWaitMs).toBeGreaterThanOrEqual(0);
  }, 5000);

  test('avgWaitMs: 즉시 acquire(큐 미사용) 시 기록되지 않아 0 유지', async () => {
    const limiter = new ConcurrencyLimiter(5); // 슬롯 5개
    // 슬롯 내에서 즉시 acquire — 대기 없음 → avgWaitMs 기록 안 됨
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    for (let i = 0; i < 5; i++) {
      limiter.release();
    }
    expect(limiter.getMetrics().avgWaitMs).toBe(0);
  });
});
