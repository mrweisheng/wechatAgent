// LLM 客户端测试：自动重试（429/网络错误重试 1 次，4xx 凭据错误不重试）
// 通过临时替换 globalThis.fetch 模拟，不发起真实网络请求。

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1'; // 不会被真正使用（fetch 已 mock）
process.env.DEEPSEEK_API_KEY = 'sk-test-key-0123456789abcdef';
process.env.LLM_TRACE = 'off'; // 单测不落盘

const { llmChat } = await import('./client.js');

const resp = (content, finish_reason = 'stop', usage = undefined) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content }, finish_reason }], usage })
});
const okResponse = (content = 'x') => resp(content);

test('网络层失败（fetch failed）自动重试 1 次并成功', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return okResponse('recovered');
  };
  try {
    const out = await llmChat([{ role: 'user', content: 'hi' }], { max_tokens: 10 });
    assert.equal(out, 'recovered');
    assert.equal(calls, 2, '应恰好调用两次');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('429 限流自动重试 1 次；持续失败则如实抛错', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls <= 1) return { ok: false, status: 429, text: async () => 'rate limited' };
    return okResponse('after-429');
  };
  try {
    const out = await llmChat([{ role: 'user', content: 'hi' }], { max_tokens: 10 });
    assert.equal(out, 'after-429');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }

  // 持续 429：重试一次后仍失败 -> 抛错（不再无限重试）
  let calls2 = 0;
  globalThis.fetch = async () => {
    calls2++;
    return { ok: false, status: 429, text: async () => 'rate limited' };
  };
  try {
    await assert.rejects(() => llmChat([{ role: 'user', content: 'hi' }], { max_tokens: 10 }));
    assert.equal(calls2, 2, '重试上限 1 次');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('推理开关：默认关闭（注入 reasoning_effort=none），LLM_REASONING=on 恢复', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return okResponse('x'); };
  try {
    delete process.env.LLM_REASONING;
    await llmChat([{ role: 'user', content: 'hi' }], { max_tokens: 10 });
    process.env.LLM_REASONING = 'on';
    await llmChat([{ role: 'user', content: 'hi' }], { max_tokens: 10 });
    assert.equal(bodies[0].reasoning_effort, 'none', '默认应关闭推理');
    assert.equal(bodies[1].reasoning_effort, undefined, 'LLM_REASONING=on 不应注入');
  } finally {
    delete process.env.LLM_REASONING;
    globalThis.fetch = realFetch;
  }
});

test('空正文：自动重试一次', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? resp('') : resp('recovered'); };
  try {
    const out = await llmChat([{ role: 'user', content: 'hi' }], { max_tokens: 10 });
    assert.equal(out, 'recovered');
    assert.equal(calls, 2, '空正文应触发一次重试');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('finish_reason=length（截断）：自动重试一次', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? resp('半截', 'length') : resp('完整正文'); };
  try {
    const out = await llmChat([{ role: 'user', content: 'hi' }], { max_tokens: 10 });
    assert.equal(out, '完整正文');
    assert.equal(calls, 2, '截断应触发一次重试');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OPENCODE_GO：session id 跨调用稳定（保住网关 prompt 缓存）', async () => {
  process.env.OPENCODE_GO = 'true';
  delete process.env.OPENCODE_SESSION_ID;
  const realFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, opts) => {
    captured.push(opts.headers['x-opencode-session']);
    return okResponse('x');
  };
  try {
    await llmChat([{ role: 'user', content: 'a' }], { max_tokens: 10 });
    await llmChat([{ role: 'user', content: 'b' }], { max_tokens: 10 });
    assert.equal(captured.length, 2);
    assert.ok(captured[0], '应带 x-opencode-session header');
    assert.equal(captured[0], captured[1], '两次调用 session id 应一致');
  } finally {
    globalThis.fetch = realFetch;
    process.env.OPENCODE_GO = '';
  }
});

test('401 凭据错误不重试（重试也没用）', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 401, text: async () => 'unauthorized' };
  };
  try {
    await assert.rejects(
      () => llmChat([{ role: 'user', content: 'hi' }], { max_tokens: 10 }),
      /LLM 401/
    );
    assert.equal(calls, 1, '4xx 不应重试');
  } finally {
    globalThis.fetch = realFetch;
  }
});
