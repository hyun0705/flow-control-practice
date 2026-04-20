/**
 * index.ts — 서버 진입점
 * http.createServer, 포트 3000
 */
import * as http from 'node:http';
import { createFlowControl } from './middleware/flowControl.js';
import { createRouter } from './server/router.js';
import { logger } from './utils/logger.js';
import { logAuthStatus } from './server/auth.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const flowControl = createFlowControl({
  concurrency: { max: 3 },
  tokenBucket: { capacity: 10, refillRate: 5 },
  queueTimeout: 30_000,
});

const router = createRouter(
  flowControl.middleware,
  flowControl.getMetrics,
  flowControl.resetCounters
);

const server = http.createServer(router);

server.listen(PORT, () => {
  logger.info(`flow-control-practice server listening on http://localhost:${PORT}`);
  logger.info('Dashboard: http://localhost:' + PORT + '/');
  logger.info('Metrics API: http://localhost:' + PORT + '/api/metrics');
  logger.info('SSE stream: http://localhost:' + PORT + '/api/events');
  logAuthStatus();
});

server.on('error', (err) => {
  logger.error('Server error', { err: err.message });
  process.exit(1);
});

// graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  flowControl.destroy();
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });
});
