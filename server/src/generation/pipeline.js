// 生成管线（orchestrator）：多候选生成 → 初评 → Best-of-N 筛选 → 反思改写（最多 2 轮）→ 终态
//
// 落地文档要求 + 2026-10-05 明哥澄清：
//   §6.2-E 反思改写循环（设最大轮次）
//   §11.3 相似度指纹去重（生成结果与历史比对，超阈值重写）
//   §11.8 质检参数化（软评分 <70 触发重写，最多 2 轮）
//   三版 = 同一条文案的轻微改写（多账号防折叠）：内部生成 6 版轻微改写候选，
//   质检后按分数取 3 版「互不完全相同」的展示——只拦复制粘贴级重复（阈值 0.99）。
//
// 改写采纳策略：只有「严格更优」才采纳重写稿（pass 状态 > 软评分 > 相似度），
// 防止改写越改越差。所有 LLM 调用按版本并行，控制在可接受的时延内。

import { generate, rewriteVersion, sanitizeFinalText } from './generator.js';
import { scoreVersion, SOFT_PASS } from '../qa/softScore.js';
import { checkHardRules } from '../qa/ruleEngine.js';
import { findSimilarVersions, getToneSamples, getRecentEndings, textSimilarity } from '../memory/store.js';
import { STYLE_EXEMPLARS } from '../knowledge/corpus.js';

// 相似度阈值（2026-10-05 明哥两轮澄清后的最终口径）：
// - SIM_REWRITE_THRESHOLD：新文案与历史文案相似度 ≥ 此值才触发重写（跨次「越寫越像」审美线）
// - SIM_MUTUAL_MAX：同批三版两两相似度 ≥ 此值才算「几乎完全相同」。
//   【明哥原话】三版只要不是 100% 相似就行，90% 几相似都 OK，替换几个词都行——
//   唯一目的是避免三个微信号发完全一样的文本被微信折叠。故默认 0.99 = 只拦复制粘贴级重复。
const envRatio = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : def;
};
const SIM_THRESHOLD = envRatio('SIM_REWRITE_THRESHOLD', 0.9);
const MUTUAL_SIM_MAX = envRatio('SIM_MUTUAL_MAX', 0.99);
// 低分触发（无硬违规、无相似触发）的重写稿，与原稿的最小相似度（2026-10-06 审计 P1）：
// 这种重写在 prompt 层被要求「仍是原稿的轻微改写」，但实测提分诱因会让模型创意改写，
// 采纳后同批三版「互为轻微改写」的结构被冲散（实测互相似度掉到 0.05~0.25）。
// 采纳闸：低分重写的稿子必须仍是原稿的轻微改写，否则弃用保结构。
// （硬违规/相似触发的重写不受此限——它们本就需要结构性改动。）
const SIM_LIGHT_MIN = envRatio('SIM_LIGHT_MIN', 0.45);
const MAX_REWRITE_ROUNDS = 2;
// 候选池大小：同一母版的 6 个轻微改写候选，质检后取最优 3 版；环境变量可调（演示模式固定 3）
const CANDIDATE_COUNT = Math.max(3, Number(process.env.GENERATE_CANDIDATES) || 6);

function needsRewrite(v) {
  if (!v.hardCheck.pass) return true;
  if (v.score && v.score.total != null && v.score.total < SOFT_PASS) return true;
  if (v.similarity != null && v.similarity >= SIM_THRESHOLD) return true;
  return false;
}

// 排序键：先 pass 状态，再软评分，再相似度（低者优）
function rankOf(v) {
  return (v.hardCheck.pass ? 1000 : 0)
    + (v.score?.total ?? 0) / 10
    - (v.similarity ?? 0);
}

export async function runPipeline({ text, vision, scene }, io = {}) {
  const doGenerate = io.generate || generate;
  const doRewrite = io.rewrite || rewriteVersion;
  const doScore = io.score || scoreVersion;
  const doSimilar = io.similar || findSimilarVersions;

  // 语气资产库（§6.2-B）：明哥选中过的历史样本作为 few-shot，并纳入防照抄比对。
  // 注：三版已是「同一文案轻微改写」，不再有语气档轮换；tones/angles 参数已废除。
  const toneSamples = io.toneSamples || await getToneSamples(scene);
  // 近期收尾（供 r-ending-repeat 提示规则，2026-10-06 审计 P2）
  const recentTails = io.recentTails || await getRecentEndings();
  const wantCandidates = io.candidateCount || CANDIDATE_COUNT;
  // demo 模式（未配 key）生成层只会给 3 版，这里不强求 6
  const out = await doGenerate({ text, vision, scene, toneSamples, versionCount: wantCandidates });

  const candidates = out.versions.map(v => ({
    ...v,
    hardCheck: checkHardRules(v.text, { scene, userText: text, vision, recentTails }),
    score: null,
    similarity: 0,
    similarSample: '',
    rewrites: 0
  }));

  // 演示模式（未配置 key）：无评分无筛选无改写，硬规则照检
  if (out.demo) return { ...out, versions: candidates, candidateCount: candidates.length };

  // 初评：版本级相似度（历史 + 风格样本 + 明哥选中样本）+ 软评分（并行）
  const sims = await doSimilar(candidates.map(v => v.text));
  candidates.forEach((v, i) => {
    v.similarity = sims[i]?.sim ?? 0;
    v.similarSample = sims[i]?.sample || '';
  });
  // 照抄检测：§10 风格样本 + 明哥选中过的历史样本，与历史去重同一阈值，
  // 超阈值视作雷同触发重写（few-shot 有「学样子」风险，必须配防抄）
  const fixedEx = STYLE_EXEMPLARS[scene] || STYLE_EXEMPLARS.unknown;
  const refTexts = [...fixedEx, ...toneSamples];
  for (const v of candidates) {
    for (const ex of refTexts) {
      const s = textSimilarity(v.text, ex);
      if (s > v.similarity) {
        v.similarity = s;
        v.similarSample = ex.slice(0, 60);
      }
    }
  }
  await Promise.all(candidates.map(async v => {
    v.score = await doScore(v.text, { scene });
  }));

  // ---- Best-of-N 筛选（2026-10-05 明哥再次澄清后重构）----
  // 三版 = 同一条文案的轻微改写（多账号分发防微信折叠）。
  // 筛选只做两件事：
  //   ① 质检得分优先（违规/低分靠后，选中后交反思改写）
  //   ② 两两文本不得「几乎完全相同」（相似度 ≥ MUTUAL_SIM_MAX，默认 0.99）
  // 不再要求换整体写法 / 收尾互异 / 写法标签互异——与「轻微改写」需求直接冲突，已废除。
  const notDup = (c, sel) => sel.every(s => textSimilarity(c.text, s.text) < MUTUAL_SIM_MAX);
  const ranked = [...candidates].sort((a, b) => rankOf(b) - rankOf(a));
  const selected = [];
  // 第一轮：只收质检通过的
  for (const c of ranked) { if (selected.length >= 3) break; if (c.hardCheck.pass && notDup(c, selected)) selected.push(c); }
  // 第二轮：不足 3 版时按排序继续凑（含违规稿，入选后交反思改写），
  // 但仍不得与已选文本几乎完全相同——否则三个账号发出去照样折叠，宁可少给
  for (const c of ranked) { if (selected.length >= 3) break; if (!selected.includes(c) && notDup(c, selected)) selected.push(c); }
  const versions = selected.slice(0, 3);

  // 反思改写循环
  for (let round = 1; round <= MAX_REWRITE_ROUNDS; round++) {
    const idxs = versions.map((v, i) => i).filter(i => needsRewrite(versions[i]));
    if (!idxs.length) break;

    // 本轮基线快照：并行重写只读快照，不写 versions，避免互读半采纳状态（竞态修复 2026-10-05）
    const snapshot = versions.slice();
    const results = await Promise.all(idxs.map(async i => {
      const v = snapshot[i];
      // 触发原因快照：仅低分触发的重写，采纳时须过「仍是轻微改写」闸（SIM_LIGHT_MIN）
      const scoreOnlyTrigger = v.hardCheck.pass
        && !(v.similarity != null && v.similarity >= SIM_THRESHOLD)
        && (v.score?.total != null && v.score.total < SOFT_PASS);
      const feedback = {
        violations: v.hardCheck.violations.map(x => x.msg),
        score: v.score?.total != null
          ? `${v.score.total} 分（高级感${v.score.premium}/新意${v.score.novelty}/调性${v.score.tone}）${v.score.reason || ''}`
          : null,
        similar: v.similarity >= SIM_THRESHOLD
          ? `与旧文案相似度 ${v.similarity}（${v.similarSample}…）`
          : null
      };
      const rewritten = await doRewrite({
        text: v.text, scene,
        userText: text, vision, feedback,
        avoidSample: v.similarity >= SIM_THRESHOLD ? v.similarSample : null,
        toneSamples
      });
      if (!rewritten) {
        console.warn('[pipeline] rewrite 调用失败，保留原稿');
        return null; // 重写失败保留原稿
      }

      // 【2026-10-06 审计 P0】采纳前再净化一次：rewrite 通道是版本头泄漏主通道，
      // io.rewrite 注入路径（测试/未来替代实现）也必须过同一道闸。
      const cleanText = sanitizeFinalText(rewritten);
      if (!cleanText) {
        console.warn('[pipeline] rewrite 净化后为空，保留原稿');
        return null;
      }

      const cand = {
        ...v,
        text: cleanText,
        hardCheck: checkHardRules(cleanText, { scene, userText: text, vision, recentTails })
      };
      const [score, sims2] = await Promise.all([
        doScore(cleanText, { scene }),
        doSimilar([cleanText])
      ]);
      cand.score = score;
      cand.similarity = sims2[0]?.sim ?? 0;
      cand.similarSample = sims2[0]?.sample || '';
      for (const ex of refTexts) {
        const s = textSimilarity(cleanText, ex);
        if (s > cand.similarity) {
          cand.similarity = s;
          cand.similarSample = ex.slice(0, 60);
        }
      }
      return { i, base: v, cand, scoreOnlyTrigger };
    }));

    // 采纳阶段串行：防折叠防线（2026-10-04）与「严格更优」判断基于实时 versions，
    // 确保后采纳的稿不与已采纳稿雷同、且各自严格优于本轮原稿。
    for (const r of results) {
      if (!r) continue;
      const { i, base, cand, scoreOnlyTrigger } = r;
      // 轻微改写闸（2026-10-06 审计 P1）：仅低分触发的重写稿若已偏离原稿结构，
      // 采纳它会冲散同批三版「互为轻微改写」的结构——宁可保留原低分稿。
      if (scoreOnlyTrigger) {
        const drift = textSimilarity(cand.text, base.text);
        if (drift < SIM_LIGHT_MIN) {
          console.warn(`[pipeline] 低分重写稿偏离原稿（sim=${drift} < ${SIM_LIGHT_MIN}），弃用保三版结构`);
          continue;
        }
      }
      const mutualOk = versions.every((o, j) => j === i || textSimilarity(cand.text, o.text) < MUTUAL_SIM_MAX);
      if (rankOf(cand) > rankOf(base) && mutualOk) {
        cand.rewrites = base.rewrites + 1;
        versions[i] = cand;
      }
    }
  }

  return { ...out, versions, candidateCount: candidates.length };
}
