/**
 * metrics.ts — GET /api/metrics
 * 현재 DashboardMetrics를 JSON으로 반환한다 (polling fallback용).
 */
import type * as http from 'node:http';
import type { DashboardMetrics } from '../../middleware/flowControl.js';
import { writeSecureHead } from '../responseHelpers.js';

export function createMetricsHandler(
  getMetrics: () => DashboardMetrics
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (_req, res) => {
    const metrics = getMetrics();
    writeSecureHead(res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(metrics));
  };
}
