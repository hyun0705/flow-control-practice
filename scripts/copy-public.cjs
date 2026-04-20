// copy-public.cjs — postbuild: src/public → dist/public
// Node 16.7+ fs.cpSync. Cross-platform (Windows/macOS/Linux).
// .cjs 확장자로 package.json "type": "module" 영향 없이 CJS로 실행.

const { cpSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

const src = resolve('src/public');
const dst = resolve('dist/public');

if (!existsSync(src)) {
  console.error('[copy-public] source not found: ' + src);
  process.exit(1);
}

cpSync(src, dst, { recursive: true, force: true });
console.log('[copy-public] ' + src + ' -> ' + dst);
