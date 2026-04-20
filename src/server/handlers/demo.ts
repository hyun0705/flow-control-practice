/**
 * demo.ts — POST /api/work (alias: /api/demo)
 * flow-control 미들웨어를 통과하여 슬로우 작업을 시뮬레이션한다.
 * 랜덤 지연: 500~2000ms
 */
import type * as http from 'node:http';
import type { RequestHandler } from '../../middleware/flowControl.js';
import { logger } from '../../utils/logger.js';
import { writeSecureHead } from '../responseHelpers.js';

function randomDelayMs(): number {
  return 500 + Math.floor(Math.random() * 1500); // 500~2000ms
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 실제 슬로우 작업 핸들러 (미들웨어 래핑 없이 순수 작업만)
 */
export function createDemoHandler(
  flowControlMiddleware: RequestHandler
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    void flowControlMiddleware(req, res, async () => {
      const delayMs = randomDelayMs();
      logger.debug('demo handler: starting work', { delayMs });
      await sleep(delayMs);
      writeSecureHead(res, 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, processedMs: delayMs }));
      logger.debug('demo handler: work complete', { delayMs });
    });
  };
}
