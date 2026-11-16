import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripDpapiPrefix, buildPowerShellScript, isSupportedPlatform, unprotectMasterKey } from '../../lib/dpapi.js';
import { ErrorCode } from '../../lib/errors.js';

test('stripDpapiPrefix removes the 5-byte DPAPI prefix', () => {
  const key = crypto.randomBytes(32);
  const blob = Buffer.concat([Buffer.from('DPAPI'), key]);
  assert.deepEqual(stripDpapiPrefix(blob), key);
});

test('stripDpapiPrefix keeps remaining byte length (real file is 283 bytes)', () => {
  const payload = crypto.randomBytes(278);
  const blob = Buffer.concat([Buffer.from('DPAPI'), payload]);
  assert.equal(blob.length, 283);
  assert.equal(stripDpapiPrefix(blob).length, 278);
});

test('missing DPAPI prefix -> CREDENTIALS_MALFORMED', () => {
  const blob = Buffer.concat([Buffer.from('XXXXX'), crypto.randomBytes(32)]);
  assert.throws(() => stripDpapiPrefix(blob), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('too-short blob -> CREDENTIALS_MALFORMED', () => {
  assert.throws(() => stripDpapiPrefix(Buffer.from('D')), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
  assert.throws(() => stripDpapiPrefix(null), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('PowerShell script includes the required Add-Type System.Security', () => {
  const s = buildPowerShellScript('AAAA');
  assert.match(s, /Add-Type -AssemblyName System\.Security/);
  assert.match(s, /ProtectedData\]::Unprotect/);
  assert.match(s, /'CurrentUser'/);
});

test('PowerShell script performs no file writes', () => {
  const s = buildPowerShellScript('AAAA');
  assert.ok(!/Out-File|Set-Content|Add-Content/.test(s));
});

test('isSupportedPlatform reflects win32', () => {
  // 该函数只回答「DPAPI 路径是否可用」——Linux 走 Secret Service，不是它的职责
  assert.equal(isSupportedPlatform(), process.platform === 'win32');
});

test('Linux 不支持 DPAPI，unprotectMasterKey 明确报 UNSUPPORTED_PLATFORM', {
  skip: process.platform === 'win32' ? 'Windows 上有 DPAPI' : false,
}, () => {
  const anyBlob = Buffer.concat([Buffer.from('DPAPI'), crypto.randomBytes(32)]).toString('base64');
  assert.throws(() => unprotectMasterKey(anyBlob), (e) => {
    assert.equal(e.code, ErrorCode.UNSUPPORTED_PLATFORM);
    assert.ok(e.recovery.length > 0);
    return true;
  });
});

test('unprotectMasterKey rejects empty/invalid encrypted_key', () => {
  // 非 Windows 平台会先命中 UNSUPPORTED_PLATFORM，属于预期行为而非缺陷
  const expected = isSupportedPlatform()
    ? (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED
    : (e) => e.code === ErrorCode.UNSUPPORTED_PLATFORM;
  assert.throws(() => unprotectMasterKey(''), expected);
  assert.throws(() => unprotectMasterKey(null), expected);
});

test('unprotectMasterKey on non-DPAPI blob -> CREDENTIALS_MALFORMED', () => {
  const bad = Buffer.from('NOTDPAPI' + 'x'.repeat(30)).toString('base64');
  const expected = isSupportedPlatform()
    ? (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED
    : (e) => e.code === ErrorCode.UNSUPPORTED_PLATFORM;
  assert.throws(() => unprotectMasterKey(bad), expected);
});

test('real DPAPI round trip (Windows only)', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(ps)) return;

  const key = crypto.randomBytes(32);
  const b64 = key.toString('base64');
  const p = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ` +
    `$b=[Convert]::FromBase64String('${b64}'); ` +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))`,
  ], { encoding: 'utf8' });
  if (p.status !== 0) return;

  const wrapped = Buffer.concat([Buffer.from('DPAPI'), Buffer.from(p.stdout.trim(), 'base64')]).toString('base64');
  assert.deepEqual(unprotectMasterKey(wrapped), key);
});
