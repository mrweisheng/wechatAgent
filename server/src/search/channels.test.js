// 搜索渠道适配层测试：渠道配置状态、合并去重、优先级排序、失败容错
// 通过临时替换 globalThis.fetch 模拟渠道响应，不发起真实网络请求。

import test from 'node:test';
import assert from 'node:assert/strict';

// 隔离真实 key，避免测试结果受本机 .env 影响
for (const k of ['TAVILY_API_KEY', 'FIRECRAWL_API_KEY', 'EXA_API_KEY', 'DIFFBOT_API_KEY', 'BRAVE_API_KEY', 'SEARXNG_INSTANCE_URL']) {
  delete process.env[k];
}

const { searchAll, channelStatus, CHANNEL_LIST } = await import('./channels.js');

test('channelStatus：无 key 时仅 firecrawl（keyless）可用，其余如实报未配置', async () => {
  const st = await channelStatus();
  const byName = Object.fromEntries(st.map(c => [c.name, c]));
  assert.equal(byName.firecrawl.configured, true, 'firecrawl keyless 应可用');
  assert.equal(byName.tavily.configured, false, 'tavily 无 key 不可用');
  assert.equal(byName.brave.configured, false);
  assert.ok(st.every(c => c.env), '每个渠道应如实标注所需环境变量');
});

test('channelStatus：REPLACE 占位符视为未配置（防示例 key 误当真实配置）', async () => {
  process.env.TAVILY_API_KEY = 'tvly-REPLACE_ME';
  const st = await channelStatus();
  assert.equal(st.find(c => c.name === 'tavily').configured, false);
  delete process.env.TAVILY_API_KEY;
});

test('searchAll：多渠道结果按 priority 排序合并、按 URL 去重、失败渠道进 errors', async () => {
  process.env.TAVILY_API_KEY = 'tvly-test-key';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('tavily.com')) {
      return {
        ok: true,
        json: async () => ({ results: [
          { title: 'T1', url: 'https://a.com/1', content: 'tavily 结果' },
          { title: 'T2', url: 'https://b.com/2', content: '重复 URL 候选' }
        ] })
      };
    }
    if (u.includes('firecrawl.dev')) {
      return {
        ok: true,
        json: async () => ({ data: [
          { title: 'F1', url: 'https://b.com/2', description: '与 tavily 重复' },
          { title: 'F2', url: 'https://c.com/3', description: 'firecrawl 独有' }
        ] })
      };
    }
    throw new Error('unexpected url: ' + u);
  };
  try {
    const r = await searchAll('测试查询', { max_results: 5 });
    const urls = r.merged.map(x => x.url);
    assert.deepEqual(urls, ['https://a.com/1', 'https://b.com/2', 'https://c.com/3'],
      'tavily(p1) 在前、firecrawl(p2) 在后，重复 URL 只留首个');
    assert.equal(r.merged[1].source, 'tavily', '去重保留高优先级渠道条目');
    assert.deepEqual(r.errors, []);
    assert.equal(r.channels.length, 2, '只有启用渠道出现在统计里');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TAVILY_API_KEY;
  }
});

test('searchAll：渠道报错不拖垮整体（失败进 errors，其余渠道结果照返）', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('firecrawl.dev')) return { ok: false, status: 500, text: async () => 'boom' };
    throw new Error('unexpected url: ' + u);
  };
  try {
    const r = await searchAll('测试查询', { max_results: 5 });
    assert.deepEqual(r.merged, []);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].channel, 'firecrawl');
    assert.match(r.errors[0].error, /500/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('CHANNEL_LIST 与渠道表一致（防渠道增删后清单漂移）', () => {
  assert.ok(CHANNEL_LIST.includes('firecrawl'));
  assert.ok(CHANNEL_LIST.includes('tavily'));
  assert.equal(new Set(CHANNEL_LIST).size, CHANNEL_LIST.length, '渠道名不得重复');
});
