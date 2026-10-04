// 情报接收入库测试（外部 Agent 推送通道）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 必须在 import ingest 之前指定独立 DATA_DIR，避免污染项目 data/
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'intel-test-'));
process.env.DATA_DIR = TMP;

const { ingestIntel, loadIntel, intelStats } = await import('./intelIngest.js');

test('接收白名单来源并入库', async () => {
  const r = await ingestIntel({
    source: 'test-agent',
    items: [
      { title: '粵Z兩地牌政策更新', url: 'https://www.hk01.com/news/12345', snippet: '摘要' },
      { title: '深圳口岸辦通告', url: 'https://www.sz.gov.cn/hk/notice', snippet: '摘要' }
    ]
  });
  assert.equal(r.accepted, true);
  assert.equal(r.added, 2);
  assert.equal(r.rejected, 0);
  const all = await loadIntel();
  assert.equal(all.length, 2);
  assert.ok(all.every(i => i.ingestedAt && i.via === 'test-agent'));
});

test('非白名单来源被拒绝', async () => {
  const r = await ingestIntel({
    source: 'test-agent',
    items: [
      { title: '中港牌中介广告', url: 'https://www.hzmauto.hk/cbp-invest', snippet: '广告' },
      { title: '境外站点', url: 'https://example.com/news/1', snippet: 'x' }
    ]
  });
  assert.equal(r.added, 0);
  assert.equal(r.rejected, 2);
  assert.ok(r.reasons.some(x => x.includes('非白名单')));
});

test('同一 URL 重复推送被去重', async () => {
  const r = await ingestIntel({
    source: 'test-agent',
    items: [{ title: '重复标题', url: 'https://www.hk01.com/news/12345', snippet: 'x' }]
  });
  assert.equal(r.added, 0, '已存在的 URL 不应重复入库');
});

test('非法 url 被拒绝', async () => {
  const r = await ingestIntel({
    source: 'test-agent',
    items: [
      { title: '无协议', url: 'ftp://hk01.com/x', snippet: '' },
      { title: '', url: 'https://www.hk01.com/y', snippet: '' },
      { title: '无 url', url: '', snippet: '' }
    ]
  });
  assert.equal(r.added, 0);
  assert.equal(r.rejected, 3);
});

test('多源交叉：同主题两个独立白名单域 -> verified', async () => {
  const topic = '港車北上新政策';
  const r = await ingestIntel({
    source: 'test-agent',
    items: [
      // 标题前 12 有效字需一致才会归为同主题
      { title: `${topic}細節解讀`, url: 'https://www.mingpao.com/ins/aaa', snippet: 'x' },
      { title: `${topic}官方回應`, url: 'https://news.mingpao.com/ins/bbb', snippet: 'x' },
      { title: `${topic}另一說法`, url: 'https://www.southcn.com/node/ccc', snippet: 'x' }
    ]
  });
  assert.equal(r.added, 3);
  // mingpao.com 与 news.mingpao.com 是不同 host，但同属一家媒体 -> 按 host 判定为 2 个独立源
  assert.ok(r.verified >= 1, '至少应有 1 条通过交叉核实');
  const all = await loadIntel();
  const verified = all.filter(i => i.verified);
  assert.ok(verified.length >= 1);
});

test('空 items 被拒绝', async () => {
  const r = await ingestIntel({ source: 'x', items: [] });
  assert.equal(r.accepted, false);
  assert.ok(r.reasons.includes('items 为空'));
});

test('超长字段被截断', async () => {
  const long = 'A'.repeat(5000);
  const r = await ingestIntel({
    source: 'test-agent',
    items: [{ title: long, url: 'https://www.hk01.com/long', snippet: long }]
  });
  assert.equal(r.added, 1);
  const all = await loadIntel();
  const it = all.find(i => i.url.includes('/long'));
  assert.ok(it.title.length <= 200);
  assert.ok(it.snippet.length <= 800);
});

test.after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

// 【回归 2026-10-04】带 UTF-8 BOM 的种子文件不得被误判损坏清零
test('BOM 开头的 intel.json 可正常读取追加', async () => {
  const file = path.join(TMP, 'intel.json');
  await fs.writeFile(file, '﻿[]', 'utf8');
  const r = await ingestIntel({
    source: 'bom-test',
    items: [{ title: 'BOM 測試', url: 'https://www.mingpao.com/ins/999', snippet: 'x' }]
  });
  assert.equal(r.added, 1);
  const all = await loadIntel();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'BOM 測試');
});

// 【回归 2026-10-04】intelStats 内部误调导出别名 loadIntel -> ReferenceError 被
// catch 吞掉，推送成功后 total 恒为 0。修复后 stats 必须如实反映归档。
test('ingest 后 intelStats 如实反映 total/lastPush（内部函数名陷阱回归）', async () => {
  await ingestIntel({
    source: 'stats-test-agent',
    items: [{ title: 'Stats 可觀測性測試', url: 'https://www.stheadline.com/s/1', snippet: 'x' }]
  });
  const s = await intelStats();
  assert.ok(s.total >= 1, `total 应 >= 1，实际 ${s.total}`);
  assert.ok(s.lastPushAt, 'lastPushAt 应有值');
  assert.equal(s.lastPushSource, 'stats-test-agent');
  assert.equal(s.pushEnabled, false, '测试环境未配置 token');
});

// ===== 时效过滤（2026-10-04 新增）=====
// 事故回归：2026-10 推入《比亞迪 2025 年度銷量有望超越 Tesla》——过去年份仍作展望讨论
// 测试用动态年份（当前 HK 年份），任意时间运行都成立
const { detectStaleTitle } = await import('./intelIngest.js');
const CUR_YEAR = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hong_Kong', year: 'numeric' }).format(new Date()));

test('时效过滤：过去年份 + 展望语气 = 旧闻翻炒被拒（比亚迪事故回归）', async () => {
  const title = `電動車龍頭品牌將易主？比亞迪 ${CUR_YEAR - 1} 年度銷量有望超越 Tesla`;
  const r = await ingestIntel({
    source: 'stale-test',
    items: [{ title, url: `https://www.hk01.com/stale/${CUR_YEAR}0101`, snippet: '據運輸署數據…' }]
  });
  assert.equal(r.added, 0);
  assert.equal(r.rejected, 1);
  assert.ok(r.reasons.some(x => x.includes('标题时效性存疑')), `应给出时效原因: ${r.reasons.join('|')}`);
});

test('detectStaleTitle：边界用例（当年/未来年份/无年份/纯回顾）', () => {
  // 当年展望：正常
  assert.equal(detectStaleTitle(`比亞迪 ${CUR_YEAR} 年度銷量有望超越 Tesla`), null);
  // 未来年份前瞻：正常
  assert.equal(detectStaleTitle(`${CUR_YEAR + 1} 新口岸將啟用？三大規劃曝光`), null);
  // 无年份：不拦
  assert.equal(detectStaleTitle('深圳灣口岸通關安排調整'), null);
  // 过去年份但纯回顾语气：不拦（由 publishedAt 年龄兜底）
  assert.equal(detectStaleTitle(`回顧 ${CUR_YEAR - 1} 年度香港車市十大事件`), null);
  // 过去年份 + 展望词：拦
  assert.ok(detectStaleTitle(`${CUR_YEAR - 1} 年兩地牌配額預計大幅放寬`));
});

test('时效过滤：publishedAt 超过 3 个月被拒；1 个月内放行', async () => {
  const old = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString(); // ~4 个月前
  const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(); // ~1 个月前
  const r = await ingestIntel({
    source: 'recency-test',
    items: [
      { title: `港車北上預約系統升級（舊）`, url: 'https://www.hk01.com/old/1', publishedAt: old },
      { title: `港車北上預約系統升級（新）`, url: 'https://www.hk01.com/new/1', publishedAt: recent }
    ]
  });
  assert.equal(r.added, 1);
  assert.equal(r.rejected, 1);
  assert.ok(r.reasons.some(x => x.includes('发布时间过旧')));
});
