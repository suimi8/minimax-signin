/**
 * Cloudflare Worker 入口
 *
 * 一个 Worker 同时承担：
 *   - scheduled()：Cron Trigger，定时批量签到
 *   - fetch()：/api/* 接口 + 静态托管 public/ 下的页面
 *
 * 部署：
 *   npm i -g wrangler
 *   wrangler secret put KV_REST_API_URL
 *   wrangler secret put KV_REST_API_TOKEN
 *   wrangler secret put CRON_SECRET      # 可选
 *   wrangler secret put ADMIN_TOKEN      # 可选
 *   wrangler deploy
 */

import cronHandler from '../api/cron.js';
import tasksHandler from '../api/tasks.js';
import statusHandler from '../api/status.js';
import loginStartHandler from '../api/login/start.js';
import loginPollHandler from '../api/login/poll.js';

const ROUTES = {
  '/api/cron': cronHandler,
  '/api/tasks': tasksHandler,
  '/api/status': statusHandler,
  '/api/login/start': loginStartHandler,
  '/api/login/poll': loginPollHandler,
};

/** 把 Worker 的 env 绑定注入 process.env，让 lib 里统一的环境读取能拿到 */
function injectEnv(env) {
  globalThis.process = globalThis.process || {};
  globalThis.process.env = { ...(globalThis.process.env || {}), ...env };
}

/** 极简 Vercel handler <-> Worker 适配层 */
function makeReq(request, url) {
  return Object.assign(request, {
    query: Object.fromEntries(url.searchParams.entries()),
    // body 由 handler 自己用 readJson 解析（request 本身是异步可迭代的）
  });
}

function makeRes() {
  const headers = new Headers();
  let statusCode = 200;
  let body = null;
  const res = {
    headers,
    get statusCode() { return statusCode; },
    set statusCode(v) { statusCode = v; },
    get headersSent() { return false; },
    status(code) { statusCode = code; return res; },
    setHeader(k, v) { headers.set(k, v); return res; },
    getHeader(k) { return headers.get(k); },
    json(data) {
      headers.set('Content-Type', 'application/json; charset=utf-8');
      body = JSON.stringify(data, null, 2);
      return res;
    },
    end(text) {
      if (text !== undefined && text !== null) body = String(text);
      return res;
    },
    toResponse() {
      return new Response(body ?? '', { status: statusCode, headers });
    },
  };
  return res;
}

async function handleApi(request, url) {
  const pathname = url.pathname.replace(/\/+$/, '');
  const handler = ROUTES[pathname];
  if (!handler) {
    return Response.json({ ok: false, error: `no such route: ${pathname}` }, { status: 404 });
  }
  const req = makeReq(request, url);
  const res = makeRes();
  await handler(req, res);
  return res.toResponse();
}

export default {
  /** Cron Trigger */
  async scheduled(event, env, ctx) {
    injectEnv(env);
    try {
      const { runBatch } = await import('../lib/runner.js');
      const s = await runBatch(null);
      console.log(
        `[cron] 到点 ${s.due} / 处理 ${s.processed} / 成功 ${s.success} / 失败 ${s.failed} / ${s.ms}ms`
      );
    } catch (e) {
      console.error('[cron] 失败:', e);
    }
  },

  /** HTTP */
  async fetch(request, env, ctx) {
    injectEnv(env);
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) return handleApi(request, url);

    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    // 静态资源由 Wrangler 的 [assets] 托管，这里兜底返回首页
    return new Response(
      '<meta http-equiv="refresh" content="0;url=/index.html">',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  },
};
