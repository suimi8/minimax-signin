import { json, readJson, checkAdmin } from '../lib/api.js';
import { newUid, getUser, putUser, deleteUser, listUids, getUsers, storageHint } from '../lib/store.js';
import { normalizeInput, describeSchedule, isDue, todayKey } from '../lib/tasks.js';

/** 对外脱敏：绝不把 Cookie / token 吐给前端 */
function safe(u) {
  if (!u) return null;
  return {
    uid: u.uid,
    name: u.name || '',
    account: u.account || null,
    schedule: u.schedule || null,
    scheduleText: describeSchedule(u),
    notify: {
      bark: u.notify?.bark ? '***' : '',
      serverchan: u.notify?.serverchan ? '***' : '',
      webhook: u.notify?.webhook ? '***' : '',
      telegram: u.notify?.telegramChatId ? '***' : '',
    },
    hasCreds: !!u.creds?.cookie?.agent,
    status: u.status || (u.creds ? 'active' : 'pending'),
    lastRunDate: u.lastRunDate || null,
    lastRunAt: u.lastRunAt || null,
    lastResult: u.lastResult || null,
    lastError: u.lastError || null,
    due: isDue(u),
    updatedAt: u.updatedAt || null,
  };
}

export default async function handler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  const uid = req.query?.uid;

  try {
    /* ---------- 创建任务 ---------- */
    if (method === 'POST') {
      const body = await readJson(req);
      const id = await newUid();
      const task = {
        ...normalizeInput(body),
        creds: null,
        account: null,
        status: 'pending', // 待扫码
        createdAt: new Date().toISOString(),
      };
      await putUser(id, task);
      const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      return json(res, 200, {
        ok: true,
        uid: id,
        manageUrl: `${origin}/?uid=${id}`,
        task: safe({ ...task, uid: id }),
      });
    }

    /* ---------- 查询 ---------- */
    if (method === 'GET') {
      if (uid) {
        const u = await getUser(uid);
        if (!u) return json(res, 200, { ok: false, error: '任务不存在' });
        return json(res, 200, { ok: true, task: safe(u), storage: storageHint() });
      }
      // 无 uid = 管理员列表
      const auth = checkAdmin(req);
      if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.message });
      const users = await getUsers(await listUids());
      return json(res, 200, {
        ok: true,
        storage: storageHint(),
        total: users.length,
        tasks: users.map(safe),
      });
    }

    /* ---------- 更新 ---------- */
    if (method === 'PATCH') {
      if (!uid) return json(res, 200, { ok: false, error: '缺少 uid' });
      const u = await getUser(uid);
      if (!u) return json(res, 200, { ok: false, error: '任务不存在' });
      const body = await readJson(req);
      const merged = normalizeInput({ ...u, ...body });
      // 通知字段允许部分覆盖：不传则保留原值
      const notify = { ...(u.notify || {}) };
      for (const k of Object.keys(notify)) {
        if (body.notify && k in body.notify) notify[k] = body.notify[k];
      }
      const next = { ...u, ...merged, notify };
      if (body.enabled !== undefined) next.schedule = { ...next.schedule, enabled: body.enabled !== false };
      if (body.lastRunDate === null) next.lastRunDate = null; // 允许重置以便重跑
      await putUser(uid, next);
      return json(res, 200, { ok: true, task: safe(next) });
    }

    /* ---------- 删除 ---------- */
    if (method === 'DELETE') {
      if (!uid) return json(res, 200, { ok: false, error: '缺少 uid' });
      await deleteUser(uid);
      return json(res, 200, { ok: true, deleted: uid });
    }

    return json(res, 405, { ok: false, error: 'Method Not Allowed' });
  } catch (err) {
    console.error('[tasks]', err);
    return json(res, 200, { ok: false, error: err.message });
  }
}
