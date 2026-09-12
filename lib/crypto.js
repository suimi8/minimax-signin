import { createHash } from 'node:crypto';

/**
 * MiniMax Web 端请求签名
 *
 * 逆向自 MiniMax 前端 chunk（mmx-account / mavis-chat 两个应用一致）：
 *
 *   x-timestamp = Math.floor(Date.parse(new Date().toString()) / 1000)
 *   x-signature = md5(`${x-timestamp}${SALT}${bodyString}`)     // bodyString 为空串表示无 body
 *   yy          = md5(`${encodeURIComponent(urlWithQuery)}_{bodyJson}${md5(timeMs)}ooui`)
 *
 * 其中 SALT = 'I*7Cf%WZ#S&%1RlZJ&C2'
 */

export const SIG_SALT = 'I*7Cf%WZ#S&%1RlZJ&C2';
const YY_SUFFIX = 'ooui';

export function md5(input) {
  return createHash('md5').update(String(input), 'utf8').digest('hex');
}

/** 与浏览器 encodeURIComponent 完全一致的编码 */
export function encodeURIComponentJS(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * x-signature
 * @param {number} timestampSec 秒级时间戳
 * @param {string} bodyString   原始请求体字符串，无 body 时传 ''
 */
export function xSignature(timestampSec, bodyString = '') {
  return md5(`${timestampSec}${SIG_SALT}${bodyString}`);
}

/**
 * yy 头
 * @param {object} o
 * @param {string} o.hasSearchParamsPath 形如 `/minimax-cloud/api/v1/signin/status?a=1&b=2`
 * @param {*}      o.body                请求体对象（POST 才会参与计算）
 * @param {string} o.method              GET / POST
 * @param {number} o.time                毫秒级时间戳（与 unix 参数一致）
 */
export function makeYY({ hasSearchParamsPath, body, method, time }) {
  let bodyPart = '{}';
  if (method && String(method).toLowerCase() === 'post') {
    bodyPart = body ? JSON.stringify(body) : '{}';
  }
  const raw = `${encodeURIComponentJS(hasSearchParamsPath)}_${bodyPart}${md5(String(time))}${YY_SUFFIX}`;
  return md5(raw);
}
