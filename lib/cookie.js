/**
 * 极简 Cookie Jar
 * 按「站点」分组保存，避免 account.minimaxi.com 与 agent.minimaxi.com 的同名 Cookie 互相覆盖。
 */

const SITES = ['account', 'agent'];

export class CookieJar {
  constructor(seed) {
    this.sites = { account: new Map(), agent: new Map() };
    if (seed) this.load(seed);
  }

  /** seed: { account: 'a=1; b=2', agent: 'x=3' } 或 JSON 字符串 */
  load(seed) {
    let obj = seed;
    if (typeof seed === 'string') {
      try {
        obj = JSON.parse(seed);
      } catch {
        obj = { agent: seed };
      }
    }
    for (const site of SITES) {
      const raw = obj?.[site];
      if (typeof raw === 'string' && raw) {
        for (const [k, v] of parseCookieString(raw)) this.sites[site].set(k, v);
      }
    }
    return this;
  }

  /** @returns {{account: string, agent: string}} */
  toJSON() {
    const out = {};
    for (const site of SITES) {
      out[site] = [...this.sites[site].entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return out;
  }

  /** 供 Cookie 请求头使用 */
  headerFor(site) {
    return [...this.sites[site].entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** 解析响应中的 set-cookie（Node fetch 用 headers.getSetCookie()） */
  absorb(site, setCookies) {
    const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
    for (const raw of list) {
      if (!raw) continue;
      const first = raw.split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      // 值为空且带过期时间 => 删除
      if (value === '' || /expires=thu, 01 jan 1970/i.test(raw)) {
        this.sites[site].delete(name);
      } else {
        this.sites[site].set(name, value);
      }
    }
    return this;
  }

  isEmpty() {
    return SITES.every((s) => this.sites[s].size === 0);
  }
}

export function parseCookieString(str) {
  const out = [];
  for (const part of String(str).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
  }
  return out;
}

export function siteOf(url) {
  const host = new URL(url).host;
  if (host.startsWith('account.')) return 'account';
  if (host.startsWith('agent.')) return 'agent';
  return 'agent';
}
