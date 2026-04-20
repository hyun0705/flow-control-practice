/**
 * static.ts — 정적 파일 서빙
 * fs.readFileSync 기반, MIME 타입 매핑 포함.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { writeSecureHead } from './responseHelpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  let urlPath = req.url ?? '/';
  if (urlPath === '/') {
    urlPath = '/index.html';
  }

  // 경로 순회 방지 — path.resolve로 완전히 정규화한 후 접두사 비교
  // path.normalize만으로는 인코딩 우회 공격을 막지 못할 수 있다.
  const filePath = path.resolve(PUBLIC_DIR, urlPath.replace(/^\//, ''));

  // PUBLIC_DIR + path.sep 접두사 비교: 심볼릭 링크 우회 및 정규화 우회 방지
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    writeSecureHead(res, 403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    writeSecureHead(res, 200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      writeSecureHead(res, 404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      logger.error('Static file error', { path: filePath, err: nodeErr.message });
      writeSecureHead(res, 500);
      res.end('Internal Server Error');
    }
  }
}
