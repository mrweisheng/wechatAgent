// 记忆层测试：BOM 容错、版本级去重、反馈回填（语气偏好）
// 注意：store 在 import 时解析 DATA_DIR，必须先设环境变量再动态 import。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = path.join(os.tmpdir(), 'store-test-' + Date.now());
process.env.DEEPSEEK_API_KEY = ''; // 隔离真实 key，避免误触发 LLM 路径

const store = await import('./store.js');

test('BOM 开头的 JSON 可正常读取（不再误判损坏清零）', async () => {
  const file = path.join(process.env.DATA_DIR, 'corrections.json');
  // 手写带 UTF-8 BOM 的种子文件（上一版会判损坏并隔离）
  await fs.writeFile(file, '﻿[]', 'utf8');
  const items = await store.findCorrections();
  assert.deepEqual(items, []);
});

test('版本级去重：相同输出 vs 历史输出应强命中（上一版拿输入比输出恒为零）', async () => {
  const text = '交車。\n\n佢先繞住部車行咗一圈，先開門上車。\n\n有啲嘢，坐低就知，\n唔使多講。\n\n#明哥中港牌';
  await store.addHistory({ scene: 'car', text: '交咗部車', versions: [{ angle: '細節特寫', tone: '沉穩質感', pass: true, text }] });
  const [r] = await store.findSimilarVersions([text]);
  assert.equal(r.sim, 1);
  assert.ok(r.sample.length > 0, '应带回最相似样本供重写时规避');
  // 差异明显的文案不应命中
  const [r2] = await store.findSimilarVersions(['收工。今日唔傾牌，唔講車。飲杯茶，睇下海。#明哥中港牌']);
  assert.ok(r2.sim < 0.6);
});

test('反馈回填：被选中的语气排前面（M2 回填）', async () => {
  await store.recordFeedback({ kind: 'pick', payload: { scene: 'car', index: 0, angle: '對比', tone: '極簡留白' } });
  await store.recordFeedback({ kind: 'pick', payload: { scene: 'car', index: 1, angle: '立場', tone: '極簡留白' } });
  await store.recordFeedback({ kind: 'edit', payload: { scene: 'car', tone: '簡約克制' } }); // edit 不计入
  const order = await store.getPreferredToneOrder();
  assert.equal(order[0], '極簡留白');
  assert.equal(order.length, 3);
});

test('语气资产库：选中且通过硬规则的正文沉淀为样本（M2 §6.2-B）', async () => {
  const A = '號碼定咗。\n\n群裡一句「搞掂」，\n背後成個流程安安穩穩。\n\n#明哥中港牌';
  const B = '交車。\n\n佢先繞住部車行咗一圈，先開門上車。\n\n#明哥中港牌';
  const C = '今日主角，RX300。\n\n唔張揚，自有一種從容。\n\n#明哥中港牌';
  // pick + pass=true 的 business 两条；一条未通过硬规则（应被排除）；一条 car 场景（回落用）
  await store.recordFeedback({ kind: 'pick', payload: { scene: 'business', angle: '群聊引用', tone: '沉穩質感', text: A, pass: true } });
  await store.recordFeedback({ kind: 'pick', payload: { scene: 'business', angle: '細節特寫', tone: '簡約克制', text: B, pass: true } });
  await store.recordFeedback({ kind: 'pick', payload: { scene: 'business', angle: '立場', tone: '極簡留白', text: '壞樣本', pass: false } });
  await store.recordFeedback({ kind: 'pick', payload: { scene: 'car', angle: '對比', tone: '沉穩質感', text: C, pass: true } });
  await store.recordFeedback({ kind: 'edit', payload: { scene: 'business', tone: '沉穩質感', text: '不該算選中' } });

  const samples = await store.getToneSamples('business');
  assert.equal(samples.length, 2);
  assert.ok(samples.includes(A));
  assert.ok(!samples.includes('壞樣本'), '未通过硬规则的选中不应入样本库');

  // car 场景无 pick 时回落全域
  const fb = await store.getToneSamples('edu');
  assert.ok(fb.length > 0, '无场景命中应回落到全域近期选中');
  assert.ok(fb.length <= 3);
});
