// 硬规则引擎
// 语义：violations（阻断） + warnings（提示）分离；checked 如实反映实际执行的规则数。
//
// 语域约定（重要）：发布渠道为微信私域朋友圈，非公开广告投放。
// 因此绝对化用语不阻断，仅作 advisory 提示。
//
// ctx 参数（可选）：
//   { scene, userText, vision }
//     scene      —— 场景，用于场景相关规则（早安禁硬广 / 晒单完成态 / 虚构检测）
//     userText   —— 用户原始输入，用于虚构检测（文案内容须能在原文找到依据）
//     vision     —— 视觉识别结果，type==='screenshot' 决定群聊内容是否有据

import {
  HARD_RULES, CLICHE_BLACKLIST,
  IN_PROGRESS_TERMS, PROMO_TERMS,
  FABRICATION_PATTERNS, AVAILABLE_PORTS, DRAMA_MARKERS
} from '../knowledge/corpus.js';

// ---- 价格 / 里程 / 车牌（繁简双写，文档 §5.2 一票否决）----
// 【修复 2026-10-04】阿拉伯数字直跟「萬/万」的写法（88萬 / 88 萬 / 8萬公里）
// 原先全部漏网——车源输入常带阿拉伯数字价格，LLM 回显时正是这种写法。
// 【修复 2026-10-05】「千萬/千万」作副词（如「千萬唔好急」）会被误判为价格：
//   中文数字金额后若紧跟否定/意愿副词（唔/不/別/别/咪/勿/要），不判为价格。
const PRICE_LIKE = /(?:[¥$￥]\s*\d{1,3}(?:[,，]\s*\d{3})+|[¥$￥]\s*\d+\s*起|\d+(?:\.\d+)?\s*[萬万]|\d{5,}\s*(?:元|塊|块|蚊|RMB|HKD)|[一二三四五六七八九十百千万]{1,4}[萬万](?![唔不別别咪勿要]))/;
const MILEAGE_LIKE = /[\d,]+\s*[萬万]?\s*(?:公里|km|KM|千米|英里)/;
// 真实车牌：粤Z·A1234 / 粤B12345 / 粵Z 88888（内地牌=汉字+字母+5位；港牌=2字母+4位）
const PLATE_LIKE = /[粤粵][A-Z]\s*[·•]?\s*[A-Z0-9]{4,5}|[A-Z]{2}\s*[·•]?\s*\d{4}/;

// 交车/交付语境：r-car-delivery-scope 只在此语境下适用（避免误伤正常选号/验车帖）
const CAR_DELIVERY_INPUT = /交車|交车|提車|提车|交付|交咗部|交左部/;

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

// 无引号转述框架：命中只说明「有转述动作」，是否虚构取决于**转述内容**有无出处。
// 框架字样本身极少逐字出现在用户原文（用户写「客人好滿意」，文案写「客人話好滿意」），
// 直接回查框架字样必误拦亲口转述 —— 须回查框架之后、同一分句内的内容：
// 能在依据语料中找到（整句，或任一 ≥2 字连续片段）即放行；完全无出处才判虚构。
const NARRATIVE_FRAMES = new Set([
  '客人話', '客户话', '客話', '客戶話', '佢話', '佢講', '他话', '他講',
  '表態', '表态', '答話', '答话', '話晒', '话晒', '大讚', '大赞', '激讚', '激赞',
  '一句『', '一句「'
]);

function tailGrounded(text, index, len, evidence) {
  const endRel = [text.indexOf('，', index), text.indexOf(',', index),
    text.indexOf('。', index), text.indexOf('；', index), text.indexOf('\n', index)]
    .filter(x => x !== -1);
  const end = endRel.length ? Math.min(...endRel) : text.length;
  const tail = text.slice(index + len, end).replace(/[^\w一-龥]/g, '');
  if (!tail) return false;
  if (evidence.includes(tail)) return true;
  for (let L = 2; L <= tail.length; L++) {
    for (let s = 0; s + L <= tail.length; s++) {
      if (evidence.includes(tail.slice(s, s + L))) return true;
    }
  }
  return false;
}

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
  const { scene, userText = '', vision = null } = ctx;

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
    // 【2026-10-05 明哥反馈后收紧】删除「≤5 字短应答一律放行」豁免——
    // 该豁免本为容忍截图 OCR 漏字，实测成了虚构通道：「可以行得」（4字）、
    // 「搞掂」（2字）这类编造引语全部免检通过。现在任何引语（去标点后非空）
    // 都必须能在「依据语料」（用户原文 + 截图识别结果）里逐字找到，否则即违规。
    const unsupported = quotes.filter(q => {
      const norm = q.replace(/[^\w一-龥]/g, '');
      if (!norm) return false;                      // 纯标点/符号引号，无从查证
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
      if (NARRATIVE_FRAMES.has(p) && tailGrounded(text, m.index, m[0].length, evidence)) return false;
      return !spanCovered(m.index, m[0].length);
    });
    if (unsupported.length) {
      violations.push({ id: 'r-no-fabricate', msg: `引号内容在原始输入中无依据：${unsupported.join('、').slice(0, 60)}` });
    }
    if (fabHit.length) {
      violations.push({ id: 'r-no-fabricate', msg: `疑似虚构客户评价（原文无此表述）：${fabHit.join('、')}` });
    }
  }

  // ---- r-group-screenshot：提及群聊必须以真实上传的群聊截图为据 ----
  // 【2026-10-05 明哥反馈】两次实测翻车：没传图，文案编出「群裡最後一句
  // 『可以行得。』」；传了截图，引用的「搞掂」也不是图里的原文。
  // 规则：文案出现群聊字样时，必须存在有效识别的群聊截图，否则一律违规——
  // 群聊反应/群消息不可能凭空存在。视觉识别降级（_degraded）同样视为无据。
  evaluated.add('r-group-screenshot');
  const GROUP_MARKERS = /群裡|群里|群組|群组|群内|群內|微信群|業務群|业务群|服務群|服务群|客戶群|客户群|聊天記錄|聊天记录/;
  const hasScreenshot = !!(vision && !vision._degraded && vision.type === 'screenshot');
  if (GROUP_MARKERS.test(text) && !hasScreenshot) {
    violations.push({
      id: 'r-group-screenshot',
      msg: '文案提到群聊，但你没有提供群聊截图——群聊内容（群里反应/群消息）只能来自真实截图，未提供时一律不提群'
    });
  }

  // ---- r-no-client-name：客户姓名/称呼不写入文案（2026-10-04 明哥硬要求，阻断）----
  // 群截图里能提取到客户姓什么/叫什么，也一律不进文案，用「客戶」「一對夫婦」等泛称。
  // 用户输入中自己写的称呼视为用户的选择，放行。
  // 检测：从视觉描述收集「X生/X太/X小姐/X先生/X女士/X老闆」类称呼 token，
  // 文案出现且不在用户输入中 → 拦截。无视觉输入时不评估。
  if (vision?.description) {
    evaluated.add('r-no-client-name');
    const NAME_TOKEN = /[一-龥](?:生|太|姐)(?![一-龥])|[一-龥](?:小姐|先生|女士|老闆|老板)/g;
    // 非称呼的常见词（避免「學生/醫生/發生/養生」等被当作客户称呼误拦）
    const NON_NAME = new Set([
      '學生', '学生', '醫生', '医生', '先生', '太太', '小姐', '女士', '老闆', '老板',
      '後生', '后生', '發生', '发生', '產生', '产生', '陌生', '女生', '男生', '師生', '师生',
      '一生', '人生', '今生', '餘生', '余生', '衛生', '卫生', '養生', '养生', '留學生', '留学生'
    ]);
    const srcTokens = [...new Set(String(vision.description).match(NAME_TOKEN) || [])]
      .filter(t => !NON_NAME.has(t));
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

  // ---- r-port-unverified：口岸须与本次业务一致（阻断，2026-10-05 明哥确认）----
  // 实测发现：模型会从知识库/风格锚替本次成交「配」一个口岸（如凭空写蓮塘）。
  // 口岸是本次成交的具体事实，与实际不符即事故——明哥口径：没有明确信息就追问
  // 或拦截，绝不自行补。两类放行：
  //   ① 通用罗列（≥3 个口岸）视为介绍，不拦；
  //   ② 用户输入本身说了「各個口岸／每個口岸的都有」——此时文案罗列白名单口岸
  //      是如实转述，不算虚构（2026-10-05 明哥口径补充）。
  if (scene === 'business') {
    evaluated.add('r-port-unverified');
    const introListing = /各[個个]口岸|每[個个]口岸|所有口岸/.test(evidenceAll);
    const portsMentioned = AVAILABLE_PORTS.filter(p => text.includes(p) && !evidenceAll.includes(p));
    const distinct = portsMentioned.filter(p => !portsMentioned.some(o => o !== p && o.includes(p)));
    if (distinct.length && distinct.length < 3 && !introListing) {
      violations.push({
        id: 'r-port-unverified',
        msg: `口岸「${distinct.join('、')}」未在你提供的文字/图片中出现——口岸属本次业务关键事实，不得虚构；未提供就删去口岸表述`
      });
    }
  }

  // ---- r-absolute-advisory：已删除（2026-10-05）----
  // ABSOLUTE_TERMS 全链路无消费方（不阻断/不评分/不触发重写），连同前端提示整体移除。

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

  // ---- r-car-delivery-scope：純購車交車帖不得添加兩地牌後續（2026-10-05 明哥業務反饋，阻斷）----
  // 交車＝車輛交付，默認純購車，交付即完結；裝卡/選號/驗車屬兩地牌，除非用戶輸入/圖片確實提到。
  // 仅当本次确实是「交车/交付」语境时才套用（選號/驗車本身是正常业务帖，不能误伤）
  const deliveryCtx = CAR_DELIVERY_INPUT.test(userText)
    || /交車|交车|交付|提車|提车/.test(String(vision?.extracted?.status || ''));
  if ((scene === 'business' || scene === 'car') && deliveryCtx) {
    evaluated.add('r-car-delivery-scope');
    // 只拦「装卡」——它是用户明确指出的两地牌后续环节；验车/选号可能在交付前发生，不误伤
    const followUp = ['裝卡', '装卡'];
    const hit = followUp.filter(t => text.includes(t));
    const grounded = /兩地牌|两地牌|牌/.test(evidenceAll) || followUp.some(t => evidenceAll.includes(t));
    if (hit.length && !grounded) {
      violations.push({
        id: 'r-car-delivery-scope',
        msg: `交車（純購車）交付即完結，不應添加兩地牌後續：${hit.join('、')}——裝卡/選號/驗車屬兩地牌環節`
      });
    }
  }

  // ---- r-visit-count：不寫客戶到場次數（2026-10-05 明哥反饋，僅提示）----
  // 【2026-10-05 审计修正】原正则只认「兩隻手數／出現…次數／到場…次數」三种字面，
  // 实测漏放率极高：「出現咗兩次」「嚟咗兩次」「到場三次」「一共出現兩次」全部放行。
  // 现在补充「客户/佢/我哋… + 数量词 + 次」的通用计数句式。
  // 保持 advisory（仅提示）：中文「次数」有正常用法（如「第二次交車」指第二辆车），
  // 升为阻断会误伤，故按窄匹配补漏而非全面拦截。
  if (scene === 'business' || scene === 'car') {
    evaluated.add('r-visit-count');
    const CN_NUM = '一|兩|两|三|四|五|六|七|八|九|十';
    const ACTOR = '客戶|客户|佢|他|她|買家|买家|車主|车主';
    const visitCount = new RegExp([
      // 原三种
      `(?:兩隻手|两只手)(?:數|数)`,
      `出現[^。\\n]{0,10}次數`,
      `到場[^。\\n]{0,8}次數`,
      // 补漏：主体 + 「数量词 + 次」
      `(?:${ACTOR})[^。\\n]{0,12}?(?:${CN_NUM}|\\d)\\s*次`,
      // 补漏：「一共/總共/前後 + 数量词 + 次」
      `(?:一共|總共|总共|前後|前后|前后)[^。\\n]{0,6}?(?:${CN_NUM}|\\d)\\s*次`
    ].join('|')).test(text);
    if (visitCount) {
      warnings.push({ id: 'r-visit-count', msg: '不要寫客戶到場次數（買家甚至唔使親自到場），建議刪除具體次數' });
    }
  }

  // ---- r-low-ending：交車/業務帖收尾不得用口頭禪/掃興告別（2026-10-05 明哥反饋，僅提示）----
  if (scene === 'business' || scene === 'car') {
    evaluated.add('r-low-ending');
    const tail = String(text).trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      .filter(l => !/#\s*明哥中港牌/.test(l)).pop() || '';
    if (/路上見|路上见|各自返程|各自返家/.test(tail)) {
      warnings.push({ id: 'r-low-ending', msg: `收尾「${tail}」偏低／掃興，交車帖建議用高級祝福或關係、前路意象` });
    }
  }

  // ---- r-geo-hk：公司本部位於香港，不寫「客戶從香港過來」（2026-10-05 明哥反饋，僅提示）----
  evaluated.add('r-geo-hk');
  if (/從香港過來|从香港过来|從香港趕來|从香港赶来/.test(text)) {
    warnings.push({ id: 'r-geo-hk', msg: '公司本部位於香港，香港客戶是本地客戶：不應寫「客戶從香港過來／趕來」' });
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
