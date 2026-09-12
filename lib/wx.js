/**
 * 微信开放平台扫码登录（snsapi_login）
 * 完全服务端可实现：取 uuid -> 取二维码图片 -> 长轮询换取 code
 */

const WX_APPID = 'wx3572110fad830c98';
const WX_REDIRECT_URI = 'https://chat.minimaxi.com/wxscan';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const QRCONNECT_URL =
  `https://open.weixin.qq.com/connect/qrconnect?appid=${WX_APPID}` +
  `&scope=snsapi_login&redirect_uri=${encodeURIComponent(WX_REDIRECT_URI)}` +
  `&state=hailuo&login_type=jssdk&self_redirect=true&styletype=&sizetype=&bgcolor=&rst=`;

export function qrImageUrl(uuid) {
  return `https://open.weixin.qq.com/connect/qrcode/${uuid}`;
}

/** 创建一个扫码会话，返回 { uuid, qrUrl, qrDataUrl } */
export async function createSession({ withImageDataUrl = true } = {}) {
  const res = await fetch(QRCONNECT_URL, {
    headers: { 'User-Agent': UA, Referer: 'https://account.minimaxi.com/' },
  });
  if (!res.ok) throw new Error(`获取二维码页面失败: HTTP ${res.status}`);
  const html = await res.text();

  const m =
    html.match(/qrconnect\?uuid=([0-9A-Za-z_-]{6,})/) ||
    html.match(/["']uuid["']\s*[:=]\s*["']([0-9A-Za-z_-]{6,})["']/);
  if (!m) throw new Error('未能从微信二维码页面解析出 uuid');
  const uuid = m[1];

  const out = { uuid, qrUrl: qrImageUrl(uuid), qrDataUrl: null };
  if (withImageDataUrl) {
    const img = await fetch(qrImageUrl(uuid), { headers: { 'User-Agent': UA, Referer: QRCONNECT_URL } });
    if (img.ok) {
      const buf = Buffer.from(await img.arrayBuffer());
      out.qrDataUrl = `data:${img.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
    }
  }
  return out;
}

/**
 * 长轮询扫码状态
 * @returns {Promise<{errcode:number, code:string|null}>}
 *   408 等待扫码 | 404 已扫码待确认 | 405 成功(code 可用) | 403 已拒绝 | 402/400 二维码过期
 */
export async function pollOnce(uuid, last = '', timeoutMs = 25000) {
  const url = `https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${encodeURIComponent(uuid)}${
    last ? `&last=${last}` : ''
  }`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: QRCONNECT_URL },
      signal: controller.signal,
    });
    const text = await res.text();
    const ec = /window\.wx_errcode\s*=\s*(\d+)/.exec(text);
    const cd = /window\.wx_code\s*=\s*'([^']*)'/.exec(text);
    return { errcode: ec ? Number(ec[1]) : -1, code: cd ? cd[1] : null };
  } catch (err) {
    // 超时视为「继续等待」
    if (err?.name === 'AbortError') return { errcode: 408, code: null };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const WX_STATUS_TEXT = {
  408: '等待扫码',
  404: '已扫码，请在微信上确认',
  405: '扫码成功',
  403: '已取消授权',
  402: '二维码已过期',
  400: '二维码已过期',
  500: '微信服务异常',
};
