/**
 * sse.ts — GET /api/events
 * SSE 스트림으로 1초마다 DashboardMetrics를 push한다.
 */
import type * as http from 'node:http';
import type { DashboardMetrics } from '../../middleware/flowControl.js';
import { logger } from '../../utils/logger.js';
import { SECURITY_HEADERS } from '../responseHelpers.js';

export function createSseHandler(
  getMetrics: () => DashboardMetrics
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // 즉시 첫 데이터 전송
    const sendMetrics = (): void => {
      try {
        const metrics = getMetrics();
        res.write(`data: ${JSON.stringify(metrics)}\n\n`);
      } catch (err) {
        logger.error('SSE write error', { err });
      }
    };

    sendMetrics();

    const intervalId = setInterval(sendMetrics, 1000);

    req.on('close', () => {
      clearInterval(intervalId);
      logger.debug('SSE client disconnected');
    });

    req.on('error', (err) => {
      clearInterval(intervalId);
      logger.warn('SSE request error', { err: err.message });
    });
  };
}
