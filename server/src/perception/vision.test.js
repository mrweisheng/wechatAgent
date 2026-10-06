// 场景路由与信息缺口检测测试

import test from 'node:test';
import assert from 'node:assert/strict';
import { routeScene, detectMissing, isImageMime, retrieveKnowledge } from './vision.js';

test('场景路由：关键词', () => {
  assert.equal(routeScene({ text: '早晨，今日好天' }), 'greeting');
  assert.equal(routeScene({ text: '選號完成' }), 'business');
  assert.equal(routeScene({ text: '今日推薦 RX300' }), 'car');
  assert.equal(routeScene({ text: '兩地牌點解入唔到內地' }), 'edu');
  assert.equal(routeScene({ text: '今晚收工帶隊去深圳食飯' }), 'daily');
  assert.equal(routeScene({ text: '寫個中秋文案' }), 'festival');
  assert.equal(routeScene({ text: '' }), 'unknown');
});

test('场景路由：daily 优先于 car 的泛化词「今日」', () => {
  // 「今日收工帶隊去深圳食飯」含「今日」，但语义是日常而非车源
  assert.equal(routeScene({ text: '今日收工帶隊去深圳食飯' }), 'daily');
  assert.equal(routeScene({ text: '今日想飲茶' }), 'daily');
  // 但明确的车型词仍应归 car
  assert.equal(routeScene({ text: '今日推薦 RX300' }), 'car');
  assert.equal(routeScene({ text: '今日四十系埃爾法到店' }), 'business'); // 「到店」按 §3 属业务动态（晒单事件）
});

test('场景路由：图型自识别', () => {
  assert.equal(routeScene({ text: '', vision: { type: 'screenshot', extracted: {} } }), 'business');
  assert.equal(routeScene({ text: '', vision: { type: 'car', extracted: {} } }), 'car');
  assert.equal(routeScene({ text: '', vision: { type: 'poster', extracted: {} } }), 'greeting');
});

// 【回归 2026-10-04】上一版 greeting 最先检查且含「路上見」，
// 业务文案带「路上見」收尾会被劫持成早安场景，输出完全跑偏
test('场景路由：业务关键词优先于问候短语（「路上見」不再劫持）', () => {
  assert.equal(routeScene({ text: '選號完成，路上見' }), 'business');
  assert.equal(routeScene({ text: '今日交車，早安' }), 'business');
  assert.equal(routeScene({ text: '中秋前交咗部車' }), 'festival');
  // 纯问候仍归 greeting
  assert.equal(routeScene({ text: '早晨' }), 'greeting');
  assert.equal(routeScene({ text: '早安，今日好天' }), 'greeting');
});

test('场景路由：视觉识别出状态优先归业务', () => {
  assert.equal(routeScene({ text: '', vision: { type: 'other', extracted: { status: '交車' } } }), 'business');
});

// 【回归 2026-10-06 审计】交车的粤语高频说法（交咗/交左/提車/交付/攞車）原先路由成
// unknown —— r-car-delivery-scope / r-port-unverified / r-sharedan-completed /
// r-no-future-time / r-visit-count / r-low-ending 六条场景门控规则整层失效
// （生产实证 2026-10-06 02:55:07：「今日交咗部車畀客戶」-> unknown）。
test('场景路由：交车粤语说法归 business（业务红线不再整层失效）', () => {
  assert.equal(routeScene({ text: '今日交咗部車畀客戶' }), 'business');
  assert.equal(routeScene({ text: '交左部車' }), 'business');
  assert.equal(routeScene({ text: '提車' }), 'business');
  assert.equal(routeScene({ text: '交付完成' }), 'business');
  assert.equal(routeScene({ text: '客戶嚟攞車' }), 'business');
  assert.equal(routeScene({ text: '交咗部車，客人好滿意' }), 'business');
});

// 审核发现的死代码：原先要求「完全无输入」才追问，与 detectMissing 内部条件互斥
test('有输入但要素缺失时应追问（原先不可达）', () => {
  const m = detectMissing({ scene: 'car', text: '今日推薦', vision: null });
  assert.ok(m.length > 0, '车型缺失应触发追问');
});

test('要素齐备时不追问', () => {
  const m = detectMissing({
    scene: 'car',
    text: '今日推薦四十系埃爾法',
    vision: { extracted: { cars: ['埃爾法'] } }
  });
  assert.equal(m.length, 0);
});

test('早安场景不追问（星期由系统注入）', () => {
  assert.equal(detectMissing({ scene: 'greeting', text: '', vision: null }).length, 0);
});

test('完全无输入时追问', () => {
  assert.ok(detectMissing({ scene: 'unknown', text: '', vision: null }).length > 0);
  assert.ok(detectMissing({ scene: 'business', text: '', vision: null }).length > 0);
});

test('图片 MIME 识别含 HEIC/AVIF（原先静默丢弃 iPhone 照片）', () => {
  assert.equal(isImageMime('image/jpeg'), true);
  assert.equal(isImageMime('image/heic'), true);
  assert.equal(isImageMime('image/heif'), true);
  assert.equal(isImageMime('image/avif'), true);
  assert.equal(isImageMime('application/pdf'), false);
});

test('知识库检索命中', () => {
  const hits = retrieveKnowledge('今日推薦四十系埃爾法，蓮塘口岸');
  assert.ok(hits.length > 0);
  assert.ok(hits.some(h => h.id === 'kw-port-available'));
});

// 【回归 2026-10-04】「夫妇到店咨询办莲塘口岸牌」含「口岸」曾被误路由 edu；
// §3 明确「到店/咨询/办理」属业务动态
test('场景路由：到店/咨询/办理优先归 business（不被「口岸」带偏到科普）', () => {
  assert.equal(routeScene({ text: '今日有一对夫妻到店，经过各方面详细的咨询之后，最终还是选择我们在我们这里办理的莲塘口岸车牌，认为明哥这里非常靠谱' }), 'business');
});

// 【2026-10-04 审核采纳】视觉明确信号优先于文本泛化词：明确车图不被随口的日常话带偏
test('场景路由：视觉明确信号先于文本泛化词', () => {
  assert.equal(routeScene({ text: '今晚收工飲茶', vision: { type: 'car', extracted: {} } }), 'car');
  assert.equal(routeScene({ text: '今日想飲茶', vision: { type: 'screenshot', extracted: {} } }), 'business');
  // 文本明确业务词仍最优先
  assert.equal(routeScene({ text: '搞掂', vision: { type: 'poster', extracted: {} } }), 'business');
});

test('多图合并：类型按信息密度、要素并集、hasPII 任一为真', async () => {
  const { mergeVisions } = await import('./vision.js');
  const car = { type: 'car', description: '白色埃爾法', extracted: { cars: ['埃爾法'], ports: [], status: '', hasPII: false } };
  const chat = { type: 'screenshot', description: '群聊：選號完成', extracted: { cars: [], ports: ['蓮塘'], status: '選號完成', hasPII: true } };
  const m = mergeVisions([car, chat]);
  assert.equal(m.type, 'screenshot', '截图信息密度最高，主导类型');
  assert.deepEqual(m.extracted.cars, ["埃爾法"]);
  assert.deepEqual(m.extracted.ports, ['蓮塘']);
  assert.equal(m.extracted.status, '選號完成');
  assert.equal(m.extracted.hasPII, true);
  assert.equal(m._multiImage, true);
  // 全降级：返回带降级标记的原对象
  const d = mergeVisions([{ _degraded: true, type: 'other', description: 'x', extracted: {} }]);
  assert.equal(d._degraded, true);
});
