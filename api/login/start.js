import { json, checkAdmin } from '../../lib/api.js';
import { createSession } from '../../lib/wx.js';

export default async function handler(req, res) {
  const auth = checkAdmin(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.message });

  try {
    const s = await createSession({ withImageDataUrl: true });
    return json(res, 200, { ok: true, uuid: s.uuid, qrUrl: s.qrUrl, qrDataUrl: s.qrDataUrl });
  } catch (err) {
    return json(res, 200, { ok: false, error: err.message });
  }
}
