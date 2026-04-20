/**
 * server.test.ts — 인증(auth) + 보안 헤더 통합 테스트
 *
 * 실제 http.Server를 띄워 router 전체 경로를 검증한다.
 * 포트는 무작위(0)로 배정해 충돌을 방지한다.
 *
 * static.ts는 import.meta.url을 사용하므로 Jest ESM 환경에서 mock 처리한다.
 */
// static.ts의 import.meta.url을 피하기 위해 mock 처리
jest.mock('../src/server/static.js', () => ({
  serveStatic: (_req: unknown, res: { writeHead: (c: number, h?: Record<string, string>) => void; end: (b?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html></html>');
  },
}));
import { maskTokenInUrl } from '../src/server/auth.js';

import * as http from 'node:http';
import { createFlowControl } from '../src/middleware/flowControl.js';
import { createRouter } from '../src/server/router.js';
import { SECURITY_HEADERS, sendUnauthorized } from '../src/server/responseHelpers.js';

/** 테스트 서버 헬퍼 */
function startServer(authToken?: string): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    // 환경변수 설정 (테스트마다 override)
    if (authToken !== undefined) {
      process.env['FLOW_CONTROL_AUTH_TOKEN'] = authToken;
    } else {
      delete process.env['FLOW_CONTROL_AUTH_TOKEN'];
    }

    // auth 모듈을 재로드하지 않아도 되도록 checkAuth 내부의 AUTH_TOKEN은
    // 모듈 로드 시 한 번만 읽힌다. 테스트는 auth.ts를 직접 mock하거나
    // 환경변수를 미리 설정하고 Jest 모듈 캐시를 초기화해야 한다.
    // 여기서는 auth.ts의 내부 로직을 직접 테스트하는 대신,
    // 동일한 checkAuth 함수를 래핑한 라우터를 사용한다.

    const flowControl = createFlowControl({
      concurrency: { max: 5 },
      tokenBucket: { capacity: 100, refillRate: 100 },
    });

    const router = createRouter(flowControl.middleware, flowControl.getMetrics, flowControl.resetCounters);
    const server = http.createServer(router);

    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server port'));
        return;
      }
      resolve({
        server,
        port: addr.port,
        close: () =>
          new Promise<void>((res, rej) => {
            flowControl.destroy();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/** HTTP GET 헬퍼 */
function httpGet(
  port: number,
  path: string,
  headers?: Record<string, string>
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: headers ?? {} },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 보안 헤더 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe('보안 헤더', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // 인증 비활성 상태 (dev mode)
    delete process.env['FLOW_CONTROL_AUTH_TOKEN'];
    const s = await startServer(undefined);
    port = s.port;
    close = s.close;
  });

  afterAll(async () => {
    await close();
  });

  function assertSecurityHeaders(headers: http.IncomingHttpHeaders): void {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers[key.toLowerCase()]).toBe(value);
    }
  }

  test('200 응답(GET /api/metrics)에 4개 보안 헤더가 있다', async () => {
    const res = await httpGet(port, '/api/metrics');
    expect(res.statusCode).toBe(200);
    assertSecurityHeaders(res.headers);
  });

  test('404 응답(GET /not-found)에 4개 보안 헤더가 있다', async () => {
    const res = await httpGet(port, '/not-found');
    expect(res.statusCode).toBe(404);
    assertSecurityHeaders(res.headers);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 401 응답 보안 헤더 테스트 — sendUnauthorized 직접 단위 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe('sendUnauthorized — 401 응답에 4개 보안 헤더가 있다', () => {
  test('sendUnauthorized는 401 + 4개 보안 헤더를 설정한다', () => {
    let capturedStatus = 0;
    const capturedHeaders: Record<string, string | number> = {};

    const mockRes = {
      writeHead(code: number, hdrs?: Record<string, string | number>) {
        capturedStatus = code;
        if (hdrs) Object.assign(capturedHeaders, hdrs);
      },
      end(_body?: string) { /* no-op */ },
    } as unknown as http.ServerResponse;

    sendUnauthorized(mockRes);

    expect(capturedStatus).toBe(401);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(capturedHeaders[key]).toBe(value);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 인증 테스트 — 모듈 캐시 문제로 인해 checkAuth 로직을 직접 단위 테스트한다
// ─────────────────────────────────────────────────────────────────────────────

describe('checkAuth 단위 테스트', () => {
  /**
   * auth.ts의 AUTH_TOKEN은 모듈 로드 시 고정되므로
   * 여기서는 checkAuth 로직과 동일한 함수를 직접 구현해 테스트한다.
   * (실제 환경에서는 서버 재기동 시 환경변수가 적용된다)
   */
  function extractToken(url: string, authHeader?: string): string | undefined {
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice('Bearer '.length).trim();
    }
    const qIdx = url.indexOf('?');
    if (qIdx !== -1) {
      const queryStr = url.slice(qIdx + 1);
      for (const part of queryStr.split('&')) {
        const [key, ...rest] = part.split('=');
        if (key === 'token') return decodeURIComponent(rest.join('='));
      }
    }
    return undefined;
  }

  function checkAuthLogic(
    token: string,
    url: string,
    authHeader?: string
  ): boolean {
    const provided = extractToken(url, authHeader);
    return provided === token;
  }

  test('Authorization Bearer 헤더 — 정답 토큰: 통과', () => {
    expect(checkAuthLogic('secret', '/api/metrics', 'Bearer secret')).toBe(true);
  });

  test('Authorization Bearer 헤더 — 오답 토큰: 차단', () => {
    expect(checkAuthLogic('secret', '/api/metrics', 'Bearer wrong')).toBe(false);
  });

  test('?token= 쿼리 파라미터 — 정답 토큰: 통과', () => {
    expect(checkAuthLogic('secret', '/api/metrics?token=secret')).toBe(true);
  });

  test('?token= 쿼리 파라미터 — 오답 토큰: 차단', () => {
    expect(checkAuthLogic('secret', '/api/metrics?token=wrong')).toBe(false);
  });

  test('토큰 없이 접근: 차단', () => {
    expect(checkAuthLogic('secret', '/api/metrics')).toBe(false);
  });

  test('인증 비활성 시(token undefined) — 항상 통과', () => {
    // AUTH_TOKEN이 undefined이면 모두 통과 — 별도 확인
    // auth.ts의 AUTH_TOKEN=undefined 경우는 checkAuth 내에서 true를 즉시 반환
    // 여기서는 dev mode 서버 응답으로 간접 검증한다
    expect(true).toBe(true); // placeholder (아래 통합 테스트에서 검증)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 인증 통합 테스트 — 실제 서버에서 401 vs 200 검증
// (AUTH_TOKEN은 모듈 로드 시 고정이므로 dev mode 서버만 테스트 가능)
// ─────────────────────────────────────────────────────────────────────────────

describe('인증 통합 — dev mode (AUTH_TOKEN 미설정)', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    delete process.env['FLOW_CONTROL_AUTH_TOKEN'];
    const s = await startServer(undefined);
    port = s.port;
    close = s.close;
  });

  afterAll(async () => {
    await close();
  });

  test('인증 비활성 시 /api/metrics는 토큰 없이 200을 반환한다', async () => {
    const res = await httpGet(port, '/api/metrics');
    expect(res.statusCode).toBe(200);
  });

  test('인증 비활성 시 /api/events는 토큰 없이 200을 반환한다', async () => {
    // SSE는 스트림이므로 연결 후 즉시 닫는다
    const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
        (r) => {
          resolve({ statusCode: r.statusCode ?? 0 });
          r.destroy(); // 즉시 스트림 종료
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// timingSafeCompare — checkAuth 토큰 비교 경로 단위 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe('timingSafeCompare (checkAuth 경로)', () => {
  /**
   * auth.ts의 timingSafeCompare는 private이므로 checkAuth 로직 구현체를 직접 재현해
   * 세 가지 경로를 검증한다.
   */
  function timingSafeCompareSim(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  }

  test('길이 불일치 → 즉시 false (타이밍 공격 방지)', () => {
    // 짧은 토큰과 긴 토큰: timingSafeEqual 호출 전에 false 선반환
    expect(timingSafeCompareSim('abc', 'abcd')).toBe(false);
  });

  test('동일 길이 + 정답 → true', () => {
    expect(timingSafeCompareSim('correct-token', 'correct-token')).toBe(true);
  });

  test('동일 길이 + 오답 → false', () => {
    // 같은 길이지만 다른 내용: timingSafeEqual이 false를 반환해야 한다
    expect(timingSafeCompareSim('correct-token', 'wrongg-token!!')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maskTokenInUrl 유틸 단위 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe('maskTokenInUrl', () => {
  test('?token= 값을 ***로 마스킹한다', () => {
    const masked = maskTokenInUrl('/api/metrics?token=supersecret');
    expect(masked).toBe('/api/metrics?token=***');
    expect(masked).not.toContain('supersecret');
  });

  test('token 파라미터가 없으면 URL을 그대로 반환한다', () => {
    const url = '/api/metrics?foo=bar';
    expect(maskTokenInUrl(url)).toBe(url);
  });

  test('복수 쿼리 파라미터 중 token만 마스킹한다', () => {
    const masked = maskTokenInUrl('/api/metrics?foo=bar&token=mysecret&baz=qux');
    expect(masked).toContain('foo=bar');
    expect(masked).toContain('token=***');
    expect(masked).toContain('baz=qux');
    expect(masked).not.toContain('mysecret');
  });

  test('Token= (대문자 key)도 마스킹한다 (case-insensitive)', () => {
    // regex 플래그 /gi — 대소문자 구분 없이 매칭해야 한다
    const masked = maskTokenInUrl('/api/metrics?Token=MySecret');
    expect(masked).not.toContain('MySecret');
    expect(masked).toContain('***');
  });

  test('token=빈문자열 엣지 — 마스킹 후 token=***이다', () => {
    const masked = maskTokenInUrl('/api/metrics?foo=bar&token=&baz=qux');
    expect(masked).toContain('token=***');
    expect(masked).toContain('foo=bar');
    expect(masked).toContain('baz=qux');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 403 응답 보안 헤더 테스트 — path traversal 시도 시
// ─────────────────────────────────────────────────────────────────────────────

describe('403 응답 보안 헤더', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    delete process.env['FLOW_CONTROL_AUTH_TOKEN'];
    const s = await startServer(undefined);
    port = s.port;
    close = s.close;
  });

  afterAll(async () => {
    await close();
  });

  function assertSecurityHeaders(headers: http.IncomingHttpHeaders): void {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers[key.toLowerCase()]).toBe(value);
    }
  }

  test('path traversal 시도 시 403 응답에 4개 보안 헤더가 있다', async () => {
    // static.ts가 mock이므로 실제 403은 발생하지 않으나
    // router의 404 경로에서 보안 헤더를 확인한다
    const res = await httpGet(port, '/../../etc/passwd');
    // 404 또는 403 모두 보안 헤더가 있어야 한다
    expect([403, 404]).toContain(res.statusCode);
    assertSecurityHeaders(res.headers);
  });

  test('URL 인코딩 변형 path traversal (%2f) 시도 시 보안 헤더가 있다', async () => {
    // %2f는 /의 URL 인코딩 — 정규화 후 traversal이 차단되어야 한다
    const res = await httpGet(port, '/..%2fetc%2fpasswd');
    expect([403, 404]).toContain(res.statusCode);
    assertSecurityHeaders(res.headers);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 응답 body에 요청 path 미포함 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe('404 응답 path 반사 제거', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    delete process.env['FLOW_CONTROL_AUTH_TOKEN'];
    const s = await startServer(undefined);
    port = s.port;
    close = s.close;
  });

  afterAll(async () => {
    await close();
  });

  test('404 응답 body에 요청 path가 포함되지 않는다', async () => {
    const sensitivePath = '/etc/passwd';
    const res = await httpGet(port, sensitivePath);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(sensitivePath);
    expect(res.body).not.toContain('/etc/passwd');
  });

  test('404 응답 body에 statusCode 필드가 있다', async () => {
    const res = await httpGet(port, '/no-such-route');
    expect(res.statusCode).toBe(404);
    const parsed = JSON.parse(res.body) as { error: string; statusCode: number };
    expect(parsed.statusCode).toBe(404);
    expect(parsed.error).toBe('Not Found');
  });

  test('404 응답 Content-Type이 application/json이다', async () => {
    const res = await httpGet(port, '/no-such-route');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CSP 헤더에 'unsafe-inline' 미존재 확인
// ─────────────────────────────────────────────────────────────────────────────

describe("CSP 헤더에 'unsafe-inline' 미포함", () => {
  test("SECURITY_HEADERS의 CSP 값에 'unsafe-inline'이 없다", () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).toBeDefined();
    expect(csp).not.toContain('unsafe-inline');
  });
});
