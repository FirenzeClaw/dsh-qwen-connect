/**
 * 凭据解密与加载。
 *
 * 两种平台格式：
 *
 * **Windows（Chromium v10）**
 *   [0..3)    ASCII "v10"
 *   [3..15)   12 字节 AES-GCM nonce
 *   [15..n-16) 密文
 *   [n-16..n) 16 字节 GCM auth tag
 *   主密钥来自 `Local State` 的 os_crypt.encrypted_key（DPAPI 保护），32 字节。
 *
 * **Linux（Electron v11，实测为 CBC）**
 *   [0..3)    ASCII "v11"
 *   [3..n)    AES-128-CBC 密文，IV = 16 个空格字节
 *   主密钥 = PBKDF2-HMAC-SHA1(口令, "saltysalt", 1 轮, 16 字节)，
 *   口令取自 Secret Service（`chrome_libsecret_os_crypt_password_v2`，
 *   application=QwenWorkCN）。
 *
 *   ⚠️ 上游 Chromium 的 `os_crypt_linux.cc` 在 v11 上用的是 AES-128-**GCM**
 *   （nonce 前置 12 字节）。本机 App 1.3.1 的产物**不是**该形态：实测 GCM
 *   全部参数组合都认证失败，CBC + 空格 IV 才解出合法 JSON。因此这里按
 *   「先 GCM 后 CBC」逐个尝试，以实测为准而不是以文档为准。
 *
 * 安全约束：解密结果只在内存中持有；任何日志/错误信息都不得包含 token 明文。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { QwenAuthError, ErrorCode } from './errors.js';
import { unprotectMasterKey, isSupportedPlatform } from './dpapi.js';
import { readSecretServicePassword } from './secret-service.js';

export const AUTH_V2_FILE = 'auth-v2.dat';
export const AUTH_V1_FILE = 'auth.dat';
export const LOCAL_STATE_FILE = 'Local State';

const V10_PREFIX = Buffer.from('v10', 'ascii');
const V11_PREFIX = Buffer.from('v11', 'ascii');
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const IV_LENGTH = 16;
/** Linux CBC 的固定 IV：16 个 0x20（空格）字节，Chromium 的历史常量。 */
const LINUX_CBC_IV = Buffer.alloc(IV_LENGTH, 0x20);
const LINUX_SALT = 'saltysalt';
const MIN_PAYLOAD = NONCE_LENGTH + TAG_LENGTH; // 允许空明文：密文长度可以为 0

/** 默认凭据目录：Windows 为 %APPDATA%\QwenWorkCN，Linux 为 ~/.config/QwenWorkCN。 */
export function defaultAppDataDir(env = process.env) {
  // Linux/Electron：XDG 配置目录下的 QwenWorkCN（实测 App 1.3.1 的 userDataPath）
  if (process.platform !== 'win32') {
    const xdg = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? os.homedir(), '.config');
    return path.join(xdg, 'QwenWorkCN');
  }
  const roaming = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : null);
  if (!roaming) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, '无法确定 %APPDATA% 路径。');
  }
  return path.join(roaming, 'QwenWorkCN');
}

// ---------------------------------------------------------------------------
// 纯函数：AES-256-GCM 解密
// ---------------------------------------------------------------------------

/**
 * 解析 Chromium v10 载荷结构（不涉及密钥，便于单测）。
 * @param {Buffer} raw
 * @returns {{ nonce: Buffer, ciphertext: Buffer, tag: Buffer }}
 */
export function parseV10Payload(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < V10_PREFIX.length + MIN_PAYLOAD) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MALFORMED,
      `凭据文件过短（${raw?.length ?? 0} 字节），不是合法的 v10 载荷。`,
    );
  }
  const prefix = raw.subarray(0, 3);
  if (!prefix.equals(V10_PREFIX)) {
    const shown = prefix.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MALFORMED,
      `凭据前缀不是 "v10"（实际为 "${shown}"）。当前仅支持 Chromium v10 格式。`,
    );
  }
  return {
    nonce: raw.subarray(3, 3 + NONCE_LENGTH),
    ciphertext: raw.subarray(3 + NONCE_LENGTH, raw.length - TAG_LENGTH),
    tag: raw.subarray(raw.length - TAG_LENGTH),
  };
}

/**
 * 判断凭据载荷的前缀是 v10 还是 v11。
 * @param {Buffer} raw
 * @returns {'v10'|'v11'|null}
 */
export function detectPayloadVersion(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 3) return null;
  const prefix = raw.subarray(0, 3);
  if (prefix.equals(V10_PREFIX)) return 'v10';
  if (prefix.equals(V11_PREFIX)) return 'v11';
  return null;
}

/**
 * 由 Linux 口令派生 AES-128 密钥（PBKDF2-HMAC-SHA1，1 轮，16 字节）。
 *
 * 为什么是 1 轮：Chromium 的 Linux 实现在历史版本固定这个参数，
 * 目的是「不要把口令当明文存」，不是抗爆破。传错轮数会得到完全不同的密钥。
 *
 * @param {string} password Secret Service 里的口令
 * @returns {Buffer} 16 字节密钥
 */
export function deriveLinuxKey(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MISSING,
      'Secret Service 返回的 Safe Storage 口令为空。',
      { recovery: '请重新登录千问办公桌面应用，让系统密钥环重新写入口令。' },
    );
  }
  return crypto.pbkdf2Sync(password, LINUX_SALT, 1, IV_LENGTH, 'sha1');
}

/**
 * 解 Linux 的 v11 载荷。
 *
 * 按实测顺序尝试两种结构：
 *   ① AES-128-GCM，nonce 前置 12 字节（上游 Chromium 文档形态）
 *   ② AES-128-CBC，IV = 16 个空格（本机 App 1.3.1 实测形态）
 *
 * @param {Buffer} raw 含 v11 前缀的完整载荷
 * @param {string} password Secret Service 口令
 * @returns {string} UTF-8 明文
 */
export function decryptV11(raw, password) {
  if (!Buffer.isBuffer(raw) || raw.length <= 3) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MALFORMED, 'v11 载荷过短。');
  }
  const body = raw.subarray(3);
  const key = deriveLinuxKey(password);

  // ① GCM：nonce(12) + 密文 + tag(16)
  if (body.length > NONCE_LENGTH + TAG_LENGTH) {
    try {
      const nonce = body.subarray(0, NONCE_LENGTH);
      const rest = body.subarray(NONCE_LENGTH);
      const tag = rest.subarray(rest.length - TAG_LENGTH);
      const ciphertext = rest.subarray(0, rest.length - TAG_LENGTH);
      const d = crypto.createDecipheriv('aes-128-gcm', key, nonce, { authTagLength: TAG_LENGTH });
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
    } catch {
      /* 落到 CBC 分支 */
    }
  }

  // ② CBC：整段密文，IV 固定为空格
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, LINUX_CBC_IV);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch (e) {
    throw new QwenAuthError(
      ErrorCode.DECRYPT_FAILED,
      `v11 解密失败（GCM 与 CBC 均不成立）：${e.message}`,
      { recovery: '请重新登录千问办公桌面应用，让凭据与密钥环口令重新对齐。' },
    );
  }
}

/**
 * 用 AES-256-GCM 解出明文（纯函数，便于单测）。
 * @param {Buffer} raw 含 v10 前缀的完整载荷
 * @param {Buffer} masterKey 32 字节主密钥
 * @returns {string} UTF-8 明文
 */
export function decryptV10(raw, masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new QwenAuthError(
      ErrorCode.DECRYPT_FAILED,
      `主密钥长度必须为 32 字节（实际 ${masterKey?.length ?? 0}）。`,
    );
  }
  const { nonce, ciphertext, tag } = parseV10Payload(raw);
  let decipher;
  try {
    decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return out.toString('utf8');
  } catch (e) {
    throw new QwenAuthError(
      ErrorCode.DECRYPT_FAILED,
      `AES-GCM 解密失败（GCM 认证标签校验不通过或主密钥不匹配）：${e.message}`,
      { cause: e },
    );
  }
}

/**
 * 按 Chromium v10 格式加密（供测试构造 fixture 与回写使用）。
 * @param {string} plaintext
 * @param {Buffer} masterKey
 * @returns {Buffer} 含 v10 前缀的完整载荷
 */
export function encryptV10(plaintext, masterKey, nonce = crypto.randomBytes(NONCE_LENGTH)) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error('encryptV10: masterKey 必须为 32 字节');
  }
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`encryptV10: nonce 必须为 ${NONCE_LENGTH} 字节`);
  }
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, nonce, { authTagLength: TAG_LENGTH });
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([V10_PREFIX, nonce, body, cipher.getAuthTag()]);
}

/**
 * 按实测的 Linux v11 格式加密（AES-128-CBC，IV = 空格），用于回写。
 *
 * 为什么复用 CBC 而不是新写 GCM：回写必须生成 **App 自己能读** 的文件。
 * App 1.3.1 实测读的是 CBC 形态，写 GCM 会让 App 下次启动读不出登录态。
 *
 * @param {string} plaintext
 * @param {string} password Secret Service 口令
 * @returns {Buffer} 含 v11 前缀的完整载荷
 */
export function encryptV11(plaintext, password) {
  const key = deriveLinuxKey(password);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, LINUX_CBC_IV);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([V11_PREFIX, body]);
}

// ---------------------------------------------------------------------------
// 文件级读取
// ---------------------------------------------------------------------------

function readLocalState(dir) {
  const p = path.join(dir, LOCAL_STATE_FILE);
  if (!fs.existsSync(p)) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `未找到 Local State 文件：${p}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MALFORMED, `Local State 不是合法 JSON：${e.message}`, { cause: e });
  }
  const key = parsed?.os_crypt?.encrypted_key;
  if (!key) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MALFORMED,
      'Local State 中不存在 os_crypt.encrypted_key（该环境可能未启用 Chromium 加密存储）。',
    );
  }
  return key;
}

/**
 * 读取并解密指定凭据文件。
 * @param {string} file 完整路径
 * @param {{ kind: 'dpapi', key: Buffer } | { kind: 'libsecret', password: string } | Buffer} platformKey
 *   平台密钥。为兼容旧调用方，直接传 Buffer 时按 Windows 主密钥处理。
 * @returns {object} 解析后的 JSON
 */
export function decryptCredentialsFile(file, platformKey) {
  if (!fs.existsSync(file)) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `未找到凭据文件：${file}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `无法读取凭据文件：${e.message}`, { cause: e });
  }

  const version = detectPayloadVersion(raw);
  let text;
  if (version === 'v11') {
    // Linux 载荷：需要 Secret Service 口令
    const password = Buffer.isBuffer(platformKey)
      ? null
      : platformKey?.kind === 'libsecret' ? platformKey.password : null;
    if (password === null) {
      throw new QwenAuthError(
        ErrorCode.CREDENTIALS_MALFORMED,
        '凭据是 Linux v11 格式，但当前没有 Secret Service 口令可用。',
        { recovery: '在 Linux 上请确认系统密钥环已解锁，并已登录千问办公桌面应用。' },
      );
    }
    text = decryptV11(raw, password);
  } else {
    const masterKey = Buffer.isBuffer(platformKey) ? platformKey : platformKey?.key;
    text = decryptV10(raw, masterKey);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // 绝不把 text 打进错误信息
    throw new QwenAuthError(
      ErrorCode.SCHEMA_INVALID,
      `凭据解密后的内容不是合法 JSON（长度 ${text.length} 字符）。`,
      { cause: e },
    );
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new QwenAuthError(ErrorCode.SCHEMA_INVALID, '凭据 JSON 顶层不是对象。');
  }
  return json;
}

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------

/**
 * 把 auth-v2 / auth-v1 两种结构统一成内部凭据对象。
 * @param {object} raw 解密后的原始 JSON
 * @param {{ source: string }} meta
 */
export function normalizeCredentials(raw, meta = {}) {
  const token = typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : '';
  const refreshToken = typeof raw.refreshToken === 'string' && raw.refreshToken.length > 0 ? raw.refreshToken : '';
  if (!token) {
    throw new QwenAuthError(ErrorCode.SCHEMA_INVALID, '凭据中缺少 token 字段。');
  }

  const expiresAt = parseDate(raw.expiresAt);
  const refreshTokenExpiresAt = parseDate(raw.refreshTokenExpiresAt);

  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    token,
    refreshToken,
    expiresAt,
    refreshTokenExpiresAt,
    user: normalizeUser(raw.user),
    identityVersion: raw.identityVersion ?? 0,
    loginMethod: raw.loginMethod ?? null,
    refreshStrategy: raw.refreshStrategy ?? null,
    loginDeviceId: raw.loginDeviceId ?? null,
    loginTimestamp: raw.loginTimestamp ?? null,
    source: meta.source ?? null,
    sourceFile: meta.sourceFile ?? null,
    appDataDir: meta.appDataDir ?? null,
    // 回写加密凭据所需的 AES 主密钥；只驻留内存，绝不序列化到日志/配置
    masterKey: Buffer.isBuffer(meta.masterKey) ? meta.masterKey : null,
    // Linux 回写所需的 Secret Service 口令（与 masterKey 互斥）
    secretPassword: typeof meta.secretPassword === 'string' ? meta.secretPassword : null,
  };
}

function normalizeUser(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    id: u.id ?? null,
    name: u.name ?? null,
    username: u.username ?? null,
    email: u.email ?? null,
    tier: u.tier ?? null,
    planName: u.planName ?? null,
    planId: u.planId ?? null,
    isBiz: u.isBiz ?? false,
  };
}

function parseDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 解密并加载凭据（核心同步实现）。
 *
 * 优先读 auth-v2.dat（schemaVersion 2，当前版本），失败或不存在时回退 auth.dat。
 *
 * 平台差异：
 *   · Windows → `Local State` 的 DPAPI 主密钥 + v10/AES-GCM
 *   · Linux   → Secret Service 口令 + v11（GCM 优先，CBC 兜底）
 *
 * @param {{ appDataDir?: string, env?: NodeJS.ProcessEnv, prefer?: 'v2'|'v1',
 *   secretPassword?: string }} [opts]
 * @returns {object} 规范化凭据对象
 */
/**
 * 加载凭据：同步返回规范化对象，同时该对象也是 thenable，
 * 因此 `loadCredentials()` 与 `loadCredentials().then(...)` 两种写法都成立
 * （t1 契约的 verify 命令使用后者）。
 *
 * 失败时同步抛出带 `code` 的 QwenAuthError。
 */
export function loadCredentials(opts = {}) {
  return toThenable(loadCredentialsSync(opts));
}

/**
 * 把同步返回值包成「字段可直读、同时可 .then()」的对象。
 */
export function toThenable(value) {
  return Object.assign(Object.create(null), value, {
    then: (onFulfilled, onRejected) => Promise.resolve(value).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(value).catch(onRejected),
    finally: (handler) => Promise.resolve(value).finally(handler),
  });
}

/**
 * 解析当前平台的主密钥形态。
 *
 * Windows 返回 32 字节 AES 主密钥；Linux 返回 Secret Service 口令字符串。
 * 两者都只在内存中传递，绝不落盘或进日志。
 *
 * @param {string} dir 凭据目录
 * @param {object} opts
 * @returns {{ kind: 'dpapi', key: Buffer } | { kind: 'libsecret', password: string }}
 */
function resolvePlatformKey(dir, opts) {
  if (isSupportedPlatform()) {
    return { kind: 'dpapi', key: unprotectMasterKey(readLocalState(dir)) };
  }
  if (process.platform !== 'linux') {
    throw new QwenAuthError(
      ErrorCode.UNSUPPORTED_PLATFORM,
      `凭据解密仅支持 Windows DPAPI 与 Linux Secret Service，当前平台为 ${process.platform}。`,
    );
  }
  // Linux：口令可能由调用方注入（测试用），否则走 Secret Service
  const password = typeof opts.secretPassword === 'string' && opts.secretPassword !== ''
    ? opts.secretPassword
    : readSecretServicePassword({ application: opts.secretApplication ?? 'QwenWorkCN' });
  return { kind: 'libsecret', password };
}

/**
 * 纯同步实现（内部使用；对外统一走 thenable 包装的 loadCredentials）。
 * @param {{ appDataDir?: string, env?: NodeJS.ProcessEnv, prefer?: 'v2'|'v1',
 *   secretPassword?: string }} [opts]
 * @returns {object} 规范化凭据对象
 */
function loadCredentialsSync(opts = {}) {
  const dir = opts.appDataDir ?? defaultAppDataDir(opts.env);
  const platformKey = resolvePlatformKey(dir, opts);

  const order = opts.prefer === 'v1'
    ? [AUTH_V1_FILE, AUTH_V2_FILE]
    : [AUTH_V2_FILE, AUTH_V1_FILE];

  /** @type {QwenAuthError[]} */
  const failures = [];
  for (const name of order) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      failures.push(new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `未找到凭据文件：${file}`));
      continue;
    }
    try {
      const raw = decryptCredentialsFile(file, platformKey);
      return normalizeCredentials(raw, {
        source: name === AUTH_V2_FILE ? 'auth-v2' : 'auth-v1',
        sourceFile: file,
        appDataDir: dir,
        // Windows 保留主密钥用于回写；Linux 回写走同一口令，故不持有密钥
        masterKey: platformKey.kind === 'dpapi' ? platformKey.key : null,
        secretPassword: platformKey.kind === 'libsecret' ? platformKey.password : null,
      });
    } catch (e) {
      failures.push(e);
    }
  }

  // 全部候选都失败：优先抛出 ScheMA/解密类错误（比"文件不存在"更有诊断价值）
  const meaningful = failures.find(
    (e) => e.code !== ErrorCode.CREDENTIALS_MISSING,
  );
  throw meaningful ?? failures[0] ?? new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `凭据目录 ${dir} 下没有可用凭据文件。`);
}

/**
 * 探测凭据是否就绪（不抛异常的版本，适合设置卡片首次渲染）。
 * @returns {{ ok: true, credentials: object } | { ok: false, error: object }}
 */
export function probeCredentials(opts = {}) {
  try {
    return { ok: true, credentials: loadCredentials(opts) };
  } catch (e) {
    if (e instanceof QwenAuthError) {
      return { ok: false, error: e.toJSON() };
    }
    return {
      ok: false,
      error: { code: 'UNKNOWN', message: String(e?.message ?? e), recovery: '', retryable: false },
    };
  }
}

/**
 * 判断 token 是否已过期（带提前量，默认 60s，避免边界请求失败）。
 */
export function isTokenExpired(creds, skewMs = 60_000, now = Date.now()) {
  if (!creds?.expiresAt) return false; // 无过期信息时不主动刷新
  return creds.expiresAt.getTime() - skewMs <= now;
}

/** 生成不含任何敏感值的摘要，供日志使用 */
export function describeCredentials(creds) {
  return {
    source: creds.source,
    sourceFile: creds.sourceFile,
    schemaVersion: creds.schemaVersion,
    hasToken: Boolean(creds.token),
    tokenLength: creds.token?.length ?? 0,
    hasRefreshToken: Boolean(creds.refreshToken),
    expiresAt: creds.expiresAt?.toISOString() ?? null,
    refreshTokenExpiresAt: creds.refreshTokenExpiresAt?.toISOString() ?? null,
    loginDeviceIdPresent: Boolean(creds.loginDeviceId),
    refreshStrategy: creds.refreshStrategy,
    user: creds.user ? { id: maskId(creds.user.id), name: creds.user.name, tier: creds.user.tier, planId: creds.user.planId } : null,
  };
}

function maskId(id) {
  if (typeof id !== 'string' || id.length <= 8) return id ?? null;
  return `${id.slice(0, 8)}...`;
}
