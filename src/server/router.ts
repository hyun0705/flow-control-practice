/**
 * router.ts — URL + method 기반 switch 라우팅
 */
import * as http from 'node:http';
import { serveStatic } from './static.js';
import { logger } from '../utils/logger.js';
import type { DashboardMetrics, RequestHandler } from '../middleware/flowControl.js';
import { createMetricsHandler } from './handlers/metrics.js';
import { createSseHandler } from './handlers/sse.js';
import { createDemoHandler } from './handlers/demo.js';
import { createBurstHandler } from './handlers/burst.js';
import { createResetHandler } from './handlers/reset.js';
import { checkAuth, maskTokenInUrl } from './auth.js';
import { writeSecureHead } from './responseHelpers.js';

export function createRouter(
  flowControlMiddleware: RequestHandler,
  getMetrics: () => DashboardMetrics,
  resetCounters: () => void
): http.RequestListener {
  const metricsHandler = createMetricsHandler(getMetrics);
  const sseHandler = createSseHandler(getMetrics);
  const demoHandler = createDemoHandler(flowControlMiddleware);
  const burstHandler = createBurstHandler(flowControlMiddleware);
  const resetHandler = createResetHandler(resetCounters);

  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const method = req.method ?? 'GET';
    // URL에서 쿼리스트링 제거 (라우팅용)
    const url = (req.url ?? '/').split('?')[0];

    logger.debug('incoming request', { method, url: maskTokenInUrl(req.url ?? '/') });

    switch (true) {
      case method === 'GET' && url === '/':
      case method === 'GET' && url === '/index.html':
      case method === 'GET' && url === '/dashboard.css':
      case method === 'GET' && url === '/dashboard.js':
        // 정적 파일은 인증 불필요 (대시보드 HTML/CSS/JS 자체는 공개)
        serveStatic(req, res);
        break;

      case method === 'GET' && url === '/api/metrics':
        if (!checkAuth(req, res)) return;
        metricsHandler(req, res);
        break;

      case method === 'GET' && url === '/api/events':
        if (!checkAuth(req, res)) return;
        sseHandler(req, res);
        break;

      case method === 'POST' && url === '/api/demo':
      case method === 'POST' && url === '/api/work':
        if (!checkAuth(req, res)) return;
        demoHandler(req, res);
        break;

      case method === 'POST' && url === '/api/burst':
        if (!checkAuth(req, res)) return;
        burstHandler(req, res);
        break;

      case method === 'POST' && url === '/api/reset':
        if (!checkAuth(req, res)) return;
        resetHandler(req, res);
        break;

      default:
        writeSecureHead(res, 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found', statusCode: 404 }));
        break;
    }
  };
}
