// 主入口：Express 服务 + 路由 + 静态前端
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { channelStatus } from './search/channels.js';
import { classifyImage, routeScene, detectMissing, isImageMime, mergeVisions } from './perception/vision.js';
import { runPipeline } from './generation/pipeline.js';
import { INTEL_TOPICS, INTEL_GUIDELINES, INTEL_RECENCY } from './knowledge/corpus.js';
import {
  addHistory, recentHistory,
  recordFeedback, addCorrection, findCorrections
} from './memory/store.js';
import { WRITE_APPROACHES } from './knowledge/corpus.js';
import { startIntelCron, runIntelOnce } from './cron/intel.js';
import { ingestIntel, intelStats, loadIntel } from './ingest/intelIngest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const INVITE = (process.env.INVITE_CODE || '').trim();
const AUTH_DISABLED = (process.env.AUTH_DISABLED || '').toLowerCase() === 'true';

// ---- 安全：fail-closed ----
// 未配置邀请码 = 全部 API 裸奔。默认拒绝启动，需显式 AUTH_DISABLED=true 才放行。
const PUBLIC_PATHS = new Set(['/api/login', '/api/healthz', '/api/intel/push', '/api/intel/topics']);
if (!AUTH_DISABLED && (!INVITE || /REPLACE/.test(INVITE))) {
  console.error('[FATAL] 未配置 INVITE_CODE，所有 /api 将无鉴权。');
  console.error('        请在 .env 设置 INVITE_CODE，或显式设置 AUTH_DISABLED=true 关闭鉴权。');
  process.exit(1);
}
if (AUTH_DISABLED) {
  console.warn('[WARN] AUTH_DISABLED=true —— 全部接口无鉴权，仅限本机开发。');
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ---- 鉴权中间件（放在 healthz / intel push 放行之后注册）----
app.use((req, res, next) => {
  if (AUTH_DISABLED) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith('/api/')) {
    const code = req.headers['x-invite-code'];
    if (!code || code !== INVITE) return res.status(401).json({ ok: false, error: '未授权' });
  }
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 4 } });

// 包装 async 路由：Express 4 不捕获 promise rejection，否则进程会崩
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- 简单失败限流（防邀请码/推送 token 暴力尝试，无外部依赖）----
// 按 IP 记录 401 失败次数，窗口内超限直接 429；成功后清零。
// 反向代理部署时所有请求同源 IP，属已知局限（单用户场景可接受，见 README）。
const authFails = new Map();
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX_FAILS = 10;
function failRateLimit(req, res, next) {
  const ip = req.socket.remoteAddress || 'unknown';
  const rec = authFails.get(ip);
  const now = Date.now();
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

// ---- 公开健康检查（不含敏感信息）----
app.get('/api/healthz', (req, res) => {
  res.json({ ok: true, llm: isLlmConfigured() });
});

function isLlmConfigured() {
  const k = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!k || /REPLACE/.test(k) || k.length < 20) return false;
  // 接受两种前缀：DeepSeek 官方 sk-，OpenCode Go 的 oc_sk_
  return k.startsWith('sk-') || k.startsWith('oc_sk_');
}

// ---- 完整健康检查（需鉴权）：渠道真实状态 ----
app.get('/api/health', wrap(async (req, res) => {
  res.json({
    ok: true,
    llm: isLlmConfigured(),
    llmNote: isLlmConfigured() ? null : 'DEEPSEEK_API_KEY 未配置或格式可疑，将使用演示文案',
    channels: await channelStatus(),
    intelCron: (process.env.INTEL_ENABLED || '').toLowerCase() === 'true',
    intel: await intelStats()
  });
}));

// ---- 登录（带失败限流）----
app.post('/api/login', failRateLimit, (req, res) => {
  const { code } = req.body || {};
  if (AUTH_DISABLED) return res.json({ ok: true, token: 'disabled' });
  if (code && code === INVITE) return res.json({ ok: true, token: code });
  res.status(401).json({ ok: false, error: '邀请码错误' });
});

// ---- 核心生成（管线：生成 → 硬规则 → 软评分 → 去重 → 反思改写）----
app.post('/api/generate', upload.array('images', 4), wrap(async (req, res) => {
  const text = ((req.body && req.body.text) || '').trim();
  // 多图支持（2026-10-04 审核采纳）：最多 4 张（主图 + 群聊截图等常见组合），
  // 逐张识别后合并要素；全部降级才算降级；非图片文件如实提示
  const files = req.files || [];
  let vision = null;
  let degraded = false;

  if (files.length) {
    const visions = [];
    for (const f of files) {
      if (isImageMime(f.mimetype)) {
        visions.push(await classifyImage(f.buffer, f.mimetype));
      } else {
        degraded = true;
        visions.push({ _unsupported: f.mimetype });
      }
    }
    vision = visions.length > 1 ? mergeVisions(visions) : visions[0];
    degraded = !!vision?._degraded;
  }

  const scene = routeScene({ text, vision });
  const missing = detectMissing({ scene, text, vision });

  // 要素级校验：有输入但关键要素缺失时也要追问（原先仅完全空输入才追问 = 死代码）
  if (missing.length) {
    return res.json({ ok: true, needsMore: true, questions: missing, scene, understood: text || '(仅图)' });
  }

  // 【2026-10-04 澄清】三版 = 同一内容的三种写法（防折叠），写法路径固定三条；
  // 旧「叙事角度轮换记账」不再参与单次生成（跨次防重由版本级相似度检测承担）
  const angles = WRITE_APPROACHES;

  // LLM 失败直接抛错，由 error handler 转 502 —— 不再返回假文案
  const out = await runPipeline({ text, vision, scene, angles });

  await addHistory({
    scene, text,
    visionType: vision?.type || null,
    angles,
    versions: out.versions.map(v => ({
      angle: v.angle, tone: v.tone, pass: v.hardCheck.pass,
      text: v.text,
      score: v.score?.total ?? null,
      similarity: v.similarity ?? 0
    }))
  });

  res.json({
    ok: true,
    scene,
    angles,
    versions: out.versions,
    candidates: out.candidateCount || out.versions.length,
    imagePlan: out.imagePlan,
    sceneNotes: out.sceneNotes,
    demo: !!out.demo,
    degraded,
    degradedReason: vision?._degradedReason || null,
    parseFailed: !!out.parseFailed,
    parseNote: out.parseNote || null,
    error: out.error || null,
    warning: vision?._unsupported ? `暂不支持识别 ${vision._unsupported}，请转 JPG/PNG` : null
  });
}));

// ---- 反馈 ----
app.post('/api/feedback', wrap(async (req, res) => {
  const { kind, payload } = req.body || {};
  if (!kind) return res.status(400).json({ ok: false, error: 'kind required' });
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

// ---- 情报线：本地搜索（需鉴权）----
app.post('/api/intel/run', wrap(async (req, res) => {
  const fresh = await runIntelOnce();
  res.json({ ok: true, freshCount: fresh.length, items: fresh });
}));

// ---- 情报线：外部 Agent 推送（公开，走独立 token 鉴权 + 失败限流）----
// 见 README「情报推送 API」：外部 Agent 每天搜索后 POST 到这里
app.post('/api/intel/push', failRateLimit, wrap(async (req, res) => {
  const PUSH_TOKEN = (process.env.INTEL_PUSH_TOKEN || '').trim();
  if (!PUSH_TOKEN || /REPLACE/.test(PUSH_TOKEN)) {
    return res.status(503).json({ ok: false, error: '未配置 INTEL_PUSH_TOKEN，推送接口未启用' });
  }
  const token = req.headers['x-push-token'] || (req.body && req.body.token);
  if (!token || token !== PUSH_TOKEN) {
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

  // 1) body 解析失败 = 客户端问题
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: '请求体不是合法 JSON' });
  }
  // 2) multer 文件过大
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: '图片超过 5MB，请压缩后重试' });
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
  console.log(`[auth] ${AUTH_DISABLED ? 'DISABLED（无鉴权）' : 'INVITE_CODE 已启用'}`);
  startIntelCron();
});
