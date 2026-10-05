// 集成契约回归：前端上传字段名必须与后端 multer 配置一致。
// 背景（2026-10-05 审核）：前端曾用字段名 'image'，后端 upload.array('images')，
// 带图生成全部 500（LIMIT_UNEXPECTED_FILE），而单元测试全绿无人发现。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '../../public/index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(here, 'index.js'), 'utf8');

test('前端图片上传字段名与后端 multer 字段名一致', () => {
  const m = serverJs.match(/upload\.array\(\s*['"]([^'"]+)['"]/);
  assert.ok(m, '后端应使用 upload.array(field, ...)');
  const field = m[1];
  assert.ok(
    html.includes(`append('${field}'`),
    `前端应按后端字段名 '${field}' 上传图片（不一致会导致 LIMIT_UNEXPECTED_FILE）`
  );
});
