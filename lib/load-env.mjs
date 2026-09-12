/**
 * 极简 .env 加载器（仅本地开发用）
 *
 * Vercel / GitHub Actions / Cloudflare 都会自己注入环境变量，
 * 只有本地跑 `node scripts/*.mjs` 或 `npm run dev` 时需要它。
 * 已存在的环境变量不会被覆盖。
 */
import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadEnv(file = join(ROOT, '.env')) {
  try {
    await access(file);
  } catch {
    return false;
  }
  const txt = await readFile(file, 'utf8');
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 去掉成对引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}
