import { json, checkCron } from '../lib/api.js';
import { storageHint } from '../lib/store.js';
import { collectDue, runBatch } from '../lib/runner.js';
import { describeSchedule } from '../lib/tasks.js';

export default async function handler(req, res) {
  const auth = checkCron(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.message });

  try {
    // ?dry=1 只预演，不真的签到
    if (req.query?.dry === '1') {
      const users = await collectDue();
      return json(res, 200, {
        ok: true,
        dry: true,
        due: users.length,
        users: users.map((u) => ({
          uid: u.uid,
          name: u.account?.name || u.name,
          schedule: describeSchedule(u),
          status: u.status,
        })),
      });
    }

    const summary = await runBatch(req.query?.uid || null);
    return json(res, 200, { ok: true, storage: storageHint(), summary });
  } catch (err) {
    console.error('[cron]', err);
    return json(res, 200, { ok: false, error: err.message });
  }
}
