/**
 * 本地自测：读取凭证并执行一次签到
 *   node scripts/check.mjs
 * 凭证来源：环境变量 MINIMAX_CREDS，或项目根目录 .creds.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from '../lib/load-env.mjs';

await loadEnv(); // 本地读取 .env

import { SigninSession, todayStatus } from '../lib/minimax.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function load() {
  if (process.env.MINIMAX_CREDS) return JSON.parse(process.env.MINIMAX_CREDS);
  const p = join(ROOT, '.creds.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  throw new Error('未找到凭证，请先运行 `npm run login`');
}

async function main() {
  const creds = load();
  const s = new SigninSession(creds);

  const user = await s.getUserInfo().catch((e) => ({ __err: e.message }));
  console.log('账号:', user?.name || user.__err, user?.realUserID ? `(ID ${user.realUserID})` : '');

  const st = await s.getSigninStatus();
  const { today, needClaim } = todayStatus(st);
  console.log('签到面板:', JSON.stringify(st?.days || []));

  if (!needClaim) {
    console.log('👉 今日无需签到:', today?.status === 3 ? '已领取' : '不可领取');
  } else {
    const r = await s.claim();
    console.log('👉 签到结果:', JSON.stringify(r.data || r));
  }
  console.log('凭证已刷新 token:', s.tokenRefreshed);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
