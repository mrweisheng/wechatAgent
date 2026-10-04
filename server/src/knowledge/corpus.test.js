// 情报白名单域名匹配与绕过检测

import test from 'node:test';
import assert from 'node:assert/strict';
import { isWhitelisted, SOURCE_WHITELIST } from '../knowledge/corpus.js';

test('白名单来源通过（主域与子域）', () => {
  const ok = [
    'https://www.hk01.com/news/1',
    'https://hk01.com/news/1',
    'https://news.hk01.com/x',
    'https://www.mingpao.com/ins/1',
    'https://news.mingpao.com/ins/1',
    'https://www.sz.gov.cn/hk/1',
    'https://www.gov.hk/tc/1',
    'https://www.southcn.com/node/1',
    'https://www.stheadline.com/x'
  ];
  for (const u of ok) assert.equal(isWhitelisted(u), true, `应通过：${u}`);
});

test('非白名单与绕过尝试被拒绝', () => {
  const bad = [
    // 中介广告页（Firecrawl keyless 实测会返回此类内容）
    'https://www.hzmauto.hk/cbp-invest',
    'https://example.com/blog/1',
    // query 注入
    'https://evil.com/?u=https://www.hk01.com',
    // 后缀拼接
    'https://www.hk01.com.evil.com/x',
    'https://hk01.com.attacker.net/x',
    // userinfo 欺骗
    'https://user:pass@www.hk01.com@evil.com/x',
    // 前缀混淆
    'https://notgov.hk/x',
    'https://xgov.hk/1',
    // 非 http 协议与本地
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://127.0.0.1/x',
    'not a url',
    ''
  ];
  for (const u of bad) assert.equal(isWhitelisted(u), false, `应拒绝：${u}`);
});

test('白名单条目结构合法', () => {
  assert.ok(SOURCE_WHITELIST.length >= 9);
  for (const s of SOURCE_WHITELIST) {
    assert.ok(s.name, '应有 name');
    assert.ok(Array.isArray(s.domains) && s.domains.length > 0, `${s.name} 应有 domains`);
    for (const d of s.domains) {
      assert.match(d, /^[a-z0-9.-]+\.[a-z]{2,}$/i, `域名格式非法：${d}`);
      assert.ok(!d.startsWith('.'), `域名不应以点开头：${d}`);
    }
  }
});
