// LLM 客户端测试：自动重试（429/网络错误重试 1 次，4xx 凭据错误不重试）
// 通过临时替换 globalThis.fetch 模拟，不发起真实网络请求。

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1'; // 不会被真正使用（fetch 已 mock）
process.env.DEEPSEEK_API_KEY = 'sk-test-key-0123456789abcdef';

const { llmChat } = await import('./client.js');

const okResponse = (content = 'x') => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] })
});

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
