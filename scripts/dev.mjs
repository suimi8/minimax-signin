/**
 * 本地开发服务器（模拟 Vercel 的路由与 handler 签名）
 *   node scripts/dev.mjs         # 默认 http://localhost:3000
 *   PORT=8080 node scripts/dev.mjs
 *
 * 静态预览（直接打开 public/index.html）下 /api/* 不存在会 404，
 * 用这个脚本才能真正跑通接口。
 */
import { createServer } from 'node:http';
import { loadEnv } from '../lib/load-env.mjs';

await loadEnv(); // 本地开发：读取 .env（云端由平台注入，此行无副作用）
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);

// 本地开发服务器不该因为单个请求异常就整个退出
process.on('uncaughtException', (e) => console.error('[dev] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[dev] unhandledRejection:', e));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function shimRes(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data, null, 2));
    return res;
  };
  return res;
}

async function handleApi(req, res, pathname) {
  const rel = pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  if (!rel) return res.status(404).json({ ok: false, error: 'unknown api' });

  const file = join(ROOT, 'api', rel + '.js');
  if (!existsSync(file)) return res.status(404).json({ ok: false, error: `no such route: /api/${rel}` });

  try {
    // 加 ?ts= 保证修改 handler 后下次请求能拿到新版本（不需要重启 dev 服务）
    const mod = await import(pathToFileURL(file).href + '?ts=' + Date.now());
    const handler = mod.default;
    if (typeof handler !== 'function') throw new Error(`${rel} 未导出 default handler`);

    // query
    const u = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(u.searchParams.entries());

    // body
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json') && raw) {
        try {
          req.body = JSON.parse(raw);
        } catch {
          req.body = raw;
        }
      } else {
        req.body = raw || undefined;
      }
    }

    await handler(req, res);
  } catch (err) {
    console.error(`[api] /api/${rel} 异常:`, err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  }
}

async function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') {
    res.statusCode = 204;
    return res.end();
  }
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = join(ROOT, 'public', normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(join(ROOT, 'public'))) return res.status(403).end('forbidden');

  try {
    const st = await stat(file);
    if (st.isDirectory()) file = join(file, 'index.html');
  } catch {
    return res.status(404).end('not found');
  }
  try {
    const buf = await readFile(file);
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.end(buf);
  } catch {
    res.status(404).end('not found');
  }
}

createServer(async (req, res) => {
  // res.status()/res.json() 必须对所有响应生效，否则 404 分支会抛
  // "res.status is not a function" 直接把进程打挂
  shimRes(res);
  const pathname = new URL(req.url, 'http://localhost').pathname;
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${req.method} ${pathname}`);

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(`[dev] ${req.method} ${pathname} 未捕获异常:`, err);
    if (!res.headersSent) res.status(500).end('internal error');
    else res.end();
  }
}).listen(PORT, () => {
  console.log(`\n  MiniMax 签到 · 本地服务已启动  ->  http://localhost:${PORT}\n`);
  console.log(`  /               扫码登录页面`);
  console.log(`  /api/status     查看状态`);
  console.log(`  /api/cron       手动执行一次签到\n`);
});
