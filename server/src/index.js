// 主入口：Express 服务 + 路由 + 静态前端
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { channelStatus } from './search/channels.js';
import { classifyImage, routeScene, detectMissing, isImageMime, mergeVisions } from './perception/vision.js';
import { runPipeline } from './generation/pipeline.js';
import { INTEL_TOPICS, INTEL_GUIDELINES, INTEL_RECENCY } from './knowledge/corpus.js';
import { llmKeyUsable } from './llm/client.js';
import {
  addHistory, recentHistory,
  recordFeedback, addCorrection, findCorrections
} from './memory/store.js';
import { startIntelCron, runIntelOnce } from './cron/intel.js';
import { ingestIntel, intelStats, loadIntel } from './ingest/intelIngest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 4, fieldSize: 2 * 1024 * 1024 }
});

// 常数时间比较（推送 token 等密钥比对，防时序侧信道；先散列归一长度）
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 包装 async 路由：Express 4 不捕获 promise rejection，否则进程会崩
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- 简单失败限流（防推送 token 暴力尝试，无外部依赖）----
// 按 IP 记录 401 失败次数，窗口内超限直接 429；成功后清零。
// 反向代理部署时所有请求同源 IP，属已知局限（单用户场景可接受，见 README）。
const authFails = new Map();
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX_FAILS = 10;
function failRateLimit(req, res, next) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  // 防内存无界增长：超过阈值时清理已过期窗口（长期运行不被大量一次性失败 IP 撑大）
  if (authFails.size > 1000) {
    for (const [k, v] of authFails) if (v.until <= now) authFails.delete(k);
  }
  const rec = authFails.get(ip);
  if (rec && rec.until > now && rec.count >= RL_MAX_FAILS) {
    res.set('Retry-After', Math.ceil((rec.until - now) / 1000));
    return res.status(429).json({ ok: false, error: '尝试过于频繁，请稍后再试' });
  }
  res.on('finish', () => {
    if (res.statusCode === 401) {
      const r = authFails.get(ip);
      if (!r || r.until <= now) {
        authFails.set(ip, { count: 1, until: now + RL_WINDOW_MS });
      } else {
        r.count++;
      }
    } else if (res.statusCode === 200) {
      authFails.delete(ip);
    }
  });
  next();
}

// ---- 生成接口限流（2026-10-06 审计 P1）----
// /api/generate 是烧钱入口（单次请求 = 母版 + 改写 + 评审 + 反思多轮 LLM 调用），
// 公网暴露无限制会被刷爆额度。按 IP 计次，默认 30 次/小时（GENERATE_RATE_LIMIT 可调）。
// 反向代理部署时所有请求同源 IP，属已知局限（与 failRateLimit 同口径，见 README）。
const genHits = new Map();
const GEN_WINDOW_MS = 60 * 60 * 1000;
const GEN_MAX = Math.max(1, Number(process.env.GENERATE_RATE_LIMIT) || 30);
function genRateLimit(req, res, next) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  // 防内存无界增长：超过阈值时清理已过期窗口
  if (genHits.size > 1000) {
    for (const [k, v] of genHits) if (v.until <= now) genHits.delete(k);
  }
  const rec = genHits.get(ip);
  if (rec && rec.until > now && rec.count >= GEN_MAX) {
    res.set('Retry-After', Math.ceil((rec.until - now) / 1000));
    return res.status(429).json({ ok: false, error: '生成过于频繁，请稍后再试' });
  }
  if (!rec || rec.until <= now) genHits.set(ip, { count: 1, until: now + GEN_WINDOW_MS });
  else rec.count++;
  next();
}

// ---- 公开健康检查（不含敏感信息）----
app.get('/api/healthz', (req, res) => {
  res.json({ ok: true, llm: llmKeyUsable() });
});

// ---- 完整健康检查：渠道真实状态 ----
app.get('/api/health', wrap(async (req, res) => {
  res.json({
    ok: true,
    llm: llmKeyUsable(),
    llmNote: llmKeyUsable() ? null : 'DEEPSEEK_API_KEY 未配置或格式可疑，将使用演示文案',
    channels: await channelStatus(),
    intelCron: (process.env.INTEL_ENABLED || '').toLowerCase() === 'true',
    intel: await intelStats()
  });
}));

// ---- 核心生成（管线：生成 → 硬规则 → 软评分 → 去重 → 反思改写）----
app.post('/api/generate', genRateLimit, upload.array('images', 4), wrap(async (req, res) => {
  const text = ((req.body && req.body.text) || '').trim();
  // 多图支持（2026-10-04 审核采纳）：最多 4 张（主图 + 群聊截图等常见组合），
  // 逐张识别后合并要素；全部降级才算降级；非图片文件如实提示
  const files = req.files || [];
  const unsupportedMimes = [];
  let vision = null;
  let degraded = false;

  if (files.length) {
    // 多张并行识别（原先串行，4 张图最长等 4 分钟）
    const visions = await Promise.all(files.map(async f => {
      if (isImageMime(f.mimetype)) return classifyImage(f.buffer, f.mimetype);
      unsupportedMimes.push(f.mimetype);
      return { _unsupported: f.mimetype };
    }));
    vision = visions.length > 1 ? mergeVisions(visions) : visions[0];
    degraded = !!vision?._degraded;
    // 注意：非图片文件标记不能依赖 mergeVisions 的返回值——合并会过滤掉
    // _unsupported/_degraded 项，混合上传时曾把非图片静默吞掉、零提示
  }

  const scene = routeScene({ text, vision });
  const missing = detectMissing({ scene, text, vision });

  // 要素级校验：有输入但关键要素缺失时也要追问（原先仅完全空输入才追问 = 死代码）
  if (missing.length) {
    return res.json({ ok: true, needsMore: true, questions: missing, scene, understood: text || '(仅图)' });
  }

  // LLM 失败直接抛错，由 error handler 转 502 —— 不再返回假文案
  const out = await runPipeline({ text, vision, scene });

  // 历史写库失败不拖累生成结果：LLM 已成功产出，不能因追加历史抛错让前端拿到 500
  try {
    await addHistory({
      scene, text,
      visionType: vision?.type || null,
      versions: out.versions.map(v => ({
        pass: v.hardCheck.pass,
        text: v.text,
        score: v.score?.total ?? null,
        similarity: v.similarity ?? 0
      }))
    });
  } catch (e) {
    console.error('[history] 历史写入失败（不影响生成结果）:', e?.message || e);
  }

  res.json({
    ok: true,
    scene,
    versions: out.versions,
    candidates: out.candidateCount || out.versions.length,
    sceneNotes: out.sceneNotes,
    demo: !!out.demo,
    degraded,
    degradedReason: vision?._degradedReason || null,
    parseFailed: !!out.parseFailed,
    parseNote: out.parseNote || null,
    // 截图含隐私时提醒打码（配图是用户自己的图，文案层无从替他打码，只提示）
    maskReminder: vision?.extracted?.hasPII === true,
    error: out.error || null,
    warning: unsupportedMimes.length
      ? `暂不支持识别 ${unsupportedMimes.join('、')}，已跳过该文件，请转 JPG/PNG`
      : null
  });
}));

// ---- 反馈 ----
app.post('/api/feedback', wrap(async (req, res) => {
  const { kind, payload } = req.body || {};
  if (!kind) return res.status(400).json({ ok: false, error: 'kind required' });
  // 【2026-10-06 审计 P2】payload.text 限长 + 控制字符过滤（与 /api/correction 同口径）：
  // 选中反馈的 text 会进语气资产库并作为 few-shot 注入 prompt——
  // 无上限的超大/带控制字符文本是存储与提示注入双重隐患。
  if (payload && typeof payload.text === 'string') {
    payload = {
      ...payload,
      text: payload.text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, 2000)
    };
  }
  await recordFeedback({ kind, payload });
  res.json({ ok: true });
}));

// ---- 纠错入库 ----
app.post('/api/correction', wrap(async (req, res) => {
  const { original, corrected, type, scene } = req.body || {};
  if (!original || !corrected) return res.status(400).json({ ok: false, error: 'original & corrected required' });
  // 限长 + 过滤控制字符，防止超大 payload 与提示注入载体
  const clean = s => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, 2000);
  await addCorrection({ original: clean(original), corrected: clean(corrected), type, scene });
  res.json({ ok: true });
}));

app.get('/api/corrections', wrap(async (req, res) => {
  res.json({ ok: true, items: await findCorrections(req.query.scene) });
}));

app.get('/api/history', wrap(async (req, res) => {
  res.json({ ok: true, items: await recentHistory(20) });
}));

// ---- 情报线：本地搜索 ----
app.post('/api/intel/run', wrap(async (req, res) => {
  const fresh = await runIntelOnce();
  // runIntelOnce 返回统计对象 { ok, added, received, ... }（不是数组），直接展开
  res.json({ ok: true, ...fresh });
}));

// ---- 情报线：外部 Agent 推送（公开，走独立 token 鉴权 + 失败限流）----
// 见 README「情报推送 API」：外部 Agent 每天搜索后 POST 到这里
app.post('/api/intel/push', failRateLimit, wrap(async (req, res) => {
  const PUSH_TOKEN = (process.env.INTEL_PUSH_TOKEN || '').trim();
  if (!PUSH_TOKEN || /REPLACE/.test(PUSH_TOKEN)) {
    return res.status(503).json({ ok: false, error: '未配置 INTEL_PUSH_TOKEN，推送接口未启用' });
  }
  const token = req.headers['x-push-token'] || (req.body && req.body.token);
  if (!token || !safeEqual(token, PUSH_TOKEN)) {
    return res.status(401).json({ ok: false, error: '推送 token 无效' });
  }
  const r = await ingestIntel(req.body);
  res.status(r.accepted ? 200 : 400).json(r);
}));

app.get('/api/intel/stats', wrap(async (req, res) => {
  res.json({ ok: true, ...await intelStats() });
}));

// ---- 情报线：给外部搜索 Agent 的检索指导（公开静态信息）----
// 外部 Agent 可动态拉取「搜什么 / 怎么挑 / 什么不推」，避免文档过期。
// now/year 让 Agent 正确计算「近 7 天」——它自己的时钟未必可靠。
app.get('/api/intel/topics', wrap(async (req, res) => {
  const nowIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(new Date());
  res.json({
    ok: true,
    now: nowIso,
    year: Number(nowIso.slice(0, 4)),
    recency: INTEL_RECENCY,
    topics: INTEL_TOPICS,
    guidelines: INTEL_GUIDELINES,
    whitelist: (await intelStats()).sources,
    guide: '按 topics 检索（务必用引擎时间过滤），只搬运 标题/链接/一句话摘要，POST /api/intel/push（完整对接见 docs/情报推送对接说明.md）'
  });
}));

// ---- 情报线：已归档资讯浏览（供前端展示，谈资素材入口）----
app.get('/api/intel/items', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const items = await loadIntel();
  res.json({ ok: true, total: items.length, items: items.slice(0, limit) });
}));

// ---- 静态前端 ----
app.use(express.static(path.resolve(__dirname, '../../public')));

// ---- 全局错误处理（必须在最后）----
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // 1) body 解析失败 = 客户端问题（只认 body-parser 的类型标记；
  //    业务代码自己抛的 SyntaxError 不该被误报成「JSON 不合法」）
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: '请求体不是合法 JSON' });
  }
  // 2) multer 文件过大
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: '图片超过 5MB，请压缩后重试' });
  }
  // 2b) multer 字段名不符 / 文件数超限（原先落到 500 通用错误，无从排查）
  if (err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ ok: false, error: '图片字段名不符（应使用 images，最多 4 张）' });
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ ok: false, error: '图片数量超过上限（最多 4 张）' });
  }
  // 2c) 文本字段过大（textarea 粘贴超长内容；multipart 不受 express.json 限制约束）
  if (err?.code === 'LIMIT_FIELD_SIZE') {
    return res.status(413).json({ ok: false, error: '文字内容过长（上限 2MB），请精简后重试' });
  }
  // 3) LLM 上游失败 = 502，并把原因如实告知（前端会红色横幅提示，避免把假文案当真）
  const msg = String(err?.message || err);
  if (/LLM|调用 LLM|vision/.test(msg)) {
    console.error('[llm-error]', msg);
    return res.status(502).json({ ok: false, error: msg });
  }
  // 4) 其他 = 500
  console.error('[error]', req.method, req.path, err);
  res.status(500).json({ ok: false, error: '服务器内部错误，请查看服务端日志' });
});

// ---- 启动 ----
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  startIntelCron();
});
