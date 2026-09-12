/**
 * 命令行批量签到（给 GitHub Actions / crontab / 任何能跑 Node 的地方用）
 *
 *   node scripts/cron-run.mjs            # 按调度处理所有到点任务
 *   node scripts/cron-run.mjs --dry      # 只列出到点任务，不执行
 *   node scripts/cron-run.mjs --uid=u_x  # 只跑指定任务
 *
 * 环境变量：
 *   KV_REST_API_URL / KV_REST_API_TOKEN   （或 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）
 *   CRON_CONCURRENCY  并发数，默认 10
 *   CRON_BUDGET_MS    时间预算，默认 240000
 */
import { loadEnv } from '../lib/load-env.mjs';

await loadEnv(); // 本地读取 .env

import { runBatch, collectDue } from '../lib/runner.js';
import { describeSchedule } from '../lib/tasks.js';
import { storageHint } from '../lib/store.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const uidArg = args.find((a) => a.startsWith('--uid='));
const uid = uidArg ? uidArg.slice(6) : null;

async function main() {
  console.log('存储后端:', storageHint());

  if (dry) {
    const users = await collectDue();
    console.log(`到点任务 ${users.length} 个：`);
    for (const u of users) {
      console.log(`  - ${u.uid}  ${u.account?.name || u.name || ''}  ${describeSchedule(u)}  [${u.status}]`);
    }
    return;
  }

  const s = await runBatch(uid);
  console.log(
    `\n完成：到点 ${s.due} / 处理 ${s.processed} / 成功 ${s.success} / 失败 ${s.failed}` +
      `${s.stoppedByBudget ? ' / 预算中断（剩余下轮继续）' : ''} / 耗时 ${s.ms}ms\n`
  );
  for (const r of s.results) {
    const detail = r.ok ? JSON.stringify(r.result) : r.error;
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.uid} ${r.name || ''} ${detail || ''}`);
  }
  if (s.failed > 0) process.exitCode = 1; // 让 CI 标红，但不影响已成功的用户
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
