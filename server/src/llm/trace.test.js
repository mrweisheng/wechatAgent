// LLM 留痕模块测试：JSONL 追加、失败原始响应落盘、开关关闭时不写

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.tmpdir(), 'trace-test-' + Date.now());
process.env.DATA_DIR = DIR;
process.env.LLM_TRACE = 'on';

const { traceCall, traceRaw } = await import('./trace.js');

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
