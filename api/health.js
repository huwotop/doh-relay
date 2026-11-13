'use strict';
// GET /api/health — 状态检查，无 secret、不限流。
// Uptime Kuma 监控用（只是监控，不是保活——serverless 本来就不需要保活）。
const core = require('../lib/doh');

module.exports = (req, res) => {
  const out = core.handleHealth({
    platform: 'vercel',
    region: process.env.VERCEL_REGION || 'unknown',
    env: process.env,
  });
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.status(out.status).send(out.body);
};
