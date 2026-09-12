/**
 * 迁移工具（本地 → 云端 KV）
 *
 * 两种来源，按优先级：
 *   1. .tasks.json   多用户任务，整批搬到 KV（保留原 uid）
 *   2. .creds.json   旧版单用户凭证，新建成一个任务
 *
 *   node scripts/migrate.mjs           # 执行迁移
 *   node scripts/migrate.mjs --force   # 目标已有任务也继续导入
 */
import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/load-env.mjs';

await loadEnv(); // 本地读取 .env

const { newUid, putUser, listUids, activeBackend, storageHint } = await import('../lib/store.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  console.log('目标存储:', storageHint());
  if (activeBackend() !== 'kv') {
    console.error('❌ 当前不是 KV 后端。请在 .env 里配置 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }

  const existing = await listUids();
  if (existing.length && !force) {
    console.error(`❌ KV 里已有 ${existing.length} 个任务，已中止。确认要继续就加 --force`);
    process.exit(1);
  }

  const tasksFile = join(ROOT, '.tasks.json');
  const credsFile = join(ROOT, '.creds.json');
  let done = 0;

  if (await exists(tasksFile)) {
    const db = JSON.parse(await readFile(tasksFile, 'utf8'));
    for (const [uid, t] of Object.entries(db)) {
      if (!uid.startsWith('u_')) continue; // 跳过 __cursor 之类的元数据
      await putUser(uid, t);
      console.log(`  ✅ ${uid}  ${t.name || ''}  ${t.account?.name || '(未绑定)'}`);
      done++;
    }
  }

  if (!done && (await exists(credsFile))) {
    const creds = JSON.parse(await readFile(credsFile, 'utf8'));
    const uid = await newUid();
    await putUser(uid, {
      name: '迁移的账号',
      creds,
      account: null,
      schedule: { hour: 9, minute: 0, tzOffset: 480, enabled: true },
      notify: {},
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    console.log(`  ✅ ${uid}  迁移的账号（来自 .creds.json）`);
    done++;
  }

  if (!done) { console.log('没有可迁移的数据'); return; }
  console.log(`\n迁移完成，共 ${done} 个任务。当前 KV 任务数: ${(await listUids()).length}`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
