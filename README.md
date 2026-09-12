# MiniMax Agent 多人自动签到（Vercel）

每个人一个签到任务：**各自扫码绑定自己的账号、各自设定签到时间、各自配置通知**。
系统按 Cron 定时遍历所有到点的任务并完成签到；凭证失效时用户自己重新扫码即可，无需改代码。

核心逻辑全部由 HAR 抓包逆向而来，**无头、无浏览器依赖、零 npm 依赖**（只用 Node 内置模块）。

---

## 一、能力一览

| 能力 | 说明 |
|---|---|
| 多用户 | 每人一条任务，独立存储、独立调度、互不干扰 |
| 自定义时间 | 每人可设自己的签到时刻与时区（如 08:30 UTC+8） |
| 通知 | 每人可配 Bark / Server 酱 / Telegram / 自定义 Webhook，只通知本人 |
| 凭证自愈 | token 由 `_token` Cookie 直接取；`renewal` 只用于续期，失败不影响签到 |
| 失效重登 | 管理链接扫码重新绑定，几秒钟恢复 |
| 并发与限额 | 并发池（默认 10）+ 时间预算（默认 240s），100+ 用户可在单次调用内跑完 |
| 失败处理 | 失败最多重试 3 次；凭证失效立即停重试并单独通知，避免每 10 分钟骚扰 |

---

## 二、逆向结论（已实测）

### 1. 请求签名

MiniMax 前端在 `mmx-account` 与 `mavis-chat` 两个应用里用的是同一套算法：

```js
x-timestamp = Math.floor(Date.now() / 1000)
x-signature = md5(`${x-timestamp}I*7Cf%WZ#S&%1RlZJ&C2${bodyString}`)   // 无 body 时 bodyString = ''
yy          = md5(`${encodeURIComponent(pathWithQuery)}_${bodyJson}${md5(timeMs)}ooui`)
```

少了 `x-signature` 网关直接返回 `400 {"error":"invalid signature"}`；带上正确签名后才走到鉴权（401），说明是强校验。
`yy` 按上述公式生成后实测被服务端接受（代码里仍保留 400/403 自动降级重试的兜底）。

### 2. 鉴权

**Cookie（会话） + `token` 头（JWT，约 40 天）** 双要素。只有 token 没有 Cookie → 401。

关于 token 来源有个坑：**`POST /v1/api/user/renewal` 在没有旧 token 时会返回
`{"code":2,"message":"请求异常，请检查请求参数"}`**，它不能凭空签发第一个 token。
真正的第一个 token 由 `GET /auth/callback` 下发的 **`_token` Cookie** 携带（值本身就是 JWT）。
代码里的 `MiniMaxClient.syncTokenFromCookie()` 干的就是这件事。

**结论：只要持久化 Cookie 就够了。**

### 3. 登录链路（微信扫码）

```
① open.weixin.qq.com/connect/qrconnect  →  取 uuid
② open.weixin.qq.com/connect/qrcode/{uuid}  →  二维码图片
③ lp.open.weixin.qq.com/connect/l/qrconnect?uuid=…  →  长轮询
        408 等待扫码 / 404 已扫待确认 / 405 成功(带 wx_code) / 403 拒绝 / 402·400 过期
④ POST account.minimaxi.com/v1/api/user/getOpenData   {code}              → unionID
⑤ POST account.minimaxi.com/oauth2/login              {loginType:'5', unionID, deviceID, login_redirect}
⑥ GET  account.minimaxi.com/oauth2/authorize?client_id=agent-minimax&…     → 302 到 agent 域
⑦ GET  agent.minimaxi.com/auth/callback?code=…&state=…                     → 写入 _token Cookie
⑧ POST agent.minimaxi.com/v1/api/user/renewal   （可选，仅用于续期）
```

①~③ 是微信开放平台标准 `snsapi_login`，**纯服务端可完成**。

### 4. 签到接口

| 用途 | 方法 | 路径 |
|---|---|---|
| 签到面板 | GET | `/minimax-cloud/api/v1/signin/status` |
| 领取今日奖励 | POST | `/minimax-cloud/api/v1/signin/claim`（body `{}`） |
| 用户信息 | GET | `/v1/api/user/info` |
| 刷新 token | POST | `/v1/api/user/renewal` |

`days[].status`：`1` 未解锁 · `2` 可领取 · `3` 已领取；`is_today` 标出今天。

---

## 三、数据结构（Vercel KV / Upstash Redis）

```
idx:users     SET      所有 uid
user:{uid}    JSON     单个任务
```

`user:{uid}` 结构：

```jsonc
{
  "uid": "u_xxxxxxxx",
  "name": "备注名",
  "creds": { "cookie": {"account": "...", "agent": "..."}, "token": "...", "uuid": "...", "deviceId": "...", "userId": "..." },
  "account": { "name": "Dream丶", "userId": "365...", "avatar": "...", "retentionDays": 522 },
  "schedule": { "hour": 9, "minute": 0, "tzOffset": 480, "enabled": true },
  "notify": { "bark": "", "serverchan": "", "webhook": "", "telegramBotToken": "", "telegramChatId": "" },
  "status": "active",          // pending 待扫码 / active / expired 凭证失效 / failed
  "lastRunDate": "2026-09-12", // 用户本地日期，用于当日去重
  "lastRunAt": "...",
  "lastResult": { "claimed": true, "points": 400, "dayNo": 1 },
  "lastError": null,
  "failedAttempts": 0
}
```

未配置 KV 且不在 Vercel 上时，退化为本地文件 `.tasks.json`（仅供开发调试）。

---

## 四、调度模型

Cron 每 **10 分钟**触发一次，由 **GitHub Actions** 负责（`.github/workflows/signin.yml`）。
`vercel.json` 里**没有**配 cron —— Hobby 计划的 cron 每天只能跑一次，配 `*/10` 会导致部署失败；
需要 Vercel 自己定时的话见方案 C。

判定规则：

```
用户本地时间已过设定时刻  &&  本地日期这一轮还没跑过  →  到点
```

这样即使 Cron 粒度与设定的分钟数不整除也不会漏签，最坏只是晚一个 tick（≤10 分钟）。
已绑定凭证但当日跑过的任务会被跳过；未扫码的 `pending` 任务不参与调度。

> **Vercel Hobby 计划的 Cron 每天只能跑一次**，自定义时间需要 `*/10` 这种高频触发，
> 因此多人场景**需要 Pro 计划**。Hobby 下只能所有人共用同一个时间。

---

## 五、部署：免费方案选型

Vercel 的卡点只有两处，都可以绕开：

| 卡点 | Hobby 免费版 | 需要 Pro 的原因 |
|---|---|---|
| Cron 频率 | 每天 1 次 | 用户自定义签到时刻需要 `*/10` 这种高频触发 |
| 函数时长 | 60s | 批量签到 100+ 用户想留足预算 |

**关键洞察**：Web UI 和批量定时这两件事可以拆开。UI 只做单用户操作（扫码绑定、查状态），
几秒就够，Vercel Hobby 完全够用；只有「定时批量跑」需要挪到别处。所以**一分钱不用花**。

### 方案对比

| 方案 | 费用 | 定时能力 | 说明 |
|---|---|---|---|
| **Vercel Hobby（UI）+ GitHub Actions（定时）** | **全免费** | 分钟级 cron，单次上限 6 小时 | ⭐ 推荐，见下方步骤 |
| Cloudflare Workers 免费版 | 全免费 | Cron Trigger 分钟级 | 一体化部署；但免费版单次 CPU 时间有限，用户集中在同一时刻时可能不够 |
| Vercel Pro | $20/月起 | 分钟级，300s | 最省事，花钱买省心 |
| Deno Deploy | 免费额度 | `Deno.cron` | 需把存储换成本项目的 KV 之外的 Deno KV |
| Render / Fly.io / Railway | 无真正免费 | — | 免费额度已基本取消，不推荐 |

> GitHub Actions：**公开仓库不限运行分钟数**（Secrets 不会泄露）；
> 私有仓库每月 2000 分钟免费。`*/30` 每月约 1440 次，单次不到 1 分钟，够用。

---

### ⭐ 方案 A（推荐）：Vercel Hobby 托管 UI + GitHub Actions 定时

#### A1. 准备 KV（两边共用）

去 [Upstash](https://upstash.com) 免费注册一个 Redis，拿到 `UPSTASH_REDIS_REST_URL` 与
`UPSTASH_REDIS_REST_TOKEN`（免费额度每天 1 万条命令，100+ 用户绰绰有余）。
也可以直接用 Vercel 的 KV（底层就是 Upstash），两边填同一份即可。

#### A2. 部署 UI 到 Vercel（免费）

```bash
vercel deploy --prod
```

环境变量只需要 `KV_REST_API_URL` + `KV_REST_API_TOKEN`（以及可选的 `ADMIN_TOKEN`）。
Vercel 的 Cron 可以不管——批量签到交给 GitHub Actions。

#### A3. 一键发布到 GitHub

```bash
gh auth login              # 首次需要登录
bash scripts/publish.sh    # 默认仓库名 minimax-signin，可加参数改
```

脚本会建公开仓库、推代码，并把 `.env` 里的 KV 凭证自动写进仓库 Secrets。

<details><summary>手动步骤（不想用脚本时展开）</summary>

```bash
gh auth login
gh repo create minimax-signin --public --source=. --remote=origin --push

gh secret set UPSTASH_REDIS_REST_URL  < <(echo -n "$UPSTASH_REDIS_REST_URL")
gh secret set UPSTASH_REDIS_REST_TOKEN < <(echo -n "$UPSTASH_REDIS_REST_TOKEN")
```

</details>

#### A3.5 关于 Secrets 命名（容易踩的坑）

工作流里引用的是 `secrets.KV_REST_API_URL` 与 `secrets.KV_REST_API_TOKEN`
（跟 Vercel KV 的自动注入同名）。而我们的存储层两个名字都认：

| Secrets 名 | 说明 |
|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | **工作流需要的名字** |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 本地 `.env` 用的名字 |

`scripts/publish.sh` 会把两个名字都写上，所以正常不会出问题。
如果你手动配，只填了 `UPSTASH_*`，日志里会出现：

```
KV_REST_API_URL:            ← 空！
存储后端: 本地文件 .tasks.json   ← 说明没连上 KV
```

看到这个就是没连上 KV，补上 `KV_` 前缀的两个即可。

#### A4. 启用定时

> ⚠️ **GitHub 的已知限制**：OAuth 应用（`gh auth login` 默认那种 token）**没有 `workflow` scope**，
> 无法创建或修改 `.github/workflows/` 下的文件，git push、Contents API、Git Data API 都会
> 返回 404/拒绝。首次添加 workflow 必须二选一：
>
> - **推荐**：用 GitHub 网页编辑器创建该文件（30 秒，无需任何 token）
>   → `https://github.com/<你>/<仓库>/new/master?filename=.github/workflows/signin.yml`
> - 或者：创建**经典 PAT** 并勾选 `workflow` scope，用它推送一次
>
> 一旦文件在仓库里存在，后续用普通 token 修改它也是允许的（限制只针对 OAuth app）。

推上去后打开仓库的 Actions 页启用工作流（默认 `*/30 * * * *`）。
公开仓库不限分钟数，想更精确可把工作流里的 cron 改成 `*/10`。

手动验证：Actions → `MiniMax 每日签到` → Run workflow。


推上去后打开仓库的 Actions 页启用工作流（默认 `*/30 * * * *`）。
公开仓库不限分钟数，想更精确可把 `.github/workflows/signin.yml` 改成 `*/10`。

手动验证：Actions → `MiniMax 每日签到` → Run workflow。


1. 把代码推到 GitHub 仓库
2. Settings → Secrets and variables → Actions → New repository secret，添加：
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
3. Actions 里启用 `MiniMax 每日签到` 工作流（已写好在 `.github/workflows/signin.yml`）

默认 `*/30 * * * *`。想更精确就改成 `*/10`（公开仓库无分钟限制）。

手动测试：Actions → 该工作流 → Run workflow。

#### A5. 命令行等价用法

GitHub Actions 跑的就是这个脚本，任何能跑 Node 的地方都能用（服务器 crontab、群晖、软路由等）：

```bash
node scripts/cron-run.mjs            # 处理所有到点任务
node scripts/cron-run.mjs --dry      # 只列出到点任务
node scripts/cron-run.mjs --uid=u_x  # 只跑指定用户
```

---

### 方案 B：Cloudflare Workers 一体化

```bash
npm i -g wrangler
wrangler login

wrangler secret put KV_REST_API_URL
wrangler secret put KV_REST_API_TOKEN
wrangler secret put CRON_SECRET      # 可选
wrangler secret put ADMIN_TOKEN      # 可选

wrangler deploy
```

`wrangler.toml` 里已配好 `*/10` 的 Cron Trigger 与 `public/` 静态托管。
代码同时提供 `scheduled()`（定时批量）和 `fetch()`（接口 + 页面）。

> 免费版 CPU 时间有限（Worker 单次执行），`wrangler.toml` 里已把并发降到 5、预算降到 45s。
> 如果用户签到时间很集中（比如几十人都是 09:00），建议错峰，或改用方案 A。

### 方案 C：Vercel 自己定时（需 Pro）

```bash
vercel deploy --prod
```

然后在 `vercel.json` 里加回 crons（Hobby 计划不支持这种频率，配了会部署失败）：

```json
"crons": [{ "path": "/api/cron", "schedule": "*/10 * * * *" }]
```

并把 `functions` 的 `maxDuration` 从 `60` 提到 `300`（Pro 上限）。

## 六、接口一览

| 路径 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/` | GET | — | 用户页面（创建 / 查看 / 管理任务） |
| `/api/tasks` | POST | — | 创建任务，返回 `{uid, manageUrl}` |
| `/api/tasks?uid=` | GET | — | 查询单个任务（脱敏） |
| `/api/tasks?uid=` | PATCH | — | 修改时间 / 通知 / 启停 |
| `/api/tasks?uid=` | DELETE | — | 删除任务 |
| `/api/tasks` | GET | `ADMIN_TOKEN` | 全部任务列表 |
| `/api/status?uid=` | GET | — | 实时账号 + 签到面板 |
| `/api/login/start` | POST | — | 创建扫码会话，返回二维码 data URL |
| `/api/login/poll` | POST | — | 轮询扫码结果，`{uuid, last, uid}`，成功后绑定凭证 |
| `/api/cron` | GET | `CRON_SECRET` | 批量签到；`?dry=1` 只预演；`?uid=` 单用户立即执行 |

---

## 七、本地开发

```bash
node scripts/dev.mjs        # 或 npm run dev → http://localhost:3000
node scripts/login.mjs      # 终端扫码（旧版单用户，输出凭证 JSON）
node scripts/migrate.mjs    # 把 .creds.json 迁移成多用户任务
```

> 直接静态打开 `public/index.html` 时 `/api/*` 会 404——那是静态文件服务，没有后端。
> 必须用 `npm run dev`、`vercel dev` 或已部署的域名访问。

本地开发把 KV 凭证写进项目根目录的 `.env`（已在 `.gitignore` 中，不会被提交）：

```bash
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx
# ADMIN_TOKEN=        # 可选
# CRON_SECRET=        # 可选
```

`scripts/dev.mjs` 与所有 `scripts/*.mjs` 都会自动加载它；云端由平台注入环境变量，这行加载无副作用。

---

## 八、已修复的坑（排查记录）

1. **微信 `wx_code` 一次性** —— 前端用 `setInterval` 并发轮询时，多个长轮询会拿到同一个 405 code 并各自兑换，第二个必报 `code been used (40163)`。改成自调度循环（上一次返回后才发下一次）+ 后端 5 分钟 code 去重。
2. **`res.text` 被同名方法覆盖** —— 对象字面量里 `text` 字符串属性会被后面的 `text()` 方法覆盖，改用 `rawText`。
3. **dev 服务器 `res.status` shim 只装在 `/api/`** —— 任何 404 静态请求都会 `TypeError` 把 Node 进程打挂（表现为浏览器 `fetch failed`）。shim 已提到最外层，并加了 `uncaughtException` 兜底。
4. **文件后端并发丢数据** —— `writeFile` 先截断，并发 `readFile` 读到空文件 → 解析失败返回 `{}` → 下次写入把整个库清空。已改为串行锁 + 临时文件原子 rename（仅影响本地文件后端，KV 本身是原子的）。
5. **token 来源误判** —— 以为 `renewal` 能签发首个 token，实际要靠 `_token` Cookie。

---

## 九、注意事项

- 本项目只做「登录 + 每日签到」，不做任何刷量行为。
- 管理链接（`?uid=`）即凭证，拿到即可操作对应任务。uid 为 128 位随机值不可猜测，但仍请提醒用户妥善保管。
- 请求指纹（UA、`device_id`、`uuid`、屏幕参数）在首次绑定后固定保存并复用，避免频繁换设备触发风控。
- 若 MiniMax 改了签名盐值，只需更新 `lib/crypto.js` 里的 `SIG_SALT`。
