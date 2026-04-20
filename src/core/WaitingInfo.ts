/**
 * WaitingInfo — 순수 값 객체
 * 대기열 진입 시 생성되는 메타데이터를 담는다.
 * 전역 순번 카운터(globalSequence)는 모듈 스코프로 관리한다.
 */

export interface IWaitingInfo {
  readonly id: number;        // 전역 순번 (1-based, 단조 증가)
  readonly position: number;  // 현재 대기 위치 (앞에 몇 명 있나, 0-based)
  readonly enqueuedAt: number; // Date.now()
  estimatedWaitMs: number;    // 동적 갱신 가능
}

let globalSequence = 0;

/** 전역 순번을 리셋한다 (테스트 전용) */
export function resetGlobalSequence(): void {
  globalSequence = 0;
}

export class WaitingInfo implements IWaitingInfo {
  readonly id: number;
  readonly position: number;
  readonly enqueuedAt: number;
  estimatedWaitMs: number;

  constructor(position: number, estimatedWaitMs: number = 0) {
    globalSequence += 1;
    this.id = globalSequence;
    this.position = position;
    this.enqueuedAt = Date.now();
    this.estimatedWaitMs = estimatedWaitMs;
  }

  /** 경과 대기 시간 (ms) */
  get elapsedMs(): number {
    return Date.now() - this.enqueuedAt;
  }
}
