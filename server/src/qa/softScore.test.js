// 软评分测试：解析健壮性、档位映射、权重计算、失败优雅降级

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScoreJson, scoreVersion, SOFT_WEIGHTS, SOFT_PASS, SCALE_MAX } from './softScore.js';

test('parseScoreJson：1-5 档标准 JSON，映射为 0-100 供加权 + 保留原始档位', () => {
  const s = parseScoreJson('{"premium":4,"novelty":3,"tone":5,"reason":"可以"}');
  assert.equal(s.premium, 75);   // (4-1)*25
  assert.equal(s.novelty, 50);
  assert.equal(s.tone, 100);
  assert.deepEqual(s.dims, { premium: 4, novelty: 3, tone: 5 });
  assert.equal(s.reason, '可以');
});

test('parseScoreJson：markdown 包裹 + 前后噪音', () => {
  const s = parseScoreJson('评审如下：\n```json\n{"premium": 4, "novelty": 3, "tone": 3, "reason": "略平"}\n```\n以上。');
  assert.equal(s.premium, 75);
  assert.equal(s.tone, 50);
});

test('parseScoreJson：兼容旧版 0-100 输出（自动折算档位）', () => {
  const s = parseScoreJson('{"premium":80,"novelty":60,"tone":70,"reason":"ok"}');
  assert.equal(s.dims.premium, 4);  // 80/20
  assert.equal(s.dims.novelty, 3);  // 60/20
  assert.equal(s.dims.tone, 4);     // 70/20 -> 3.5 四舍五入
});

test('parseScoreJson：越界收敛到 1-5 档，非数字判失败', () => {
  const s = parseScoreJson('{"premium":150,"novelty":-5,"tone":3}');
  assert.equal(s.dims.premium, 5);  // 150 折算后收敛到最高档
  assert.equal(s.premium, 100);     // 映射回 0-100
  assert.equal(parseScoreJson('{"premium":0,"novelty":3,"tone":3}').dims.premium, 1);
  assert.equal(parseScoreJson('{"premium":"高","novelty":3,"tone":3}'), null);
  assert.equal(parseScoreJson('模型无法评审'), null);
});

test('权重与阈值符合 §11.8（40/30/30，70 分及格，5 档制）', () => {
  assert.equal(SOFT_WEIGHTS.premium, 0.4);
  assert.equal(SOFT_WEIGHTS.novelty, 0.3);
  assert.equal(SOFT_WEIGHTS.tone, 0.3);
  assert.equal(SOFT_PASS, 70);
  assert.equal(SCALE_MAX, 5);
});

test('未配置 key：返回 skipped 不抛错', async () => {
  const r = await scoreVersion('测试文案');
  assert.equal(r.skipped, true);
  assert.equal(r.total, null);
});

test('评审调用失败：优雅降级为 skipped，绝不阻断产出', async () => {
  const r = await scoreVersion('测试文案', { scene: 'car' }, {
    llm: async () => { throw new Error('LLM 500：上游异常'); }
  });
  assert.equal(r.skipped, true);
  assert.equal(r.total, null);
});

test('评分正常路径：total 按 40/30/30 加权（档位映射后）', async () => {
  const r = await scoreVersion('测试文案', { scene: 'car', angle: '對比', tone: '沉穩質感' }, {
    llm: async () => '{"premium":4,"novelty":3,"tone":4,"reason":"ok"}'
  });
  // 75*0.4 + 50*0.3 + 75*0.3 = 30+15+22.5 = 67.5 -> 68
  assert.equal(r.total, 68);
  assert.equal(r.skipped, false);
  assert.deepEqual(r.dims, { premium: 4, novelty: 3, tone: 4 });
});
