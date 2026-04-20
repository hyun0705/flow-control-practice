/**
 * auth.ts — FLOW_CONTROL_AUTH_TOKEN 기반 인증 유틸리티
 *
 * 환경변수 FLOW_CONTROL_AUTH_TOKEN이 설정된 경우:
 *   - Authorization: Bearer <token> 헤더 또는 ?token=<token> 쿼리 파라미터를 검증한다.
 *   - 실패 시 401을 반환한다.
 *
 * 미설정 시:
 *   - 인증을 건너뛴다 (dev mode).
 *   - 서버 기동 시 logger.warn으로 알린다.
 */
import type * as http from 'node:http';
import * as crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { sendUnauthorized } from './responseHelpers.js';

/** 설정된 인증 토큰. 미설정이면 undefined. */
const AUTH_TOKEN: string | undefined = process.env['FLOW_CONTROL_AUTH_TOKEN'] || undefined;

/**
 * 서버 기동 시 인증 상태를 로깅한다.
 * index.ts에서 한 번 호출하면 된다.
 */
export function logAuthStatus(): void {
  if (AUTH_TOKEN === undefined) {
    logger.warn('auth disabled — dev mode (set FLOW_CONTROL_AUTH_TOKEN to enable)');
  } else {
    logger.info('auth enabled — FLOW_CONTROL_AUTH_TOKEN is set');
  }
}

/**
 * 타이밍 공격에 안전한 문자열 비교.
 * 길이가 다르면 즉시 false를 반환한다 (crypto.timingSafeEqual은 동일 길이만 허용).
 * 길이가 같으면 crypto.timingSafeEqual로 비교해 상수 시간을 보장한다.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * URL의 ?token= 쿼리 파라미터 값을 '***'로 마스킹한다.
 * 로그에 토큰 값이 평문으로 남지 않도록 로깅 직전에 호출한다.
 *
 * 예: '/api/metrics?token=secret&foo=bar' → '/api/metrics?token=***&foo=bar'
 */
export function maskTokenInUrl(url: string): string {
  return url.replace(/((?:^|[&?])token=)[^&]*/gi, '$1***');
}

/**
 * 요청에서 Bearer 토큰 또는 ?token= 쿼리 파라미터를 추출한다.
 */
function extractToken(req: http.IncomingMessage): string | undefined {
  // 1. Authorization: Bearer <token> 헤더
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  // 2. ?token=<token> 쿼리 파라미터
  const rawUrl = req.url ?? '';
  const qIdx = rawUrl.indexOf('?');
  if (qIdx !== -1) {
    const queryStr = rawUrl.slice(qIdx + 1);
    for (const part of queryStr.split('&')) {
      const [key, ...rest] = part.split('=');
      if (key === 'token') {
        return decodeURIComponent(rest.join('='));
      }
    }
  }

  return undefined;
}

/**
 * 인증을 검증한다.
 * AUTH_TOKEN이 미설정이면 항상 true(통과).
 * 설정된 경우 요청의 토큰과 비교한다.
 *
 * @returns true면 통과, false면 sendUnauthorized가 호출되었음을 의미한다.
 */
export function checkAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  if (AUTH_TOKEN === undefined) {
    // 인증 비활성 — 모두 통과
    return true;
  }

  const provided = extractToken(req);
  if (provided !== undefined && timingSafeCompare(provided, AUTH_TOKEN)) {
    return true;
  }

  sendUnauthorized(res);
  return false;
}
