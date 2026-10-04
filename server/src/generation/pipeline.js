// 生成管线（orchestrator）：多候选生成 → 初评 → Best-of-N 筛选 → 反思改写（最多 2 轮）→ 终态
//
// 落地文档要求 + 2026-10-04 调研结论：
//   §6.2-E 反思改写循环（设最大轮次）
//   §11.3 相似度指纹去重（生成结果与历史比对，超阈值重写）
//   §11.8 质检参数化（软评分 <70 触发重写，最多 2 轮）
//   Best-of-N（HF/ICLR 2025-26 趋势）：同等算力下「多采样 + 验证器重排」常优于
//   纯自我修正 —— 内部生成 6 版（每角度 × 2 语气），质检后每角度只留最优 1 版，
//   展示给用户的 3 版永远是筛过的，不是抽到的。
//
// 改写采纳策略：只有「严格更优」才采纳重写稿（pass 状态 > 软评分 > 相似度），
// 防止改写越改越差。所有 LLM 调用按版本并行，控制在可接受的时延内。

import { generate, rewriteVersion } from './generator.js';
import { scoreVersion, SOFT_PASS } from '../qa/softScore.js';
import { checkHardRules } from '../qa/ruleEngine.js';
import { findSimilarVersions, getPreferredToneOrder, getToneSamples, textSimilarity } from '../memory/store.js';
import { STYLE_EXEMPLARS } from '../knowledge/corpus.js';

const SIM_THRESHOLD = 0.6;
const MAX_REWRITE_ROUNDS = 2;
// 候选池大小：3 角度 × 2 语气 = 6；环境变量可调（演示模式固定 3）
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

export async function runPipeline({ text, vision, scene, angles }, io = {}) {
  const doGenerate = io.generate || generate;
  const doRewrite = io.rewrite || rewriteVersion;
  const doScore = io.score || scoreVersion;
  const doSimilar = io.similar || findSimilarVersions;

  // 反馈回填（M2）：最常被「選中此版」的语气排前面
  const tones = io.tones || await getPreferredToneOrder();
  // 语气资产库（§6.2-B）：明哥选中过的历史样本作为 few-shot，并纳入防照抄比对
  const toneSamples = io.toneSamples || await getToneSamples(scene);
  const wantCandidates = io.candidateCount || CANDIDATE_COUNT;
  // demo 模式（未配 key）生成层只会给 3 版，这里不强求 6
  const out = await doGenerate({ text, vision, scene, angles, tones, toneSamples, versionCount: wantCandidates });

  const candidates = out.versions.map(v => ({
    ...v,
    hardCheck: checkHardRules(v.text, { scene, userText: text, vision, imagePlan: out.imagePlan }),
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
    v.score = await doScore(v.text, { scene, angle: v.angle, tone: v.tone });
  }));

  // ---- Best-of-N 筛选（2026-10-04 澄清后重构）----
  // 三版 = 同一内容的三种写法（多账号分发防微信折叠）。
  // 筛选标准：质检得分优先 + 三版彼此写法差异足够：
  //   ① 整篇两两相似度 < 0.45（字面互异）
  //   ② 收尾句两两不得雷同（祝福/收尾复读是视觉疲劳根源，单查整篇查不出）
  //   ③ 写法标签互异（A/B/C 各一条）
  const MUTUAL_SIM_MAX = 0.45;
  const endingOf = t => {
    const ls = String(t).trim().split('\n').filter(l => l.trim() && !/#\s*明哥中港牌/.test(l));
    return ls[ls.length - 1] || '';
  };
  const distinct = (a, b) =>
    textSimilarity(a.text, b.text) < MUTUAL_SIM_MAX &&
    endingOf(a.text) !== endingOf(b.text) &&
    textSimilarity(endingOf(a.text), endingOf(b.text)) < 0.7;
  const pick = (c, sel) => sel.every(s => distinct(c, s)) && !sel.some(s => s.angle === c.angle);
  const relax = (c, sel) => sel.every(s => textSimilarity(c.text, s.text) < MUTUAL_SIM_MAX);
  const ranked = [...candidates].sort((a, b) => rankOf(b) - rankOf(a));
  const selected = [];
  for (const c of ranked) { if (selected.length >= 3) break; if (pick(c, selected)) selected.push(c); }
  // 放宽一：允许同标签（仍要求文本互异）
  for (const c of ranked) { if (selected.length >= 3) break; if (!selected.includes(c) && relax(c, selected)) selected.push(c); }
  // 放宽二：候选不足时如实凑数（宁少勿假，标签重复可接受）
  for (const c of ranked) { if (selected.length >= 3) break; if (!selected.includes(c)) selected.push(c); }
  // 按写法路径稳定排序展示（直述→觀點→白描）
  const approaches = angles || [];
  selected.sort((a, b) => {
    const ia = approaches.indexOf(a.angle), ib = approaches.indexOf(b.angle);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const versions = selected.slice(0, 3);

  // 反思改写循环
  for (let round = 1; round <= MAX_REWRITE_ROUNDS; round++) {
    const idxs = versions.map((v, i) => i).filter(i => needsRewrite(versions[i]));
    if (!idxs.length) break;

    await Promise.all(idxs.map(async i => {
      const v = versions[i];
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
        text: v.text, scene, angle: v.angle, tone: v.tone,
        userText: text, vision, feedback,
        avoidSample: v.similarity >= SIM_THRESHOLD ? v.similarSample : null,
        toneSamples
      });
      if (!rewritten) {
        console.warn('[pipeline] rewrite 调用失败，保留原稿:', v.angle, v.tone);
        return; // 重写失败保留原稿
      }

      const cand = {
        ...v,
        text: rewritten,
        hardCheck: checkHardRules(rewritten, { scene, userText: text, vision, imagePlan: out.imagePlan })
      };
      const [score, sims2] = await Promise.all([
        doScore(rewritten, { scene, angle: v.angle, tone: v.tone }),
        doSimilar([rewritten])
      ]);
      cand.score = score;
      cand.similarity = sims2[0]?.sim ?? 0;
      cand.similarSample = sims2[0]?.sample || '';
      for (const ex of refTexts) {
        const s = textSimilarity(rewritten, ex);
        if (s > cand.similarity) {
          cand.similarity = s;
          cand.similarSample = ex.slice(0, 60);
        }
      }

      // 防折叠防线（2026-10-04）：重写稿须与同批其他版本保持互异——
      // 并行重写可能收敛到相近内容，两版雷同就失去了多账号分发的意义
      const mutualOk = versions.every((o, j) => j === i || textSimilarity(rewritten, o.text) < MUTUAL_SIM_MAX);

      // 仅当严格更优才采纳
      if (rankOf(cand) > rankOf(v) && mutualOk) {
        cand.rewrites = v.rewrites + 1;
        versions[i] = cand;
      }
    }));
  }

  return { ...out, versions, candidateCount: candidates.length };
}
