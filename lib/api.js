/**
 * 安全比较。优先用 node:crypto 的 timingSafeEqual，
 * 在没有完整 node:crypto 的运行环境（如 Cloudflare Workers）下退化为普通比较。
 */
let timingSafeEqual = null;
try {
  ({ timingSafeEqual } = await import('node:crypto'));
} catch {
  timingSafeEqual = null;
}

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) return false;
  if (timingSafeEqual) return timingSafeEqual(ab, bb);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function json(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
}

export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string')
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * 鉴权：
 *  - /api/cron 由 Vercel Cron 调用时带 Authorization: Bearer $CRON_SECRET
 *  - 管理接口用 ?token= 或 X-Admin-Token，对应环境变量 ADMIN_TOKEN
 * 未设置对应环境变量时不鉴权（方便本地调试）。
 */
export function checkCron(req) {
  const secret = process.env.CRON_SECRET;
  const admin = process.env.ADMIN_TOKEN;
  if (secret) {
    const auth = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (safeEq(auth, secret)) return { ok: true };
  }
  if (admin) {
    const provided = req.headers?.['x-admin-token'] || req.query?.token || '';
    if (safeEq(provided, admin)) return { ok: true };
  }
  if (!secret && !admin) return { ok: true }; // 本地调试：都没配置则放行
  return { ok: false, status: 401, message: 'Unauthorized: 需要 CRON_SECRET 或 ADMIN_TOKEN' };
}

export function checkAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return { ok: true };
  const provided =
    req.headers?.['x-admin-token'] ||
    (req.query && req.query.token) ||
    (() => {
      const auth = req.headers?.authorization || '';
      return auth.replace(/^Bearer\s+/i, '');
    })();
  if (safeEq(provided, token)) return { ok: true };
  return { ok: false, status: 401, message: 'Unauthorized: ADMIN_TOKEN 不匹配' };
}


/**
 * 「若设置了 ADMIN_TOKEN 且调用方带了口令，则校验」。
 * 用于必须公开的端点（如 /api/login/start）：
 * 没配口令、或没带口令时一律放行，带了就必须是正确的。
 * 这样设了 ADMIN_TOKEN 也不会把普通用户挡在门外。
 */
export function checkAdminIfAny(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return { ok: true };
  const provided =
    req.headers?.['x-admin-token'] ||
    (req.query && req.query.token) ||
    (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided) return { ok: true };
  return safeEq(provided, token)
    ? { ok: true }
    : { ok: false, status: 401, message: 'Unauthorized: ADMIN_TOKEN 不匹配' };
}
