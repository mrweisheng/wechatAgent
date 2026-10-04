// 统一 LLM 客户端：DeepSeek 官方 API / OpenCode Go 订阅网关
//
// generator / vision / softScore 共用，避免三处各自维护
// header 与错误提示。Node 20 原生 fetch，无需 node-fetch。

const DEFAULT_TIMEOUT_MS = 60000;

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
    headers['x-opencode-session'] = process.env.OPENCODE_SESSION_ID || `minge-${Date.now()}`;
  }
  const body = { model: (opts.model ? opts.model : llmModel()), messages, max_tokens: opts.max_tokens ?? 1000 };
  if (opts.temperature != null) body.temperature = opts.temperature;
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
    return j.choices?.[0]?.message?.content || '';
  } catch (e) {
    // 429/5xx/网络层（fetch failed、超时、连接重置）重试一次；4xx 凭据类错误不重试
    const msg = String(e?.message || e);
    const cause = String(e?.cause?.message || e?.cause?.code || '');
    const retryable = /LLM (429|5\d{2})/.test(msg) ||
      /fetch failed|network|timeout|timed? ?out|aborted|ECONN|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket/i.test(msg + ' ' + cause);
    if (retryable && attempt < 1) {
      await new Promise(res => setTimeout(res, 1200));
      return llmChat(messages, opts, attempt + 1);
    }
    throw e;
  }
}
