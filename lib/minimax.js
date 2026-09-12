import { MiniMaxClient, UA, randomUUID, randomDeviceId } from './http.js';
import { CookieJar } from './cookie.js';

const ACCOUNT = 'https://account.minimaxi.com';
const AGENT = 'https://agent.minimaxi.com';

const OAUTH_STATE = () =>
  Buffer.from(
    JSON.stringify({ redirect_uri: `${AGENT}/`, csrf: randomUUID() }),
    'utf8'
  ).toString('base64');

const AUTHORIZE_QUERY = (state) =>
  `client_id=agent-minimax` +
  `&redirect_uri=${encodeURIComponent(`${AGENT}/auth/callback`)}` +
  `&response_type=code&source=agent_web&state=${encodeURIComponent(state)}`;

/** 一次不带签名的「浏览器跳转」请求，手动处理 302 与 Cookie */
async function rawGet(url, jar, site) {
  const cookie = jar.headerFor(site);
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: `${site === 'account' ? ACCOUNT : AGENT}/`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    redirect: 'manual',
  });
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
  jar.absorb(site, setCookies);
  return { status: res.status, location: res.headers.get('location'), setCookies };
}

/* ------------------------------------------------------------------ */
/*  登录：微信 code -> MiniMax 会话                                     */
/* ------------------------------------------------------------------ */

/**
 * 用微信扫码得到的 code 换取完整的 MiniMax 会话凭证
 * @param {string} wxCode 微信 wx_code
 * @returns {Promise<{creds: object, user: object}>}
 */
export async function loginWithWxCode(wxCode) {
  const jar = new CookieJar();
  const acc = new MiniMaxClient({ jar });

  // 1) code -> unionID / openID
  const open = await acc.post('/v1/api/user/getOpenData', {
    site: 'account',
    body: { code: wxCode },
  });
  const openJson = await open.json();
  const unionID = openJson?.data?.unionID;
  if (!unionID) {
    throw new Error(`getOpenData 失败: ${JSON.stringify(openJson).slice(0, 300)}`);
  }

  // 2) 用 unionID 登录 SSO，写入 account.minimaxi.com 的会话 Cookie
  const state = OAUTH_STATE();
  const loginRedirect = `/oauth2/authorize?${AUTHORIZE_QUERY(state)}`;
  const login = await acc.post('/oauth2/login', {
    site: 'account',
    body: {
      loginType: '5',
      unionID,
      deviceID: acc.deviceId,
      login_redirect: loginRedirect,
    },
  });
  const loginJson = await login.json();
  if (loginJson?.code !== 0 && !loginJson?.data?.user_id) {
    throw new Error(`oauth2/login 失败: ${JSON.stringify(loginJson).slice(0, 300)}`);
  }

  // 3) 走一次 OAuth2 authorize，换取 agent 域的 code
  const authRes = await rawGet(`${ACCOUNT}/oauth2/authorize?${AUTHORIZE_QUERY(state)}`, jar, 'account');
  if (!authRes.location) {
    throw new Error(`oauth2/authorize 未返回跳转地址 (HTTP ${authRes.status})`);
  }

  // 4) agent 域回调，写入 agent.minimaxi.com 的会话 Cookie
  const cbUrl = authRes.location.startsWith('http') ? authRes.location : `${ACCOUNT}${authRes.location}`;
  const cbRes = await rawGet(cbUrl, jar, 'agent');
  if (cbRes.status >= 400) {
    throw new Error(`auth/callback 失败 (HTTP ${cbRes.status})`);
  }
  if (jar.isEmpty()) {
    throw new Error('登录未能获取到任何 Cookie，可能已被风控拦截，请稍后重试');
  }

  // 5) 换取 token（JWT，约 40 天有效）
  //    注意：token 本体其实已经由 /auth/callback 写进 `_token` Cookie，
  //    renewal 只是用来续期的，失败也不影响登录结果。
  const client = new MiniMaxClient({ jar, uuid: acc.uuid, deviceId: acc.deviceId });
  let token = client.syncTokenFromCookie();
  if (!token) {
    let renewal = await client.post('/v1/api/user/renewal', { site: 'agent' });
    if ((renewal.status === 400 || renewal.status === 403) && client.sendYY) {
      client.sendYY = false;
      renewal = await client.post('/v1/api/user/renewal', { site: 'agent' });
    }
    const renewalJson = await renewal.json();
    token = renewalJson?.data?.token || '';
    if (!token) console.warn('[minimax] renewal 未返回 token:', JSON.stringify(renewalJson).slice(0, 200));
  }
  client.token = token;
  if (loginJson?.data?.str_user_id) client.userId = loginJson.data.str_user_id;

  // 6) 读取用户信息
  let user = null;
  try {
    const info = await client.get('/v1/api/user/info', { site: 'agent' });
    const j = await info.json();
    user = j?.data?.userInfo || null;
    if (user?.realUserID) client.userId = String(user.realUserID);
  } catch (e) {
    console.warn('[minimax] 读取用户信息失败:', e.message);
  }

  return { creds: client.exportCreds(), user };
}

/* ------------------------------------------------------------------ */
/*  签到                                                                */
/* ------------------------------------------------------------------ */

export class SigninSession {
  /** @param {object} creds 来自 store 的凭证 */
  constructor(creds) {
    this.creds = creds || {};
    this.client = new MiniMaxClient({
      jar: this.creds.cookie,
      token: this.creds.token,
      uuid: this.creds.uuid || randomUUID(),
      deviceId: this.creds.deviceId || randomDeviceId(),
      userId: this.creds.userId || '',
    });
    this.tokenRefreshed = false;
    // token 可能没被持久化，但从 _token Cookie 里能直接拿到
    if (!this.client.token) {
      this.client.syncTokenFromCookie();
      if (this.client.token) this.creds.token = this.client.token;
    }
  }

  /**
   * 发起请求；若被网关以 400/403 拒绝且当前带 yy 头，则自动去掉 yy 重试一次。
   * （yy 的构造在个别接口上可能与前端存在差异，降级后仍可正常鉴权）
   */
  async _call(fn) {
    let res = await fn();
    if ((res.status === 400 || res.status === 403) && this.client.sendYY) {
      console.warn(
        `[minimax] 请求被拒 HTTP ${res.status}，去掉 yy 头重试: ${String(res.rawText || '').slice(0, 200)}`
      );
      this.client.sendYY = false;
      this.yyDropped = true;
      res = await fn();
    }
    return res;
  }

  /** token 缺失或即将过期时刷新 */
  async ensureToken() {
    if (this.client.token && jwtExp(this.client.token) > Date.now() / 1000 + 86400) return false;
    const res = await this._call(() => this.client.post('/v1/api/user/renewal', { site: 'agent' }));
    const j = await res.json();
    const token = j?.data?.token;
    if (!token) {
      if (res.status === 401) throw new AuthError('凭证已失效（401），请重新扫码登录');
      throw new Error(`刷新 token 失败: ${JSON.stringify(j).slice(0, 300)}`);
    }
    this.client.token = token;
    this.creds.token = token;
    this.tokenRefreshed = true;
    return true;
  }

  async getUserInfo() {
    const res = await this._call(() => this.client.get('/v1/api/user/info', { site: 'agent' }));
    const j = await res.json();
    if (res.status === 401) throw new AuthError('凭证已失效（401）');
    return j?.data?.userInfo || null;
  }

  /** 签到面板 */
  async getSigninStatus() {
    await this.ensureToken();
    const res = await this._call(() =>
      this.client.get('/minimax-cloud/api/v1/signin/status', { site: 'agent' })
    );
    const j = await res.json();
    if (res.status === 401) throw new AuthError('凭证已失效（401），请重新扫码登录');
    if (j?.base_resp && j.base_resp.status_code !== 0) {
      throw new Error(`signin/status: ${j.base_resp.status_msg || j.base_resp.status_code}`);
    }
    return j?.data || null;
  }

  /** 领取今日签到奖励 */
  async claim() {
    await this.ensureToken();
    const res = await this._call(() =>
      this.client.post('/minimax-cloud/api/v1/signin/claim', { site: 'agent', body: {} })
    );
    const j = await res.json();
    if (res.status === 401) throw new AuthError('凭证已失效（401），请重新扫码登录');
    if (j?.base_resp && j.base_resp.status_code !== 0) {
      const code = j.base_resp.status_code;
      // 常见：今天已领取
      if (/已签|已领|重复|already/i.test(j.base_resp.status_msg || '') || code === 1022100011) {
        return { already: true, raw: j };
      }
      throw new Error(`signin/claim: ${j.base_resp.status_msg || code}`);
    }
    return { already: false, raw: j, data: j?.data || null };
  }

  exportCreds() {
    this.creds.token = this.client.token;
    this.creds.uuid = this.client.uuid;
    this.creds.deviceId = this.client.deviceId;
    this.creds.userId = this.client.userId;
    this.creds.cookie = this.client.jar.toJSON();
    return this.creds;
  }
}

export class AuthError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AuthError';
    this.isAuthError = true;
  }
}

export function jwtExp(token) {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return json.exp || 0;
  } catch {
    return 0;
  }
}

/** 判断今日是否已领取（status: 1=未解锁 2=可领取 3=已领取） */
export function todayStatus(data) {
  const days = data?.days || [];
  const today = days.find((d) => d.is_today) || null;
  return { today, days, needClaim: !!today && today.status === 2 };
}
