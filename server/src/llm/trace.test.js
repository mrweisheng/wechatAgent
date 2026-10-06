// LLM 留痕模块测试：JSONL 追加、失败原始响应落盘、开关关闭时不写

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.tmpdir(), 'trace-test-' + Date.now());
process.env.DATA_DIR = DIR;
process.env.LLM_TRACE = 'on';

const { traceCall, traceRaw, sanitizeTracePayload } = await import('./trace.js');

test('traceCall 追加 JSONL；traceRaw 落盘原始响应', async () => {
  await traceCall({ label: 'x', contentLen: 1 });
  await traceRaw('generate-parse-failed', { a: 1 });
  const trace = await fs.readFile(path.join(DIR, 'llm-trace.jsonl'), 'utf8');
  assert.match(trace, /"label":"x"/);
  const files = await fs.readdir(path.join(DIR, 'llm-fail'));
  assert.equal(files.length, 1);
  assert.match(files[0], /generate-parse-failed/);
});

test('LLM_TRACE=off 时不写文件', async () => {
  process.env.LLM_TRACE = 'off';
  const before = await fs.readdir(DIR);
  await traceCall({ label: 'y' });
  await traceRaw('z', {});
  const after = await fs.readdir(DIR);
  assert.deepEqual(after.sort(), before.sort());
  process.env.LLM_TRACE = 'on';
});

// 【2026-10-06 审计 P1】vision payload 的截图 base64 含客户隐私，落盘前必须摘除
test('sanitizeTracePayload：图片 data URL 与大段 base64 被摘除，正文保留', () => {
  const b64 = 'A'.repeat(3000);
  const payload = {
    body: {
      messages: [
        { role: 'user', content: [
          { type: 'text', text: '正常提示词' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }
        ] }
      ]
    },
    response: { choices: [{ message: { content: '正常文案正文，可以留痕' } }] },
    raw: b64
  };
  const s = sanitizeTracePayload(payload);
  const dumped = JSON.stringify(s);
  assert.ok(!dumped.includes(b64), 'base64 不得落盘');
  assert.ok(!dumped.includes('data:image'), 'data URL 不得落盘');
  assert.ok(dumped.includes('正常提示词') && dumped.includes('正常文案正文'), '正常文本必须保留');
  assert.equal(s.raw, '[base64 payload omitted]');
});

test('traceRaw 落盘内容已脱敏；llm-fail 只保留最近 20 份', async () => {
  const b64 = 'B'.repeat(2000);
  for (let i = 0; i < 25; i++) {
    await traceRaw('retention-check', { i, img: 'data:image/png;base64,' + b64 });
    await new Promise(r => setTimeout(r, 2)); // 保证文件名时间戳有序
  }
  const dir = path.join(DIR, 'llm-fail');
  const files = (await fs.readdir(dir)).filter(f => f.includes('retention-check'));
  assert.ok(files.length <= 20, `llm-fail 应封顶 20 份，实际 ${files.length}`);
  const latest = await fs.readFile(path.join(dir, files.sort().reverse()[0]), 'utf8');
  assert.ok(!latest.includes(b64), '落盘内容不得含 base64');
});
