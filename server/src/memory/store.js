// 记忆层
// 覆盖：叙事角度轮换记账、历史文案去重指纹、反馈、纠错库
// 存储：JSON 文件（原子写 + 损坏保护），后续可换 SQLite + 向量库

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
await fs.mkdir(DATA_DIR, { recursive: true });

const FILES = {
  history: path.join(DATA_DIR, 'history.json'),
  feedback: path.join(DATA_DIR, 'feedback.json'),
  corrections: path.join(DATA_DIR, 'corrections.json'),
  angleLedger: path.join(DATA_DIR, 'angle_ledger.json')
};

async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    // 容忍 UTF-8 BOM：JSON.parse 不接受 BOM，带 BOM 的手写种子文件
    // 曾被整批误判「损坏」并隔离清零（2026-10-04 修复）
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    // 真损坏：备份后回落默认值，绝不静默覆盖丢失历史
    const bak = file + '.corrupt-' + Date.now();
    await fs.rename(file, bak).catch(() => {});
    console.warn(`[store] ${path.basename(file)} 损坏，已备份至 ${bak}`);
    return fallback;
  }
}

// 原子写：先写唯一 .tmp 再 rename，避免并发/中断产生半截文件
// （tmp 带随机后缀：两个并发写方共享同名 .tmp 会互相覆盖/抢走 rename 源）
async function writeJson(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

// ========== 历史文案（去重指纹）============
export async function addHistory(entry) {
  const cur = await readJson(FILES.history, []);
  cur.unshift({ ...entry, at: new Date().toISOString() });
  cur.splice(200);
  await writeJson(FILES.history, cur);
}

export async function recentHistory(limit = 10) {
  const cur = await readJson(FILES.history, []);
  return cur.slice(0, limit);
}

// ===== 3-gram 相似度（文档 §11.3 相似度指纹去重）=====
function shingles(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// 两段文本的 3-gram Jaccard 相似度（供 pipeline 比对风格样本等固定参照）
export function textSimilarity(a, b) {
  return Number(jaccard(shingles(a), shingles(b)).toFixed(3));
}

/**
 * 语气资产库（§6.2-B tone DNA：好样本沉淀，2026-10-04）
 * 从「選中此版」反馈里提取文案正文作为明哥审美的真实样本：
 * - 只取 kind==='pick' 且带文本且当时硬规则通过的
 * - 同场景去重（相似度 ≥0.35 视为重复口味）
 * - 该场景没有选中记录时回落到全域近期选中（风格偏好跨场景成立）
 * 生成端把样本作为 few-shot 注入（并纳入防照抄比对），替代部分固定锚点。
 */
export async function getToneSamples(scene, { limit = 3, maxSim = 0.35 } = {}) {
  const fb = await readJson(FILES.feedback, []);
  const picks = fb.filter(f =>
    f?.kind === 'pick' && typeof f?.payload?.text === 'string' && f.payload.text.trim()
    && f?.payload?.pass !== false
  );
  const inScene = picks.filter(f => (f.payload.scene || 'unknown') === scene);
  const pool = inScene.length ? inScene : picks;
  const out = [];
  for (const p of pool) {
    const t = p.payload.text.trim();
    if (out.some(o => textSimilarity(o, t) >= maxSim)) continue;
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 版本级去重（2026-10-04 修复）：拿「生成的文案」与「历史生成的文案」比对。
 * 上一版拿用户输入比历史输出，普通话输入 vs 粤语文案 3-gram 几乎不重叠，
 * 同一请求重发也零命中，防重实际不生效。
 * @param {string[]} texts 本批生成的各版本文案
 * @returns {Promise<Array<{sim:number, sample:string, at:string}>>} 与输入对齐，取最相似一条
 */
export async function findSimilarVersions(texts, { limit = 20, threshold = 0.3 } = {}) {
  const hist = await readJson(FILES.history, []);
  const olds = [];
  for (const h of hist.slice(0, limit)) {
    for (const v of (h.versions || [])) {
      if (v.text) olds.push({ sh: shingles(v.text), sample: v.text, at: h.at });
    }
  }
  return texts.map(t => {
    const s = shingles(t);
    let best = { sim: 0, sample: '', at: null };
    for (const o of olds) {
      const sim = jaccard(s, o.sh);
      if (sim > best.sim) best = { sim, sample: o.sample, at: o.at };
    }
    return {
      sim: Number(best.sim.toFixed(3)),
      sample: best.sim >= threshold ? best.sample.slice(0, 60) : '',
      at: best.at
    };
  });
}

// ========== 反馈 ==========
export async function recordFeedback(payload) {
  const cur = await readJson(FILES.feedback, []);
  cur.unshift({ ...payload, at: new Date().toISOString() });
  cur.splice(500);
  await writeJson(FILES.feedback, cur);
}

// ========== 纠错库（文档 6.2-G）============
export async function addCorrection({ original, corrected, type, scene }) {
  const cur = await readJson(FILES.corrections, []);
  cur.unshift({
    original, corrected,
    type: type || 'unknown',
    scene: scene || 'unknown',
    at: new Date().toISOString()
  });
  cur.splice(200);
  await writeJson(FILES.corrections, cur);
}

export async function findCorrections(scene) {
  const cur = await readJson(FILES.corrections, []);
  if (!scene) return cur.slice(0, 5);
  const exact = cur.filter(c => c.scene === scene);
  // 无精确匹配时回落通用纠错，保证纠错记忆始终生效
  return (exact.length ? exact : cur.filter(c => c.scene === 'generic')).slice(0, 5);
}
