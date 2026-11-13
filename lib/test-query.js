'use strict';
// 构造最小 DNS 查询报文，给 GET ?name=&type= 测试和本地测试用。
// 只用 Uint8Array，不依赖 Buffer —— Workers 里也能用。
const TYPES = { A: 1, AAAA: 28, CNAME: 5, MX: 15, TXT: 16, HTTPS: 65, NS: 2, SOA: 6 };

function buildTestQuery(name, typeName) {
  const qtype = TYPES[(typeName || 'A').toUpperCase()] || 1;
  const labels = name.replace(/\.$/, '').split('.');

  // Header: ID=0x1234, RD=1, QDCOUNT=1
  const bytes = [0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

  const enc = new TextEncoder();
  for (const label of labels) {
    const b = enc.encode(label);
    if (b.length > 63) throw new Error(`label too long: ${label}`);
    bytes.push(b.length);
    for (const x of b) bytes.push(x);
  }
  bytes.push(0); // 根标签结尾

  bytes.push((qtype >> 8) & 0xff, qtype & 0xff, 0x00, 0x01); // QTYPE + QCLASS=IN
  return Uint8Array.from(bytes);
}

module.exports = { buildTestQuery, TYPES };
