/**
 * responseHelpers.ts — 공통 HTTP 응답 유틸리티
 *
 * 모든 응답에 일괄 보안 헤더를 주입한다. 헤더 적용 로직을 단일 지점에 두어
 * 누락이나 불일치를 방지한다.
 */
import type * as http from 'node:http';

/**
 * 모든 HTTP 응답에 적용해야 하는 보안 헤더.
 * Content-Security-Policy: 인라인 스타일을 허용하지 않는다.
 * 모든 스타일은 dashboard.css 외부 파일로 관리해야 한다.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * 보안 헤더 + 지정 헤더를 병합하여 writeHead를 호출한다.
 * 모든 응답(200, 401, 404, 503 등)에서 이 함수를 사용해야 한다.
 */
export function writeSecureHead(
  res: http.ServerResponse,
  statusCode: number,
  extraHeaders?: Record<string, string | number>
): void {
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
}

/**
 * 401 Unauthorized 응답을 전송한다.
 */
export function sendUnauthorized(res: http.ServerResponse): void {
  writeSecureHead(res, 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized', statusCode: 401 }));
}
