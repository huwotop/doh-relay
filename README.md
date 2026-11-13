# DoH 中转

部署在 Serverless 边缘平台上的 **DNS over HTTPS（DoH）中转服务**。同一份代码可以部署到 Vercel Functions 或 Cloudflare Workers，对外提供标准 DoH 接口，为自建 DNS 解析器或客户端提供海外解析出口。

- **纯透传** — 请求原样转发给上游 DoH，不解析、不改写、不注入 ECS
- **不做分流** — 区域分流由调用方决定，本服务只负责转发
- **内置能力** — 实例内 TTL 缓存、按客户端 IP 限流、上游自动故障切换
- **双平台** — 核心逻辑与平台无关，两个平台共用同一份代码
- **零依赖** — 没有第三方包，不需要构建步骤

## 目录结构

核心逻辑只有一份，平台差异被两个极薄适配层挡在外面：

```
lib/doh.js          ← 平台无关核心：DNS 报文解析、上游转发、缓存、限流
lib/test-query.js   ← 构造测试查询报文
api/dns-query.js    ← Vercel 适配层（Node req/res）
api/health.js       ← Vercel 适配层
worker/index.mjs    ← Cloudflare Workers 适配层（Web Request/Response）
vercel.json         ← Vercel 路由 / 区域 / 超时
wrangler.jsonc      ← Workers 配置
```

`lib/doh.js` 只使用 Web 标准 API（`fetch`、`TextEncoder`、`DataView`、`atob`、`AbortController`），不依赖 `Buffer`、`process.env` 或任何 Node 专有模块，因此两个运行时都能直接执行，Workers 侧无需开启 `nodejs_compat`。

## 接口

两个平台的路由完全一致：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` / `POST` | `/<DOH_SECRET>/dns-query` | 主入口。`POST` 需 `Content-Type: application/dns-message` |
| `GET` | `/<DOH_SECRET>/dns-query?dns=<base64url>` | RFC 8484 的 GET 形式 |
| `GET` | `/<DOH_SECRET>/dns-query?name=example.com&type=A` | 调试用，由服务端构造查询 |
| `GET` | `/dns-query?secret=<DOH_SECRET>` | 直连形式，路径带密钥不可用时使用 |
| `GET` | `/api/health` 或 `/health` | 健康检查，返回 JSON |

响应为 `application/dns-message` 二进制报文，`Cache-Control: no-store`。密钥不匹配返回 `404`，触发限流返回 `429`，两个上游都失败返回 `SERVFAIL` 报文。

## 配置项

| 环境变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `DOH_SECRET` | 是 | 无 | 路径中的密钥。**为空时路径不受保护**，仅会打警告 |
| `UPSTREAM_PRIMARY` | 否 | `https://dns.google/dns-query` | 主上游 |
| `UPSTREAM_FALLBACK` | 否 | `https://cloudflare-dns.com/dns-query` | 备用上游 |
| `UPSTREAM_TIMEOUT_MS` | 否 | `3000` | 单个上游超时（毫秒） |
| `RATE_PER_MIN` | 否 | `120` | 每客户端 IP 每分钟请求上限 |

密钥生成：`openssl rand -hex 16`。用平台的环境变量 / secret 机制注入。

## 部署到 Vercel

1. 把仓库导入 Vercel，Framework Preset 选 **Other**（无构建步骤）。
2. Settings → Environment Variables 添加 `DOH_SECRET`（其余变量可选）。
3. 加完变量后 **Redeploy 一次**，环境变量才会生效。
4. Settings → Functions → Function Region 选 **Singapore (sin1)**。`vercel.json` 已写 `regions: ["sin1"]`，默认区域是美国东部，不改会多出约 200ms。
5. 部署完成后地址为 `https://<项目名>.vercel.app/<DOH_SECRET>/dns-query`。

## 部署到 Cloudflare Workers

```bash
npx wrangler login
npx wrangler secret put DOH_SECRET   # 粘贴随机串
npx wrangler deploy
```

部署后地址为 `https://doh-relay.<你的子域>.workers.dev/<DOH_SECRET>/dns-query`。非敏感变量已写在 `wrangler.jsonc` 的 `vars` 中，修改后重新 deploy 即可。

绑定自定义域名，在 `wrangler.jsonc` 里加：

```jsonc
"routes": [{ "pattern": "doh.example.com", "custom_domain": true }]
```

> Workers 的自定义域名要求域名的 **NS 托管在同一个 Cloudflare 账号**下，不支持 CNAME 接入。

本地跑真实 Workers 运行时（workerd，行为与线上一致）：

```bash
echo 'DOH_SECRET=testsecret' > .dev.vars
npx wrangler dev
```

Vercel 侧对应 `vercel dev`。查看线上日志用 `npx wrangler tail`。

## 两个平台怎么选

| | Vercel Hobby | Cloudflare Workers Free |
|---|---|---|
| 额度 | 100 万调用/月、100GB 带宽、4 CPU 小时/月，超额暂停不扣费 | 10 万请求/天，CPU 10ms/次，超额返回 1027 |
| 出口位置 | 可固定为 `sin1` 新加坡，延迟可预期 | 离客户端最近的边缘节点，不固定 |
| 自定义域名 | 支持 CNAME 接入任意 DNS | 要求域名 NS 托管在 Cloudflare |
| 日志 | Dashboard → Logs | Workers Logs + `wrangler tail` |

个人量级（每天几千次查询）在两边都远低于额度。想延迟数字稳定选 Vercel 固定区域；想到上游链路更短、排障更方便选 Workers；也可以两个都部署，在上游配置里互为主备。

## 验证部署

```bash
# 1. 健康检查
curl https://<地址>/api/health
# 期望 {"ok":true,"platform":"...","region":"...","upstream":"...","fallback":"..."}

# 2. 真实查询（返回二进制 DNS 报文，不是 JSON）
curl -s "https://<地址>/<DOH_SECRET>/dns-query?name=example.com&type=A" | xxd | head

# 3. 错误密钥应返回 404
curl -o /dev/null -w "%{http_code}\n" "https://<地址>/wrongsecret/dns-query?name=example.com&type=A"

# 4. 量延迟
curl -w "%{time_total}\n" -o /dev/null -s https://<地址>/api/health
```

`platform` 字段会返回 `vercel` 或 `cloudflare-workers`，便于确认当前命中的是哪个部署。单次查询超过 8 秒说明链路异常，需要查上游。

## 注意事项

- **不要公开中转地址。** 地址泄露后被滥用会烧掉额度（Vercel 超额暂停到下个周期，Workers 超额直接返回 1027）。仓库建议设为私有。
- **缓存和限流都是实例内内存。** 函数实例或 isolate 回收后即清空，跨实例不共享。它们只用于减少上游调用，不能当作可靠的配额控制。
- **上游超时策略**：每上游只尝试一次，最坏 `3s + 3s = 6s` 返回。两个上游都失败时返回 SERVFAIL 报文而非挂起，调用方可以自行 fallback。
- **Workers 免费版 CPU 上限 10ms/请求。** 当前逻辑只遍历 DNS 报文头部和记录，实测远低于上限，但不要往里加重型处理（大报文改写、ECS 注入等）。
- **不要设置 `Connection: close` 等逐跳头部。** Workers 与 Node 对这类头部的处理不一致，代码中已省略。
- **平台条款风险**：Cloudflare 会限制把 Workers 当作纯代理/隧道使用。DoH 报文体积很小，不属于带宽滥用，但若被判定为纯代理服务，可能被限流。
- **免费额度的出口 IP 是共享的**，上游 DoH 服务对这些 IP 的策略可能变化；出现大面积失败时先检查上游是否可用。
