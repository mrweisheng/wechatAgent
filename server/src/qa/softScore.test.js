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

// 【回归 2026-10-06 审计】6-19 既非 1-5 档也不像 0-100，原先折叠成 1 档=0 分拖穿总分
test('parseScoreJson：6-19 噪声档位判失败（优雅降级，不再折叠成 0 分）', () => {
  assert.equal(parseScoreJson('{"premium":10,"novelty":3,"tone":3}'), null);
  assert.equal(parseScoreJson('{"premium":4,"novelty":6,"tone":4}'), null);
  assert.equal(parseScoreJson('{"premium":19,"novelty":4,"tone":4}'), null);
  // 20 及以上仍是合法 0-100 折算路径
  assert.equal(parseScoreJson('{"premium":20,"novelty":4,"tone":4}').dims.premium, 1);
});

// 【2026-10-06 审计修正】及格线 70→60：5 档锚点（4档=75/3档=50）与 70 错配，
// 典型达标分 4/3/4=68 被误判不及格，生产 58% 版本白触发反思改写。
test('权重与阈值符合 §11.8（40/30/30，60 分及格，5 档制）', () => {
  assert.equal(SOFT_WEIGHTS.premium, 0.4);
  assert.equal(SOFT_WEIGHTS.novelty, 0.3);
  assert.equal(SOFT_WEIGHTS.tone, 0.3);
  assert.equal(SOFT_PASS, 60);
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
