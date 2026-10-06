// 软评分（§6.2-E / §11.8）：与生成器解耦的独立评审调用
//
// 【评分尺度 v2（2026-10-04）】调研结论：LLM 评审用 0-100 细分度噪声大、
// 一致性差；粗粒度有序档位（1-5）配锚点描述更稳定。每维输出 1-5 档整数，
// 映射回 0-100（(档-1)*25）保持权重（高级感40/新意30/调性30），管线与前端接口无感。
// 兼容处理：模型若仍输出 0-100，自动折算成 1-5 档。
//
// 【及格线标定 v3（2026-10-06 审计修正）】70 分线与 5 档锚点错配：
// 档位映射只有 0/25/50/75/100 五档，「良好但有瑕疵」的典型评分 4/3/4
// 加权后 = 68 分 < 70 —— 生产实测 58% 版本低于 70，每次生成白白触发
// 约 4 次反思改写（烧 token、拖时延，改写稿还常把三版结构冲散）。
// 锚点语义对齐：4 档 =「达标，有小瑕疵但不影响发布」= 75 分；
// 3 档 =「可接受但平庸」= 50 分。及格线取两者之间的 60：
// 4/3/4（68）放行，3/3/3（50）仍拦截。
//
// 解耦方式：评审是独立的一次 LLM 调用，与生成调用无共享上下文，system 提示
// 立场为「独立评审、与作者无关」。如需进一步解耦，可在 .env 设 SCORER_MODEL
// 指定另一个模型做评审（例如生成用 flash、评审用 pro）。
//
// 健壮性约定：评审失败/解析失败一律返回 skipped，绝不阻断文案产出 ——
// 软评分是质量增强层，不是红线层（红线由 ruleEngine 硬规则负责）。

import { llmChat, llmKeyUsable } from '../llm/client.js';

export const SOFT_WEIGHTS = { premium: 0.4, novelty: 0.3, tone: 0.3 };
// 及格线 60（标定理由见文件头「及格线标定 v3」）：4/3/4=68 放行，3/3/3=50 拦截
export const SOFT_PASS = 60;
export const SCALE_MAX = 5;

// 档位 -> 0-100（1档=0，5档=100）
const dimToPct = d => (d - 1) * 25;

// 从可能带噪音的输出中提取 JSON 评分（LLM 偶尔会包裹 markdown 或加说明文字）
// 输出统一为：{ premium, novelty, tone }（0-100，供加权）+ dims（原始 1-5 档，供展示）
export function parseScoreJson(raw) {
  const cleaned = String(raw || '').replace(/```json\n?|\n?```/g, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    // 1-5 档为主；>5 视为旧版 0-100 输出，折算档位（80→4档、65→3档…）
    const toDim = x => {
      const n = Number(x);
      if (!Number.isFinite(n)) return null;
      // 【修复 2026-10-06 审计】6-19 既非合法 1-5 档、也不像 0-100（评审被要求从严，
      // 真给 10/100 的概率极低，多为噪声输出）——原先 n/20 四舍五入后折叠成 1 档=0 分，
      // 直接把总分拖穿。判 null → 整条 skipped 优雅降级，不冤枉文案。
      if (n > SCALE_MAX && n < 20) return null;
      const d = n > SCALE_MAX ? Math.round(n / 20) : Math.round(n);
      return Math.max(1, Math.min(SCALE_MAX, d));
    };
    const dp = toDim(j.premium), dn = toDim(j.novelty), dt = toDim(j.tone);
    if (!dp || !dn || !dt) return null;
    return {
      premium: dimToPct(dp),
      novelty: dimToPct(dn),
      tone: dimToPct(dt),
      dims: { premium: dp, novelty: dn, tone: dt },
      reason: String(j.reason || '').slice(0, 80)
    };
  } catch {
    return null;
  }
}

/**
 * 评分一版文案
 * @param {object} meta { scene }（angle/tone 已随三版机制废除）
 * @param {object} io   { llm, model } —— llm 供测试注入，model 可覆盖评审模型
 * @returns {Promise<{skipped:boolean, total:number|null, premium?:number, novelty?:number, tone?:number, dims?:object, reason?:string}>}
 */
export async function scoreVersion(text, meta = {}, io = {}) {
  if (!llmKeyUsable() && !io.llm) return { skipped: true, total: null };
  const call = io.llm || llmChat;
  const model = io.model || (process.env.SCORER_MODEL || undefined);

  const prompt = `你是独立的朋友圈文案评审，与文案作者无任何关系，从严评审、宁低勿高。不受辞藻华丽程度影响，只按以下标准打分。

【评审对象】场景：${meta.scene}
【文案】
${text}

【评分（每维 1-5 档整数，档位含义）】
5 = 直接纳用：明显好，挑不出实质问题
4 = 良好：达标，有小瑕疵但不影响发布
3 = 中等：可接受，但平庸处明显（措辞套路/节奏平/不出彩）
2 = 差：有硬伤（堆砌、生硬书面腔、跑题、像广告）
1 = 不可用

【三个维度】
- premium 高级感：克制指「无废话、不堆砌、不升华」，与长度无关——短而信息完整（事件+细节或观点）= 高档，长而废话 = 低档，长度本身不评分。【低档反模式】①堆砌形容词/多个感叹号/网络热词/微商口号 ②伪留白碎片句（如「車頭一道光。門縫一聲。」）③敷衍收尾（如「就係咁多」）④句句堆金句 ⑤脑补客户动作/停顿/台词/表情（如「靜咗幾秒。然後一句：『得。』」——导演腔）⑥【2026-10-04 明哥否决】流水账：只罗列结果没有血肉（像日记「今天晴，做了什么」）⑦信息稀薄：有结果但无任何具体细节或成句观点。高档 = 每句语义完整、信息密度合适、细节有指向、平实收尾偶有点睛
- novelty 新意：与 AI 通用套路（励志金句、鸡汤转折、万能形容词）或本次同批其他版本雷同 = 低档；与品牌官方示例结构同构但内容是本次真实事实 = 正常（品牌语感正应如此），不扣分
- tone 调性：是否符合场景要求（晒单须完成态、早安/节日不得带销售、科普须准确）与香港粤语书写的自然度；普通话书面腔、翻译腔 = 低档；【硬要求】出现客户姓名/称呼（陳生/王先生等，图中提取的）= 直接最低档；群消息被当作事件本身转述 = 低档（引用群内短反应作细节且逐字来自截图 = 正常）；【硬要求】编造未来时间节点（下週/明天/星期幾等，输入与图均未提）= 直接最低档——时间承诺必须来自用户

只输出 JSON（不要其他文字）：
{"premium":<1-5>,"novelty":<1-5>,"tone":<1-5>,"reason":"<30字内指出最主要问题，达标写「达标」>"}`;

  try {
    const raw = await call([
      { role: 'system', content: '你是严格独立的朋友圈文案评审，只输出 JSON，绝不美化分数。' },
      { role: 'user', content: prompt }
    ], {
      max_tokens: 4000, // 给足冗余（max_tokens 是上限不计费；关闭推理后实际用量远低于此）
      temperature: 0.2, // 评审要稳定，不要创造性
      model,
      label: 'score'
    });
    const s = parseScoreJson(raw);
    if (!s) return { skipped: true, total: null, reason: '评分解析失败' };
    const total = Math.round(s.premium * SOFT_WEIGHTS.premium + s.novelty * SOFT_WEIGHTS.novelty + s.tone * SOFT_WEIGHTS.tone);
    return { skipped: false, ...s, total };
  } catch {
    // 评审调用失败不阻断产出
    return { skipped: true, total: null, reason: '评审调用失败' };
  }
}
