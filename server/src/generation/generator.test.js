// LLM 输出解析容错测试
// 依据：审核实测 —— temperature 0.85 下模型常改用 *** / --- 尾空格 / 中文标题 / 代码块

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput } from '../generation/generator.js';

const ANGLES = ['細節特寫', '群聊引用', '時間場景'];
const TONES = ['沉穩質感', '簡約克制', '極簡留白'];
const TAIL = '\n\nIMAGE_PLAN: 拍車頭 3/4 角度\nSCENE_NOTES: 因為交車';

const V1 = 'VERSION_1\n正文一甲。\n\n#明哥中港牌';
const V2 = 'VERSION_2\n正文二乙。\n\n#明哥中港牌';
const V3 = 'VERSION_3\n正文三丙。\n\n#明哥中港牌';

function expect3(name, content) {
  test(name, () => {
    const r = parseOutput(content, ANGLES, TONES, 'car');
    assert.equal(r.parseFailed, undefined, '不应标记解析失败');
    assert.equal(r.versions.length, 3, '应解析出 3 版');
    assert.equal(new Set(r.versions.map(v => v.text)).size, 3, '三版内容不应重复');
    for (const v of r.versions) {
      assert.ok(!/IMAGE_PLAN|SCENE_NOTES|VERSION_\d/.test(v.text), `元信息混入正文：${v.text}`);
      assert.ok(v.text.includes('#明哥中港牌'), '落款被破坏');
    }
  });
}

expect3('规范 --- 分隔', `${V1}\n\n---\n${V2}\n\n---\n${V3}${TAIL}`);
expect3('分隔符改为 ***（带标题）', `${V1}\n\n***\n${V2}\n\n***\n${V3}${TAIL}`);
// 【回归】上一版 stripMarkdown 的 /\*\*\*/g 会把独立 *** 行删成空行，
// 导致纯分隔符（无 VERSION 头）路径失效。此用例专门锁定该路径。
expect3('分隔符 ***（无标题，走 SEPARATOR）',
  `正文一甲。\n\n#明哥中港牌\n\n***\n\n正文二乙。\n\n#明哥中港牌\n\n***\n\n正文三丙。\n\n#明哥中港牌${TAIL}`);
expect3('分隔符 ***（无标题，无空行）',
  `正文一甲。\n\n#明哥中港牌\n***\n正文二乙。\n\n#明哥中港牌\n***\n正文三丙。\n\n#明哥中港牌${TAIL}`);
expect3('分隔符 --- 带尾空格', `${V1}\n\n--- \n${V2}\n\n--- \n${V3}${TAIL}`);
expect3('分隔符 ==== 与 ──', `${V1}\n\n====\n${V2}\n\n──\n${V3}${TAIL}`);
expect3('中文标题 版本一/二/三',
  `版本一\n正文一甲。\n\n#明哥中港牌\n\n版本二\n正文二乙。\n\n#明哥中港牌\n\n版本三\n正文三丙。\n\n#明哥中港牌${TAIL}`);
expect3('方括号标题 【版本1】',
  `【版本1】\n正文一甲。\n\n#明哥中港牌\n\n【版本2】\n正文二乙。\n\n#明哥中港牌\n\n【版本3】\n正文三丙。\n\n#明哥中港牌${TAIL}`);
expect3('无标题纯分隔线',
  `正文一甲。\n\n#明哥中港牌\n\n---\n\n正文二乙。\n\n#明哥中港牌\n\n---\n\n正文三丙。\n\n#明哥中港牌${TAIL}`);
expect3('代码块包裹', '```\n' + `${V1}\n\n---\n${V2}\n\n---\n${V3}` + '\n```' + TAIL);
expect3('**加粗标题**',
  `**VERSION_1**\n正文一甲。\n\n#明哥中港牌\n\n---\n\n**VERSION_2**\n正文二乙。\n\n#明哥中港牌\n\n---\n\n**VERSION_3**\n正文三丙。\n\n#明哥中港牌${TAIL}`);
expect3('IMAGE_PLAN 置于最前',
  `IMAGE_PLAN: 拍車頭\nSCENE_NOTES: 理由\n\n${V1}\n\n---\n${V2}\n\n---\n${V3}`);

test('仅返回 1 版时显式失败，不静默复制', () => {
  const r = parseOutput('VERSION_1\n只有一版。\n\n#明哥中港牌', ANGLES, TONES, 'car');
  assert.equal(r.parseFailed, true);
  assert.equal(r.versions.length, 1, '不应复制成 3 版');
  assert.match(r.parseNote, /1\/3/);
});

test('tone 正确回填', () => {
  const r = parseOutput(`${V1}\n\n---\n${V2}\n\n---\n${V3}`, ANGLES, TONES, 'car');
  assert.deepEqual(r.versions.map(v => v.tone), TONES);
});

test('sceneNotes 正确抽离；IMAGE_PLAN 已废弃（剥离正文、不再返回）', () => {
  // 【2026-10-05 明哥澄清】配图 = 用户自己上传的图，配图指引整体移除。
  // 模型若仍输出 IMAGE_PLAN，须被剥离、不进正文、也不回落默认模板。
  const r = parseOutput(`${V1}\n\n---\n${V2}\n\n---\n${V3}${TAIL}`, ANGLES, TONES, 'car');
  assert.match(r.sceneNotes, /因為交車/);
  assert.equal(r.imagePlan, undefined);
  assert.ok(!JSON.stringify(r.versions).includes('拍車頭'), 'IMAGE_PLAN 内容不得混入版本正文');
});

test('缺失 SCENE_NOTES 时为空串，不影响版本', () => {
  const r = parseOutput(`${V1}\n\n---\n${V2}\n\n---\n${V3}`, ANGLES, TONES, 'car');
  assert.equal(r.sceneNotes, '');
});

// Best-of-N：6 版候选时按 maxVersions 完整保留，角度/语气组合正确
test('parseOutput maxVersions=6：取满 6 版，后 3 版同角度换语气', () => {
  const mk = i => `版本${i}。\n\n#明哥中港牌`;
  const content = Array.from({ length: 6 }, (_, i) => `VERSION_${i + 1}\n${mk(i)}`).join('\n---\n')
    + '\n\nIMAGE_PLAN: 測試\nSCENE_NOTES: 測試';
  const angles = ['細節特寫', '群聊引用', '時間場景'];
  const tones = ['沉穩質感', '簡約克制', '極簡留白'];
  const r = parseOutput(content, angles, tones, 'business', 6);
  assert.equal(r.versions.length, 6);
  assert.equal(r.versions[0].angle, '細節特寫');
  assert.equal(r.versions[3].angle, '細節特寫', '第 4 版回到第一角度');
  assert.equal(r.versions[0].tone, '沉穩質感');
  assert.equal(r.versions[3].tone, '簡約克制', '后半池换第二语气');
  assert.equal(r.parseFailed, undefined);
});
