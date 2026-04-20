/**
 * copy-public.mjs — postbuild: src/public → dist/public
 * Node 16.7+ fs.cpSync 사용. 크로스플랫폼 (Windows/macOS/Linux).
 */
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const src = resolve('src/public');
const dst = resolve('dist/public');

if (!existsSync(src)) {
  console.error(`[copy-public] source not found: ${src}`);
  process.exit(1);
}

cpSync(src, dst, { recursive: true, force: true });
console.log(`[copy-public] ${src} → ${dst}`);
