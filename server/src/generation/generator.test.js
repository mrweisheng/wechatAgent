// LLM 输出解析容错测试
// 依据：审核实测 —— temperature 0.85 下模型常改用 *** / --- 尾空格 / 中文标题 / 代码块

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput, sanitizeFinalText, mergeParaphrases } from '../generation/generator.js';

const TAIL = '\n\nIMAGE_PLAN: 拍車頭 3/4 角度\nSCENE_NOTES: 因為交車';

const V1 = 'VERSION_1\n正文一甲。\n\n#明哥中港牌';
const V2 = 'VERSION_2\n正文二乙。\n\n#明哥中港牌';
const V3 = 'VERSION_3\n正文三丙。\n\n#明哥中港牌';

function expect3(name, content) {
  test(name, () => {
    const r = parseOutput(content, 'car');
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
  const r = parseOutput('VERSION_1\n只有一版。\n\n#明哥中港牌', 'car');
  assert.equal(r.parseFailed, true);
  assert.equal(r.versions.length, 1, '不应复制成 3 版');
  assert.match(r.parseNote, /1\/3/);
});

test('版本不再携带 angle/tone 标签（三版=同一文案轻微改写，2026-10-05）', () => {
  const r = parseOutput(`${V1}\n\n---\n${V2}\n\n---\n${V3}`, 'car');
  for (const v of r.versions) {
    assert.equal(v.angle, undefined, 'angle 标签应已废除');
    assert.equal(v.tone, undefined, 'tone 标签应已废除');
  }
});

test('sceneNotes 正确抽离；IMAGE_PLAN 已废弃（剥离正文、不再返回）', () => {
  // 【2026-10-05 明哥澄清】配图 = 用户自己上传的图，配图指引整体移除。
  // 模型若仍输出 IMAGE_PLAN，须被剥离、不进正文、也不回落默认模板。
  const r = parseOutput(`${V1}\n\n---\n${V2}\n\n---\n${V3}${TAIL}`, 'car');
  assert.match(r.sceneNotes, /因為交車/);
  assert.equal(r.imagePlan, undefined);
  assert.ok(!JSON.stringify(r.versions).includes('拍車頭'), 'IMAGE_PLAN 内容不得混入版本正文');
});

test('缺失 SCENE_NOTES 时为空串，不影响版本', () => {
  const r = parseOutput(`${V1}\n\n---\n${V2}\n\n---\n${V3}`, 'car');
  assert.equal(r.sceneNotes, '');
});

// 【回归 2026-10-06 实测】改写模型的标题行若未被识别为块头（如带冒号变体），
// 会走分隔线兜底路径，VERSION_N 残留块首泄漏进正文
test('版本标题行残留在块首时被摘除，不泄漏进正文', () => {
  const content = 'VERSION_1：\n正文一甲。\n\n#明哥中港牌\n\n---\n\nVERSION_2\n正文二乙。\n\n#明哥中港牌\n\n---\n\n正文三丙。\n\n#明哥中港牌';
  const r = parseOutput(content, 'car');
  assert.equal(r.versions.length, 3);
  for (const v of r.versions) {
    assert.ok(!/VERSION_\d|^版本[一二三]/im.test(v.text), `标题泄漏进正文：${v.text.slice(0, 30)}`);
    assert.ok(v.text.includes('#明哥中港牌'), '落款被破坏');
  }
});

// Best-of-N：6 版候选时按 maxVersions 完整保留
test('parseOutput maxVersions=6：取满 6 版', () => {
  const mk = i => `版本${i}。\n\n#明哥中港牌`;
  const content = Array.from({ length: 6 }, (_, i) => `VERSION_${i + 1}\n${mk(i)}`).join('\n---\n')
    + '\n\nIMAGE_PLAN: 測試\nSCENE_NOTES: 測試';
  const r = parseOutput(content, 'business', 6);
  assert.equal(r.versions.length, 6);
  assert.equal(r.parseFailed, undefined);
});

// 【回归 2026-10-06 审计 P0】生产历史实锤的三种版本头泄漏变体（2/18 条 pass=true 入库）。
// parseOutput 的 VERSION_HEAD 与旧 stripLeadingHead 均不认【】/加粗变体，
// rewriteVersion 通道此前完全不剥头——统一由 sanitizeFinalText 拦截。
test('sanitizeFinalText：剥除【VERSION_1】块首标题（生产泄漏变体①）', () => {
  assert.equal(
    sanitizeFinalText('【VERSION_1】\n交咗部車。\n\n#明哥中港牌'),
    '交咗部車。\n\n#明哥中港牌'
  );
});

test('sanitizeFinalText：剥除前导说明行 + 版本头（生产泄漏变体②，rewrite 通道）', () => {
  assert.equal(
    sanitizeFinalText('以下係改寫：\n\nVERSION_1\n交咗部車。\n\n#明哥中港牌'),
    '交咗部車。\n\n#明哥中港牌'
  );
});

test('sanitizeFinalText：剥除加粗标题（生产泄漏变体③）', () => {
  assert.equal(
    sanitizeFinalText('**【VERSION_1】**\n交咗部車。\n\n#明哥中港牌'),
    '交咗部車。\n\n#明哥中港牌'
  );
});

test('sanitizeFinalText：不碰正文（首行即正文时原样返回）', () => {
  const body = '交咗部車。\n\n客人好滿意。\n\n#明哥中港牌';
  assert.equal(sanitizeFinalText(body), body);
  // 正文中间的「版本」字样不得被剥（只剥头部行）
  const mid = '今日交車。\n\n客戶話 VERSION_2 先係佢想要嘅。\n\n#明哥中港牌';
  assert.equal(sanitizeFinalText(mid), mid);
});

test('parseOutput：【VERSION_N】标题块经分隔线兜底后块首仍被净化', () => {
  const content = '【VERSION_1】\n正文一甲。\n\n#明哥中港牌\n\n---\n\n【VERSION_2】\n正文二乙。\n\n#明哥中港牌\n\n---\n\n【VERSION_3】\n正文三丙。\n\n#明哥中港牌';
  const r = parseOutput(content, 'car');
  assert.equal(r.versions.length, 3);
  for (const v of r.versions) {
    assert.ok(!/VERSION_\d|【|】/.test(v.text), `标题泄漏进正文：${v.text.slice(0, 30)}`);
    assert.ok(v.text.includes('#明哥中港牌'), '落款被破坏');
  }
});

// 【2026-10-06 审计 P1】改写稿与母版的最小相似度下限：
// 失控的创意改写不收（保三版「互为轻微改写」结构）；几乎完全相同的不收（防折叠）。
test('mergeParaphrases：偏离母版的创意改写被剔除，轻微改写保留', () => {
  const base = '今日順利交收。\n\n成個流程安安穩穩，冇甩漏。\n\n好事通常都係靜靜哋發生嘅。\n\n祝往來中港，一路暢順。\n\n#明哥中港牌';
  const light = '今日順利辦妥。\n\n成個流程安安穩穩，冇甩漏。\n\n好事通常都係靜靜哋發生嘅。\n\n祝往來中港，一路暢順。\n\n#明哥中港牌';
  const drift = '週末去咗海邊食飯睇日落，心情好好。\n\n#明哥中港牌'; // 与母版几无重叠
  const merged = mergeParaphrases(base, [{ text: light }, { text: drift }]);
  assert.deepEqual(merged.map(v => v.text), [base, light], '应只收母版 + 轻微改写稿');
});

test('mergeParaphrases：与母版几乎完全相同的改写稿被剔除（防三账号同发折叠）', () => {
  const base = '今日順利交收。\n\n成個流程安安穩穩，冇甩漏。\n\n祝往來中港，一路暢順。\n\n#明哥中港牌';
  const merged = mergeParaphrases(base, [{ text: base }]);
  assert.equal(merged.length, 1, '复制粘贴级重复只留母版');
});
