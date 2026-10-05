// 统一 LLM 客户端：DeepSeek 官方 API / OpenCode Go 订阅网关
//
// generator / vision / softScore 共用，避免三处各自维护
// header 与错误提示。Node 20 原生 fetch，无需 node-fetch。

import { traceCall, traceRaw } from './trace.js';

const DEFAULT_TIMEOUT_MS = 60000;

// 网关 session id 回退值：进程内只生成一次，重试/多次调用复用，保住 prompt 缓存
let sessionFallback = null;

// 推理开关（2026-10-05）：默认关闭，LLM_REASONING=on 才恢复。
// 该网关/model 为推理模型，思考 token 与正文共用 max_tokens —— 实测思考可达 2000+，
// 会把 6 版正文挤空（end-to-end 实测出现「解析出 0 版」）。关闭后 reasoning_tokens=0，
// 实测提速约 4x、输出 token 降约 90%。探针实测 reasoning_effort='none' 生效。
export function llmReasoningEnabled() {
  return String(process.env.LLM_REASONING || 'off').trim().toLowerCase() === 'on';
}

export function llmKeyUsable() {
  const k = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!k || /REPLACE/.test(k) || k.length < 20) return false;
  // 接受两种前缀：DeepSeek 官方 sk-，OpenCode Go 的 oc_sk_
  return k.startsWith('sk-') || k.startsWith('oc_sk_');
}

export function llmModel() {
  return (process.env.DEEPSEEK_MODEL || 'deepseek-flash').trim();
}

/**
 * 调用 chat completions，返回 content 字符串。
 * 失败抛错（含状态码与人性化提示），由调用方决定降级或上抛。
 * 可重试错误（429/5xx/网络层失败）自动重试 1 次（1.2s 退避）——
 * 瞬时抖动不该让整次生成失败（可靠性 2026-10-04）。
 */
export async function llmChat(messages, opts = {}, attempt = 0) {
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
  };
  // OpenCode Go 网关要求客户端自带 UA 与稳定 session id（用于路由与 prompt 缓存）
  if (process.env.OPENCODE_GO === 'true') {
    headers['User-Agent'] = 'minge-wechat-agent/0.1';
    if (!sessionFallback) sessionFallback = `minge-${Date.now()}`;
    headers['x-opencode-session'] = process.env.OPENCODE_SESSION_ID || sessionFallback;
  }
  const body = { model: (opts.model ? opts.model : llmModel()), messages, max_tokens: opts.max_tokens ?? 1000 };
  if (opts.temperature != null) body.temperature = opts.temperature;
  // 关推理：reasoning_effort='none'（实测 reasoning_tokens=0）
  if (!llmReasoningEnabled()) body.reasoning_effort = 'none';
  const label = opts.label || 'llm';

  try {
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      let hint = '请检查 .env 的 DEEPSEEK_API_KEY';
      if (r.status === 429) hint = '额度或频率受限，请稍后重试';
      else if (r.status >= 500) hint = '上游服务异常，请稍后重试';
      throw new Error(`LLM ${r.status}：${errText.slice(0, 160)}（${hint}）`);
    }
    const j = await r.json();
    const choice = j?.choices?.[0] || {};
    const content = choice?.message?.content || '';
    const usage = j?.usage || null;
    const truncated = choice?.finish_reason === 'length';
    const empty = !String(content).trim();

    // 留痕：每次调用一行元数据；空/截断另存完整原始响应供诊断（fire-and-forget）
    traceCall({
      ts: new Date().toISOString(),
      label,
      model: body.model,
      maxTokens: body.max_tokens,
      reasoning: body.reasoning_effort || 'default',
      finishReason: choice?.finish_reason || null,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      contentLen: String(content).length,
      empty,
      truncated,
      attempt
    });

    // 空正文 / 被截断 = 无效输出，抛可重试错误（此前会静默返回空串，导致 0 版）
    if (empty || truncated) {
      traceRaw(label, { ts: new Date().toISOString(), label, attempt, body, response: j });
      const why = empty
        ? `空正文（finish_reason=${choice?.finish_reason || '?'}，completion=${usage?.completion_tokens ?? '?'}）`
        : `输出被截断（finish_reason=length，completion=${usage?.completion_tokens ?? '?'}）`;
      const err = new Error(`LLM ${label} ${why}`);
      err.retryableLlm = true;
      throw err;
    }
    return content;
  } catch (e) {
    // 429/5xx/网络层/空正文/截断 重试一次；4xx 凭据类错误不重试
    const msg = String(e?.message || e);
    const cause = String(e?.cause?.message || e?.cause?.code || '');
    const retryable = e?.retryableLlm || /LLM (429|5\d{2})/.test(msg) ||
      /fetch failed|network|timeout|timed? ?out|aborted|ECONN|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket/i.test(msg + ' ' + cause);
    if (retryable && attempt < 1) {
      await new Promise(res => setTimeout(res, 1200));
      return llmChat(messages, opts, attempt + 1);
    }
    throw e;
  }
}
