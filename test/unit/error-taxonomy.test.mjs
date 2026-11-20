/**
 * 错误分类表的稳定性。
 *
 * 这层被删掉过一次：`lib/auth-api.js`（43 个导出名的桶文件）曾把
 * `ErrorCode`、`QwenAuthError` 一并重导出，测试也跟着写在了桶上。桶被删除后，
 * 这些断言必须有地方继续存在——它们守的是**跨模块契约**：
 *
 *   · `ErrorCode` 的每个键都被某些调用方按名比较，删或改名会静默改变行为
 *   · `toJSON()` 是错误跨进浏览器（卡片）时的唯一形状，泄露栈或丢失
 *     `recovery` 都会让用户看到无用的提示
 *
 * 因此断言直接落在 `lib/errors.js` —— 真正有消费者的那一层。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, QwenAuthError, isQwenAuthError } from '../../lib/errors.js';

test('ErrorCode covers every required category', () => {
  for (const c of [
    'CREDENTIALS_MISSING',
    'DPAPI_FAILED',
    'DECRYPT_FAILED',
    'TOKEN_EXPIRED_NO_REFRESH',
    'SCHEMA_INVALID',
    'CREDENTIALS_MALFORMED',
    'REFRESH_REJECTED',
    'REFRESH_NETWORK',
    'API_UNAUTHORIZED',
    'API_ERROR',
    'UNSUPPORTED_PLATFORM',
  ]) {
    assert.ok(ErrorCode[c], `missing error code ${c}`);
  }
});

test('每个 ErrorCode 的值都是唯一的稳定字符串', () => {
  const values = Object.values(ErrorCode);
  assert.equal(new Set(values).size, values.length, 'ErrorCode 的值有重复');
  for (const v of values) {
    assert.equal(typeof v, 'string');
    assert.match(v, /^[A-Z][A-Z_]*$/u, `错误码形态不符: ${v}`);
  }
});

test('QwenAuthError.toJSON exposes code and recovery', () => {
  const e = new QwenAuthError(ErrorCode.DECRYPT_FAILED, 'boom');
  const j = e.toJSON();
  assert.equal(j.code, 'DECRYPT_FAILED');
  assert.ok(j.recovery.length > 0);
  assert.equal(typeof j.retryable, 'boolean');
});

test('toJSON 不带出栈信息（错误会跨进浏览器）', () => {
  const e = new QwenAuthError(ErrorCode.API_ERROR, 'boom');
  const serialised = JSON.stringify(e.toJSON());
  assert.equal(serialised.includes('at '), false, 'toJSON 里出现了栈帧文本');
  assert.equal('stack' in e.toJSON(), false, 'toJSON 不应包含 stack 字段');
});

test('isQwenAuthError 能认出本模块的错误，不误认普通错误', () => {
  assert.equal(isQwenAuthError(new QwenAuthError(ErrorCode.API_ERROR, 'x')), true);
  assert.equal(isQwenAuthError(new Error('x')), false);
  assert.equal(isQwenAuthError(null), false);
  assert.equal(isQwenAuthError(undefined), false);
  // 形状相同但不是本类实例的对象不得被认为是它（避免跨模块 instanceof 误判放宽）
  assert.equal(isQwenAuthError({ code: ErrorCode.API_ERROR, message: 'x' }), false);
});
