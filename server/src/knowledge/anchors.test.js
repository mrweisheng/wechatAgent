// 锚点自检（2026-10-05 审计落地）
//
// 【为什么需要这个测试】
// 病根不在单条规则，而在「明哥每反馈一次 → 加一条规则 → 但没人回头改风格锚」：
//   · STYLE_EXEMPLARS 是手写静态语料，作为 few-shot 注入生成/重写 prompt；
//   · 规则（ruleEngine）持续新增；
//   → 两者必然漂移，出现「正面示范了一条自己禁掉的写法」。
// 实际踩过的坑：business 风格锚第 1 条以「路上見」收尾，而「路上見」
// 已被列为低质收尾禁用（r-low-ending）。少样本里排第 1 的锚权重最高，
// 等于在教模型违规。逐条人工修是治标，本测试把「靠人记得改」变成
// 「测试红着告诉你」——治本。
//
// 维护方式：新增/修改任何规则后跑 `npm test`，本测试会指名道姓地报出
// 哪条锚过时了。若某条规则确实不适合检查锚点（如依赖外部输入证据的
// 证据型规则），加入 EVIDENCE_RULES 豁免并注明理由，不要删测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLE_EXEMPLARS, SERVICE_DETAIL_HINTS, TONE_ANTI_PATTERNS } from './corpus.js';
import { checkHardRules } from '../qa/ruleEngine.js';

// 豁免：证据型规则——判定依赖「用户输入/图片里有没有」，而风格锚是
// 脱离具体那次生成的通用范例，没有对应输入，查它必然误报。
// （实测：无输入时任何含口岸的锚都会触发 r-port-unverified。）
const EVIDENCE_RULES = new Set([
  'r-port-unverified',   // 口岸须与本次输入一致；锚无输入，属正常
  'r-no-future-time',    // 时间节点须来自输入；锚无输入，属正常
  'r-no-fabricate',      // 依据语料=用户原文+视觉；锚无输入，属正常
  'r-no-client-name'     // 依据视觉提取的称呼；锚无图片，属正常
  // 注：r-mask-pii 已随配图指引一并移除（2026-10-05）；
  // r-group-screenshot 不豁免——锚里出现「群」就是教模型无据编群，必须改锚
]);

// 服务细节是「语感参考」片段，本身不带落款；补一行落款再送检，
// 避免 r-signature 把注意力引到无关的落款规则上。
const HINT_SCENE = 'business';
const withSignature = s => `${s}\n\n#明哥中港牌`;

function offending(scenario, text) {
  const r = checkHardRules(text, { scene: scenario });
  return [
    ...r.violations.map(v => v.id),
    ...r.warnings.map(w => w.id)
  ].filter(id => !EVIDENCE_RULES.has(id));
}

test('风格锚：不得示范任何被规则判为违规/提示的写法', () => {
  const bad = [];
  for (const [scene, list] of Object.entries(STYLE_EXEMPLARS)) {
    list.forEach((ex, i) => {
      const hits = offending(scene, ex);
      if (hits.length) {
        const tail = ex.trim().split('\n').filter(l => l.trim() && !/#明哥中港牌/.test(l)).pop();
        bad.push(`STYLE_EXEMPLARS.${scene}[${i}] 命中 ${hits.join('、')}｜收尾：「${tail}」`);
      }
    });
  }
  assert.equal(bad.length, 0,
    '风格锚示范了规则禁用的写法（few-shot 会教模型违规）。' +
    '请改锚，不要改测试：\n  ' + bad.join('\n  '));
});

test('服务细节暗示：不得示范已被明哥否决的写法', () => {
  const bad = [];
  SERVICE_DETAIL_HINTS.forEach((h, i) => {
    const hits = offending(HINT_SCENE, withSignature(h.eg));
    if (hits.length) bad.push(`SERVICE_DETAIL_HINTS[${i}]「${h.dir}」命中 ${hits.join('、')}｜eg：「${h.eg}」`);
  });
  assert.equal(bad.length, 0,
    '服务细节暗示示范了规则禁用的写法（会与生成约束自相矛盾）。' +
    '请改 eg，不要改测试：\n  ' + bad.join('\n  '));
});

test('服务细节：纯购车交車语境不得示范兩地牌後續（提示自相矛盾）', () => {
  // 回归 2026-10-05 审计：原「下一步預告：跟住落嚟仲有裝卡」与
  // carDeliveryBlockOf 的「交付即完結，不得添加裝卡」直接冲突，
  // 而该块对 business/car 照常注入 —— 同一份 prompt 里既禁又示范。
  // 装卡/选号/验车只允许在用户明确提到两地牌时出现，故此处直接查语料。
  const forbidden = ['裝卡', '装卡', '選號', '选号', '驗車', '验车'];
  const bad = SERVICE_DETAIL_HINTS
    .filter(h => forbidden.some(t => h.eg.includes(t)))
    .map(h => `${h.dir}：「${h.eg}」`);
  assert.equal(bad.length, 0,
    '服务细节暗示含兩地牌後续，会与 r-car-delivery-scope 硬口径冲突：\n  ' + bad.join('\n  '));
});

test('反例库自身：不得示范自己禁用的写法', () => {
  // TONE_ANTI_PATTERNS 是「反例」，不该被误当成正面锚注入。
  // 这里只做结构校验：每条必须有 pattern/bad/why，避免后来者写残缺条目。
  for (const p of TONE_ANTI_PATTERNS) {
    assert.ok(p.pattern, '反例应有 pattern');
    assert.ok(p.bad, '反例应有 bad');
    assert.ok(p.why, '反例应有 why（病灶说明）');
  }
});
