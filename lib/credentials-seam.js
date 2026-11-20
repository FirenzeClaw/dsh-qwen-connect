/**
 * 与凭据 / REST 实现之间的**唯一接缝**。
 *
 * 设计意图：DSH 集成层不重复实现任何解密逻辑，只消费底层模块的产物。
 *
 * ── 对外只暴露调用方真正使用的入口 ──────────────────────────────
 * 接口面曾宽到 8 个入口，其中三个没有任何调用方：
 *
 *   · `loadImplementation()` —— 实现细节（模块加载器），不该是公开接口
 *   · `fetchQuota()` / `fetchPlan()` —— 各自调一次 `getAccountContext()`
 *     再摘字段。它们与 `getAccountContext()` 是同一份数据的三条路径，
 *     实测 `tools/seam-live-check.mjs` 因此连打三次同样的查询。
 *
 * 现在只留 5 个，且每个都有真实消费者：
 *
 *   getValidToken()      → 可用 token（REST 用）
 *   getValidCredential() → 刷新后的完整凭据（签名用）
 *   getAccountContext()  → user / plan / quota **一次查全**
 *   isWired()            → 卡片首屏的接入探测
 *   loadDiagnostic()     → 加载失败原因（排障用）
 *
 * ── 硬性约束 ────────────────────────────────────────────────────
 * **绝不硬编码任何积分/套餐数值。** 底层未就位时这里显式抛错，让卡片显示
 * 「尚未接入」，而不是显示一个看起来真实的假数字。
 *
 * @module dsh-qwen-connect/credentials-seam
 */

import { QwenAuthError, ErrorCode } from './errors.js';

/**
 * 底层实现模块的固定位置。
 *
 * 这里曾是**多路径探测**（`./auth.js` 与 `../src/auth.js` 都试），起因是开发
 * 中期实现主体从 `src/` 整体移到了 `lib/`。布局现已稳定：`package.json` 的
 * exports 指向 `./lib/`，仓库里也没有 `src/`，所以回退候选是纯粹的死分支。
 *
 * ⚠️ 当年多路径留下过一个教训，值得记住：若只记录**最后一个**失败，
 * `./auth.js` 存在但内含语法错误、`../src/auth.js` 不存在时，用户会看到
 * 「Cannot find module '../src/auth.js'」——真实原因（首个候选文件损坏）
 * 被回退分支掩盖了。单路径之后这个问题从结构上消失，但「错误必须指向
 * 真实原因、绝不静默降级」的要求不变，由 `tools/seam-failure-check.mjs`
 * 的情形 2 与情形 3 守着。
 */
const AUTH_MODULE = './auth.js';
const REST_MODULE = './rest.js';
const CREDENTIALS_MODULE = './credentials.js';

/** 缓存的实现对象；加载失败也为 null，允许后续重试。 */
let impl = null;
/** 上次加载失败的原因，用于给出可诊断的提示。 */
let loadNote = '';

/**
 * 加载一个模块；失败时把原因记进 `loadNote` 并返回 null。
 *
 * 绝不静默返回空值——调用方会看到 null，进而抛出带 recovery 的错误。
 *
 * @param {string} specifier
 * @returns {Promise<any | null>}
 */
async function importModule(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // MODULE_NOT_FOUND 表示「没找到」；SyntaxError 等表示「找到了但坏了」，
    // 后者信息量更大，因此原样带上错误名与消息。
    loadNote = `模块 ${specifier} 加载失败 [${/** @type {any} */ (err).code ?? err.name}]：${err.message}`;
    return null;
  }
}

/**
 * 惰性加载底层产物（内部函数，不对外导出）。
 *
 * 采用惰性 + 容错加载而非顶层静态 import：底层模块缺失时，`lib/index.js`
 * 仍必须能被 DSH 成功加载并注册 provider 骨架。顶层 import 失败会让整个
 * 插件（连同设置卡片）加载失败，触发 DSH 红色横幅。
 *
 * @returns {Promise<{ auth: any, rest: any, credentials: any | null } | null>}
 */
async function loadImplementation() {
  if (impl !== null) return impl;
  loadNote = '';
  const auth = await importModule(AUTH_MODULE);
  if (auth === null) return null;
  const rest = await importModule(REST_MODULE);
  if (rest === null) return null;
  // 凭据读取模块是可选的：只有 getValidToken() 退化为纯字符串时才用到
  const credentials = await importModule(CREDENTIALS_MODULE);
  impl = { auth, rest, credentials };
  return impl;
}

/** 底层未就绪时统一抛出的错误。该错误走正常卡片错误通道展示。 */
function notWired(what) {
  return new QwenAuthError(
    ErrorCode.CREDENTIALS_MISSING,
    `dsh-qwen-connect: ${what} 尚未接入（等待凭据/REST 模块交付）。`,
    {
      recovery:
        loadNote === ''
          ? '凭据模块尚未交付，请确认插件安装完整。'
          : `凭据模块加载失败：${loadNote}`,
      retryable: true,
    },
  );
}

/**
 * 从底层的 `getValidToken()` 返回里取出 token 字符串。
 *
 * ⚠️ 实测发现：底层返回的是 `{ token, credentials, refreshed }` **对象**，
 * 而契约写的是 `Promise<string>`。它的设计更适合刷新场景（带回了刷新后的
 * 完整凭据），因此这里做兼容适配：字符串直接用，对象取 `.token`。
 *
 * @param {unknown} value
 * @returns {string}
 */
function unwrapToken(value) {
  if (typeof value === 'string') {
    if (value === '') {
      throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, '凭据中的 token 为空。', {
        recovery: '请重新登录千问办公桌面应用。',
      });
    }
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const token = /** @type {any} */ (value).token;
    if (typeof token === 'string' && token !== '') return token;
  }
  throw new QwenAuthError(
    ErrorCode.CREDENTIALS_MISSING,
    `凭据模块返回的 token 形态不符合预期（收到 ${typeof value}）。`,
    { recovery: '内部接口不匹配，请联系插件维护者。' },
  );
}

/**
 * 取得当前有效的 access token（含过期自动刷新），**始终返回字符串**。
 *
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function getValidToken(opts) {
  const loaded = await loadImplementation();
  if (loaded === null || typeof loaded.auth?.getValidToken !== 'function') {
    throw notWired('getValidToken()');
  }
  return unwrapToken(await loaded.auth.getValidToken(opts));
}

/**
 * 取得**刷新后的完整凭据对象**（签名场景专用）。
 *
 * 为什么需要它（而不是复用 `getValidToken()` 再单独读磁盘）：
 *
 * WASM 签名除 token 外还要 `user.id` 与 `loginDeviceId`。早期实现直接
 * `loadCredentials()` 读磁盘，绕过了刷新链路，存在**两个真实缺陷**：
 *   1. token 已过期时拿到的是失效 token（签名请求会被 401/403 拒绝）；
 *   2. 与底层的 refresh-token 轮换回写（`persistRefreshedCredentials`）
 *      形成两套读取路径，可能双方持有不同代际的 refresh token。
 *
 * 底层的 `getValidToken()` 恰好返回 `{ token, credentials, refreshed }`，
 * 其中 `credentials` 就是**刷新后已回写**的完整归一化凭据。因此这里直接
 * 把它透出去，让签名走与 REST 完全相同的凭据来源。
 *
 * 安全：返回值含 token / masterKey，**只允许在内存中传递**，
 * 不得序列化进日志、卡片响应或任何落盘文件。
 *
 * @param {object} [opts]
 * @returns {Promise<any>} 归一化凭据对象（含 token / user / loginDeviceId）
 */
export async function getValidCredential(opts) {
  const loaded = await loadImplementation();
  if (loaded === null || typeof loaded.auth?.getValidToken !== 'function') {
    throw notWired('getValidCredential()');
  }
  const raw = await loaded.auth.getValidToken(opts);

  // 兼容两种形态：现返回 `{ token, credentials, refreshed }`；
  // 若未来退化为纯字符串，则退回磁盘读取（并保留 token 覆盖）。
  if (
    typeof raw === 'object' &&
    raw !== null &&
    typeof raw.credentials === 'object' &&
    raw.credentials !== null
  ) {
    return raw.credentials;
  }

  const token = unwrapToken(raw);
  const fallback = loaded.credentials?.loadCredentials;
  if (typeof fallback !== 'function') {
    throw notWired('loadCredentials()');
  }
  return { ...fallback(opts), token };
}

/**
 * 聚合账号上下文（user / plan / quota），形状与卡片后端约定一致。
 *
 * **一次查询拿全三项**：卡片需要的账号、套餐、积分都来自这同一个返回值。
 * 曾经 `fetchQuota()` 与 `fetchPlan()` 各自再调一次本函数，等于同样的数据
 * 查三遍——它们已删除，调用方直接读这里的 `plan` / `quota` 字段。
 *
 * @param {object} [opts]
 * @returns {Promise<any>}
 */
export async function getAccountContext(opts) {
  const loaded = await loadImplementation();
  if (loaded === null) throw notWired('getAccountContext()');

  const token = await getValidToken(opts);
  if (typeof loaded.rest?.fetchAccountOverview !== 'function') {
    throw notWired('fetchAccountOverview()');
  }
  return loaded.rest.fetchAccountOverview(token, opts);
}

/**
 * 该接缝当前是否已连上真实实现。供卡片显示接入状态。
 *
 * @returns {Promise<boolean>}
 */
export async function isWired() {
  const loaded = await loadImplementation();
  return loaded !== null && typeof loaded.auth?.getValidToken === 'function';
}

/** 供诊断使用：上次加载失败的原因（空串表示正常）。 */
export function loadDiagnostic() {
  return loadNote;
}
