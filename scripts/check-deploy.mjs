/**
 * 部署前自检：把每个 api handler 真的 import 一遍，依赖解析失败会立刻抛错。
 *
 * 防止类似 `api/login/poll.js` 里 `'../lib/api.js'` 少写一层 `../` 的问题——
 * Node 启动时是 500（ERR_MODULE_NOT_FOUND），而本地 dev.mjs 因为用动态
 * import 不会失败，所以线上部署才会暴露。
 *
 *   node scripts/check-deploy.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APIS = [
  'api/cron.js',
  'api/status.js',
  'api/tasks.js',
  'api/login/start.js',
  'api/login/poll.js',
];

let failed = 0;
for (const rel of APIS) {
  const url = pathToFileURL(join(ROOT, rel)).href;
  try {
    await import(url);
    console.log(`  ✓ ${rel}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${rel}\n      ${String(e?.message || e).split('\n')[0]}`);
  }
}

if (failed) {
  console.error(`\n❌ ${failed} 个 handler 无法加载，部署前必须修复`);
  process.exit(1);
}
console.log(`\n✓ ${APIS.length} 个 handler 全部能正常 import`);
