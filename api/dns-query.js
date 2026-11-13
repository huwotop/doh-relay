'use strict';
// ============================================================================
// Vercel 适配层（Node Functions）
// ----------------------------------------------------------------------------
// 只做一件事：把 Node 的 (req, res) 翻译成 lib/doh.js 认的 ctx，再把返回的
// { status, headers, body } 写回 res。业务逻辑全部在 lib/doh.js。
//
// 路由由 vercel.json 的 rewrites 完成，不在代码里做动态路由：
//   /<secret>/dns-query  ->  /api/dns-query?secret=<secret>
// （旧版 api/[secret]/dns-query.js 在真实部署时被 Vercel 平台层拦成
//   NOT_FOUND，已废弃，别再改回带方括号的目录）
// ============================================================================
const core = require('../lib/doh');

const MAX_BODY = 65535;

// Vercel Node 运行时里 req 是 IncomingMessage；body 没被解析时需要自己收流。
async function readNodeBody(req) {
  if (Buffer.isBuffer(req.body)) return new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
  if (typeof req.body === 'string') return new TextEncoder().encode(req.body);
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !req.body.readable) {
    // 被平台当成 JSON 解析过了，不是 DNS wireformat
    throw new Error('unexpected parsed body');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const out = await core.handleDnsQuery({
    url,
    method: req.method,
    header: (name) => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v.join(', ') : (v ?? null);
    },
    secret: url.searchParams.get('secret') || (req.query && req.query.secret) || '',
    body: () => readNodeBody(req),
    env: process.env,
  });

  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  const isBytes = out.body instanceof Uint8Array;
  res.status(out.status).send(isBytes ? Buffer.from(out.body.buffer, out.body.byteOffset, out.body.byteLength) : out.body);
};
