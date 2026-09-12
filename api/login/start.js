import { json, checkAdminIfAny } from '../../lib/api.js';
import { createSession } from '../../lib/wx.js';

/**
 * 创建微信扫码会话。
 * 注意：这是**公开接口**——任何用户都要靠它拿二维码来完成绑定，
 * 绝不能加管理员校验（否则设了 ADMIN_TOKEN 后所有人都扫不了码）。
 * 它本身不泄露任何信息，只返回一个微信侧的 uuid 和二维码图片。
 */
export default async function handler(req, res) {
  const auth = checkAdminIfAny(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.message });

  try {
    const s = await createSession({ withImageDataUrl: true });
    return json(res, 200, { ok: true, uuid: s.uuid, qrUrl: s.qrUrl, qrDataUrl: s.qrDataUrl });
  } catch (err) {
    return json(res, 200, { ok: false, error: err.message });
  }
}
