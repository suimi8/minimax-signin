/**
 * 多租户存储层（Vercel KV / Upstash Redis REST）
 *
 * 数据结构：
 *   idx:users        SET   —— 所有 uid
 *   user:{uid}       JSON  —— 单个用户的完整记录
 *   cursor           —— 上一轮 cron 未处理完的位置（断点续跑）
 *
 * 本地开发（未配置 KV）时退化为项目根目录的多用户 JSON 文件 .tasks.json。
 */

/**
 * 注意：node 内置模块一律按需动态 import，
 * 这样同一份代码也能跑在 Cloudflare Workers / Deno 等无 node:fs 的环境里。
 */
let _ROOT = null;
async function rootDir() {
  if (_ROOT) return _ROOT;
  try {
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    _ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    _ROOT = process.cwd();
  }
  return _ROOT;
}

let FILE_PATH = null;
async function filePath() {
  if (!FILE_PATH) {
    const { join } = await import('node:path');
    FILE_PATH = join(await rootDir(), '.tasks.json');
  }
  return FILE_PATH;
}

async function randomId(bytes = 16) {
  try {
    const { randomBytes } = await import('node:crypto');
    return randomBytes(bytes).toString('base64url');
  } catch {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}


/** 统一的环境变量读取（兼容没有 process 的运行时） */
const env = (k) => (globalThis.process?.env?.[k] ?? globalThis[k] ?? undefined);

const USERS_SET = 'idx:users';
const userKey = (uid) => `user:${uid}`;

/* ------------------------------------------------------------------ */
/*  后端选择                                                            */
/* ------------------------------------------------------------------ */

export function activeBackend() {
  if (env('KV_REST_API_URL') && env('KV_REST_API_TOKEN')) return 'kv';
  if (env('UPSTASH_REDIS_REST_URL') && env('UPSTASH_REDIS_REST_TOKEN')) return 'kv';
  // 仅在有 node:fs 的本地 Node 环境才退化成文件存储
  const isNode = typeof globalThis.process !== 'undefined' && !!globalThis.process.versions?.node;
  if (isNode && !env('VERCEL')) return 'file';
  return 'none';
}

export function storageHint() {
  switch (activeBackend()) {
    case 'kv':
      return 'Vercel KV / Upstash Redis（多用户）';
    case 'file':
      return '本地文件 .tasks.json（仅开发用；部署到云端请配置 KV）';
    default:
      return '未配置存储后端';
  }
}

/* ------------------------------------------------------------------ */
/*  KV（Upstash REST）                                                 */
/* ------------------------------------------------------------------ */

function kv() {
  return {
    url: String(env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL')).replace(/\/+$/, ''),
    token: env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN'),
  };
}

/** 执行单条命令，返回 result */
async function kvCmd(args) {
  const { url, token } = kv();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`KV 命令失败 [${args[0]}]: HTTP ${res.status} ${await res.text()}`);
  const j = await res.json();
  if (j.error) throw new Error(`KV 错误 [${args[0]}]: ${j.error}`);
  return j.result;
}

/** 管道批量执行，返回结果数组 */
async function kvPipeline(commands) {
  const { url, token } = kv();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`KV pipeline 失败: HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j) ? j.map((x) => x.result) : [];
}

/* ------------------------------------------------------------------ */
/*  文件后端（本地开发）                                                */
/* ------------------------------------------------------------------ */

/**
 * 文件后端：必须串行化 + 原子写。
 * 否则并发的 readFile 会读到 writeFile 截断后的空文件，解析失败返回 {}，
 * 下一次写入就把整个库清空了。
 */
let fileLock = Promise.resolve();
function withFileLock(fn) {
  const run = fileLock.then(fn, fn);
  fileLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function fileRead() {
  try {
    await (await import('node:fs/promises')).access(await filePath());
    const fsp = await import('node:fs/promises');
    const txt = await fsp.readFile(await filePath(), 'utf8');
    if (!txt.trim()) return {};
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

async function fileWrite(db) {
  const fsp = await import('node:fs/promises');
  const p = await filePath();
  const tmp = `${p}.${process.pid || 'cf'}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, p);
}

/** 读-改-写必须整体加锁 */
function fileMutate(mutator) {
  return withFileLock(async () => {
    const db = await fileRead();
    const next = await mutator(db);
    if (next !== undefined) await fileWrite(next);
    return next;
  });
}

/* ------------------------------------------------------------------ */
/*  对外 API                                                            */
/* ------------------------------------------------------------------ */

/** 生成不可猜测的 uid（128 bit） */
export async function newUid() {
  return 'u_' + (await randomId(16));
}

export async function getUser(uid) {
  if (activeBackend() === 'kv') {
    const raw = await kvCmd(['GET', userKey(uid)]);
    return raw ? JSON.parse(raw) : null;
  }
  const db = await fileRead();
  return db[uid] || null;
}

export async function putUser(uid, data) {
  const payload = JSON.stringify({ ...data, uid, updatedAt: new Date().toISOString() });
  if (activeBackend() === 'kv') {
    await kvCmd(['SET', userKey(uid), payload]);
    await kvCmd(['SADD', USERS_SET, uid]);
    return;
  }
  await fileMutate((db) => {
    db[uid] = JSON.parse(payload);
    return db;
  });
}

export async function deleteUser(uid) {
  if (activeBackend() === 'kv') {
    await kvCmd(['DEL', userKey(uid)]);
    await kvCmd(['SREM', USERS_SET, uid]);
    return;
  }
  await fileMutate((db) => {
    delete db[uid];
    return db;
  });
}

/** 返回所有 uid */
export async function listUids() {
  if (activeBackend() === 'kv') return (await kvCmd(['SMEMBERS', USERS_SET])) || [];
  return Object.keys(await fileRead());
}

/**
 * 批量读取用户（KV 走 pipeline，每批 50 条）
 * @param {string[]} uids
 * @returns {Promise<object[]>} 只返回存在的记录
 */
export async function getUsers(uids) {
  if (!uids.length) return [];
  if (activeBackend() === 'kv') {
    const out = [];
    for (let i = 0; i < uids.length; i += 50) {
      const chunk = uids.slice(i, i + 50);
      const results = await kvPipeline(chunk.map((u) => ['GET', userKey(u)]));
      results.forEach((raw) => {
        if (raw) {
          try {
            out.push(JSON.parse(raw));
          } catch {}
        }
      });
    }
    return out;
  }
  const db = await fileRead();
  return uids.map((u) => db[u]).filter(Boolean);
}

export async function getAllUsers() {
  return getUsers(await listUids());
}

/* ------------------------------------------------------------------ */
/*  断点续跑游标                                                        */
/* ------------------------------------------------------------------ */

export async function getCursor() {
  if (activeBackend() === 'kv') return (await kvCmd(['GET', 'cursor'])) || null;
  const db = await fileRead();
  return db.__cursor ?? null;
}

export async function setCursor(v) {
  if (activeBackend() === 'kv') {
    if (v == null) await kvCmd(['DEL', 'cursor']);
    else await kvCmd(['SET', 'cursor', String(v)]);
    return;
  }
  await fileMutate((db) => {
    if (v == null) delete db.__cursor;
    else db.__cursor = v;
    return db;
  });
}
