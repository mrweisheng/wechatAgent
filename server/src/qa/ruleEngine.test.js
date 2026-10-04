// 硬规则引擎测试
// 语域前提：发布渠道为微信私域朋友圈，绝对化用语只提示不阻断（明哥口径）

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHardRules, HARD_RULES } from './ruleEngine.js';

const V = r => r.violations.map(v => v.id);
const W = r => r.warnings.map(v => v.id);

// ========== 落款 ==========
test('缺落款被拦', () => {
  const r = checkHardRules('今日搞掂。');
  assert.equal(r.pass, false);
  assert.ok(V(r).includes('r-signature'));
});

test('落款与短语同行被拦（精确断言，不再用 || 掩盖）', () => {
  const r = checkHardRules('今日搞掂。\n路上見 #明哥中港牌');
  assert.equal(r.pass, false);
  assert.deepEqual(V(r), ['r-signature-alone']);
});

// ========== 语域：绝对化用语只提示 ==========
test('绝对化用语不阻断，仅提示', () => {
  for (const t of ['包過', '零風險', '全網最低', '國家級', '保證冇問題']) {
    const r = checkHardRules(`${t}。\n\n#明哥中港牌`);
    assert.equal(r.pass, true, `${t} 不应阻断`);
    assert.ok(W(r).includes('r-absolute-advisory'));
  }
});

// ========== 仍然阻断的底线 ==========
test('价格与车牌里程被拦（繁简双写）', () => {
  assert.ok(V(checkHardRules('成交價 ¥1,234,567。\n\n#明哥中港牌')).includes('r-no-numbers'));
  assert.ok(V(checkHardRules('叫價十萬蚊。\n\n#明哥中港牌')).includes('r-no-numbers'));
  assert.ok(V(checkHardRules('車牌 粵Z·A1234。\n\n#明哥中港牌')).includes('r-no-numbers'));
  assert.ok(V(checkHardRules('粵B12345 已選。\n\n#明哥中港牌')).includes('r-no-numbers'));
  assert.ok(V(checkHardRules('只跑了 50,000 公里。\n\n#明哥中港牌')).includes('r-no-numbers'));
});

test('微商套话被拦', () => {
  assert.ok(V(checkHardRules('感恩託付，圓滿收官。\n\n#明哥中港牌')).includes('r-cliche'));
});

test('涉政被拦', () => {
  assert.ok(V(checkHardRules('談論天安門事件。\n\n#明哥中港牌')).includes('r-no-politics'));
});

// ========== 口岸 ==========
test('皇崗/文錦渡写成可办理被拦', () => {
  assert.ok(V(checkHardRules('皇崗口岸受理中。\n\n#明哥中港牌')).includes('r-no-fake-port'));
  assert.ok(V(checkHardRules('文錦渡可辦。\n\n#明哥中港牌')).includes('r-no-fake-port'));
  assert.ok(V(checkHardRules('文錦渡今天辦好了。\n\n#明哥中港牌')).includes('r-no-fake-port'));
});

// 【回归】旧实现用「邻近否定词」启发式，「已/搞掂咗/冇」被当否定词 + 跨分句误豁免
test('皇崗否定豁免不得过宽（混合语境回归）', () => {
  const mustBlock = [
    '皇崗已經可以辦理。\n\n#明哥中港牌',      // 「已」不是否定
    '冇錯，皇崗受理中。\n\n#明哥中港牌',        // 否定在前一分句
    '文錦渡唔係唔可以辦理。\n\n#明哥中港牌',      // 双重否定 = 可办
    '皇崗搞掂咗，牌已入手。\n\n#明哥中港牌'      // 暗示已办成
  ];
  for (const t of mustBlock) {
    const r = checkHardRules(t, { scene: 'edu' });
    assert.ok(V(r).includes('r-no-fake-port'), `应拦截：${t.split('\n')[0]}`);
  }
});

test('皇崗标准停批表述应放行', () => {
  const ok = [
    '皇崗口岸，早已唔受理。\n\n#明哥中港牌',
    '皇崗已停批。\n\n#明哥中港牌',
    '文錦渡冇受理。\n\n#明哥中港牌',
    '聽講皇崗牌有人叫價七位數，真唔真我唔知。\n\n#明哥中港牌'
  ];
  for (const t of ok) {
    const r = checkHardRules(t, { scene: 'edu' });
    assert.equal(r.pass, true, `应放行：${t.split('\n')[0]}`);
  }
});

test('皇崗已停批的反向表述应放行（文档 §1 标准谈资口径）', () => {
  assert.equal(checkHardRules('皇崗口岸，早已唔受理。\n\n#明哥中港牌').pass, true);
  assert.equal(checkHardRules('聽講皇崗牌有人叫價七位數，真唔真我唔知。\n\n#明哥中港牌').pass, true);
});

// ========== 场景相关规则 ==========
test('r-sharedan-completed 拦进行时', () => {
  const r = checkHardRules('選號進行中，稍後再更新。\n\n#明哥中港牌', { scene: 'business' });
  assert.ok(V(r).includes('r-sharedan-completed'));
});

test('r-sharedan-completed 完成态放行', () => {
  assert.equal(checkHardRules('選號完成。\n\n#明哥中港牌', { scene: 'business' }).pass, true);
});

test('r-no-promo-greeting 早安禁硬广', () => {
  const r = checkHardRules('早晨，星期一。\n\n今日推薦 RX300，即辦。\n\n#明哥中港牌', { scene: 'greeting' });
  assert.ok(V(r).includes('r-no-promo-greeting'));
});

test('r-no-promo-greeting 正常早安放行', () => {
  assert.equal(checkHardRules('早晨，星期一。\n\n霧未散。\n\n路上見。\n\n#明哥中港牌', { scene: 'greeting' }).pass, true);
});

test('r-no-fabricate 拦无依据引号', () => {
  const r = checkHardRules('群裡朋友話：「陳生好滿意」。\n\n#明哥中港牌', { scene: 'business', userText: '選號完成' });
  assert.ok(V(r).includes('r-no-fabricate'));
});

test('r-no-fabricate 有依据则放行', () => {
  const r = checkHardRules('群裡一句「搞掂」。\n\n#明哥中港牌', { scene: 'business', userText: '群裡一句「搞掂」' });
  assert.equal(r.pass, true);
});

test('r-no-fabricate 短口语引用不误伤（§10 官方示例风格）', () => {
  // 用户只说「選號完成」，文案引用「搞掂」「冇問題」是群聊常规写法，不算虚构
  const userText = '今日一對夫婦結伴嚟辦蓮塘，選號完成';
  const samples = [
    '群裡一句「搞掂」，背後成個流程安安穩穩。\n\n#明哥中港牌',
    '群裡最平淡嗰三個字——「冇問題」。\n\n#明哥中港牌',
    '一句「搞掂」。\n\n#明哥中港牌'
  ];
  for (const t of samples) {
    const r = checkHardRules(t, { scene: 'business', userText });
    assert.ok(!V(r).includes('r-no-fabricate'), `误拦短引用：${t.split('\n')[0]} -> ${V(r).join(',')}`);
  }
});

test('r-no-fabricate 拦长篇虚构表述（各引号类型）', () => {
  const userText = '選號完成';
  const cases = [
    ['直角引号', '客戶留言：「交車好順，服務一流」。\n\n#明哥中港牌'],
    ['直双引号', '客戶留言："交車好順，服務一流"。\n\n#明哥中港牌'],
    ['单引号', "客戶留言：'交車好順，服務一流'。\n\n#明哥中港牌"],
    ['超长引号', '「' + '客'.repeat(41) + '」。\n\n#明哥中港牌']
  ];
  for (const [name, t] of cases) {
    const r = checkHardRules(t, { scene: 'business', userText });
    assert.ok(V(r).includes('r-no-fabricate'), `${name} 应被拦截`);
  }
});

test('r-no-fabricate 独立查评价词（不被引号短路）', () => {
  // 原文无「滿意」但文案出现 -> 虚构评价
  const r = checkHardRules('陳生好滿意。\n\n#明哥中港牌', { scene: 'business', userText: '選號完成' });
  assert.ok(V(r).includes('r-no-fabricate'));
});

// 【回归 2026-10-04】上一版 FABRICATION_PATTERNS 命中即违规、从不回查原文，
// 明哥亲口说「客人好滿意」、文案如实转述反而被拦（还谎报「原文无此表述」）
test('r-no-fabricate 评价词在用户原文有依据时放行', () => {
  const r = checkHardRules('交車完成。\n\n客人話好滿意。\n\n#明哥中港牌', {
    scene: 'business', userText: '今日交車，客人好滿意'
  });
  assert.equal(r.pass, true, `有依据不应拦截：${V(r).join(',')}`);
});

test('r-no-fabricate 截图识别出的引语放行（视觉结果也是证据）', () => {
  const r = checkHardRules('群裡一句「陳生話服務一流」。\n\n#明哥中港牌', {
    scene: 'business',
    userText: '',
    vision: { type: 'screenshot', description: '群聊截圖，陳生話服務一流', extracted: { status: '選號完成', hasPII: true } }
  });
  assert.ok(!V(r).includes('r-no-fabricate'), `截图证据不应判虚构：${V(r).join(',')}`);
});

test('r-no-fabricate 全场景生效（不限于 business）', () => {
  const r = checkHardRules('客戶留言：「交車好順，服務一流」。\n\n#明哥中港牌', {
    scene: 'car', userText: '推薦 RX300'
  });
  assert.ok(V(r).includes('r-no-fabricate'), '虚构红线应与场景无关');
});

test('r-mask-pii 有PII但未提示打码被拦', () => {
  const r = checkHardRules('搞掂晒。\n\n#明哥中港牌', {
    vision: { extracted: { hasPII: true } }, imagePlan: '拍現場圖'
  });
  assert.ok(V(r).includes('r-mask-pii'));
});

test('r-mask-pii 已提示打码放行', () => {
  const r = checkHardRules('搞掂晒。\n\n#明哥中港牌', {
    vision: { extracted: { hasPII: true } }, imagePlan: '群聊截圖，發布前打碼頭像暱稱'
  });
  assert.equal(r.pass, true);
});

// ========== 误报回归：正常文案不得被拦 ==========
test('正常粤语文案不得被误拦', () => {
  const cases = [
    '唯一一次返鄉嘅機會。\n\n#明哥中港牌',
    '今日係第一次見陳生。\n\n#明哥中港牌',
    '第一時間幫你睇好。\n\n#明哥中港牌',
    '呢部未必唯一。\n\n#明哥中港牌',
    '向每一位堅持嘅人致敬。\n\n#明哥中港牌',
    '今日主角，RX300。\n\n唔張揚，但企喺度，自有一種從容。\n\n#明哥中港牌',
    '蓮塘辦好晒，寫喺日程表淨係幾行字。\n\n#明哥中港牌'
  ];
  for (const t of cases) {
    const r = checkHardRules(t);
    assert.equal(r.pass, true, `误拦：${t.slice(0, 20)} -> ${V(r).join(',')}`);
  }
});

// ========== checked 如实性 ==========
test('checked 不得虚报 HARD_RULES 长度', () => {
  const r = checkHardRules('測試。\n\n#明哥中港牌');
  assert.ok(r.checked <= r.declared, 'checked 不应超过 declared');
  assert.ok(r.checked < r.declared, 'clean 文本不应评估全部场景相关规则');
  assert.equal(typeof r.unimplemented, 'object');
});

test('全场景下 checked 如实反映已评估规则', () => {
  const r = checkHardRules('搞掂晒。\n\n#明哥中港牌', {
    scene: 'greeting', userText: 'x', vision: { type: 'screenshot', description: '客戶群對話', extracted: { hasPII: true } },
    imagePlan: '打碼'
  });
  // greeting 场景下 r-sharedan-completed 不适用，其余应已评估
  assert.deepEqual(r.unimplemented.sort(), ['r-no-future-time', 'r-port-unverified', 'r-sharedan-completed']);
  assert.equal(r.checked, r.declared - 3);
});

test('繁简均接受：不做字体检测（明哥 2026-10-03 确认）', () => {
  // 繁体、简体、港式粤语写法都应放行
  const samples = [
    '今日主角，RX300。\n\n唔張揚，自有一種從容。\n\n#明哥中港牌',
    '今天交车，一切顺利。\n\n谢谢各位。\n\n#明哥中港牌',
    '今日搞掂晒，好正。\n\n#明哥中港牌',
    '今日經后海去口岸。\n\n#明哥中港牌',
    '北斗七星下面食飯。\n\n#明哥中港牌'
  ];
  for (const t of samples) {
    const r = checkHardRules(t);
    assert.equal(r.pass, true, `不应因字体拦下：${t.split('\n')[0]}`);
  }
});

test('HARD_RULES 不含 r-traditional', () => {
  assert.ok(!HARD_RULES.some(x => x.id === 'r-traditional'));
});

// 【回归 2026-10-04】阿拉伯数字直跟「萬/万」原漏网（88萬 / 88 萬 / 8萬公里）
// 车源输入常带阿拉伯数字价格，LLM 回显正是这种写法
test('价格与里程：阿拉伯数字 + 萬 的写法被拦（原先漏网）', () => {
  const mustBlock = ['售價 88 萬。\n\n#明哥中港牌', '只要 88萬。\n\n#明哥中港牌', '行咗 8萬公里。\n\n#明哥中港牌', '88.5 萬起。\n\n#明哥中港牌'];
  for (const t of mustBlock) {
    assert.ok(V(checkHardRules(t, { scene: 'car', userText: t })).includes('r-no-numbers'), `应拦截：${t.slice(0, 12)}`);
  }
  // 年份/系别不受影响
  for (const t of ['2023年款。\n\n#明哥中港牌', '今日主角，四十系埃爾法。\n\n#明哥中港牌', 'RX300 到店。\n\n#明哥中港牌']) {
    assert.equal(checkHardRules(t).pass, true, `不应误拦：${t.slice(0, 14)}`);
  }
});

// 【回归 2026-10-04 二轮】导演腔镜头：明哥否决「靜咗幾秒。然後一句：『得。』」（尴尬+脑补）
test('r-drama 导演腔触发提示（warning 不阻断）', () => {
  const cases = [
    '陳生坐入去，手放喺軚盤上面。靜咗幾秒。然後一句：「得」。\n\n#明哥中港牌',
    '佢笑住話，就係呢部。\n\n#明哥中港牌',
    '佢望住我，半晌冇出聲。\n\n#明哥中港牌'
  ];
  for (const t of cases) {
    const r = checkHardRules(t, { scene: 'business', userText: '今日交車' });
    assert.equal(r.pass, true, 'r-drama 是提示级，不应阻断');
    assert.ok(W(r).includes('r-drama'), `应提示导演腔：${t.slice(0, 12)}`);
  }
});

test('r-drama 官方示例的客户动作白描不误伤', () => {
  // §10 交车官方示例：「佢先繞住部車行咗一圈，先開門上車」——自然白描，无导演腔
  const r = checkHardRules('交車。\n\n佢先繞住部車行咗一圈，先開門上車。\n\n#明哥中港牌', { scene: 'business', userText: '今日交咗部40系埃爾法畀陳生' });
  assert.ok(!W(r).includes('r-drama'), `白描不应误报：${W(r).join(',')}`);
  assert.equal(r.pass, true);
});

// 【2026-10-04 明哥确认】成交/晒单（business）场景落款可带一个业务标签（双标签）
test('双标签：business 场景 #明哥中港牌 #蓮塘兩地牌 放行，其他场景仍单落款', () => {
  // business 双标签放行
  const okBiz = checkHardRules('今日成交，蓮塘搞掂。\n\n#明哥中港牌 #蓮塘兩地牌', { scene: 'business' });
  assert.equal(okBiz.pass, true);
  // 单标签在 business 依旧放行
  assert.equal(checkHardRules('搞掂。\n\n#明哥中港牌', { scene: 'business' }).pass, true);
  // 非 business 场景双标签 = 落款不单独（早安不许带业务标签）
  const badGreet = checkHardRules('早晨，星期一。\n\n#明哥中港牌 #蓮塘兩地牌', { scene: 'greeting' });
  assert.ok(V(badGreet).includes('r-signature-alone'), '非业务场景双标签应拦');
  // 落款行跟普通文字（非标签）在 business 也拦
  const badText = checkHardRules('搞掂。\n\n#明哥中港牌 搞定收工', { scene: 'business' });
  assert.ok(V(badText).includes('r-signature-alone'), '落款行普通文字应拦');
});


// 【回归 2026-10-04 多图实测】图为群聊截图时，「群裡幾句話」有图为证不算虚构
test('r-no-fabricate：群聊截图场景「群裡」叙述放行', () => {
  const r = checkHardRules('今日交車。\n\n群裡幾句話，逐步走完。\n\n#明哥中港牌', {
    scene: 'business',
    userText: '今日交車，多謝陳生信任',
    vision: { type: 'screenshot', description: '客戶群對話', extracted: { status: '交車', hasPII: true } }
  });
  assert.ok(!V(r).includes('r-no-fabricate'), `截图在，群裡叙述不应判虚构：${V(r).join(',')}`);
});

// 【2026-10-04 明哥硬要求】图中提取的客户姓名/称呼一律不写入文案
test('r-no-client-name：视觉来源的称呼进文案被拦，用户自己写的放行', () => {
  const vision = { type: 'screenshot', description: '客戶群：恭喜陳生，今日已完成選號', extracted: { status: '選號完成', hasPII: true } };
  // 图里来的称呼 → 拦
  const blocked = checkHardRules('選號搞掂，陳生嗰單。\n\n#明哥中港牌', {
    scene: 'business', userText: '幫客戶搞掂咗選號', vision, imagePlan: '群聊截圖打碼'
  });
  assert.ok(V(blocked).includes('r-no-client-name'), `应拦图中称呼：${V(blocked).join(',')}`);
  // 用户输入里自己写了 → 放行（用户的选择）
  const allowed = checkHardRules('陳生嗰單，選號搞掂。\n\n#明哥中港牌', {
    scene: 'business', userText: '幫陳生搞掂咗選號', vision, imagePlan: '群聊截圖打碼'
  });
  assert.ok(!V(allowed).includes('r-no-client-name'));
  // 泛称 → 放行
  const generic = checkHardRules('一位客戶選號搞掂。\n\n#明哥中港牌', {
    scene: 'business', userText: '幫客戶搞掂咗選號', vision, imagePlan: '群聊截圖打碼'
  });
  assert.ok(!V(generic).includes('r-no-client-name'));
  // 无视觉输入：不评估
  const noVision = checkHardRules('搞掂。\n\n#明哥中港牌', { scene: 'business' });
  assert.ok(!V(noVision).includes('r-no-client-name'));
  assert.ok(noVision.unimplemented.includes('r-no-client-name'), '无视觉时应如实列入未评估');
});

// 【2026-10-04 明哥硬要求】未来时间节点须来自输入/图片，不得编造
test('r-no-future-time：无来源的时间承诺被拦，有来源/无时间说法放行', () => {
  // 无来源 → 拦
  const blocked = checkHardRules('選號搞掂。\n\n下週裝卡，到時再報。\n\n#明哥中港牌', {
    scene: 'business', userText: '幫客戶搞掂咗選號'
  });
  assert.ok(V(blocked).includes('r-no-future-time'), `应拦编造时间：${V(blocked).join(',')}`);
  // 用户文字里有 → 放行
  const okText = checkHardRules('選號搞掂。\n\n下週裝卡，到時再報。\n\n#明哥中港牌', {
    scene: 'business', userText: '選號搞掂，下週裝卡'
  });
  assert.ok(!V(okText).includes('r-no-future-time'));
  // 图片识别里有 → 放行
  const okVision = checkHardRules('選號搞掂。\n\n下週裝卡。\n\n#明哥中港牌', {
    scene: 'business', userText: '選號搞掂',
    vision: { type: 'screenshot', description: '客戶群：下週安排裝卡', extracted: { status: '選號完成' } }
  });
  assert.ok(!V(okVision).includes('r-no-future-time'));
  // 不带时间的后续说法 → 放行
  const vague = checkHardRules('選號搞掂。\n\n之後仲有裝卡，照流程行。\n\n#明哥中港牌', {
    scene: 'business', userText: '選號搞掂'
  });
  assert.equal(vague.pass, true);
  // 早安场景的「星期四」是今天，不适用此规则
  const morning = checkHardRules('早晨，星期四。\n\n霧未散。\n\n#明哥中港牌', { scene: 'greeting' });
  assert.equal(morning.pass, true);
});

// 【回归 2026-10-04 e2e 实测】模型从知识库替本次成交「配」口岸（输入无口岸却写蓮塘）
test('r-port-unverified：口岸无来源提示核实；通用罗列与有来源放行', () => {
  // 无来源单口岸 → 提示（不阻断）
  const w = checkHardRules('今日成交，蓮塘搞掂。\n\n#明哥中港牌 #蓮塘兩地牌', { scene: 'business', userText: '搞掂' });
  assert.equal(w.pass, true);
  assert.ok(W(w).includes('r-port-unverified'), `应提示口岸核实：${W(w).join(',')}`);
  // 用户输入里有口岸 → 不提示
  const ok = checkHardRules('今日成交，蓮塘搞掂。\n\n#明哥中港牌 #蓮塘兩地牌', { scene: 'business', userText: '蓮塘搞掂' });
  assert.ok(!W(ok).includes('r-port-unverified'));
  // 通用罗列多个口岸 → 不提示
  const list = checkHardRules('兩地牌可辦：深圳灣、蓮塘、沙頭角、港珠澳大橋，今日又落一單。\n\n#明哥中港牌', { scene: 'business', userText: '又落一單' });
  assert.ok(!W(list).includes('r-port-unverified'));
});
