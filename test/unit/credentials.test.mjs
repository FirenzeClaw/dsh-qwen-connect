import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  loadCredentials,
  probeCredentials,
  normalizeCredentials,
  isTokenExpired,
  describeCredentials,
  encryptV10,
  encryptV11,
  decryptV10,
  decryptV11,
  deriveLinuxKey,
  detectPayloadVersion,
  defaultAppDataDir,
  AUTH_V2_FILE,
  AUTH_V1_FILE,
  LOCAL_STATE_FILE,
} from '../../lib/credentials.js';
import { ErrorCode, QwenAuthError } from '../../lib/errors.js';

const KEY = crypto.randomBytes(32);
/** Linux 夹具用的口令（对应 Secret Service 里的 Safe Storage 口令）。 */
const SECRET = 'test-secret-password';

/**
 * 造一个凭据目录夹具。
 *
 * Windows 走 `Local State` + DPAPI 主密钥；Linux 走 v11 + Secret Service 口令。
 * 测试通过 `secretPassword` 注入口令，避免真的去读系统密钥环。
 */
function makeFixtureDir({ authV2 = null, authV1 = null, encryptedKeyB64, omitLocalState = false, masterKey = KEY } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwencred-'));
  if (!omitLocalState) {
    const keyB64 = encryptedKeyB64 ?? Buffer.concat([Buffer.from('DPAPI'), KEY]).toString('base64');
    fs.writeFileSync(path.join(dir, LOCAL_STATE_FILE), JSON.stringify({ os_crypt: { encrypted_key: keyB64 } }));
  }
  const enc = process.platform === 'win32'
    ? (t) => encryptV10(t, masterKey)
    : (t) => encryptV11(t, SECRET);
  if (authV2) fs.writeFileSync(path.join(dir, AUTH_V2_FILE), enc(JSON.stringify(authV2)));
  if (authV1) fs.writeFileSync(path.join(dir, AUTH_V1_FILE), enc(JSON.stringify(authV1)));
  return dir;
}

/** 按平台补齐解密凭据所需的参数（Linux 注入口令，Windows 依赖 DPAPI）。 */
function platformOpts(dir) {
  return process.platform === 'win32' ? { appDataDir: dir } : { appDataDir: dir, secretPassword: SECRET };
}

const V2 = {
  schemaVersion: 2,
  token: 'tok-'.padEnd(60, 'a'),
  refreshToken: 'rt-'.padEnd(40, 'b'),
  expiresAt: '2099-09-18T03:29:01Z',
  refreshTokenExpiresAt: '2099-09-11T04:28:59.905Z',
  user: { id: '11111111-2222-3333-4444-555555555555', name: 'Tester', username: 'tester', email: 't@example.invalid', tier: 'Free', planId: 'subscription-cn-free' },
  identityVersion: 0,
  loginMethod: 'browser',
  refreshStrategy: 'device_token',
  loginDeviceId: 'device-uuid-0001',
  loginTimestamp: 1700000000,
};

test('defaultAppDataDir points at APPDATA/QwenWorkCN (Windows) or XDG (Linux)', () => {
  if (process.platform === 'win32') {
    const d = defaultAppDataDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
    assert.equal(d, path.join('C:\\Users\\x\\AppData\\Roaming', 'QwenWorkCN'));
    return;
  }
  // Linux/Electron：userDataPath 位于 XDG 配置目录
  const d = defaultAppDataDir({ XDG_CONFIG_HOME: '/tmp/xdg-home', HOME: '/home/x' });
  assert.equal(d, path.join('/tmp/xdg-home', 'QwenWorkCN'));
  // 未显式设置 XDG_CONFIG_HOME 时回退到 $HOME/.config
  const d2 = defaultAppDataDir({ HOME: '/home/x' });
  assert.equal(d2, path.join('/home/x', '.config', 'QwenWorkCN'));
});

test('normalizeCredentials parses auth-v2 shape', () => {
  const c = normalizeCredentials(V2, { source: 'auth-v2' });
  assert.equal(c.schemaVersion, 2);
  assert.equal(c.loginDeviceId, 'device-uuid-0001');
  assert.equal(c.refreshStrategy, 'device_token');
  assert.equal(c.user.tier, 'Free');
  assert.equal(c.user.planId, 'subscription-cn-free');
  assert.ok(c.expiresAt instanceof Date);
  assert.equal(c.expiresAt.toISOString(), '2099-09-18T03:29:01.000Z');
  assert.ok(c.refreshTokenExpiresAt instanceof Date);
});

test('normalizeCredentials parses legacy auth-v1 shape', () => {
  const c = normalizeCredentials({ token: 'legacy', refreshToken: 'r', expiresAt: '2099-01-01T00:00:00Z', user: { id: 'u', name: 'n', tier: 'Free' } });
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.loginDeviceId, null);
  assert.equal(c.refreshStrategy, null);
  assert.equal(c.refreshTokenExpiresAt, null);
});

test('normalizeCredentials without token -> SCHEMA_INVALID', () => {
  assert.throws(() => normalizeCredentials({ user: {} }), (e) => e.code === ErrorCode.SCHEMA_INVALID);
});

test('normalizeCredentials keeps masterKey in memory for write-back', () => {
  const c = normalizeCredentials(V2, { masterKey: KEY });
  assert.deepEqual(c.masterKey, KEY);
});

test('isTokenExpired applies 60s skew', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(isTokenExpired({ expiresAt: new Date(now + 10_000) }, 60_000, now), true);
  assert.equal(isTokenExpired({ expiresAt: new Date(now + 120_000) }, 60_000, now), false);
  assert.equal(isTokenExpired({ expiresAt: null }, 60_000, now), false);
});

test('describeCredentials never leaks token plaintext', () => {
  const c = normalizeCredentials(V2, { source: 'auth-v2' });
  const d = describeCredentials(c);
  const s = JSON.stringify(d);
  assert.ok(!s.includes(V2.token));
  assert.ok(!s.includes(V2.refreshToken));
  assert.equal(d.hasToken, true);
  assert.equal(d.tokenLength, V2.token.length);
});

test('loadCredentials without credential files -> CREDENTIALS_MISSING', () => {
  // Windows 下缺 Local State 就是缺凭据；Linux 下由口令路径报同类错误
  const dir = makeFixtureDir({ authV2: V2, omitLocalState: true });
  if (process.platform !== 'win32') {
    // Linux 不依赖 Local State，改为断言「目录里没有任何凭据文件」
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwencred-'));
    assert.throws(() => loadCredentials(platformOpts(emptyDir)), (e) => e.code === ErrorCode.CREDENTIALS_MISSING);
    return;
  }
  assert.throws(() => loadCredentials({ appDataDir: dir }), (e) => {
    assert.ok(e instanceof QwenAuthError);
    assert.equal(e.code, ErrorCode.CREDENTIALS_MISSING);
    assert.match(e.recovery, /QwenWorkCN/);
    return true;
  });
});

test('Local State without encrypted_key -> CREDENTIALS_MALFORMED (Windows only)', {
  skip: process.platform !== 'win32' ? 'DPAPI/Local State 是 Windows 专有路径' : false,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwencred-'));
  fs.writeFileSync(path.join(dir, LOCAL_STATE_FILE), JSON.stringify({ os_crypt: {} }));
  assert.throws(() => loadCredentials({ appDataDir: dir }), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('Local State not JSON -> CREDENTIALS_MALFORMED (Windows only)', {
  skip: process.platform !== 'win32' ? 'DPAPI/Local State 是 Windows 专有路径' : false,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwencred-'));
  fs.writeFileSync(path.join(dir, LOCAL_STATE_FILE), 'not json');
  assert.throws(() => loadCredentials({ appDataDir: dir }), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('probeCredentials returns structured error instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwencred-'));
  const r = probeCredentials({ appDataDir: dir });
  assert.equal(r.ok, false);
  assert.ok(r.error.code);
  assert.equal(typeof r.error.recovery, 'string');
});

test('probeCredentials never returns token on failure', () => {
  if (process.platform === 'win32') {
    const dir = makeFixtureDir({ authV2: V2, encryptedKeyB64: 'not-a-real-key' });
    const r = probeCredentials({ appDataDir: dir });
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(V2.token));
    return;
  }
  // Linux：错口令必然解不开，且失败结果里不得出现 token
  const dir = makeFixtureDir({ authV2: V2 });
  const r = probeCredentials({ appDataDir: dir, secretPassword: 'wrong-password' });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(V2.token));
});

test('decryptCredentialsFile round trips a fixture end to end', () => {
  const dir = makeFixtureDir({ authV2: V2 });
  const file = path.join(dir, AUTH_V2_FILE);
  const blob = fs.readFileSync(file);
  const text = process.platform === 'win32' ? decryptV10(blob, KEY) : decryptV11(blob, SECRET);
  const raw = JSON.parse(text);
  assert.equal(raw.token, V2.token);
  assert.equal(raw.user.name, 'Tester');
});

test('legacy auth.dat can be decrypted and normalized', () => {
  const legacy = { token: 'legacy-token', refreshToken: 'legacy-rt', expiresAt: '2099-01-01T00:00:00Z', user: { id: 'u1', name: 'Legacy', tier: 'Free' } };
  const dir = makeFixtureDir({ authV1: legacy });
  const file = path.join(dir, AUTH_V1_FILE);
  const blob = fs.readFileSync(file);
  const text = process.platform === 'win32' ? decryptV10(blob, KEY) : decryptV11(blob, SECRET);
  const c = normalizeCredentials(JSON.parse(text), { source: 'auth-v1' });
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.token, 'legacy-token');
});

test('detectPayloadVersion distinguishes v10 and v11', () => {
  assert.equal(detectPayloadVersion(encryptV10('{}', KEY)), 'v10');
  assert.equal(detectPayloadVersion(encryptV11('{}', SECRET)), 'v11');
  assert.equal(detectPayloadVersion(Buffer.from('nope')), null);
  assert.equal(detectPayloadVersion(Buffer.from('v1')), null);
});

test('v11 round trip: encryptV11 -> decryptV11', () => {
  const plain = JSON.stringify({ token: 'x'.repeat(20), user: { name: '中文用户名' } });
  const blob = encryptV11(plain, SECRET);
  assert.equal(blob.subarray(0, 3).toString('ascii'), 'v11');
  assert.equal(decryptV11(blob, SECRET), plain);
  // 中文必须原样还原（UTF-8 往返）
  assert.ok(decryptV11(blob, SECRET).includes('中文用户名'));
});

test('v11 with wrong password -> DECRYPT_FAILED and no plaintext leak', () => {
  const secret = JSON.stringify({ token: 'super-secret-token' });
  const blob = encryptV11(secret, SECRET);
  assert.throws(() => decryptV11(blob, 'wrong-password'), (e) => {
    assert.equal(e.code, ErrorCode.DECRYPT_FAILED);
    assert.ok(!e.message.includes('super-secret-token'));
    return true;
  });
});

test('deriveLinuxKey is deterministic and 16 bytes (AES-128)', () => {
  const a = deriveLinuxKey(SECRET);
  const b = deriveLinuxKey(SECRET);
  assert.equal(a.length, 16);
  assert.deepEqual(a, b);
  assert.notDeepEqual(deriveLinuxKey('other'), a);
  assert.throws(() => deriveLinuxKey(''), (e) => e.code === ErrorCode.CREDENTIALS_MISSING);
});

test('loadCredentials on Linux decrypts v11 with injected secret', {
  skip: process.platform === 'win32' ? 'Linux 专有路径' : false,
}, () => {
  const dir = makeFixtureDir({ authV2: V2 });
  const c = loadCredentials({ appDataDir: dir, secretPassword: SECRET });
  assert.equal(c.source, 'auth-v2');
  assert.equal(c.token, V2.token);
  // Linux 不持有 DPAPI 主密钥，但要持有口令以便回写
  assert.equal(c.masterKey, null);
  assert.equal(c.secretPassword, SECRET);
});
