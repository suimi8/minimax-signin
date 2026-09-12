import { json, readJson } from '../../lib/api.js';
import { pollOnce, WX_STATUS_TEXT } from '../../lib/wx.js';
import { loginWithWxCode } from '../../lib/minimax.js';
import { getUser, putUser, newUid, storageHint, activeBackend } from '../../lib/store.js';
import { notifyUser } from '../../lib/notify.js';
import { normalizeInput } from '../../lib/tasks.js';

/**
 * 微信 wx_code 是一次性的。若前端并发轮询，多个长轮询会拿到同一个 code
 * 并各自兑换，第二个必然报 "code been used"(40163)。这里做 5 分钟去重。
 */
const CODE_TTL = 5 * 60 * 1000;
const consumedCodes = new Map(); // code -> { ts, uid }
function pruneCodes() {
  const now = Date.now();
  for (const [k, v] of consumedCodes) if (now - v.ts > CODE_TTL) consumedCodes.delete(k);
}

/**
 * 把登录结果写入指定（或新建的）任务。
 * 任务**只在扫码成功后才创建**——避免用户点了按钮却没扫码，留下一条永远绑不上的孤儿记录。
 */
async function bind(uid, creds, user, meta = {}) {
  let task = uid ? await getUser(uid) : null;
  let created = false;
  if (!task) {
    if (!uid) uid = await newUid(); // 传了 uid 就用它（可能是被删后又重新绑定）
    const norm = normalizeInput(meta);
    task = {
      name: meta.name || norm.name || user?.name || '',
      schedule: norm.schedule,
      notify: norm.notify,
      createdAt: new Date().toISOString(),
    };
    created = true;
  } else if (meta && Object.keys(meta).length) {
    // 重新扫码：允许顺带更新备注 / 时间 / 通知
    const norm = normalizeInput({ ...task, ...meta });
    task.name = meta.name ?? task.name ?? '';
    task.schedule = norm.schedule;
    task.notify = { ...(task.notify || {}), ...norm.notify };
  }
  task.creds = creds;
  task.account = {
    name: user?.name || '',
    userId: user?.realUserID ? String(user.realUserID) : '',
    avatar: user?.avatar || '',
    retentionDays: user?.retentionDays ?? null,
  };
  task.status = 'active';
  task.lastError = null;
  task.failedAttempts = 0;
  await putUser(uid, task);
  return { uid, created, task };
}

export default async function handler(req, res) {
  try {
    const { uuid, last = '', uid, meta = {} } = await readJson(req);
    if (!uuid) return json(res, 200, { ok: false, error: '缺少 uuid，请先调用 /api/login/start' });

    const { errcode, code } = await pollOnce(uuid, last, 20000);

    if (errcode === 405 && code) {
      pruneCodes();
      const cached = consumedCodes.get(code);
      if (cached) {
        // 同一 code 已消费过，直接复用，避免 40163
        const t = await getUser(cached.uid);
        return json(res, 200, {
          ok: true,
          done: true,
          duplicate: true,
          uid: cached.uid,
          account: t?.account || null,
          storage: storageHint(),
        });
      }

      const { creds, user } = await loginWithWxCode(code);
      const { uid: finalUid, task } = await bind(uid, creds, user, meta);
      consumedCodes.set(code, { ts: Date.now(), uid: finalUid });

      try {
        await notifyUser(
          task.notify,
          'MiniMax 签到任务已绑定',
          `账号：${user?.name || '-'}\n管理链接：/?uid=${finalUid}\n绑定时间：${new Date().toLocaleString('zh-CN')}`,
          { uid: finalUid }
        );
      } catch {}

      const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      return json(res, 200, {
        ok: true,
        done: true,
        uid: finalUid,
        manageUrl: `${origin}/?uid=${finalUid}`,
        account: task.account,
        storage: { backend: activeBackend(), hint: storageHint() },
      });
    }

    if (errcode === 403 || errcode === 402 || errcode === 400) {
      return json(res, 200, {
        ok: true,
        done: false,
        expired: true,
        errcode,
        message: WX_STATUS_TEXT[errcode] || '已失效',
      });
    }

    return json(res, 200, {
      ok: true,
      done: false,
      errcode,
      message: WX_STATUS_TEXT[errcode] || `微信状态码 ${errcode}`,
      nextLast: errcode === 404 ? '404' : '',
    });
  } catch (err) {
    console.error('[poll]', err);
    return json(res, 200, { ok: false, error: err.message });
  }
}
