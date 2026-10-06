// 生成管线测试：硬规则触发重写、低分触发重写、相似触发重写、改劣弃用、轮次上限
// 全部用注入的假 LLM，不发起真实调用。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = path.join(os.tmpdir(), 'pipeline-test-' + Date.now());
process.env.DEEPSEEK_API_KEY = '';

const { runPipeline } = await import('./pipeline.js');

const GOOD = '搞掂。\n\n好事，靜靜哋發生。\n\n#明哥中港牌';
const BAD_NUM = '成交價 ¥1,234,567。\n\n#明哥中港牌'; // 硬规则违规（数字）
const ANGLES = ['細節特寫', '群聊引用', '時間場景'];

function fakeIo({ versionsTexts, rewriteResults, scores, sims }) {
  let rewriteCalls = 0;
  return {
    generate: async () => ({
      versions: versionsTexts.map((t, i) => ({ text: t, angle: ANGLES[i % ANGLES.length], tone: '沉穩質感' })),
      sceneNotes: 'test'
    }),
    rewrite: async () => {
      const r = rewriteResults[Math.min(rewriteCalls, rewriteResults.length - 1)];
      rewriteCalls++;
      return r;
    },
    score: async (text) => (typeof scores === 'function' ? scores(text) : scores),
    similar: async (texts) => (typeof sims === 'function' ? texts.map(sims) : texts.map(() => ({ sim: 0, sample: '' }))),
    tones: ['沉穩質感', '簡約克制', '極簡留白'],
    _rewriteCalls: () => rewriteCalls
  };
}

test('硬规则违规触发重写，改好则采纳', async () => {
  const GOOD2 = '驗車完成，冇問題。\n\n#明哥中港牌';
  const FIX = '搞掂晒，流程安穩。\n\n#明哥中港牌'; // 口岸属关键事实，无来源不得出现（r-port-unverified）
  const io = fakeIo({
    versionsTexts: [GOOD, BAD_NUM, GOOD2],
    rewriteResults: [FIX], // 重写修掉数字（且与同批版本互异）
    scores: { total: 80, premium: 80, novelty: 80, tone: 80, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '選號完成', scene: 'business', angles: ANGLES }, io);
  const fixed = out.versions.find(v => v.text === FIX);
  assert.ok(fixed, '重写稿应入选');
  assert.equal(fixed.rewrites, 1);
  assert.equal(fixed.hardCheck.pass, true);
});

test('低分（<60）触发重写，改差则弃用保留原稿', async () => {
  const io = fakeIo({
    versionsTexts: [GOOD, GOOD, GOOD],
    rewriteResults: [BAD_NUM], // 越改越差
    scores: (text) => text === GOOD
      ? { total: 55, premium: 55, novelty: 55, tone: 55, skipped: false } // 原稿低分
      : { total: 90, premium: 90, novelty: 90, tone: 90, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '收工', scene: 'daily', angles: ANGLES }, io);
  // 原稿 pass 且 55 分；重写稿虽 90 分但硬规则违规（数字）—— 必须弃用
  assert.equal(out.versions[0].text, GOOD);
  assert.equal(out.versions[0].rewrites, 0);
});

test('相似度 ≥0.6 触发重写并传入规避样本', async () => {
  const OLD = '舊文柔，同舊文柔好似。';
  const NEW_GOOD = '全新角度。\n\n#明哥中港牌';
  let captured = null;
  const io = {
    ...fakeIo({
      versionsTexts: [GOOD, GOOD, GOOD],
      rewriteResults: [NEW_GOOD],
      scores: { total: 85, premium: 85, novelty: 85, tone: 85, skipped: false }
    }),
    similar: async (texts) => texts.map(t => t === NEW_GOOD ? { sim: 0.1, sample: '' } : { sim: 0.9, sample: OLD }),
    rewrite: async (args) => { captured = args; return NEW_GOOD; }
  };
  const out = await runPipeline({ text: '早安', scene: 'greeting', angles: ANGLES }, io);
  assert.equal(out.versions[0].rewrites, 1, '相似超阈值应触发重写并采纳');
  assert.ok(out.versions[0].similarity < 0.6, '重写后相似度应下降');
  assert.ok(captured.avoidSample, '重写时应收到规避样本');
  assert.ok(captured.feedback.similar, '质检反馈应包含相似度说明');
});

// 【2026-10-06 审计 P1】仅低分触发的重写稿若创意改写、偏离原稿结构，
// 采纳会把同批三版「互为轻微改写」的结构冲散——必须弃用保结构。
test('低分重写稿偏离原稿结构时弃用（保三版轻微改写结构）', async () => {
  const DRIFT = '週末去咗海邊食飯睇日落，吹住海風好舒服。\n\n#明哥中港牌'; // 高分但与原稿几无重叠
  const io = fakeIo({
    versionsTexts: [GOOD, GOOD, GOOD],
    rewriteResults: [DRIFT],
    scores: (text) => text === GOOD
      ? { total: 55, premium: 55, novelty: 55, tone: 55, skipped: false } // 原稿低分触发重写
      : { total: 92, premium: 92, novelty: 92, tone: 92, skipped: false }, // 重写稿高分
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '收工', scene: 'daily', angles: ANGLES }, io);
  assert.equal(out.versions[0].text, GOOD, '偏离原稿的高分重写稿不得采纳');
  assert.equal(out.versions[0].rewrites, 0);
});

test('低分重写稿仍是轻微改写时正常采纳', async () => {
  const LIGHT = '搞掂晒。\n\n好事，靜靜哋發生。\n\n#明哥中港牌'; // 原稿的换词级轻微改写
  const io = fakeIo({
    versionsTexts: [GOOD, GOOD, GOOD],
    rewriteResults: [LIGHT],
    scores: (text) => text === GOOD
      ? { total: 55, premium: 55, novelty: 55, tone: 55, skipped: false }
      : { total: 85, premium: 85, novelty: 85, tone: 85, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '收工', scene: 'daily', angles: ANGLES }, io);
  assert.equal(out.versions[0].text, LIGHT, '轻微改写的高分重写稿应采纳');
  assert.equal(out.versions[0].rewrites, 1);
});

test('重写轮次上限 2：不会无限重试', async () => {
  let scoreSeq = [40, 45, 50]; // 一直不及格（2026-10-06 及格线 60）
  let idx = 0;
  const io = fakeIo({
    versionsTexts: [GOOD, GOOD, GOOD],
    rewriteResults: [GOOD],
    scores: () => ({ total: scoreSeq[Math.min(idx++, scoreSeq.length - 1)], premium: 50, novelty: 50, tone: 50, skipped: false }),
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '早安', scene: 'greeting', angles: ANGLES }, io);
  // idx 每次评分 +1：初评 3 次 + 每轮重写后再评 —— 重写最多 2 轮
  const totalScores = idx;
  assert.ok(totalScores <= 3 + 3 * 2, '评分调用数不应超过初评+2轮上限');
  assert.ok(out.versions.every(v => v.rewrites <= 2));
});

test('demo 模式（未配置 key）：不做评分与重写', async () => {
  const io = fakeIo({
    versionsTexts: [GOOD, GOOD, GOOD],
    rewriteResults: [GOOD],
    scores: () => { throw new Error('demo 模式不应评分'); },
    sims: () => { throw new Error('demo 模式不应查相似'); }
  });
  io.generate = async () => ({
    demo: true,
    versions: versionsTextsOf(GOOD),
    sceneNotes: 'y'
  });
  function versionsTextsOf(t) { return [0, 1, 2].map(i => ({ text: t, angle: ANGLES[i], tone: '沉穩質感' })); }
  const out = await runPipeline({ text: '收工', scene: 'daily', angles: ANGLES }, io);
  assert.equal(out.demo, true);
  assert.ok(out.versions.every(v => v.rewrites === 0));
  assert.ok(out.versions.every(v => v.hardCheck));
});

test('全部达标时不触发任何重写', async () => {
  const io = fakeIo({
    versionsTexts: [GOOD, GOOD, GOOD],
    rewriteResults: [GOOD],
    scores: { total: 88, premium: 90, novelty: 85, tone: 88, skipped: false },
    sims: { sim: 0.1, sample: '' }
  });
  const out = await runPipeline({ text: '選號完成', scene: 'business', angles: ANGLES }, io);
  assert.ok(out.versions.every(v => v.rewrites === 0));
  assert.ok(out.versions.every(v => v.score.total === 88));
});

test('照抄 §10 风格样本会被判雷同并触发重写（few-shot 防护）', async () => {
  const { STYLE_EXEMPLARS } = await import('../knowledge/corpus.js');
  const COPIED = STYLE_EXEMPLARS.business[0]; // 模型直接照抄官方示例
  const FRESH = '搞掂晒。\n\n今日不多講。\n\n#明哥中港牌';
  const io = fakeIo({
    versionsTexts: [COPIED, GOOD, GOOD],
    rewriteResults: [FRESH],
    scores: { total: 85, premium: 85, novelty: 85, tone: 85, skipped: false },
    sims: { sim: 0, sample: '' } // 历史为空，仅靠样本比对命中
  });
  const out = await runPipeline({ text: '選號完成', scene: 'business', angles: ANGLES }, io);
  const fresh = out.versions.find(v => v.text === FRESH);
  assert.ok(fresh, '重写稿应入选');
  assert.equal(fresh.rewrites, 1, '照抄样本应触发重写');
  assert.ok(!out.versions.some(v => v.text === COPIED), '不应保留照抄稿');
  assert.ok(fresh.similarity < 0.6, '重写后应脱离雷同区间');
});

test('语气资产库样本传入生成与重写（few-shot），并纳入防照抄', async () => {
  const SAMPLE = '明哥選中過的句子。\n\n#明哥中港牌';
  let genArgs = null;
  const io = {
    ...fakeIo({
      versionsTexts: [GOOD, GOOD, GOOD],
      rewriteResults: [GOOD],
      scores: { total: 85, premium: 85, novelty: 85, tone: 85, skipped: false },
      sims: { sim: 0, sample: '' }
    }),
    toneSamples: [SAMPLE]
  };
  const origGen = io.generate;
  io.generate = async (args) => { genArgs = args; return origGen(args); };
  const out = await runPipeline({ text: '選號完成', scene: 'business', angles: ANGLES }, io);
  assert.deepEqual(genArgs.toneSamples, [SAMPLE], '生成应收到语气样本');
  assert.ok(out.versions.every(v => v.rewrites === 0));
});

// ===== Best-of-N（2026-10-04 澄清后）：多候选筛选 = 分数优先 + 三版互异（防折叠） =====
test('Best-of-N：违规候选被互异合规候选顶替，展示 3 版全过', async () => {
  const io = fakeIo({
    versionsTexts: [
      GOOD, BAD_NUM,
      '驗車完成，冇問題。\n\n#明哥中港牌',
      '大橋口岸通關順利。\n\n#明哥中港牌',
      '深圳灣又落一單。\n\n#明哥中港牌',
      '交車搞掂，簽好合同。\n\n#明哥中港牌'
    ],
    rewriteResults: [GOOD],
    scores: { total: 80, premium: 80, novelty: 80, tone: 80, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '選號完成', scene: 'business', angles: ANGLES }, io);
  assert.equal(out.candidateCount, 6, '候选池应为 6');
  assert.equal(out.versions.length, 3);
  assert.ok(out.versions.every(v => v.hardCheck.pass), '筛选后三版应全部合规');
  assert.ok(out.versions.some(v => v.rewrites === 0));
});

test('Best-of-N：同角度两个语气候选，取软评分更高者', async () => {
  const SUPERIOR = '今日搞掂。\n\n靜靜哋，唔使講。\n\n#明哥中港牌';
  const io = fakeIo({
    versionsTexts: [GOOD, GOOD, GOOD, SUPERIOR, GOOD, GOOD],
    rewriteResults: [GOOD],
    scores: (text) => text === SUPERIOR
      ? { total: 92, premium: 92, novelty: 92, tone: 92, skipped: false }
      : { total: 65, premium: 65, novelty: 65, tone: 65, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '選號完成', scene: 'business', angles: ANGLES }, io);
  assert.ok(out.versions.includes(out.versions.find(v => v.text === SUPERIOR)), '高分候选应入选');
  assert.equal(out.versions[0].text, SUPERIOR, '展示第一版应为全场最高分');
});

test('Best-of-N：解析不足时不硬凑（如实返回少量版本）', async () => {
  const GOOD2 = '驗車完成，冇問題。\n\n#明哥中港牌';
  const io = fakeIo({
    versionsTexts: [GOOD, GOOD2], // LLM 只出了 2 版（且互不相同）
    rewriteResults: [GOOD],
    scores: { total: 80, premium: 80, novelty: 80, tone: 80, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '選號完成', scene: 'business', angles: ANGLES }, io);
  assert.equal(out.versions.length, 2, '不足 3 版如实返回，不静默复制');
});

// 【2026-10-05 明哥澄清】微信折叠只在「完全相同」时发生，稍有不同即可并存。
// 默认阈值放宽到 0.9：只拦几乎一模一样，换词级相似不再强制去重。
test('防折叠（默认宽松）：完全相同的候选只留一个', async () => {
  const P = '蓮塘嗰單，今日成交，逐項傾清楚，簽好合同。#明哥中港牌';
  const B = '驗車完成，冇問題三個字最抵聽。#明哥中港牌';
  const C = '大橋口岸今日通關順利，新一批搞掂。#明哥中港牌';
  const io = fakeIo({
    versionsTexts: [P, P, B, C, GOOD, GOOD],
    rewriteResults: [GOOD],
    scores: { total: 80, premium: 80, novelty: 80, tone: 80, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '蓮塘搞掂', scene: 'business', angles: ['直述寫法', '觀點寫法', '白描寫法'] }, io);
  const texts = out.versions.map(v => v.text);
  assert.equal(texts.filter(t => t === P).length, 1, '完全相同的两版只能留一个');
});

test('防折叠（默认宽松）：稍有不同即可并存', async () => {
  // 落款须单独成行（r-signature-alone），桩文案不能把落款写在正文行尾
  const A = '蓮塘嗰單，今日成交，逐項傾清楚，簽好合同。\n\n#明哥中港牌';
  const A2 = '蓮塘嗰單今日成交，逐項傾清楚，合同簽好。\n\n#明哥中港牌'; // 换词级相似
  const B = '驗車完成，冇問題三個字最抵聽。\n\n#明哥中港牌';
  const io = fakeIo({
    versionsTexts: [A, A2, B, GOOD, GOOD, GOOD],
    rewriteResults: [GOOD],
    scores: { total: 80, premium: 80, novelty: 80, tone: 80, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '蓮塘搞掂', scene: 'business', angles: ['直述寫法', '觀點寫法', '白描寫法'] }, io);
  const texts = out.versions.map(v => v.text);
  assert.ok(texts.includes(A) && texts.includes(A2), '换词级相似的两版应可并存（不再强制去重）');
});

// 【2026-10-05 明哥澄清】三版 = 轻微改写，收尾相同不再互斥；只拦「几乎完全相同」
test('轻微改写口径：收尾相同、正文措辞不同的候选可同时入选', async () => {
  const END = '\n\n祝往來中港，一路暢順。\n\n#明哥中港牌';
  const A = '今日順利交收。' + END;
  const B = '今日搞掂交收。' + END;
  const C = '今日辦妥交收。' + END;
  const io = fakeIo({
    versionsTexts: [A, B, C, GOOD, GOOD, GOOD],
    rewriteResults: [GOOD],
    scores: { total: 80, premium: 80, novelty: 80, tone: 80, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '今日順利交收', scene: 'business', angles: ANGLES }, io);
  assert.equal(out.versions.length, 3);
  assert.deepEqual(
    [...out.versions.map(v => v.text)].sort(),
    [A, B, C].sort(),
    '三版收尾相同、仅措辞不同，应全部入选'
  );
});

test('轻微改写口径：几乎完全相同的候选仍只留一个（防三账号同发折叠）', async () => {
  const P = '蓮塘嗰單，今日成交，逐項傾清楚，簽好合同。\n\n#明哥中港牌';
  const io = fakeIo({
    versionsTexts: [P, P, GOOD, GOOD, GOOD, GOOD],
    rewriteResults: [GOOD],
    scores: { total: 80, premium: 80, novelty: 80, tone: 80, skipped: false },
    sims: { sim: 0, sample: '' }
  });
  const out = await runPipeline({ text: '蓮塘搞掂', scene: 'business', angles: ANGLES }, io);
  const texts = out.versions.map(v => v.text);
  assert.equal(texts.filter(t => t === P).length, 1, '完全相同的两版只能留一个');
});
