// 搜索渠道适配层
//
// 【实测结论 2026-10-03，勿再假设】
//   Tavily  keyless 不可用（api_key:'tvly-free' -> 401）—— 必须有 key，否则跳过
//   Firecrawl keyless 可用（200）
//   You.com 已移除：端点 403，且 api.ydc-index.io 非官方域，带 key 时存在密钥外泄风险
//   SearXNG / Exa / Diffbot / Brave：需自建实例或 key
//
// 另：推荐主路径是「外部 Agent 推送」(/api/intel/push)，本层仅作本地兜底与手动检索。

const TIMEOUT_MS = 12000;

function withTimeout(url, opts, ms = TIMEOUT_MS) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

// 显式映射，避免按渠道名推导环境变量导致的隐性错误
const KEY_ENV = {
  tavily: 'TAVILY_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  exa: 'EXA_API_KEY',
  diffbot: 'DIFFBOT_API_KEY',
  brave: 'BRAVE_API_KEY',
  searxng: 'SEARXNG_INSTANCE_URL'
};

const hasKey = name => {
  const v = (process.env[KEY_ENV[name]] || '').trim();
  return v.length > 0 && !/REPLACE/.test(v);
};

// ===== Tavily（需 key）=====
async function tavily(query, { max_results = 5 } = {}) {
  if (!hasKey('tavily')) throw new Error('tavily: no key');
  const r = await withTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results,
      search_depth: 'basic',
      include_answer: false
    })
  });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const data = await r.json();
  return (data.results || []).map(x => ({
    source: 'tavily', title: x.title, url: x.url, snippet: x.content
  }));
}

// ===== Firecrawl keyless（实测可用）=====
async function firecrawl(query, { max_results = 5 } = {}) {
  const key = (process.env.FIRECRAWL_API_KEY || '').trim();
  const r = await withTimeout('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key && !/REPLACE/.test(key) ? { Authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify({ query, limit: max_results })
  });
  if (!r.ok) throw new Error(`firecrawl ${r.status}`);
  const data = await r.json();
  return (data.data || []).map(x => ({
    source: 'firecrawl', title: x.title, url: x.url, snippet: x.description || x.content
  }));
}

// ===== Exa =====
async function exa(query, { max_results = 5 } = {}) {
  if (!hasKey('exa')) throw new Error('exa: no key');
  const r = await withTimeout('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.EXA_API_KEY },
    body: JSON.stringify({ query, numResults: max_results })
  });
  if (!r.ok) throw new Error(`exa ${r.status}`);
  const data = await r.json();
  return (data.results || []).map(x => ({
    source: 'exa', title: x.title, url: x.url, snippet: x.text
  }));
}

// ===== Diffbot =====
async function diffbot(query, { max_results = 5 } = {}) {
  if (!hasKey('diffbot')) throw new Error('diffbot: no key');
  const url = 'https://kg.diffbot.com/kg/v3/enhance'
    + `?token=${encodeURIComponent(process.env.DIFFBOT_API_KEY)}`
    + `&query=${encodeURIComponent(query)}&numResults=${max_results}`;
  const r = await withTimeout(url, {});
  if (!r.ok) throw new Error(`diffbot ${r.status}`);
  const data = await r.json();
  return (data.data || []).map(x => ({
    source: 'diffbot', title: x.name || x.title, url: x.homepage_url || x.url, snippet: x.shortDescription
  }));
}

// ===== Brave Search =====
async function brave(query, { max_results = 5 } = {}) {
  if (!hasKey('brave')) throw new Error('brave: no key');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max_results}`;
  const r = await withTimeout(url, { headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY } });
  if (!r.ok) throw new Error(`brave ${r.status}`);
  const data = await r.json();
  return (data.web?.results || []).map(x => ({
    source: 'brave', title: x.title, url: x.url, snippet: x.description
  }));
}

// ===== SearXNG（自建实例）=====
async function searxng(query, { max_results = 5 } = {}) {
  if (!hasKey('searxng')) throw new Error('searxng: no instance');
  const inst = process.env.SEARXNG_INSTANCE_URL.replace(/\/$/, '');
  const url = `${inst}/search?q=${encodeURIComponent(query)}&format=json&language=zh-Hans`;
  const r = await withTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 minge-agent' } });
  if (!r.ok) throw new Error(`searxng ${r.status}`);
  const data = await r.json();
  return (data.results || []).slice(0, max_results).map(x => ({
    source: 'searxng', title: x.title, url: x.url, snippet: x.content
  }));
}

// keyless 的渠道不需要 key；其余按 KEY_ENV 判定
const CHANNELS = [
  { name: 'tavily',   fn: tavily,   priority: 1, keyless: false },
  { name: 'firecrawl', fn: firecrawl, priority: 2, keyless: true },
  { name: 'searxng',  fn: searxng,  priority: 3, keyless: false },
  { name: 'exa',      fn: exa,      priority: 4, keyless: false },
  { name: 'diffbot',  fn: diffbot,  priority: 5, keyless: false },
  { name: 'brave',    fn: brave,    priority: 6, keyless: false }
];

export const CHANNEL_LIST = CHANNELS.map(c => c.name);

export async function searchAll(query, opts = {}) {
  const results = [];
  const errors = [];
  const active = [];

  await Promise.all(CHANNELS.map(async ch => {
    const enabled = ch.keyless || hasKey(ch.name);
    if (!enabled) return;
    active.push(ch.name);
    try {
      results.push({ channel: ch.name, priority: ch.priority, items: await ch.fn(query, opts) });
    } catch (e) {
      errors.push({ channel: ch.name, error: String(e.message || e) });
    }
  }));

  // 按 priority 合并去重（原先用 localeCompare 字母序，「Tavily 首选」形同虚设）
  const priorityOf = Object.fromEntries(CHANNELS.map(c => [c.name, c.priority]));
  results.sort((a, b) => priorityOf[a.channel] - priorityOf[b.channel]);

  const merged = [];
  const seen = new Set();
  for (const { items } of results) {
    for (const it of items) {
      if (!it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      merged.push(it);
    }
  }

  return {
    query,
    merged,
    channels: results.map(r => ({ channel: r.channel, count: r.items.length })),
    errors
  };
}

// 渠道真实状态（不再谎报 enabled）
export async function channelStatus() {
  return CHANNELS.map(c => ({
    name: c.name,
    configured: c.keyless || hasKey(c.name),
    keyless: c.keyless,
    env: KEY_ENV[c.name]
  }));
}
