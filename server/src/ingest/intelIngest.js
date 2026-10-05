// 情报接收入库（外部 Agent 推送通道）
//
// 设计目的（明哥第 3 点诉求）：
//   本系统不自己配搜索、不做重 Agent。改由「外部已有的搜索 Agent」每天按约定格式
//   搜索后 POST 过来，本系统只负责【入库 + 校验 + 去重 + 交叉核实 + 归档】。
//
// 外部 Agent 的职责边界（必须极简，便于任何工具对接）：
//   1. 按关键词搜索
//   2. 【不生成任何文案】——只搬运「标题 / 链接 / 一句话摘要」
//   3. POST 到 /api/intel/push
//
// 本系统负责：
//   1. 白名单域名过滤（SOURCE_WHITELIST）
//   2. 与已归档资讯去重
//   3. 多源交叉核实（同一主题 ≥2 个独立白名单域名 -> verified）
//   4. 归档到 data/intel.json，标注来源与核实状态
//
// 注意：归档内容【永不自动发布】，只作谈资素材（文档 §7）。

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isWhitelisted, SOURCE_WHITELIST,
  INTEL_RECENCY, STALE_FORECAST_MARKERS
} from '../knowledge/corpus.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const INTEL_FILE = path.join(DATA_DIR, 'intel.json');
const META_FILE = path.join(DATA_DIR, 'intel-meta.json');
const MAX_ITEMS = 1000;

// 推送可观测性：lastPushAt 独立于条目归档记录——外部 Agent 推来一整批
// 全是重复项时（每天推同批旧闻是常态），若只看 items[0].ingestedAt，
// 会误报「Agent 没在推送」。恰恰在这个场景下指标必须如实。
async function recordPushMeta(source, at) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(META_FILE, JSON.stringify({
      lastPushAt: at,
      lastPushSource: String(source || 'external-agent').slice(0, 50)
    }), 'utf8');
  } catch { /* 可观测性写失败不影响主流程 */ }
}

async function loadAll() {
  try {
    const raw = await fs.readFile(INTEL_FILE, 'utf8');
    // 容忍 UTF-8 BOM（JSON.parse 不接受，见 store.js 同款修复）
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 文件损坏：备份后重建，不静默覆盖。用 copyFile 而非 rename——
      // rename 失败被吞掉时，下一次 saveAll 会把唯一可恢复的原始数据覆盖掉
      const bak = INTEL_FILE + '.corrupt-' + Date.now();
      await fs.copyFile(INTEL_FILE, bak).catch(() => {});
      console.warn('[intel] intel.json 损坏，已备份至', bak);
    }
    return [];
  }
}

// 推送可能并发到达（外部 Agent 重试 / 与 /api/intel/run 同时触发），
// 「读→改→写」不加互斥会互相覆盖：轻则丢整批入库，重则共享 .tmp 被
// 对方 rename 走后 rename 抛 ENOENT 直接 500。模块级 Promise 链串行化。
let ingestChain = Promise.resolve();

async function saveAll(items) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // tmp 文件名唯一化：共享 .tmp 在并发下会被另一个写方覆盖/抢走
  const tmp = `${INTEL_FILE}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(tmp, INTEL_FILE); // 原子写，避免半截文件
}

const norm = s => String(s || '').replace(/\s+/g, '').trim().toLowerCase();

// 主题归一：取标题前 6 个有效字，用于交叉核实分组。
// 启发式且偏保守：同一事件的不同媒体标题通常共享前 5~7 字
// （如「港車北上新政策…」「深圳灣口岸…」）。宁可分组偏细（漏判 verified），
// 也不要分组偏粗（把无关新闻误标为已核实事实）。
function topicKey(title) {
  return norm(title).replace(/[^\w一-龥]/g, '').slice(0, 6);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }
}

// 当前年份按香港时区（与生成层的早安星期同一口径，部署时区无关）
function hkYear(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hong_Kong', year: 'numeric' }).format(now));
}

/**
 * 旧闻翻炒识别（2026-10-04 新增，实际事故：2026 年仍推入「2025 年度銷量有望超越 Tesla」）
 * 规则：标题里出现的年份全部早于当前年 + 命中展望/推测措辞 → 判为过期展望。
 * 只查标题（谈资展示的就是标题）；无年份或含当年/未来年份的，不拦。
 * 纯回顾（无展望词）不拦 —— 交给 publishedAt 年龄校验兜底。
 */
export function detectStaleTitle(title, now = new Date()) {
  const cur = hkYear(now);
  const years = [...String(title).matchAll(/20\d{2}/g)].map(m => Number(m[0]));
  if (!years.length) return null;
  const maxYear = Math.max(...years);
  if (maxYear >= cur) return null;
  if (STALE_FORECAST_MARKERS.some(m => String(title).includes(m))) {
    return { titleYear: maxYear, currentYear: cur };
  }
  return null;
}

/**
 * 接收入库（并发安全：模块级互斥串行化，见 ingestChain）
 * @param body { source, items: [{title, url, snippet, publishedAt}] }
 * @returns { accepted, received, added, rejected, verified, reasons }
 */
export function ingestIntel(body = {}) {
  const run = ingestChain.then(() => doIngest(body));
  ingestChain = run.catch(() => { /* 链上吞错，防止一次失败毒化后续所有推送 */ });
  return run;
}

async function doIngest(body = {}) {
  const items = Array.isArray(body.items) ? body.items : [];
  const reasons = [];

  if (!items.length) {
    return { accepted: false, received: 0, added: 0, rejected: 0, verified: 0, reasons: ['items 为空'] };
  }

  // 无论入库结果如何，推送动作本身先记录（可观测性）
  await recordPushMeta(body.source, new Date().toISOString());

  const existing = await loadAll();
  const seen = new Set(existing.map(i => norm(i.url) || norm(i.title)));
  // 主题 -> 独立白名单 host 集合（用于交叉核实）
  const topicHosts = new Map();
  for (const it of existing) {
    const k = topicKey(it.title);
    if (!k) continue;
    if (!topicHosts.has(k)) topicHosts.set(k, new Set());
    const h = hostOf(it.url);
    if (h) topicHosts.get(k).add(h);
  }

  const accepted = [];
  let rejected = 0;

  // 单次推送上限：超出部分如实计入 rejected，不让外部 Agent 误以为都被去重了
  const INCOMING_CAP = 200;
  const incoming = items.slice(0, INCOMING_CAP);
  if (items.length > INCOMING_CAP) {
    rejected += items.length - INCOMING_CAP;
    reasons.push(`超出单次推送上限 ${INCOMING_CAP} 条，截断 ${items.length - INCOMING_CAP} 条`);
  }
  const nowTs = Date.now();

  for (const raw of incoming) {
    const title = String(raw?.title || '').trim().slice(0, 200);
    const url = String(raw?.url || '').trim().slice(0, 500);
    const snippet = String(raw?.snippet || '').trim().slice(0, 800);

    if (!title || !url) { rejected++; reasons.push(`缺 title/url: ${JSON.stringify(raw).slice(0, 60)}`); continue; }
    if (!/^https?:\/\//i.test(url)) { rejected++; reasons.push(`url 非法: ${url.slice(0, 60)}`); continue; }
    if (!isWhitelisted(url)) { rejected++; reasons.push(`非白名单来源: ${url.slice(0, 60)}`); continue; }

    // ---- 时效校验（2026-10-04 新增）----
    // 1) publishedAt 年龄：超过 3 个月的旧闻直接拒（agent 带了日期才查得到）
    if (raw.publishedAt) {
      const t = Date.parse(raw.publishedAt);
      const maxAgeMs = INTEL_RECENCY.maxAgeMonths * 30 * 24 * 3600 * 1000;
      if (Number.isFinite(t) && nowTs - t > maxAgeMs) {
        rejected++;
        reasons.push(`发布时间过旧（超过 ${INTEL_RECENCY.maxAgeMonths} 个月）: ${String(raw.publishedAt).slice(0, 32)}`);
        continue;
      }
    }
    // 2) 标题年份口径：过去年份 + 展望语气 = 旧闻翻炒（如「2025 年度銷量有望超越」）
    const stale = detectStaleTitle(title);
    if (stale) {
      rejected++;
      reasons.push(`标题时效性存疑: ${stale.titleYear} 年已过仍作展望讨论（当前 ${stale.currentYear} 年）: ${title.slice(0, 60)}`);
      continue;
    }

    if (seen.has(norm(url)) || seen.has(norm(title))) {
      // 同题异源：不再重复归档，但新来源的 host 计入交叉核实，
      // 让已归档的同主题条目能升级为 verified（否则永远单源待核）
      if (!seen.has(norm(url))) {
        const h = hostOf(url);
        const k = topicKey(title);
        if (h && k && topicHosts.has(k)) topicHosts.get(k).add(h);
      }
      continue; // 去重（非拒绝）
    }

    seen.add(norm(url));
    seen.add(norm(title));
    accepted.push({
      title,
      url,
      snippet,
      host: hostOf(url),
      publishedAt: raw.publishedAt || null,
      ingestedAt: new Date().toISOString(),
      via: String(body.source || 'external-agent').slice(0, 50),
      verified: false // 稍后统一判定
    });
  }

  // ---- 多源交叉核实：同主题 ≥2 个独立白名单 host -> verified ----
  // 同批新增与已归档条目统一判定：老条目在第二来源到达后也能升级
  let verified = 0;
  const markVerified = entry => {
    const k = topicKey(entry.title);
    if (!k) return;
    if (!topicHosts.has(k)) topicHosts.set(k, new Set());
    const hosts = topicHosts.get(k);
    if (entry.host) hosts.add(entry.host);
    entry.verified = hosts.size >= 2;
    if (entry.verified) verified++;
  };
  for (const a of accepted) markVerified(a);
  for (const it of existing) {
    if (it.verified) continue;
    const before = it.verified;
    markVerified(it);
    if (!before && it.verified) verified++; // 老条目升级
  }

  const merged = [...accepted, ...existing];
  if (merged.length > MAX_ITEMS) merged.length = MAX_ITEMS;
  await saveAll(merged);

  return {
    ok: true,
    accepted: true,
    received: items.length,
    added: accepted.length,
    rejected,
    verified,
    reasons: reasons.slice(0, 10)
  };
}

export async function intelStats() {
  // 注意：调 loadAll（本地函数名）；loadIntel 只是导出别名，模块内部不可见。
  // 上一版在 try 里调 loadIntel -> ReferenceError 被 catch 吞掉，total 恒为 0。
  let items = [];
  try {
    items = await loadAll();
  } catch {
    items = [];
  }
  const token = (process.env.INTEL_PUSH_TOKEN || '').trim();
  // lastPush 以独立 meta 记录为准（全重复推送也如实更新）；无 meta 时回落归档条目
  let lastPush = null;
  try {
    lastPush = JSON.parse(await fs.readFile(META_FILE, 'utf8'));
  } catch { /* 无 meta 文件，回落 */ }
  const latest = items[0] || null; // merged 时新条目在前
  return {
    sources: SOURCE_WHITELIST.map(s => ({ name: s.name, domains: s.domains })),
    file: INTEL_FILE,
    // 可观测性（2026-10-04）：部署后验证外部 Agent 是否在正常推送
    pushEnabled: !!token && !/REPLACE/.test(token),
    total: items.length,
    verified: items.filter(i => i.verified).length,
    lastPushAt: lastPush?.lastPushAt || latest?.ingestedAt || null,
    lastPushSource: lastPush?.lastPushSource || latest?.via || null
  };
}

export { loadAll as loadIntel };
