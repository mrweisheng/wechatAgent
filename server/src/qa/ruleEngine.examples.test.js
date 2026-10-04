// 方案文档 §10 全部示例回归
// 关键：示例含「聽講皇崗牌有人叫價七位數」—— 允许出现皇岗（仅作谈资），
// 但不得写成可办理；「七位數」是模糊谈资口径，不属具体数字。

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHardRules } from './ruleEngine.js';

const examples = [
  // 業務動態（完成態）
  { scene: 'business', text: `號碼定咗。\n\n群裡一句「搞掂」，\n背後成個流程安安穩穩，冇甩漏。\n\n好事，通常都係靜靜哋發生嘅。\n\n#明哥中港牌` },
  { scene: 'business', text: `驗完車。\n\n群裡最平淡嗰三個字——\n「冇問題」。\n\n最抵聽嘅，往往就係呢種。\n\n#明哥中港牌` },
  { scene: 'business', text: `卡裝好。\n\n由呢一刻起，\n關口兩邊，唔再係兩個世界。\n\n#明哥中港牌` },
  // 車源 / 交車
  { scene: 'car', text: `交車。\n\n佢先繞住部車行咗一圈，先開門上車。\n\n有啲嘢，坐低就知，\n唔使多講。\n\n#明哥中港牌` },
  { scene: 'car', text: `今日主角，RX300。\n\n唔張揚，\n但企喺度，自有一種從容。\n\n啱嗰啲唔急住向人證明啲咩嘅人。\n\n#明哥中港牌` },
  // 到店 / 忙日
  { scene: 'business', text: `一對夫婦，結伴嚟辦蓮塘。\n\n一個問得仔細，一個聽得認真。\n跨境呢件事，從來唔係一個人嘅決定。\n\n合同簽好，路就開始。\n\n#明哥中港牌` },
  { scene: 'business', text: `一日，幾單。\n\n大橋嘅、蓮塘嘅，\n有啲傾咗好耐，今日終於落定。\n\n寫喺日程表，淨係幾行字。\n背後嘅往來，只有當事人知。\n\n#明哥中港牌` },
  { scene: 'business', text: `中秋前，仲有客人放工過嚟。\n\n唔急住定，慢慢傾，\n方案理順，攞返屋企同屋企人再商量。\n\n呢種慎重，先係長遠嘅做法。\n\n#明哥中港牌` },
  // 科普
  { scene: 'edu', text: `好多人問：\n點解我架車入唔到內地？\n\n兩地牌分方向——\n一邊港車北上，一邊內地車南下。\n唔係貴唔貴，係啱唔啱。\n\n#明哥中港牌` },
  { scene: 'edu', text: `聽講皇崗牌有人叫價七位數。\n\n真唔真，我唔知。\n淨係知——我哋從唔叫人追高。\n\n#明哥中港牌` },
  // 人文
  { scene: 'greeting', text: `早晨，星期四。\n\n霧未散，路已經有人行。\n\n行得早嘅人，\n唔係唔攰，係知去邊。\n\n路上見。\n\n#明哥中港牌` },
  { scene: 'festival', text: `中秋夜。\n\n月照深圳灣，亦照維港。\n\n同一個月亮，\n兩地嘅人，都可以抬頭望一望。\n\n#明哥中港牌` },
  // 日常 / 公司事
  { scene: 'daily', text: `收工。\n\n今日唔傾牌，唔講車。\n\n飲杯茶，睇下海。\n\n#明哥中港牌` },
  { scene: 'daily', text: `開會。\n\n先唔講業績。\n\n客人交低嘅，係信任——\n呢樣嘢，賺唔返，只可以守。\n\n#明哥中港牌` }
];

test('§10 全部 14 条示例通过硬规则', () => {
  assert.equal(examples.length, 14);
  for (const { text, scene } of examples) {
    const r = checkHardRules(text, { scene });
    assert.equal(
      r.pass, true,
      `未通过[${scene}]：${text.slice(0, 24)}… -> ${r.violations.map(v => v.msg).join('；')}`
    );
  }
});

test('§10 关键反例仍被拦截', () => {
  const bad = [
    ['缺落款', '今日搞掂。', 'business'],
    ['落款同行', '路上見 #明哥中港牌', 'greeting'],
    ['徽章式落款', '謝謝支持！#明哥中港牌#', 'daily']
  ];
  for (const [name, t, scene] of bad) {
    assert.equal(checkHardRules(t, { scene }).pass, false, `${name} 应被拦截`);
  }
});
