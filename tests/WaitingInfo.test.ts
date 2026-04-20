import { WaitingInfo, resetGlobalSequence } from '../src/core/WaitingInfo.js';

describe('WaitingInfo', () => {
  beforeEach(() => {
    resetGlobalSequence();
  });

  test('id는 1-based이고 단조 증가한다', () => {
    const a = new WaitingInfo(0);
    const b = new WaitingInfo(0);
    const c = new WaitingInfo(0);
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(c.id).toBe(3);
    expect(a.id).toBeLessThan(b.id);
    expect(b.id).toBeLessThan(c.id);
  });

  test('position이 올바르게 설정된다', () => {
    const info = new WaitingInfo(5);
    expect(info.position).toBe(5);
  });

  test('estimatedWaitMs가 기본값 0이다', () => {
    const info = new WaitingInfo(0);
    expect(info.estimatedWaitMs).toBe(0);
  });

  test('estimatedWaitMs를 생성자에서 지정할 수 있다', () => {
    const info = new WaitingInfo(2, 1500);
    expect(info.estimatedWaitMs).toBe(1500);
  });

  test('estimatedWaitMs는 동적으로 갱신 가능하다', () => {
    const info = new WaitingInfo(1);
    info.estimatedWaitMs = 3000;
    expect(info.estimatedWaitMs).toBe(3000);
  });

  test('enqueuedAt은 현재 시간(ms)에 근접한다', () => {
    const before = Date.now();
    const info = new WaitingInfo(0);
    const after = Date.now();
    expect(info.enqueuedAt).toBeGreaterThanOrEqual(before);
    expect(info.enqueuedAt).toBeLessThanOrEqual(after);
  });

  test('elapsedMs는 0 이상이다', async () => {
    const info = new WaitingInfo(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(info.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test('id는 리셋 후 다시 1부터 시작한다', () => {
    const a = new WaitingInfo(0);
    expect(a.id).toBe(1);
    resetGlobalSequence();
    const b = new WaitingInfo(0);
    expect(b.id).toBe(1);
  });

  // --- 엣지 케이스 추가 ---

  test('position=0일 때 ahead=0 보장 (대기 앞 사람 없음)', () => {
    const info = new WaitingInfo(0);
    // position은 "앞에 몇 명" → position=0이면 ahead=0
    expect(info.position).toBe(0);
    // 예상 대기 시간도 기본 0
    expect(info.estimatedWaitMs).toBe(0);
  });

  test('position=0 + estimatedWaitMs=0: 즉시 처리 예상', () => {
    const info = new WaitingInfo(0, 0);
    expect(info.position).toBe(0);
    expect(info.estimatedWaitMs).toBe(0);
  });

  test('estimatedWaitMs 갱신 후 이전 값으로 롤백 가능', () => {
    const info = new WaitingInfo(3, 5000);
    expect(info.estimatedWaitMs).toBe(5000);
    info.estimatedWaitMs = 0; // 롤백
    expect(info.estimatedWaitMs).toBe(0);
    info.estimatedWaitMs = 9999; // 재설정
    expect(info.estimatedWaitMs).toBe(9999);
  });
});
