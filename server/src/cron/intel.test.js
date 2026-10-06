// 情报 cron 测试：时区规则解析、非法表达式回落、开关语义
// 【2026-10-06 审计 P2】node-schedule 字符串 cron 按服务器本地时区触发，
// UTC 服务器会偏 8 小时——resolveCronExpr 必须显式带 tz。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = path.join(os.tmpdir(), 'intel-cron-test-' + Date.now());

const { resolveCronExpr, startIntelCron } = await import('./intel.js');

test('resolveCronExpr：默认周一 08:00 @ Asia/Hong_Kong', () => {
  delete process.env.INTEL_CRON;
  delete process.env.INTEL_TZ;
  assert.deepEqual(resolveCronExpr(), { rule: '0 8 * * 1', tz: 'Asia/Hong_Kong' });
});

test('resolveCronExpr：INTEL_CRON / INTEL_TZ 环境变量覆盖', () => {
  process.env.INTEL_CRON = '30 9 * * 2';
  process.env.INTEL_TZ = 'Asia/Shanghai';
  assert.deepEqual(resolveCronExpr(), { rule: '30 9 * * 2', tz: 'Asia/Shanghai' });
  delete process.env.INTEL_CRON;
  delete process.env.INTEL_TZ;
});

test('startIntelCron：INTEL_ENABLED 非 true 时不启用（返回 false，不抛错）', () => {
  process.env.INTEL_ENABLED = '';
  assert.equal(startIntelCron(), false);
});

test('startIntelCron：非法 INTEL_CRON 回落默认且不崩（返回 job 可取消）', () => {
  process.env.INTEL_ENABLED = 'true';
  process.env.INTEL_CRON = 'not-a-cron';
  const job = startIntelCron();
  assert.ok(job, '非法表达式回落后仍应成功调度');
  if (job && typeof job.cancel === 'function') job.cancel(); // 常驻定时器不 cancel 会挂住测试进程
  delete process.env.INTEL_CRON;
  process.env.INTEL_ENABLED = '';
});
