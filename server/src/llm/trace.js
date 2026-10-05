// LLM 调用留痕（可观测性，2026-10-05）
//
// 背景：此前 LLM 输出解析失败（尤其推理 token 把正文挤空导致 0 版）时，
// 原始输出完全没有留痕，无法定位根因。现每次调用追加一行 JSONL 元数据；
// 空正文/被截断时把完整原始响应落盘到 llm-fail/，便于事后诊断。
//
// 约定：留痕失败绝不影响主流程（全部 try/catch 吞掉）。
// 开关：LLM_TRACE=off 可关闭（测试用）；默认 on。
// 落盘位置：<DATA_DIR>/llm-trace.jsonl 与 <DATA_DIR>/llm-fail/。

import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_TRACE_BYTES = 5 * 1024 * 1024;

const enabled = () => String(process.env.LLM_TRACE || 'on').toLowerCase() !== 'off';
const dataDir = () => path.resolve(process.env.DATA_DIR || './data');
const traceFile = () => path.join(dataDir(), 'llm-trace.jsonl');
const failDir = () => path.join(dataDir(), 'llm-fail');

export async function traceCall(meta) {
  if (!enabled()) return;
  try {
    await fs.mkdir(dataDir(), { recursive: true });
    const f = traceFile();
    const st = await fs.stat(f).catch(() => null);
    if (st && st.size > MAX_TRACE_BYTES) {
      await fs.rename(f, `${f}.${Date.now()}.old`).catch(() => {});
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
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}
