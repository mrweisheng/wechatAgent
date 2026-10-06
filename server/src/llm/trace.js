// LLM 调用留痕（可观测性，2026-10-05）
//
// 背景：此前 LLM 输出解析失败（尤其推理 token 把正文挤空导致 0 版）时，
// 原始输出完全没有留痕，无法定位根因。现每次调用追加一行 JSONL 元数据；
// 空正文/被截断时把完整原始响应落盘到 llm-fail/，便于事后诊断。
//
// 约定：留痕失败绝不影响主流程（全部 try/catch 吞掉）。
// 开关：LLM_TRACE=off 可关闭（测试用）；默认 on。
// 落盘位置：<DATA_DIR>/llm-trace.jsonl 与 <DATA_DIR>/llm-fail/。
//
// 【2026-10-06 审计 P1 修复】两道收紧：
//   ① PII 脱敏：vision 调用的 payload 含图片 base64 / data URL（群聊截图常带
//      客户头像、昵称、对话）——落盘 = 客户隐私明文留档。写入前一律摘除。
//   ② 保留策略：llm-fail/ 原先只增不减（无界增长），现只留最近 20 份；
//      llm-trace.jsonl 轮转的 .old 只留最近 3 份。

import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_TRACE_BYTES = 5 * 1024 * 1024;
const MAX_FAIL_FILES = 20;
const MAX_TRACE_OLD = 3;

const enabled = () => String(process.env.LLM_TRACE || 'on').toLowerCase() !== 'off';
const dataDir = () => path.resolve(process.env.DATA_DIR || './data');
const traceFile = () => path.join(dataDir(), 'llm-trace.jsonl');
const failDir = () => path.join(dataDir(), 'llm-fail');

// 深度脱敏：图片 data URL / 大段 base64 一律替换为占位符，其余字段原样保留。
// 导出供测试。base64 判定：长度 >512 且纯 base64 字符集（正常中文/英文散文不会命中）。
export function sanitizeTracePayload(v) {
  if (typeof v === 'string') {
    if (/^data:image\//.test(v)) return '[image data-url omitted]';
    if (v.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(v)) return '[base64 payload omitted]';
    return v;
  }
  if (Array.isArray(v)) return v.map(sanitizeTracePayload);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = sanitizeTracePayload(x);
    return o;
  }
  return v;
}

export async function traceCall(meta) {
  if (!enabled()) return;
  try {
    await fs.mkdir(dataDir(), { recursive: true });
    const f = traceFile();
    const st = await fs.stat(f).catch(() => null);
    if (st && st.size > MAX_TRACE_BYTES) {
      await fs.rename(f, `${f}.${Date.now()}.old`).catch(() => {});
      // 轮转留痕保留策略：文件名带时间戳，字典序≈时间序，只留最近 MAX_TRACE_OLD 份
      const olds = (await fs.readdir(dataDir()))
        .filter(x => x.startsWith('llm-trace.jsonl.') && x.endsWith('.old'))
        .sort().reverse();
      for (const o of olds.slice(MAX_TRACE_OLD)) {
        await fs.unlink(path.join(dataDir(), o)).catch(() => {});
      }
    }
    await fs.appendFile(f, JSON.stringify(meta) + '\n', 'utf8');
  } catch {
    /* 留痕失败绝不影响主流程 */
  }
}

export async function traceRaw(label, payload) {
  if (!enabled()) return;
  try {
    await fs.mkdir(failDir(), { recursive: true });
    const file = path.join(failDir(), `${Date.now()}-${String(label || 'llm').replace(/[^\w-]/g, '_')}.json`);
    await fs.writeFile(file, JSON.stringify(sanitizeTracePayload(payload), null, 2), 'utf8');
    // 失败留痕保留策略：只留最近 MAX_FAIL_FILES 份（文件名前缀即时间戳）
    const files = (await fs.readdir(failDir())).sort().reverse();
    for (const old of files.slice(MAX_FAIL_FILES)) {
      await fs.unlink(path.join(failDir(), old)).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}
