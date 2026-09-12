/**
 * 批量签到执行器（与运行平台无关）
 *
 * Vercel Function / GitHub Actions / Cloudflare Worker 都调用这里，
 * 保证换平台时行为完全一致。
 */

import { listUids, getUsers, getUser, putUser, deleteUser } from './store.js';
import { SigninSession, AuthError, todayStatus } from './minimax.js';
import { isDue, todayKey, pool, localParts } from './tasks.js';
import { notifyUser } from './notify.js';

const CONCURRENCY = Math.max(1, Number(process.env.CRON_CONCURRENCY || 10));
const BUDGET_MS = Math.max(10, Number(process.env.CRON_BUDGET_MS || 240000));
const MAX_ATTEMPTS = 3;

/** 单个用户的签到流程 */
async function runOne(task) {
  const session = new SigninSession(task.creds);
  const status = await session.getSigninStatus();
  const { today, needClaim } = todayStatus(status);

  let result;
  if (!needClaim) {
    result = { skipped: true, reason: today?.status === 3 ? '今日已领取' : '今日不可领取' };
  } else {
    const claim = await session.claim();
    if (claim.already) {
      result = { skipped: true, reason: '今日已领取' };
    } else {
      const d = claim.data || {};
      result = {
        claimed: true,
        points: d.points,
        dayNo: d.day_no,
        expireAt: d.expire_at_ms ? new Date(d.expire_at_ms).toISOString() : null,
      };
    }
  }
  // 迁移 / 旧数据可能没有 account 字段，顺手补上
  if (!task.account) {
    try {
      const u = await session.getUserInfo();
      if (u) {
        task.account = {
          name: u.name || '',
          userId: String(u.realUserID || ''),
          avatar: u.avatar || '',
          retentionDays: u.retentionDays ?? null,
        };
      }
    } catch {}
  }

  task.creds = session.exportCreds(); // token 可能被续期
  return result;
}

/** 处理一个任务：执行 + 落库 + 通知本人 */
async function handleUser(task) {
  const dateKey = todayKey(task);
  let result = null;
  let err = null;

  try {
    result = await runOne(task);
    task.lastRunDate = dateKey;
    task.failedAttempts = 0;
    task.lastError = null;
    task.status = 'active';
  } catch (e) {
    err = e;
    task.failedAttempts = (task.failedAttempts || 0) + 1;
    task.lastError = e.message;
    // 凭证失效或重试次数用尽 → 当天不再重试，避免反复骚扰
    if (e instanceof AuthError || task.failedAttempts >= MAX_ATTEMPTS) {
      task.lastRunDate = dateKey;
      task.status = e instanceof AuthError ? 'expired' : 'failed';
    }
  }

  task.lastResult = result;
  task.lastRunAt = new Date().toISOString();

  try {
    const who = task.account?.name || task.name || task.uid;
    if (err) {
      const needLogin = err instanceof AuthError;
      await notifyUser(
        task.notify,
        'MiniMax 签到失败',
        `账号：${who}\n时间：${task.lastRunAt}\n原因：${err.message}` +
          (needLogin ? '\n\n请打开管理链接重新扫码登录。' : `\n\n（第 ${task.failedAttempts} 次失败）`),
        { uid: task.uid, ok: false }
      );
    } else {
      const txt =
        result.skipped ? `今日无需签到：${result.reason}` :
        `恭喜，签到成功！\n获得积分：${result.points}\n第 ${result.dayNo} 天`;
      await notifyUser(task.notify, 'MiniMax 签到成功', `账号：${who}\n${txt}`, {
        uid: task.uid,
        ok: true,
        ...result,
      });
    }
  } catch (e) {
    console.warn('[runner] 通知失败', task.uid, e.message);
  }

  await putUser(task.uid, task);
  return {
    uid: task.uid,
    name: task.account?.name || task.name,
    ok: !err,
    result,
    error: err?.message || null,
  };
}

/** 取出所有「已绑定凭证且已到点」的任务 */
export async function collectDue() {
  const uids = await listUids();
  const users = await getUsers(uids);
  return users.filter((u) => u.creds?.cookie?.agent && isDue(u));
}

/** 取单个任务（用于手动立即执行） */
export async function collectOne(uid) {
  const u = await getUser(uid);
  return u ? [u] : [];
}

/**
 * 执行批量签到
 * @param {string[]|null} onlyUid 指定单个 uid；null 表示按调度筛选
 */
/**
 * 清理长时间停留在「未绑定」状态的任务。
 * 用户点开扫码却中途放弃会留下这种记录，它们永远不会被执行，只会越堆越多。
 * @param {number} maxAgeMs 超过这个时长仍未绑定就删除，默认 24 小时
 */
export async function purgeStalePending(maxAgeMs = 24 * 60 * 60 * 1000) {
  const users = await getUsers(await listUids());
  const now = Date.now();
  let removed = 0;
  for (const u of users) {
    if (u.creds?.cookie?.agent) continue; // 已绑定，不动
    const created = Date.parse(u.createdAt || u.updatedAt || 0);
    if (!created || now - created < maxAgeMs) continue;
    await deleteUser(u.uid);
    removed++;
  }
  if (removed) console.log(`[runner] 已清理 ${removed} 个超时未绑定的任务`);
  return removed;
}

export async function runBatch(onlyUid = null) {
  const started = Date.now();
  let purged = 0;
  if (!onlyUid) {
    try { purged = await purgeStalePending(); }
    catch (e) { console.warn('[runner] 清理未绑定任务失败:', e.message); }
  }
  const users = onlyUid ? await collectOne(onlyUid) : await collectDue();

  const processed = [];
  let stoppedByBudget = false;
  const BATCH = CONCURRENCY * 3;

  for (let i = 0; i < users.length; i += BATCH) {
    if (Date.now() - started > BUDGET_MS) {
      stoppedByBudget = true;
      break; // 没跑完的下一轮继续（lastRunDate 未写 → 仍然 due）
    }
    const batch = users.slice(i, i + BATCH);
    const out = await pool(batch, CONCURRENCY, handleUser);
    processed.push(
      ...out.map((r, k) =>
        r.ok ? r.value : { uid: batch[k]?.uid, ok: false, result: null, error: r.error }
      )
    );
  }

  return {
    due: users.length,
    processed: processed.length,
    success: processed.filter((p) => p.ok).length,
    failed: processed.filter((p) => !p.ok).length,
    stoppedByBudget,
    purged,
    ms: Date.now() - started,
    results: processed,
  };
}

export { localParts };
