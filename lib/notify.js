/**
 * 通知（按用户各自配置发送）
 *
 * config 字段（存在 user:{uid}.notify 里）：
 *   webhook          通用 Webhook，POST JSON {title, content, text, uid}
 *   bark             Bark（iOS）
 *   serverchan       Server 酱 Turbo SendKey
 *   telegramBotToken + telegramChatId
 */

export async function notifyUser(cfg, title, content, extra = {}) {
  const jobs = [];
  const push = (p) => jobs.push(p.catch((e) => console.warn('[notify]', e.message)));
  if (!cfg || typeof cfg !== 'object') return 0;

  if (cfg.webhook) {
    push(
      fetch(cfg.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, text: `${title}\n\n${content}`, ...extra }),
      })
    );
  }
  if (cfg.bark) {
    push(
      fetch(
        `https://api.day.app/${cfg.bark}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`
      )
    );
  }
  if (cfg.serverchan) {
    push(
      fetch(`https://sctapi.ftqq.com/${cfg.serverchan}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title, desp: content }),
      })
    );
  }
  if (cfg.telegramBotToken && cfg.telegramChatId) {
    push(
      fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cfg.telegramChatId,
          text: `*${escapeMd(title)}*\n\n${escapeMd(content)}`,
          parse_mode: 'Markdown',
        }),
      })
    );
  }

  if (!jobs.length) return 0;
  await Promise.all(jobs);
  return jobs.length;
}

function escapeMd(s) {
  return String(s).replace(/([_*`\[\]])/g, '\\$1');
}
