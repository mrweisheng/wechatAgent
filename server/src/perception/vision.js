// 感知层：多模态输入 + 图型自识别 + 意图路由 + 信息缺口检测

import { KNOWLEDGE_BASE, AVAILABLE_PORTS } from '../knowledge/corpus.js';
import { llmChat, llmKeyUsable } from '../llm/client.js';

// 含 iPhone HEIC/HEIF 与 AVIF —— 原先只认 jpeg/png/webp/gif，HEIC 被静默丢弃
const IMG_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/heic', 'image/heif', 'image/avif'
];

// 图型自识别
export async function classifyImage(imageBuffer, mime) {
  if (!llmKeyUsable()) return fallbackClassify('llm_not_configured');

  const prompt = `請觀察這張圖片，只輸出 JSON（不要 markdown 包裹）：
{
  "type": "car" | "screenshot" | "poster" | "other",
  "description": "<50字以內客觀描述；不得出現任何客戶姓名或稱呼（如陳生/王先生/李太），一律用「客戶」「一對夫婦」等泛稱>",
  "extracted": {
    "cars": ["<車型>"],
    "ports": ["<口岸>"],
    "status": "<如「選號完成」「驗車通過」「交車」>",
    "hasPII": <是否含客戶頭像/暱稱/電話/車牌等需打碼的資訊>
  }
}`;
  let raw;
  try {
    const dataUrl = `data:${mime};base64,${imageBuffer.toString('base64')}`;
    raw = await llmChat([
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } }
      ] }
    // OCR/识别任务给足上限（max_tokens 是上限不计费；关闭推理后用量远低于此）
    ], { max_tokens: 3000, timeoutMs: 60000, label: 'vision' });
    if (!raw) return fallbackClassify('llm_empty');
    return JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
  } catch (e) {
    // 区分「调用失败」与「输出解析失败」，供前端如实提示（原先一律笼统称「未启用」）
    const reason = raw ? 'llm_parse_failed' : 'llm_call_failed';
    console.warn('[vision] degrade:', reason, String(e?.message || e).slice(0, 120));
    return fallbackClassify(reason);
  }
}

function fallbackClassify(reason) {
  return {
    type: 'other',
    description: '(視覺識別未啟用或調用失敗，已跳過圖像理解)',
    extracted: { hasPII: false },
    _degraded: true,
    _degradedReason: reason // llm_not_configured | llm_call_failed | llm_parse_failed | llm_empty
  };
}

// ===== 意圖路由 =====
// 检查顺序原则：具体场景先于泛化场景。
// 【修复 2026-10-04】上一版 greeting 最先检查且含收尾短语「路上見」，
// 导致「選號完成，路上見」被劫持成早安场景（prompt 强制「早晨，星期X」开头，输出跑偏）。
// 现改为：节日/业务/日常/科普/车源等具体信号优先，问候词最泛化、放最后——
// 只有纯「早安/早晨/路上見」这类无其他语义的输入才归 greeting。
export function routeScene({ text = '', vision = null }) {
  // 优先级（2026-10-04 审核采纳）：文本明确业务/节日词 > 视觉明确信号 > 文本泛化词。
  // 视觉信号提到泛化词之前：避免「明确的车图/海报 + 随口一句泛化文本」被带偏
  // （审核报告指出：文本正则独裁易误路由带图输入）。
  if (/中秋|國慶|国庆|春節|春节|端午|聖誕|圣诞|元旦|復活節|复活节/.test(text)) return 'festival';
  // 【修复 2026-10-06 审计】交车的粤语高频说法（交咗/交左/提車/交付/攞車）原先全部
  // 路由成 unknown —— 导致 r-car-delivery-scope / r-port-unverified / r-sharedan-completed /
  // r-no-future-time / r-visit-count / r-low-ending 六条按场景门控的业务红线整层失效
  // （生产实证：「今日交咗部車畀客戶」-> unknown）。
  if (/交車|交车|交咗|交左|提車|提车|交付|攞車|攞车|選號|选号|驗車|验车|裝卡|装卡|通關|通关|過戶|过户|落定|搞掂|到店|諮詢|咨询|辦理|办理|簽約|签约|委託|委托/.test(text)) return 'business';

  if (vision?.extracted?.status) return 'business';
  if (vision?.type === 'screenshot') return 'business';
  if (vision?.type === 'car') return 'car';
  if (vision?.type === 'poster') return 'greeting';

  if (/收工|聚餐|食飯|食饭|飲茶|饮茶|公司|團隊|团队|日常|開會|开会|飯局|饭局/.test(text)) return 'daily';
  if (/兩地牌|两地牌|粵Z|粤Z|口岸|港車北上|港车北上|科普|知識|知识/.test(text)) return 'edu';
  if (/RX|埃爾法|埃尔法|Alphard|Models?d|Tesla|特斯拉|車源|车源/.test(text)) return 'car';
  if (/(?:三十|四十|30|40)系/.test(text)) return 'car';
  if (/早安|早晨|早上|路上見|路上见/.test(text)) return 'greeting';

  return 'unknown';
}

/**
 * 信息缺口检测
 * 原实现只在「完全无输入」时才追问，而 internal 也是 if(!hasText)，两者互斥 -> 死代码。
 * 现改为要素级：有输入但关键要素缺失同样要追问。
 */
export function detectMissing({ scene, text, vision }) {
  const missing = [];
  const hasText = !!(text && text.trim());
  const ve = vision?.extracted || {};

  switch (scene) {
    case 'business':
      if (!hasText && !ve.status) missing.push('業務關鍵狀態（如：選號完成 / 驗車通過 / 裝卡通關）');
      // 口岸是本次成交的关键事实（2026-10-05 明哥确认：绝不虚构）——
      // 输入/图片都没有时，宁可追问也不让模型自己「配」一个。
      // 【2026-10-05 口语补漏】「辦牌／搞掂張牌」这类不含「兩地牌」三个字的说法
      // 同样是办牌业务，之前全部漏问。
      if (/兩地牌|两地牌|裝卡|装卡|選號|选号|驗車|验车|通關|通关|過關|过关|辦牌|办牌|張牌|张牌/.test(text)
        && !ve.ports?.length
        && !AVAILABLE_PORTS.some(p => text.includes(p))) {
        missing.push('本次口岸（蓮塘 / 深圳灣 / 沙頭角 / 港珠澳大橋；尚未確定就寫「未定」）');
      }
      break;
    case 'car':
      if (!ve.cars?.length && !/三十系|四十系|30系|40系|RX|埃爾法|埃尔法|Alphard|Model/.test(text)) {
        missing.push('車型或系別（車圖未識別到）');
      }
      break;
    case 'greeting':
      // 星期由系统注入，无需追问
      break;
    case 'festival':
      if (!hasText) missing.push('想表達的氛圍或角度');
      break;
    case 'daily':
      if (!hasText) missing.push('今日事件（如：聚餐地點 / 收工心情）');
      break;
    case 'edu':
      if (!hasText) missing.push('想科普的具體話題（如：粵Z方向 / 港車北上對比）');
      break;
    default:
      if (!hasText) missing.push('今日想發的內容（場景 / 事件）');
  }
  return missing;
}

// ===== 知識庫檢索（關鍵詞命中）=====
export function retrieveKnowledge(text, vision) {
  const corpus = [text, ...(vision?.extracted?.cars || []), ...(vision?.extracted?.ports || [])]
    .filter(Boolean).join(' ');
  const hits = [];
  for (const k of KNOWLEDGE_BASE) {
    const score = k.keywords.reduce((s, kw) => s + (corpus.includes(kw) ? 1 : 0), 0);
    if (score > 0) hits.push({ ...k, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 3);
}

export function isImageMime(mime) {
  return IMG_TYPES.includes((mime || '').toLowerCase());
}

// 多图合并（2026-10-04 审核采纳）：朋友圈晒单常为「主图 + 群聊截图」多图。
// 合并规则：类型按信息密度取 screenshot > car > poster > other；
// 车型/口岸去重并集；状态取第一个非空；hasPII 任一为真即为真；全降级才算降级。
export function mergeVisions(visions) {
  const valid = (visions || []).filter(v => v && !v._degraded && !v._unsupported);
  if (!valid.length) {
    const first = (visions || []).find(v => v) || null;
    return first; // 全降级：保留第一个（含降级标记）供前端如实提示
  }
  const rank = { screenshot: 3, car: 2, poster: 1 };
  const byRank = [...valid].sort((a, b) => (rank[b.type] || 0) - (rank[a.type] || 0));
  const primary = byRank[0];
  const cars = [...new Set(valid.flatMap(v => v.extracted?.cars || []))];
  const ports = [...new Set(valid.flatMap(v => v.extracted?.ports || []))];
  const status = valid.map(v => v.extracted?.status).find(Boolean) || '';
  const hasPII = valid.some(v => v.extracted?.hasPII === true);
  return {
    type: primary.type,
    description: valid.map(v => v.description).filter(Boolean).join('；').slice(0, 300),
    extracted: { cars, ports, status, hasPII },
    _multiImage: valid.length > 1
  };
}
