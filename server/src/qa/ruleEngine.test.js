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

// ========== 语域：绝对化用语 ==========
// 【2026-10-05】r-absolute-advisory 与 ABSOLUTE_TERMS 已整体删除：
// 全链路无消费方（不阻断/不评分/不触发重写），前端提示对工作流无价值。
// 回归锁定：这些词现在既不阻断也不产生任何 warning。
test('绝对化用语彻底放行（规则已删除，不再产生提示）', () => {
  for (const t of ['包過', '零風險', '全網最低', '國家級', '保證冇問題', '我哋係行業第一']) {
    const r = checkHardRules(`${t}。\n\n#明哥中港牌`);
    assert.equal(r.pass, true, `${t} 不应阻断`);
    assert.ok(!W(r).some(w => w.startsWith('r-absolute')), `${t} 不应再产生绝对化提示`);
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

test('r-no-fabricate 有依据则放行（原文 + 群聊截图）', () => {
  const r = checkHardRules('群裡一句「搞掂」。\n\n#明哥中港牌', {
    scene: 'business',
    userText: '群裡一句「搞掂」',
    vision: { type: 'screenshot', description: '群聊截圖：群裡一句「搞掂」', extracted: { status: '選號完成', hasPII: false } }
  });
  assert.equal(r.pass, true, `有依据不应拦截：${V(r).join(',')}`);
});

// 【2026-10-05 明哥反馈收紧】原「≤5 字短引语一律放行」豁免是虚构通道：
// 没传截图编「群裡一句『搞掂』」、传了截图编「可以行得」，全部免检漏网。
// 现在：引语不论长短，必须逐字来自用户原文或截图识别结果。
test('r-no-fabricate 无依据短引语同样拦截（不再豁免）', () => {
  const userText = '今日一對夫婦結伴嚟辦蓮塘，選號完成';
  const samples = [
    '一句「搞掂」。\n\n#明哥中港牌',
    '一句「冇問題」。\n\n#明哥中港牌',
    '一句「可以行得」。\n\n#明哥中港牌'
  ];
  for (const t of samples) {
    const r = checkHardRules(t, { scene: 'business', userText });
    assert.ok(V(r).includes('r-no-fabricate'), `无依据短引语应拦：${t.split('\n')[0]} -> ${V(r).join(',')}`);
  }
});

// 【2026-10-05 明哥反馈】两次实测翻车：没传图编「群裡最後一句『可以行得。』」；
// 传了截图，引的「搞掂」也不是图里原文。群聊内容只能来自真实截图。
test('r-group-screenshot 没传截图不得提群', () => {
  const r = checkHardRules('群裡一句「搞掂」。\n\n#明哥中港牌', { scene: 'business', userText: '選號完成' });
  assert.ok(V(r).includes('r-group-screenshot'), V(r).join(','));
});

test('r-group-screenshot 传了群聊截图则放行', () => {
  const r = checkHardRules('群裡幾句話，逐步走完。\n\n#明哥中港牌', {
    scene: 'business',
    userText: '選號完成',
    vision: { type: 'screenshot', description: '群聊截圖，客戶群對話', extracted: { status: '選號完成', hasPII: true } }
  });
  assert.ok(!V(r).includes('r-group-screenshot'), V(r).join(','));
});

test('r-group-screenshot 视觉识别降级（无有效截图）时同样拦截', () => {
  const r = checkHardRules('群裡幾句話。\n\n#明哥中港牌', {
    scene: 'business',
    userText: '選號完成',
    vision: { type: 'other', description: '(視覺識別未啟用或調用失敗，已跳過圖像理解)', extracted: { hasPII: false }, _degraded: true }
  });
  assert.ok(V(r).includes('r-group-screenshot'), V(r).join(','));
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

// 【2026-10-05】UNGROUNDED_NARRATIVE_PATTERNS（原死代码）并入 FABRICATION_PATTERNS：
// 补「X話 + 无评价词」的无引号转述漏网，如「佢話即刻搞掂」——此前完全放行
test('r-no-fabricate 拦无引号转述框架（佢話+无评价词）', () => {
  const r = checkHardRules('交車完成。\n\n佢話即刻搞掂。\n\n#明哥中港牌', {
    scene: 'business', userText: '今日交咗部車'
  });
  assert.ok(V(r).includes('r-no-fabricate'), `无据无引号转述应拦：${V(r).join(',')}`);
});

test('r-no-fabricate 无引号转述在有依据时放行', () => {
  const r = checkHardRules('交車完成。\n\n佢話即刻搞掂。\n\n#明哥中港牌', {
    scene: 'business', userText: '今日交車，佢話即刻搞掂'
  });
  assert.equal(r.pass, true, `有据转述不应拦：${V(r).join(',')}`);
});

// 【回归锁定】「嗰句」裸命中会误伤官方示例句式（「最平淡嗰句回覆」是正常指代），
// 故该框架限定后接引号才命中
test('r-no-fabricate 「嗰句」不带引号的正常指代不误伤', () => {
  const r = checkHardRules('驗完車。\n\n最平淡嗰句回覆，往往就係最抵聽嗰句。\n\n#明哥中港牌', {
    scene: 'business', userText: '今日驗車'
  });
  assert.ok(!V(r).includes('r-no-fabricate'), `风格锚句式不应被拦：${V(r).join(',')}`);
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

// r-mask-pii 已移除（2026-10-05）：配图是用户自己的图，文案层无从替他打码，
// 改为 API 返回 maskReminder 由前端横幅提示，不再作为文案硬规则。

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
    scene: 'greeting', userText: 'x', vision: { type: 'screenshot', description: '客戶群對話', extracted: { hasPII: true } }
  });
  // greeting 场景下：晒单/未来时间/口岸/交车/到场次数/收尾 等场景规则均不适用；
  // r-ending-repeat 依赖 ctx.recentTails（未提供 = 不评估），其余应已评估
  assert.deepEqual(r.unimplemented.sort(), [
    'r-car-delivery-scope', 'r-ending-repeat', 'r-low-ending', 'r-no-future-time',
    'r-port-unverified', 'r-sharedan-completed', 'r-visit-count'
  ]);
  assert.equal(r.checked, r.declared - 7);
});

// 【回归 2026-10-05 明哥业务反馈】纯购车交车帖不得接两地牌后续
test('r-car-delivery-scope：纯购车交车帖不得接两地牌后续，明确办牌则放行', () => {
  const bad = checkHardRules('交車。之後仲有裝卡，照流程行。\n\n#明哥中港牌', {
    scene: 'business', userText: '今日交車，40系埃爾法，客人好滿意'
  });
  assert.ok(V(bad).includes('r-car-delivery-scope'), `应拦纯购车接装卡：${V(bad).join(',')}`);
  const ok = checkHardRules('交車，之後仲有裝卡，照流程行。\n\n#明哥中港牌', {
    scene: 'business', userText: '幫客戶交車，佢係辦兩地牌嘅，之後仲有裝卡'
  });
  assert.ok(!V(ok).includes('r-car-delivery-scope'), '用户明确办两地牌应放行');
  // 非交车语境（选号完成）不受影响
  const normal = checkHardRules('選號完成。\n\n#明哥中港牌', { scene: 'business', userText: '選號完成' });
  assert.ok(!V(normal).includes('r-car-delivery-scope'));
});

// 【回归 2026-10-05 明哥业务反馈】到场次数 / 低质收尾 / 地理错误三条提示
test('r-visit-count / r-low-ending / r-geo-hk', () => {
  const cnt = checkHardRules('客戶出現嘅次數，兩隻手數得晒。\n\n#明哥中港牌', { scene: 'business' });
  assert.ok(W(cnt).includes('r-visit-count'));
  const ending = checkHardRules('交車完成。\n\n路上見。\n\n#明哥中港牌', { scene: 'business' });
  assert.ok(W(ending).includes('r-low-ending'));
  const geo = checkHardRules('有客從香港過來取車。\n\n#明哥中港牌', { scene: 'business' });
  assert.ok(W(geo).includes('r-geo-hk'));
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
// 【2026-10-05】引语新规后，「得」须在 userText 有据才不触发 r-no-fabricate——
// 本测试只验证 r-drama 是提示级，故把引语补进依据语料
test('r-drama 导演腔触发提示（warning 不阻断）', () => {
  const cases = [
    ['陳生坐入去，手放喺軚盤上面。靜咗幾秒。然後一句：「得」。\n\n#明哥中港牌', '今日交車，佢一句「得」'],
    ['佢笑住話，就係呢部。\n\n#明哥中港牌', '今日交車'],
    ['佢望住我，半晌冇出聲。\n\n#明哥中港牌', '今日交車']
  ];
  for (const [t, ut] of cases) {
    const r = checkHardRules(t, { scene: 'business', userText: ut });
    assert.equal(r.pass, true, `r-drama 是提示级，不应阻断：${V(r).join(',')}`);
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
  // business 双标签放行（口岸须来自用户输入，见 r-port-unverified）
  const okBiz = checkHardRules('今日成交，蓮塘搞掂。\n\n#明哥中港牌 #蓮塘兩地牌', { scene: 'business', userText: '蓮塘搞掂' });
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

// 【回归 2026-10-05】「千萬」作副词（強調否定，如「千萬唔好急」）不应被误判为价格
test('价格检测：千万副词不误伤，真实金额仍拦', () => {
  const adv = checkHardRules('呢件事，千萬唔好急。\n\n#明哥中港牌');
  assert.ok(!V(adv).includes('r-no-numbers'), `千萬唔好 不应判为价格：${V(adv).join(',')}`);
  const adv2 = checkHardRules('千万要留意。\n\n#明哥中港牌');
  assert.ok(!V(adv2).includes('r-no-numbers'), '千万要 不应判为价格');
  const price = checkHardRules('唔使一千萬，幾百萬都有。\n\n#明哥中港牌');
  assert.ok(V(price).includes('r-no-numbers'), '真实金额仍应拦');
});

// 【回归 2026-10-06 审计】夸张修辞（十萬火急/一萬個理由/千萬記得/一萬分感謝等）
// 原被误拦为价格——金额后紧跟 記/個/分/倍/火 属修辞语境，豁免；真实金额仍拦。
test('价格检测：夸张修辞成语不误伤（十萬火急/一萬個/千萬記得/一萬分/十萬倍）', () => {
  const idioms = [
    '呢件事十萬火急，即刻處理。',
    '一萬個理由，都唔夠一個行動實在。',
    '十萬個為甚麼，問完就要做。',
    '千萬記得，穩陣最緊要。',
    '一萬分感謝，記喺心度。',
    '快過人十萬倍，唔係靠把口。',
    '百萬分之一嘅機會，都俾佢把握到。'
  ];
  for (const t of idioms) {
    const r = checkHardRules(t + '\n\n#明哥中港牌');
    assert.ok(!V(r).includes('r-no-numbers'), `修辞误拦：${t} -> ${V(r).join(',')}`);
  }
  // 真实金额（含「成百萬」粤语说法）仍必须拦
  const prices = ['叫價百萬。', '預算十萬左右。', '成百萬嘅貨。', '八十萬元正。'];
  for (const t of prices) {
    const r = checkHardRules(t + '\n\n#明哥中港牌');
    assert.ok(V(r).includes('r-no-numbers'), `真实金额漏拦：${t}`);
  }
});

// 【2026-10-06 审计 P2】收尾复读提示：收尾与近期发过的文案重复 = 视觉疲劳根源（明哥口径）
test('r-ending-repeat：收尾与近期重复时提示，未提供近期收尾不评估', () => {
  const text = '早晨，星期一。\n\n霧未散，路已經有人行。\n\n路上見。\n\n#明哥中港牌';
  const dup = checkHardRules(text, { scene: 'greeting', recentTails: ['路上見。', '慢慢嚟。'] });
  assert.ok(W(dup).includes('r-ending-repeat'), `复读收尾应提示：${W(dup).join(',')}`);
  assert.equal(dup.pass, true, '仅提示不阻断');

  const fresh = checkHardRules(text, { scene: 'greeting', recentTails: ['各自安好。'] });
  assert.ok(!W(fresh).includes('r-ending-repeat'), '新收尾不应提示');

  const noCtx = checkHardRules(text, { scene: 'greeting' });
  assert.ok(!W(noCtx).includes('r-ending-repeat'), '无 recentTails 不评估');
  assert.ok(noCtx.unimplemented.includes('r-ending-repeat'), '无 recentTails 时应如实列入未评估');
});

// 【回归 2026-10-05】「學生/醫生/發生」等非称呼词不应被当作客户称呼误拦
test('r-no-client-name：學生/醫生等非称呼不误拦', () => {
  const r = checkHardRules('今日有學生嚟問價。\n\n#明哥中港牌', {
    scene: 'daily', userText: '有客人嚟問價',
    vision: { type: 'other', description: '一位學生在查詢', extracted: {} }
  });
  assert.ok(!V(r).includes('r-no-client-name'), `學生 不应误拦：${V(r).join(',')}`);
});

// 【回归 2026-10-04 e2e 实测 + 2026-10-05 明哥确认升级】模型会从知识库/风格锚
// 替本次成交「配」口岸（输入无口岸却写蓮塘）。明哥口径：口岸属关键事实，
// 无来源 = 阻断（没有明确信息就追问或拦截，绝不自行补）。
test('r-port-unverified：口岸无来源阻断；通用罗列与有来源放行', () => {
  // 无来源单口岸 → 违规（阻断，触发重写删去口岸表述）
  const w = checkHardRules('今日成交，蓮塘搞掂。\n\n#明哥中港牌 #蓮塘兩地牌', { scene: 'business', userText: '搞掂' });
  assert.equal(w.pass, false);
  assert.ok(V(w).includes('r-port-unverified'), `口岸无来源应阻断：${V(w).join(',')}`);
  // 用户输入里有口岸 → 放行
  const ok = checkHardRules('今日成交，蓮塘搞掂。\n\n#明哥中港牌 #蓮塘兩地牌', { scene: 'business', userText: '蓮塘搞掂' });
  assert.ok(!V(ok).includes('r-port-unverified'));
  // 截图识别到的口岸也是证据 → 放行
  const viaVision = checkHardRules('今日成交，蓮塘搞掂。\n\n#明哥中港牌 #蓮塘兩地牌', {
    scene: 'business', userText: '搞掂',
    vision: { type: 'screenshot', description: '群聊截圖：蓮塘選號完成', extracted: { ports: ['蓮塘'], hasPII: false } }
  });
  assert.ok(!V(viaVision).includes('r-port-unverified'));
  // 通用罗列多个口岸 → 不拦（视为介绍）
  const list = checkHardRules('兩地牌可辦：深圳灣、蓮塘、沙頭角、港珠澳大橋，今日又落一單。\n\n#明哥中港牌', { scene: 'business', userText: '又落一單' });
  assert.ok(!V(list).includes('r-port-unverified'));
  // 【2026-10-05 明哥口径】用户说「各個口岸的都有」→ 文案罗列口岸是如实转述，放行
  // （哪怕只写一两个具体口岸——「各个口岸」本身已授权罗列）
  const allPorts = checkHardRules('今日客戶諮詢，蓮塘同深圳灣都有客戶問。\n\n#明哥中港牌', {
    scene: 'business', userText: '今日来了很多客户咨询，各个口岸的都有，明哥都亲自接待'
  });
  assert.ok(!V(allPorts).includes('r-port-unverified'), `各個口岸口径应放行：${V(allPorts).join(',')}`);
});
