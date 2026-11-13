// ============================================================================
// Cloudflare Workers 适配层
// ----------------------------------------------------------------------------
// 只做两件事：路由 + 把 Web Request 翻译成 lib/doh.js 认的 ctx，再把返回的
// { status, headers, body } 包成 Response。业务逻辑全部在 lib/doh.js。
//
// 与 Vercel 版的路径完全对齐，切换平台时只需换域名：
//   /<DOH_SECRET>/dns-query     主路径（推荐）
//   /dns-query?secret=...       备选，直连调试用
//   /api/health  或  /health    状态检查
//
// 为什么用 .mjs：仓库 package.json 没有 "type":"module"，Node 会把 .js 当
// CommonJS（本地测试要 import 这个入口），而 Wrangler 的模块格式入口必须是
// ESM。.mjs 两边都认，省掉一个嵌套 package.json。
// ============================================================================
import core from '../lib/doh.js';

function toResponse({ status, headers, body }) {
  return new Response(body, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health' || path === '/api/health') {
      return toResponse(core.handleHealth({
        platform: 'cloudflare-workers',
        // request.cf 只在真实边缘上存在；本地 wrangler dev 可能没有
        region: (request.cf && request.cf.colo) || 'unknown',
        env,
      }));
    }

    let secret = null;
    if (path === '/dns-query' || path === '/api/dns-query') {
      secret = url.searchParams.get('secret') || '';
    } else {
      const m = path.match(/^\/([^/]+)\/dns-query$/);
      if (!m) return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      try {
        secret = decodeURIComponent(m[1]);
      } catch {
        return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    }

    const out = await core.handleDnsQuery({
      url,
      method: request.method,
      header: (name) => request.headers.get(name),
      secret,
      body: async () => new Uint8Array(await request.arrayBuffer()),
      env,
    });
    return toResponse(out);
  },
};
