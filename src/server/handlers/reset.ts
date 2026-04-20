/**
 * reset.ts — POST /api/reset
 *
 * flowControl 카운터와 이동 평균 샘플을 초기화한다.
 * 활성 슬롯 / pending 큐 / 토큰 잔량은 건드리지 않음 (in-flight 요청 안전).
 */
import type * as http from 'node:http';
import { logger } from '../../utils/logger.js';
import { writeSecureHead } from '../responseHelpers.js';

export function createResetHandler(
  resetCounters: () => void
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (_req, res) => {
    resetCounters();
    logger.info('counters reset');
    writeSecureHead(res, 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, resetAt: Date.now() }));
  };
}
