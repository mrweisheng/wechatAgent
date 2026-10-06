// 情报线（M3）
//
// 两条输入路径：
//   A) 外部 Agent 推送（推荐）-> POST /api/intel/push  -> ingest/intelIngest.js
//   B) 本地搜索兜底 -> runIntelOnce()，走 search/channels.js
// 两条路径共用 ingestIntel() 的白名单过滤 + 去重 + 交叉核实 + 归档。
//
// 归档内容【永不自动发布】，只作谈资素材（文档 §7）。

import schedule from 'node-schedule';
import { SOURCE_WHITELIST } from '../knowledge/corpus.js';
import { searchAll } from '../search/channels.js';
import { ingestIntel, intelStats } from '../ingest/intelIngest.js';

const DEFAULT_QUERIES = [
  '粵Z兩地牌 最新政策',
  '港車北上 最新 政策',
  '深圳灣 蓮塘 口岸 動態',
  '香港 進口車 行情',
  '中港牌 稅務 合規'
];

// 本地搜索兜底：结果全部交给 ingestIntel 走同一套校验
export async function runIntelOnce(queries = DEFAULT_QUERIES, source = 'local-search') {
  const collected = [];
  const channelErrors = [];
  for (const q of queries) {
    // 渠道错误不再静默吞掉：key 失效/网络故障与「确实搜不到」必须可区分
    const r = await searchAll(q, { max_results: 5 }).catch(e => {
      channelErrors.push(String(e?.message || e).slice(0, 120));
      return { merged: [] };
    });
    for (const item of r.merged || []) {
      collected.push({ title: item.title, url: item.url, snippet: item.snippet });
    }
  }
  if (!collected.length) {
    return {
      ok: true, added: 0, received: 0, rejected: 0, verified: 0,
      reasons: channelErrors.length
        ? ['无搜索结果', ...channelErrors.map(m => '渠道错误: ' + m)]
        : ['无可用搜索渠道或均无结果'],
      channelErrors
    };
  }
  const r = await ingestIntel({ source, items: collected });
  return { ...r, collected: collected.length };
}

// 【2026-10-06 审计 P2 修复】node-schedule 的字符串 cron 按【服务器本地时区】触发——
// 服务器/容器若在 UTC，「周一 08:00」会偏 8 小时（香港早晨变香港下午）。
// 改为显式时区的对象规则；INTEL_TZ 可覆盖，默认 Asia/Hong_Kong。
export function resolveCronExpr() {
  return {
    rule: (process.env.INTEL_CRON || '0 8 * * 1').trim(),
    tz: (process.env.INTEL_TZ || 'Asia/Hong_Kong').trim()
  };
}

export function startIntelCron() {
  if ((process.env.INTEL_ENABLED || '').toLowerCase() !== 'true') {
    console.log(`[intel] cron 未启用（如需本地兜底抓取，设 INTEL_ENABLED=true）`);
    return false;
  }
  let spec = resolveCronExpr();
  // 非法 cron 表达式会让 scheduleJob 同步抛错，进而整个服务起不来——探针校验后立即取消
  try {
    const probe = schedule.scheduleJob(spec, () => {});
    if (!probe) throw new Error('invalid cron');
    probe.cancel();
  } catch {
    console.error('[intel] INTEL_CRON 表达式非法:', spec.rule, '—— 回落默认 0 8 * * 1');
    spec = { rule: '0 8 * * 1', tz: spec.tz };
  }
  const job = schedule.scheduleJob(spec, async () => {
    try {
      const r = await runIntelOnce();
      console.log(`[intel] ${new Date().toISOString()} 抓到 ${r.received} 条，入库 ${r.added} 条，核实 ${r.verified} 条`);
    } catch (e) {
      console.error('[intel] error:', e.message);
    }
  });
  console.log(`[intel] cron 已启用: "${spec.rule}" @ ${spec.tz}（白名单 ${SOURCE_WHITELIST.length} 个源；主路径建议用外部 Agent 推送）`);
  // 返回 job 实例：调用方/测试可 cancel（常驻定时器不 cancel 会挂住进程事件循环）
  return job || true;
}

export { intelStats, SOURCE_WHITELIST };
