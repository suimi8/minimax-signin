import { md5, xSignature, makeYY } from './crypto.js';
import { CookieJar, siteOf } from './cookie.js';

const BASE = {
  account: 'https://account.minimaxi.com',
  agent: 'https://agent.minimaxi.com',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function randomUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function randomDeviceId() {
  return String(Math.floor(Math.random() * 9e17) + 1e17);
}

/**
 * MiniMax 接口客户端
 * 负责：Cookie 管理、公共 query 参数、x-signature / yy 签名
 */
export class MiniMaxClient {
  constructor({ jar, token, uuid, deviceId, userId, sendYY = true } = {}) {
    this.jar = jar instanceof CookieJar ? jar : new CookieJar(jar);
    this.token = token || '';
    this.uuid = uuid || randomUUID();
    this.deviceId = deviceId || randomDeviceId();
    this.userId = userId || '';
    /** 是否发送 yy 头；服务端若拒绝会自动降级为 false */
    this.sendYY = sendYY;
  }

  /**
   * token（JWT）实际由 /auth/callback 下发的 `_token` Cookie 携带。
   * 没有 token 时直接从 Cookie 里取，避免 /v1/api/user/renewal 在无 token 情况下被拒。
   */
  syncTokenFromCookie() {
    if (this.token) return this.token;
    const t = this.jar.sites.agent?.get('_token');
    if (t && t.split('.').length === 3) this.token = t;
    return this.token;
  }

  /** 导出可持久化的凭证 */
  exportCreds() {
    return {
      cookie: this.jar.toJSON(),
      token: this.token,
      uuid: this.uuid,
      deviceId: this.deviceId,
      userId: this.userId,
    };
  }

  /** 与浏览器一致的公共 query 参数（顺序敏感，影响 yy） */
  _params(site, timeMs, extra = {}) {
    const p = {
      device_platform: 'web',
      biz_id: 3,
      app_id: 3001,
      version_code: 22201,
      unix: timeMs,
      timezone_offset: -new Date().getTimezoneOffset() * 60,
    };
    if (site === 'account') {
      p.lang = 'zh';
      p.sys_language = 'zh';
    } else {
      p.sys_language = 'zh';
      p.lang = 'zh';
    }
    p.uuid = this.uuid;
    p.device_id = this.deviceId;
    p.os_name = 'Windows';
    p.browser_name = 'Chrome';
    p.device_memory = 32;
    p.cpu_core_num = 20;
    p.browser_language = 'zh-CN';
    p.browser_platform = 'Win32';
    if (site !== 'account' && this.userId) p.user_id = this.userId;
    p.screen_width = 1920;
    p.screen_height = 1080;
    if (site !== 'account' && this.token) p.token = this.token;
    p.client = 'web';
    return { ...p, ...extra };
  }

  /**
   * @param {string} path 以 / 开头，如 /minimax-cloud/api/v1/signin/status
   */
  async request(path, { method = 'GET', body, site, params: extraParams, rawBody, timeout = 20000 } = {}) {
    site = site || siteOf(BASE.agent + path);
    const timeMs = Date.parse(new Date().toString());
    const timestampSec = Math.floor(timeMs / 1000);

    const params = this._params(site, timeMs, extraParams);
    const qs = new URLSearchParams(
      Object.entries(params).reduce((acc, [k, v]) => {
        if (v !== null && v !== undefined) acc[k] = String(v);
        return acc;
      }, {})
    ).toString();

    const url = `${BASE[site]}${path}${path.includes('?') ? '&' : '?'}${qs}`;

    // body 处理：x-signature 用「原始字符串」，yy 用「对象」
    let bodyString = '';
    if (rawBody !== undefined) bodyString = rawBody;
    else if (body !== undefined) bodyString = typeof body === 'string' ? body : JSON.stringify(body);

    const hasSearchParamsPath = `${path}${path.includes('?') ? '&' : '?'}${qs}`;

    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `${BASE[site]}/`,
      'x-timestamp': String(timestampSec),
      'x-signature': xSignature(timestampSec, bodyString),
      token: this.token || '',
    };
    if (this.sendYY) headers.yy = makeYY({ hasSearchParamsPath, body, method, time: timeMs });
    if (bodyString) headers['Content-Type'] = 'application/json';

    const cookie = this.jar.headerFor(site);
    if (cookie) headers.Cookie = cookie;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyString || undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
      // 收集 Set-Cookie
      const setCookies =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean);
      this.jar.absorb(site, setCookies);

      // 一次性读完 body，便于重试 / 多次解析
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        location: res.headers.get('location'),
        setCookies,
        // 注意：不能用 `text` 作属性名，会被下面的 text() 方法覆盖
        rawText: text,
        async text() {
          return text;
        },
        async json() {
          try {
            return JSON.parse(text);
          } catch {
            return { __raw: text };
          }
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  get(path, opts = {}) {
    return this.request(path, { ...opts, method: 'GET' });
  }

  post(path, opts = {}) {
    return this.request(path, { ...opts, method: 'POST', body: opts.body ?? {} });
  }
}

export { md5, UA, BASE };
