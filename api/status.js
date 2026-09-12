import { json, checkAdmin } from '../lib/api.js';
import { getUser, storageHint } from '../lib/store.js';
import { SigninSession, jwtExp, todayStatus, AuthError } from '../lib/minimax.js';
import { describeSchedule, isDue, todayKey } from '../lib/tasks.js';

/** 实时查询某个任务的账号与签到面板 */
export default async function handler(req, res) {
  const uid = req.query?.uid;
  if (!uid) {
    const auth = checkAdmin(req);
    if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.message });
    return json(res, 200, { ok: false, error: '缺少 uid。可用 /api/tasks 查看全部任务。' });
  }

  try {
    const task = await getUser(uid);
    if (!task) return json(res, 200, { ok: false, error: '任务不存在' });
    if (!task.creds?.cookie?.agent) {
      return json(res, 200, { ok: true, needLogin: true, uid, name: task.name, schedule: describeSchedule(task) });
    }

    const session = new SigninSession(task.creds);
    let user = null;
    let signin = null;
    let error = null;

    try {
      const [u, st] = await Promise.all([
        session.getUserInfo().catch(() => null),
        session.getSigninStatus().catch((e) => {
          throw e;
        }),
      ]);
      user = u;
      signin = st;
    } catch (e) {
      error = e.message;
    }

    // token 可能被续期
    if (session.tokenRefreshed) {
      task.creds = session.exportCreds();
      const { putUser } = await import('../lib/store.js');
      await putUser(uid, task);
    }

    const info = signin ? todayStatus(signin) : null;
    return json(res, 200, {
      ok: true,
      uid,
      needLogin: !!error && /401|凭证已失效/.test(error),
      storage: storageHint(),
      name: task.name,
      account: task.account,
      schedule: task.schedule,
      scheduleText: describeSchedule(task),
      due: isDue(task),
      tokenExpiresAt: task.creds.token ? new Date(jwtExp(task.creds.token) * 1000).toISOString() : null,
      signin: info ? { today: info.today, days: info.days } : null,
      lastRunDate: task.lastRunDate || null,
      lastRunAt: task.lastRunAt || null,
      lastResult: task.lastResult || null,
      lastError: task.lastError || null,
      todayKey: todayKey(task),
      error,
    });
  } catch (err) {
    return json(res, 200, { ok: false, error: err.message });
  }
}
