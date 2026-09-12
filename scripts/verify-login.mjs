/**
 * 一次性验证脚本：生成二维码 -> 等待扫码 -> 完成登录 -> 实测签到接口
 * 结果写入 login-result.json
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSession, pollOnce } from '../lib/wx.js';
import { loginWithWxCode, SigninSession, todayStatus } from '../lib/minimax.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'login-result.json');
const write = (o) => writeFileSync(OUT, JSON.stringify(o, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  write({ stage: 'creating-qr' });
  const s = await createSession({ withImageDataUrl: true });
  writeFileSync(join(ROOT, 'qr.png'), Buffer.from(s.qrDataUrl.split(',')[1], 'base64'));
  write({ stage: 'waiting-scan', uuid: s.uuid, qrUrl: s.qrUrl, startedAt: new Date().toISOString() });

  const deadline = Date.now() + 10 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const { errcode, code } = await pollOnce(s.uuid, last, 25000);
    if (errcode === 405 && code) {
      write({ stage: 'exchanging', uuid: s.uuid });
      const { creds, user } = await loginWithWxCode(code);
      write({ stage: 'logged-in', user, creds });

      // 实测签到接口（只读，不真的领取）
      try {
        const sess = new SigninSession(creds);
        const info = await sess.getUserInfo();
        const st = await sess.getSigninStatus();
        write({
          stage: 'api-ok',
          user: info,
          signinStatus: st,
          today: todayStatus(st),
          note: 'signin/status 调通（含 yy 头）',
        });
      } catch (e) {
        write({ stage: 'api-failed', error: e.message, user, creds });
      }
      return;
    }
    if ([400, 402, 403].includes(errcode)) {
      write({ stage: 'expired', errcode });
      return;
    }
    last = errcode === 404 ? '404' : '';
    await sleep(500);
  }
  write({ stage: 'timeout' });
}

main().catch((e) => write({ stage: 'error', error: e.message, stack: e.stack }));
