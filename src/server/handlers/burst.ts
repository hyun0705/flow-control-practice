/**
 * burst.ts — POST /api/burst?n=N
 *
 * 서버 내부에서 N개의 태스크를 동시에 flowControl 체인에 투입한다.
 * 브라우저의 HTTP/1.1 동시 연결 제한(6) 때문에 클라이언트 측 burst가
 * 서버에 진짜 동시에 도착하지 못하는 문제를 우회한다.
 *
 * 응답은 NDJSON(newline-delimited JSON) 스트리밍으로 전송한다:
 *   {"type":"start","n":30}
 *   {"type":"task","seq":3,"status":200,"processedMs":1240,"elapsedMs":1250}
 *   {"type":"task","seq":7,"status":429,"error":"..."}
 *   ...
 *   {"type":"done","n":30,"elapsedMs":12258,"ok":28,"rateLimited":2,"queueFull":0}
 *
 * 클라이언트는 ReadableStream으로 line-by-line 읽어 각 task 결과를 UI에 표시.
 */
import type * as http from 'node:http';
import type { RequestHandler } from '../../middleware/flowControl.js';
import { logger } from '../../utils/logger.js';
import { SECURITY_HEADERS } from '../responseHelpers.js';

const DEFAULT_N = 20;
const MAX_N = 1000;
const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 2000;

interface TaskOutcome {
  status: number;
  processedMs?: number;
  error?: string;
  elapsedMs: number;
}

function randomDelayMs(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * flowControl 미들웨어 한 번을 mock req/res로 실행해 결과를 회수한다.
 * seq가 주어지면 elapsedMs는 태스크 시작 시점부터 계산.
 */
function runOneTask(middleware: RequestHandler): Promise<TaskOutcome> {
  return new Promise<TaskOutcome>((resolve) => {
    const start = Date.now();
    let settled = false;
    const settle = (r: Omit<TaskOutcome, 'elapsedMs'>): void => {
      if (settled) return;
      settled = true;
      resolve({ ...r, elapsedMs: Date.now() - start });
    };

    const mockReq = {
      method: 'POST',
      url: '/api/burst/task',
      headers: {},
    } as unknown as http.IncomingMessage;

    let statusCode = 200;
    let bodyBuf = '';
    const mockRes = {
      writeHead(code: number): void {
        statusCode = code;
      },
      end(body?: string): void {
        if (body) bodyBuf = body;
        let parsed: { error?: string; processedMs?: number } = {};
        try {
          parsed = bodyBuf ? (JSON.parse(bodyBuf) as typeof parsed) : {};
        } catch {
          // ignore
        }
        settle({
          status: statusCode,
          error: parsed.error,
          processedMs: parsed.processedMs,
        });
      },
    } as unknown as http.ServerResponse;

    void middleware(mockReq, mockRes, async () => {
      const delayMs = randomDelayMs();
      await sleep(delayMs);
      mockRes.end(JSON.stringify({ ok: true, processedMs: delayMs }));
    });
  });
}

export function createBurstHandler(
  flowControlMiddleware: RequestHandler
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const urlStr = req.url ?? '/api/burst';
    const host = req.headers.host ?? 'localhost';
    const url = new URL(urlStr, `http://${host}`);
    const nRaw = parseInt(url.searchParams.get('n') ?? String(DEFAULT_N), 10);
    const n = Math.max(1, Math.min(MAX_N, Number.isFinite(nRaw) ? nRaw : DEFAULT_N));

    // NDJSON 스트리밍 응답
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });

    const write = (obj: unknown): void => {
      res.write(JSON.stringify(obj) + '\n');
    };

    logger.info('burst start', { n });
    const start = Date.now();
    write({ type: 'start', n, startedAt: start });

    let ok = 0;
    let rateLimited = 0;
    let queueFull = 0;
    let other = 0;

    const tasks = Array.from({ length: n }, (_, i) => {
      const seq = i + 1;
      return runOneTask(flowControlMiddleware).then((r) => {
        if (r.status === 200) ok += 1;
        else if (r.status === 429) rateLimited += 1;
        else if (r.status === 503) queueFull += 1;
        else other += 1;

        write({
          type: 'task',
          seq,
          status: r.status,
          processedMs: r.processedMs,
          elapsedMs: r.elapsedMs,
          error: r.error,
        });
      });
    });

    void Promise.all(tasks)
      .then(() => {
        const elapsedMs = Date.now() - start;
        write({
          type: 'done',
          n,
          elapsedMs,
          ok,
          rateLimited,
          queueFull,
          other,
        });
        res.end();
        logger.info('burst done', { n, elapsedMs, ok, rateLimited, queueFull });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('burst failed', { err: message });
        write({ type: 'error', error: message });
        res.end();
      });
  };
}
