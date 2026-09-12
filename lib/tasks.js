/**
 * 签到任务：字段规范 + 到点判定
 *
 * 每位用户可自定义签到时刻（按各自时区）。Cron 按固定间隔触发（如每 10 分钟），
 * 判定规则：本地时间已过设定时刻 && 本地日期这一轮还没跑过 → 到点。
 * 这样不会因为 Cron 粒度与设定分钟不整除而漏签，最坏只是晚一个 tick。
 */

export const DEFAULT_TZ_OFFSET = 480; // UTC+8

export function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 用户本地时间（把 UTC 时钟平移 tzOffset 分钟后读取） */
export function localParts(tzOffset, nowMs = Date.now()) {
  const d = new Date(nowMs + tzOffset * 60000);
  return {
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: d.toISOString().slice(0, 10), // YYYY-MM-DD（用户本地日期）
    weekday: d.getUTCDay(),
  };
}

/** 规范化用户提交的任务配置 */
export function normalizeInput(body = {}) {
  const tzOffset = clampInt(body.tzOffset, -720, 840, DEFAULT_TZ_OFFSET);
  const hour = clampInt(body.hour, 0, 23, 9);
  const minute = clampInt(body.minute, 0, 59, 0);
  const notify = body.notify && typeof body.notify === 'object' ? body.notify : {};
  return {
    name: String(body.name || '').trim().slice(0, 40),
    schedule: { hour, minute, tzOffset, enabled: body.enabled !== false },
    notify: {
      bark: String(notify.bark || '').trim(),
      serverchan: String(notify.serverchan || '').trim(),
      webhook: String(notify.webhook || '').trim(),
      telegramBotToken: String(notify.telegramBotToken || notify.tgBot || '').trim(),
      telegramChatId: String(notify.telegramChatId || notify.tgChat || '').trim(),
    },
  };
}

/** 是否到点 */
export function isDue(task, nowMs = Date.now()) {
  const s = task?.schedule;
  if (!s || s.enabled === false) return false;
  const p = localParts(s.tzOffset ?? DEFAULT_TZ_OFFSET, nowMs);
  if (task.lastRunDate === p.date) return false; // 今天已跑
  return p.minutes >= s.hour * 60 + s.minute;
}

/** 该用户本地今天的日期键 */
export function todayKey(task, nowMs = Date.now()) {
  return localParts(task?.schedule?.tzOffset ?? DEFAULT_TZ_OFFSET, nowMs).date;
}

/** 人类可读的下次执行时间 */
export function describeSchedule(task) {
  const s = task?.schedule;
  if (!s) return '未设置';
  const sign = s.tzOffset >= 0 ? '+' : '-';
  const ah = Math.abs(s.tzOffset) / 60;
  const am = Math.abs(s.tzOffset) % 60;
  const tz = `UTC${sign}${ah}${am ? ':' + String(am).padStart(2, '0') : ''}`;
  return `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')} (${tz})${
    s.enabled === false ? ' · 已暂停' : ''
  }`;
}

/** 并发池：限制同时在跑的数量 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = { ok: true, value: await worker(items[idx], idx) };
      } catch (e) {
        results[idx] = { ok: false, error: e.message || String(e) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
