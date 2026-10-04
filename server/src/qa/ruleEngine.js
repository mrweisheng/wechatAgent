// 硬规则引擎
// 语义：violations（阻断） + warnings（提示）分离；checked 如实反映实际执行的规则数。
//
// 语域约定（重要）：发布渠道为微信私域朋友圈，非公开广告投放。
// 因此绝对化用语不阻断，仅作 advisory 提示。
//
// ctx 参数（可选）：
//   { scene, userText, vision, imagePlan }
//     scene      —— 场景，用于场景相关规则（早安禁硬广 / 晒单完成态 / 虚构检测）
//     userText   —— 用户原始输入，用于虚构检测（文案内容须能在原文找到依据）
//     vision     —— 视觉识别结果，extracted.hasPII 用于打码提示
//     imagePlan  —— 配图建议，用于打码提示校验

import {
  HARD_RULES, CLICHE_BLACKLIST, POLITICAL_TERMS, ABSOLUTE_TERMS,
  IN_PROGRESS_TERMS, PROMO_TERMS,
  FABRICATION_PATTERNS, AVAILABLE_PORTS, DRAMA_MARKERS
} from '../knowledge/corpus.js';

// ---- 价格 / 里程 / 车牌（繁简双写，文档 §5.2 一票否决）----
// 【修复 2026-10-04】阿拉伯数字直跟「萬/万」的写法（88萬 / 88 萬 / 8萬公里）
// 原先全部漏网——车源输入常带阿拉伯数字价格，LLM 回显时正是这种写法。
const PRICE_LIKE = /(?:[¥$￥]\s*\d{1,3}(?:[,，]\s*\d{3})+|[¥$￥]\s*\d+\s*起|\d+(?:\.\d+)?\s*[萬万]|\d{5,}\s*(?:元|塊|块|蚊|RMB|HKD)|十萬|百萬|千萬|十万|百万|千万|[一二三四五六七八九十百千万]{1,3}萬|[一二三四五六七八九十百千万]{1,3}万)/;
const MILEAGE_LIKE = /[\d,]+\s*[萬万]?\s*(?:公里|km|KM|千米|英里)/;
// 真实车牌：粤Z·A1234 / 粤B12345 / 粵Z 88888（内地牌=汉字+字母+5位；港牌=2字母+4位）
const PLATE_LIKE = /[粤粵][A-Z]\s*[·•]?\s*[A-Z0-9]{4,5}|[A-Z]{2}\s*[·•]?\s*\d{4}/;

// 否定语境：可出现在口岸名前后（「早已唔受理」「已停批」）
// 否定语境判定
// 【重要】不能用「邻近否定词」启发式 —— 上一版用 ±12 字窗口 + 宽松否定词表，
// 导致「皇崗已經可以辦理」「冇錯，皇崗受理中」等真实违规被豁免放行。
// 现改为：必须是**明确的白名单停批表述**，且否定词与办理动词须落在同一分句内。
// 否定词表刻意收窄：已 / 搞掂咗 / 冇 在本语境不构成否定。
const STOPPED_PHRASES = [
  '早已唔受理', '早已不受理', '早已停辦', '早已停办', '早停批',
  '已停批', '已停辦', '已停办', '唔再受理', '不再受理',
  '冇受理', '没有受理', '暫停受理', '暂停受理', '停止受理',
  '唔受理', '不受理', '冇開放', '没有开放', '未開放', '未开放',
  '停批咗', '停辦咗', '冇得辦', '冇得办'
];

// 办理动词（用于确认这是「可办理」语境）
const PROCESS_VERB = /(?:可辦|可办|能辦|能办|現辦|现办|受理|辦理|办理|已收|開放|开放|辦好|办好|搞掂|做到|入到牌)/;

function clauseOf(text, index) {
  // 取所在分句（以中英文逗号、句号、分号、换行分隔）
  const start = Math.max(
    text.lastIndexOf('，', index), text.lastIndexOf(',', index),
    text.lastIndexOf('。', index), text.lastIndexOf('；', index),
    text.lastIndexOf('\n', index)
  );
  const endRel = [text.indexOf('，', index), text.indexOf(',', index),
    text.indexOf('。', index), text.indexOf('；', index),
    text.indexOf('\n', index)]
    .filter(x => x !== -1);
  const end = endRel.length ? Math.min(...endRel) : text.length;
  return text.slice(start + 1, end);
}

function isStoppedStatement(text, nameIdx) {
  const clause = clauseOf(text, nameIdx);
  // 白名单停批表述优先命中
  if (STOPPED_PHRASES.some(p => clause.includes(p))) return true;
  return false;
}

export function checkHardRules(text, ctx = {}) {
  const violations = [];
  const warnings = [];
  const evaluated = new Set(); // 记录「已评估」的规则，而非「已触发」
  const { scene, userText = '', vision = null, imagePlan = '' } = ctx;

  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // ---- r-signature：结尾必含 #明哥中港牌 ----
  // 【2026-10-04 明哥确认】业务动态（成交/晒单）场景落款可带一个业务标签：
  // #明哥中港牌 #蓮塘兩地牌（双标签，参考明哥真实朋友圈）。其余场景仍单落款。
  evaluated.add('r-signature');
  const sigTail = scene === 'business'
    ? /#\s*明哥中港牌(\s*#[^\s]{1,20})?\s*$/
    : /#\s*明哥中港牌\s*$/;
  if (!sigTail.test(text)) {
    violations.push({ id: 'r-signature', msg: '缺少落款 #明哥中港牌（需单独成行）' });
  }

  // ---- r-signature-alone：落款单独成行（business 场景允许尾随一个 #业务标签）----
  evaluated.add('r-signature-alone');
  const sigLineOk = l => {
    const rest = l.replace(/#\s*明哥中港牌/, '').trim();
    if (!rest) return true;
    return scene === 'business' && /^#[^\s]{1,20}$/.test(rest);
  };
  const sigLines = lines.filter(l => /#\s*明哥中港牌/.test(l));
  if (sigLines.some(l => !sigLineOk(l))) {
    violations.push({ id: 'r-signature-alone', msg: '落款需单独成行，前面短语另起一行' });
  }

  // ---- r-no-numbers：价格 / 里程 / 车牌 ----
  evaluated.add('r-no-numbers');
  if (PRICE_LIKE.test(text)) violations.push({ id: 'r-no-numbers', msg: '出现价格或大额数字' });
  if (MILEAGE_LIKE.test(text)) violations.push({ id: 'r-no-numbers', msg: '出现里程数字' });
  if (PLATE_LIKE.test(text)) violations.push({ id: 'r-no-numbers', msg: '出现车牌号' });

  // ---- r-no-politics ----
  evaluated.add('r-no-politics');
  const polHit = POLITICAL_TERMS.filter(t => text.includes(t));
  if (polHit.length) violations.push({ id: 'r-no-politics', msg: `涉政内容：${polHit.join('、')}` });

  // ---- r-no-fake-port：皇崗/文錦渡写成可办理 ----
  // 反向表述（早已唔受理 / 已停批）放行 —— 这正是文档 §1 要求的标准谈资口径
  evaluated.add('r-no-fake-port');
  for (const name of ['皇崗', '皇岗', '文錦渡', '文锦渡']) {
    let idx = text.indexOf(name);
    while (idx !== -1) {
      // 只看**同一分句**内的办理动词，避免跨句误判
      const clause = clauseOf(text, idx);
      if (PROCESS_VERB.test(clause) && !isStoppedStatement(text, idx)) {
        violations.push({ id: 'r-no-fake-port', msg: `${name}不得写成可办理` });
        break;
      }
      idx = text.indexOf(name, idx + 1);
    }
  }
  // 反向守卫：出现办理动词但口岸不在白名单且非停批口岸
  const otherPortHit = /([一-龥]{2,4}(?:口岸|關卡|关卡))/.exec(text);
  if (otherPortHit && PROCESS_VERB.test(text)) {
    const name = otherPortHit[1].replace(/口岸|關卡|关卡/, '');
    if (name && !AVAILABLE_PORTS.some(p => name.includes(p))) {
      const idx = text.indexOf(otherPortHit[0]);
      if (!isStoppedStatement(text, idx)) {
        warnings.push({ id: 'r-port-verify', msg: `「${name}」不在可办口岸白名单（深圳灣/蓮塘/沙頭角/港珠澳大橋），请核实` });
      }
    }
  }

  // ---- r-cliche：微商套话黑名单 ----
  evaluated.add('r-cliche');
  const clicheHits = CLICHE_BLACKLIST.filter(t => text.includes(t));
  if (clicheHits.length) violations.push({ id: 'r-cliche', msg: `套话：${clicheHits.join('、')}` });

  // ---- r-sharedan-completed：晒单必须完成态 ----
  if (scene === 'business') {
    evaluated.add('r-sharedan-completed');
    const inProg = IN_PROGRESS_TERMS.filter(t => text.includes(t));
    if (inProg.length) {
      violations.push({ id: 'r-sharedan-completed', msg: `晒单须为完成态，检出进行时表述：${inProg.join('、')}` });
    }
  }

  // ---- r-no-promo-greeting：早安/节日禁硬广 ----
  if (scene === 'greeting' || scene === 'festival') {
    evaluated.add('r-no-promo-greeting');
    const promo = PROMO_TERMS.filter(t => text.includes(t));
    if (promo.length) {
      violations.push({ id: 'r-no-promo-greeting', msg: `早安/节日文案禁止硬广，检出：${promo.join('、')}` });
    }
  }

  // ---- r-no-fabricate：禁止虚构（引号内容/评价词须能在「依据语料」找到出处）----
  // 【修复 2026-10-04】上一版 FABRICATION_PATTERNS 命中即违规、从不回查原文，
  // 导致明哥亲口说「客人好滿意」、文案如实转述反而被拦（错误提示还称「原文无此表述」）。
  // 现改为：评价词命中后必须再验证「依据语料」中确无同样表述才算虚构。
  // 依据语料 = 用户原文 + 视觉识别描述/状态/车型（截图本身就是证据，OCR 引语应放行）。
  // 另：原限制 scene==='business'，但虚构文案在任何场景都属红线，故全场景生效。
  const evidence = [
    userText,
    vision?.description,
    vision?.extracted?.status,
    // 图型为群聊截图时，「群裡有人講話」类叙述有图为证（多图合并场景实测误拦修复）；
    // 字符串需让「群裡.{0,6}話」等叙述模式可命中 evidence
    vision?.type === 'screenshot' ? '群聊截图：群裡有人講話 群組 群内有人说话' : null,
    ...(vision?.extracted?.cars || []),
    ...(vision?.extracted?.ports || [])
  ].filter(Boolean).join(' ');
  const evidenceAll = evidence + ' ' + userText;

  if (evidence) {
    evaluated.add('r-no-fabricate');
    // 全部引号对：直角/弯引号/直引号
    const quotes = [
      ...[...text.matchAll(/[「『]([^」』]{1,200})[」』]/g)].map(m => m[1]),
      ...[...text.matchAll(/[“]([^”]{1,200})[”]/g)].map(m => m[1]),
      ...[...text.matchAll(/['‘]([^'’]{1,200})['’]/g)].map(m => m[1])
    ];
    const unsupported = quotes.filter(q => {
      const norm = q.replace(/[^\w一-龥]/g, '');
      if (norm.length < 3) return false;            // 1~2 字：极短口语，一律放行
      // ≤5 字且不含评价/情感动词 -> 视为群聊短应答（搞掂/冇問題/OK咁/多謝）
      const isShortReply = norm.length <= 5 && !FABRICATION_PATTERNS.some(p => new RegExp(p).test(q));
      if (isShortReply) return false;
      return !evidence.includes(q) && !evidence.includes(norm);
    });
    // 独立必查，不再 else if 短路；命中词若在依据语料同样出现（含正则类模式），不算虚构。
    // 「群裡…話」这类叙事模式若落在已证实引语的范围内（引语本身可在截图/原文找到），
    // 叙述框架同样视为有依据 —— 拦的是虚构引语，不是转述格式。
    const supportedSpans = [...text.matchAll(/[「『“]([^」』”]{1,200})[」』”]/g)]
      .filter(m => {
        const q = m[1];
        const norm = q.replace(/[^\w一-龥]/g, '');
        if (norm.length < 3) return false;
        return evidence.includes(q) || evidence.includes(norm);
      })
      .map(m => ({ start: m.index, end: m.index + m[0].length }));
    const spanCovered = (idx, len) => supportedSpans.some(s => idx < s.end && idx + len > s.start);
    const fabHit = FABRICATION_PATTERNS.filter(p => {
      const re = new RegExp(p);
      const m = re.exec(text);
      if (!m) return false;
      if (re.test(evidence)) return false;
      return !spanCovered(m.index, m[0].length);
    });
    if (unsupported.length) {
      violations.push({ id: 'r-no-fabricate', msg: `引号内容在原始输入中无依据：${unsupported.join('、').slice(0, 60)}` });
    }
    if (fabHit.length) {
      violations.push({ id: 'r-no-fabricate', msg: `疑似虚构客户评价（原文无此表述）：${fabHit.join('、')}` });
    }
  }

  // ---- r-mask-pii：含客户信息的截图须提示打码 ----
  if (vision?.extracted?.hasPII === true) {
    evaluated.add('r-mask-pii');
    if (!/打碼|打码|遮蓋|遮挡|模糊/.test(imagePlan)) {
      violations.push({ id: 'r-mask-pii', msg: '识别到截图含客户信息（头像/昵称/电话/车牌），配图建议须明确打码' });
    }
  }

  // ---- r-no-client-name：客户姓名/称呼不写入文案（2026-10-04 明哥硬要求，阻断）----
  // 群截图里能提取到客户姓什么/叫什么，也一律不进文案，用「客戶」「一對夫婦」等泛称。
  // 用户输入中自己写的称呼视为用户的选择，放行。
  // 检测：从视觉描述收集「X生/X太/X小姐/X先生/X女士/X老闆」类称呼 token，
  // 文案出现且不在用户输入中 → 拦截。无视觉输入时不评估。
  if (vision?.description) {
    evaluated.add('r-no-client-name');
    const NAME_TOKEN = /[一-龥](?:生|太|姐)(?![一-龥])|[一-龥](?:小姐|先生|女士|老闆|老板)/g;
    const srcTokens = [...new Set(String(vision.description).match(NAME_TOKEN) || [])];
    const leaked = srcTokens.filter(t => {
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(esc).test(text) && !new RegExp(esc).test(userText);
    });
    if (leaked.length) {
      violations.push({
        id: 'r-no-client-name',
        msg: `文案出现客户称呼：${leaked.join('、')} —— 图中提取的姓名/称呼不得写入（即使截图可见），请用「客戶」「一對夫婦」等泛称`
      });
    }
  }

  // ---- r-no-future-time：未来时间节点须有来源（2026-10-04 明哥硬要求，阻断）----
  // 「下週裝卡」这类具体时间承诺若非来自用户文字/图片，就是编造——
  // 会变成客户手里的预期，不兑现即纠纷。后续步骤可讲，但不带时间。
  // 检测：文案出现未来时间表达、且用户文字与视觉识别中都没有 → 拦截。
  // （仅 business/car 场景：早安的「星期X」是今天，节日无此风险）
  if (scene === 'business' || scene === 'car') {
    evaluated.add('r-no-future-time');
    const FUTURE_TIME = /下週|下周|下星期|下個月|下个月|聽日|听日|明日|明天|後日|后天|月底|月尾|月初|年底|[0-9一二三四五六七八九十]+月[0-9一二三四五六七八九十]+[日號号]|星期[一二三四五六日天]|禮拜[一二三四五六日天]|礼拜[一二三四五六日天]/g;
    const mentioned = [...new Set(String(text).match(FUTURE_TIME) || [])];
    const ungrounded = mentioned.filter(t => !evidenceAll.includes(t));
    if (ungrounded.length) {
      violations.push({
        id: 'r-no-future-time',
        msg: `未来时间节点须来自你的文字或图片信息，不得编造：${ungrounded.join('、')} —— 未提时间可用「之後仲有裝卡」这类不带时间的说法`
      });
    }
  }

  // ---- r-port-unverified：口岸须与本次业务一致（仅提示）----
  // 实测发现：模型会从知识库替本次成交「配」一个口岸（如凭空写蓮塘）。
  // 口岸是本次成交的具体事实，与实际不符即事故。通用罗列（≥3 个口岸）视为介绍，不提示。
  if (scene === 'business') {
    evaluated.add('r-port-unverified');
    const portsMentioned = AVAILABLE_PORTS.filter(p => text.includes(p) && !evidenceAll.includes(p));
    const distinct = portsMentioned.filter(p => !portsMentioned.some(o => o !== p && o.includes(p)));
    if (distinct.length && distinct.length < 3) {
      warnings.push({
        id: 'r-port-unverified',
        msg: `口岸「${distinct.join('、')}」未在你提供的文字/图片中出现，请核实与本次业务实际口岸一致`
      });
    }
  }

  // ---- r-absolute-advisory：绝对化用语（仅提示，不阻断）----
  evaluated.add('r-absolute-advisory');
  const absHit = ABSOLUTE_TERMS.filter(t => text.includes(t));
  if (absHit.length) {
    warnings.push({
      id: 'r-absolute-advisory',
      msg: `绝对化用语：${absHit.join('、')}（私域口语可接受，若对外公开发布请注意广告法第九条）`
    });
  }

  // ---- r-drama：导演腔镜头（仅提示，不阻断）----
  // 【明哥 2026-10-04 二轮否决】「靜咗幾秒。然後一句：『得。』」被评「尴尬」——
  // 停顿/台词/表情是 AI 脑补的电影手法，且属虚构场景（§5.8）。
  // 因用户输入可能真的提到该动作（极少数），做 warning 提醒核实而非硬拦；
  // 生成端的根治靠 TONE_ANTI_PATTERNS 反例 + 评审低档。
  evaluated.add('r-drama');
  const dramaHit = DRAMA_MARKERS.filter(m => text.includes(m));
  if (dramaHit.length) {
    warnings.push({
      id: 'r-drama',
      msg: `导演式镜头描写：${dramaHit.slice(0, 3).join('、')} —— 停顿/台词/表情多为脑补（§5.8 真实性），除非用户输入确有此事，否则请删除`
    });
  }

  // ---- 如实报告：checked = 已评估规则数（不再虚报 HARD_RULES.length）----
  const declared = HARD_RULES.map(r => r.id);
  const unimplemented = declared.filter(id => !evaluated.has(id));

  return {
    pass: violations.length === 0,
    violations,
    warnings,
    checked: evaluated.size,
    declared: declared.length,
    unimplemented
  };
}

export { HARD_RULES };
