'use strict';
// ============================================================================
// 平台无关的 DoH 中转核心
// ----------------------------------------------------------------------------
// 只依赖 Web 标准：fetch / TextEncoder / TextDecoder / atob / AbortController /
// DataView / Map。不碰 Buffer、不读 process.env、不用任何 Node API。
// 因此同一份逻辑可以原样跑在 Vercel Node 函数和 Cloudflare Workers 里。
//
// 两个极薄适配层负责把平台差异挡在外面：
//   api/dns-query.js   Vercel：Node (req, res) → ctx → res
//   worker/index.mjs   Workers：Request → ctx → Response
//
// 核心只认这个 ctx 形状（适配层负责填好）：
//   {
//     url: URL,                              // 完整 URL，带 query
//     method: 'GET' | 'POST' | ...,
//     header(name) -> string | null,         // 大小写不敏感
//     body() -> Promise<Uint8Array | null>,  // 只在 POST 时调用
//     secret: string,                        // 从路径或 query 解析出的 secret
//     env: object,                           // process.env 或 Workers env
//     platform?: string,                     // 仅 /health 用
//     region?: string,                       // 仅 /health 用
//   }
//
// 返回统一结构（适配层再转成 res.send 或 Response）：
//   { status: number, headers: object, body: Uint8Array | string }
//
// 纯海外 DoH 直通：不做区域分流（分流交由调用方处理），不加 ECS
// （上游只看到本服务的出口 IP，返回就近的海外节点）。
// ============================================================================

const DEFAULTS = {
  UPSTREAM_PRIMARY: 'https://dns.google/dns-query',
  UPSTREAM_FALLBACK: 'https://cloudflare-dns.com/dns-query',
  UPSTREAM_TIMEOUT_MS: 3000,
  RATE_PER_MIN: 120,
};
const MAX_BODY = 65535; // TCP DNS 上限，超过基本就是误用

const QTYPE = { 1: 'A', 28: 'AAAA', 5: 'CNAME', 15: 'MX', 16: 'TXT', 65: 'HTTPS', 2: 'NS', 6: 'SOA' };

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const { buildTestQuery } = require('./test-query');

// ---------------------------------------------------------------------------
// 配置：每次请求现读，适配层只负责把对象递进来
// ---------------------------------------------------------------------------
function readConfig(env) {
  const e = env || {};
  const num = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    primary: e.UPSTREAM_PRIMARY || DEFAULTS.UPSTREAM_PRIMARY,
    fallback: e.UPSTREAM_FALLBACK || DEFAULTS.UPSTREAM_FALLBACK,
    timeoutMs: num(e.UPSTREAM_TIMEOUT_MS, DEFAULTS.UPSTREAM_TIMEOUT_MS),
    ratePerMin: num(e.RATE_PER_MIN, DEFAULTS.RATE_PER_MIN),
    secret: e.DOH_SECRET || '',
  };
}

// ---------------------------------------------------------------------------
// DNS wireformat 解析（只用 DataView，不依赖 Buffer）
// ---------------------------------------------------------------------------
function view(buf) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function parseQuery(buf) {
  if (!buf || buf.length < 12) throw new Error('query too short');
  const dv = view(buf);
  const id = dv.getUint16(0);
  if (dv.getUint16(4) !== 1) throw new Error('only QDCOUNT=1 supported');
  let off = 12;
  const labels = [];
  for (;;) {
    if (off >= buf.length) throw new Error('truncated qname');
    const len = buf[off++];
    if (len === 0) break;
    if (len >= 0xc0) throw new Error('compressed qname in query');
    if (off + len > buf.length) throw new Error('truncated label');
    labels.push(textDecoder.decode(buf.subarray(off, off + len)));
    off += len;
  }
  if (off + 4 > buf.length) throw new Error('truncated question');
  const qtype = dv.getUint16(off);
  return { id, name: labels.join('.'), qtype };
}

function minTtl(buf) {
  try {
    const dv = view(buf);
    const an = dv.getUint16(6);
    let off = 12;
    const skipName = () => {
      for (;;) {
        const len = buf[off++];
        if (len === 0) break;
        if ((len & 0xc0) === 0xc0) { off++; break; }
        off += len;
      }
    };
    skipName(); off += 4;
    let min = Infinity;
    for (let i = 0; i < an; i++) {
      skipName();
      off += 4; // TYPE + CLASS
      const ttl = dv.getUint32(off); off += 4;
      const rdlen = dv.getUint16(off); off += 2 + rdlen;
      if (ttl > 0 && ttl < min) min = ttl;
    }
    return min === Infinity ? 60 : min;
  } catch { return 60; }
}

function servfail(id) {
  const buf = new Uint8Array(12);
  const dv = view(buf);
  dv.setUint16(0, id);
  dv.setUint16(2, 0x8182); // QR=1, RCODE=SERVFAIL
  dv.setUint16(4, 1);      // QDCOUNT=1
  return buf;
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// 上游转发
// ---------------------------------------------------------------------------
async function upstreamQuery(url, wire, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: wire,
      signal: ctrl.signal,
      // 注意：不要设 Connection: close —— Workers 会忽略/拒绝这类逐跳头部，
      // 而 Node 侧响应体被完整读完也就自然释放了，不需要它。
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message',
        'User-Agent': 'doh-relay/1.1',
      },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

async function tryUpstreams(wire, conf) {
  // 最坏 ~6s（3s + 3s），需小于调用方设置的查询超时。
  // 每个上游只试一次：serverless 里重试同一条上游收益很小，反而会超时。
  let lastErr = null;
  for (const url of [conf.primary, conf.fallback]) {
    try {
      return await upstreamQuery(url, wire, conf.timeoutMs);
    } catch (e) {
      lastErr = e;
      console.warn(`[warn] upstream ${url} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('all upstreams failed');
}

// ---------------------------------------------------------------------------
// 实例内缓存 / 限流（模块级，Worker isolate 与 Lambda 实例存活期一致）
// 跨实例不共享，属预期行为；调用方通常也有自己的缓存，这层只是减少上游调用。
// ---------------------------------------------------------------------------
const cache = new Map();
const rate = new Map();

function cacheGet(key, qid) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { cache.delete(key); return null; }
  const buf = new Uint8Array(hit.buf); // 复制，避免改到缓存本体
  view(buf).setUint16(0, qid);         // 换回本次请求的 DNS ID
  return buf;
}

function cachePut(key, buf) {
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  const ttl = Math.max(30, Math.min(minTtl(buf), 3600));
  cache.set(key, { buf: new Uint8Array(buf), expiresAt: Date.now() + ttl * 1000 });
}

function rateLimited(ip, perMin) {
  const now = Date.now();
  const w = rate.get(ip);
  if (!w || now - w.start > 60000) { rate.set(ip, { start: now, count: 1 }); return false; }
  w.count++;
  return w.count > perMin;
}

function clientIP(header) {
  const cf = header('cf-connecting-ip');
  if (cf) return cf.split(',')[0].trim();
  const xff = header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 响应构造
// ---------------------------------------------------------------------------
function textResponse(status, text) {
  return {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    body: text,
  };
}

function dnsResponse(buf) {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/dns-message', 'Cache-Control': 'no-store' },
    body: buf,
  };
}

// ---------------------------------------------------------------------------
// 主处理
// ---------------------------------------------------------------------------
async function handleDnsQuery(ctx) {
  const conf = readConfig(ctx.env);

  const got = ctx.secret != null ? ctx.secret : (ctx.url.searchParams.get('secret') || '');
  if (!conf.secret) {
    console.warn('[warn] DOH_SECRET not set — path is unprotected');
  } else if (got !== conf.secret) {
    return textResponse(404, 'not found');
  }

  const ip = clientIP(ctx.header);
  if (rateLimited(ip, conf.ratePerMin)) return textResponse(429, 'rate limited');

  let wire = null;
  try {
    if (ctx.method === 'POST') {
      const ct = ctx.header('content-type') || '';
      if (!ct.includes('application/dns-message')) return textResponse(415, 'need application/dns-message');
      wire = await ctx.body();
    } else if (ctx.method === 'GET') {
      const sp = ctx.url.searchParams;
      const dns = sp.get('dns');
      if (dns) {
        wire = b64urlDecode(dns);
      } else if (sp.get('name') && sp.get('type')) {
        // 测试用：?name=google.com&type=A
        wire = buildTestQuery(sp.get('name'), sp.get('type'));
      } else {
        return textResponse(400, 'use POST application/dns-message, GET ?dns=, or GET ?name=&type=');
      }
    } else {
      return textResponse(405, 'method not allowed');
    }
    if (!wire || wire.length < 12) throw new Error('empty/invalid query');
    if (wire.length > MAX_BODY) throw new Error('body too large');
  } catch (e) {
    return textResponse(400, 'bad request: ' + e.message);
  }

  let parsed = null;
  try { parsed = parseQuery(wire); } catch { /* 解析不了就原样透传 */ }
  const key = parsed ? `${parsed.name}|${parsed.qtype}` : null;

  if (key) {
    const hit = cacheGet(key, parsed.id);
    if (hit) return dnsResponse(hit);
  }

  let out;
  try {
    out = await tryUpstreams(wire, conf);
  } catch (e) {
    console.error('[error] all upstreams failed:', e.message);
    return dnsResponse(servfail(parsed ? parsed.id : 0));
  }

  if (key) cachePut(key, out);
  return dnsResponse(out);
}

function handleHealth(ctx) {
  const conf = readConfig(ctx.env);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      ok: true,
      platform: ctx.platform || 'unknown',
      region: ctx.region || 'unknown',
      upstream: conf.primary,
      fallback: conf.fallback,
    }),
  };
}

module.exports = {
  QTYPE,
  DEFAULTS,
  readConfig,
  parseQuery,
  minTtl,
  servfail,
  b64urlDecode,
  tryUpstreams,
  clientIP,
  handleDnsQuery,
  handleHealth,
  textEncoder,
};
