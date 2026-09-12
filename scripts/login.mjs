/**
 * 本地终端扫码登录
 *   node scripts/login.mjs
 *
 * 会在终端给出二维码（保存为 qr.png 并尝试自动打开），扫码后把凭证写入
 * .creds.json，同时打印出可直接填入 Vercel 环境变量 MINIMAX_CREDS 的内容。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exec } from 'node:child_process';
import { createSession, pollOnce, WX_STATUS_TEXT } from '../lib/wx.js';
import { loginWithWxCode } from '../lib/minimax.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('正在获取微信二维码…');
  const s = await createSession({ withImageDataUrl: true });

  const pngPath = join(ROOT, 'qr.png');
  if (s.qrDataUrl) {
    writeFileSync(pngPath, Buffer.from(s.qrDataUrl.split(',')[1], 'base64'));
    console.log(`\n二维码已保存: ${pngPath}`);
    try {
      const cmd = process.platform === 'win32' ? `start "" "${pngPath}"` : process.platform === 'darwin' ? `open "${pngPath}"` : `xdg-open "${pngPath}"`;
      exec(cmd);
      console.log('已尝试用默认程序打开，请扫码。');
    } catch {}
  }
  console.log(`也可在浏览器打开: ${s.qrUrl}\n`);

  const deadline = Date.now() + 3 * 60 * 1000;
  let last = '';
  let tip = '';
  while (Date.now() < deadline) {
    const { errcode, code } = await pollOnce(s.uuid, last, 25000);
    const msg = WX_STATUS_TEXT[errcode] || `微信状态码 ${errcode}`;
    if (msg !== tip) { tip = msg; process.stdout.write(`\r状态: ${msg}          `); }

    if (errcode === 405 && code) {
      console.log('\n\n扫码成功，正在换取 MiniMax 会话…');
      const { creds, user } = await loginWithWxCode(code);
      const payload = JSON.stringify({ ...creds, updatedAt: new Date().toISOString() });
      writeFileSync(join(ROOT, '.creds.json'), payload);
      console.log(`\n✅ 登录成功: ${user?.name || '(未知)'} (ID ${user?.realUserID || '-'})`);
      console.log(`凭证已写入: ${join(ROOT, '.creds.json')}`);
      console.log('\n—— 以下为环境变量 MINIMAX_CREDS 的值 ——\n');
      console.log(payload);
      console.log('\n把它填进 Vercel 环境变量即可（若已配置 KV/Blob，可直接用网页扫码登录，无需这一步）。');
      return;
    }
    if (errcode === 403 || errcode === 402 || errcode === 400) {
      console.log('\n二维码已失效，请重新运行本脚本。');
      return;
    }
    last = errcode === 404 ? '404' : '';
    await sleep(300);
  }
  console.log('\n\n等待超时（3 分钟），请重新运行。');
}

main().catch((e) => {
  console.error('\n❌ 失败:', e.message);
  process.exit(1);
});
