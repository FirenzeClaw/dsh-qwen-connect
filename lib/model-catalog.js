/**
 * 动态模型目录：从上游 `/api/v2/model/list` 拉取当前账号**实际可用**的模型。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────────
 * 静态回退目录只有账号类型未知时的三个保守选择。实测本机企业版返回 13 个
 * 模型（`flash` / `pro` / `qwen4-max` / `deepseek-flash` / `kimi-k3.1-pro` …），
 * 硬编码既漏掉用户真实可用的模型，也无法反映倍率变化。
 *
 * ⚠️ 与旧 README 的差异：曾有结论说 `/api/v2/model/list` 「需要 WASM 签名（403），
 * 因此只能静态内置」。该结论已过时——用签名会话请求该端点返回 **HTTP 200**
 * 且带完整 catalog（含 `is_vl` / `price_factor` / `context_config`）。
 * 403 只在**未签名**时出现。本模块因此可以直接拉取。
 *
 * ── 安全与降级 ──────────────────────────────────────────────────────
 * 拉取失败（离线 / 签名不可用 / 上游改契约）时**静默退回静态目录**，
 * 绝不让 provider 变成空列表——否则 DSH 的模型选择器会一片空白，
 * 用户连原来的对话能力都失去。
 *
 * @module dsh-qwen-connect/model-catalog
 */

import { FALLBACK_QWENWORK_MODELS, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from './models.js';

/** 上游模型目录端点（签名后可访问，实测 HTTP 200）。 */
export const MODEL_LIST_PATH = '/api/v2/model/list';

/**
 * 默认放行的模型 id。
 *
 * 用户要求「只保留 DeepSeek-V4.1-Flash」：企业版有 13 个模型，倍率从 0.1 到
 * 2.4 不等，全量暴露容易让人误选到最贵的那个。只保留这一个是有意的收敛，
 * 需要别的模型时改这条白名单即可。
 */
export const DEFAULT_ALLOWED_MODEL_IDS = Object.freeze(['deepseek-flash']);

/**
 * 把上游一条 catalog 记录转成插件内部的模型形状。
 *
 * 字段映射全部取自实测响应，不做推测：
 *   key                 → id
 *   i18n.display_name.zh（或 display_name）→ shortName
 *   price_factor        → billingRate
 *   is_vl               → supportsImages
 *   max_input_tokens    → contextWindow
 *   context_config 的值 → availableContextWindows（按 token_count 升序）
 *
 * @param {any} raw 上游 catalog 记录
 * @returns {object | null} 不可用（禁用/缺 key/缺名称）时返回 null
 */
export function normalizeCatalogEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (id === '') return null;
  // enable 明确为 false 的模型不接入——上游已声明它不可选
  if (raw.enable === false) return null;

  const name =
    (typeof raw.i18n?.display_name?.zh === 'string' && raw.i18n.display_name.zh !== ''
      ? raw.i18n.display_name.zh
      : null)
    ?? (typeof raw.display_name === 'string' && raw.display_name !== '' ? raw.display_name : null)
    ?? id;

  const contextWindow =
    Number.isFinite(raw.max_input_tokens) && raw.max_input_tokens > 0
      ? raw.max_input_tokens
      : MAX_INPUT_TOKENS;

  // context_config 形如 { '1M': { token_count: 1000000, is_default: true }, '200K': {...} }
  const windows = [];
  const cfg = raw.context_config;
  if (cfg !== null && typeof cfg === 'object') {
    for (const value of Object.values(cfg)) {
      const tokens = value?.token_count;
      if (Number.isFinite(tokens) && tokens > 0) windows.push(tokens);
    }
  }
  windows.sort((a, b) => a - b);

  return {
    id,
    shortName: name,
    billingRate: Number.isFinite(raw.price_factor) ? raw.price_factor : 1,
    supportsImages: raw.is_vl === true,
    contextWindow,
    availableContextWindows: windows.length > 0 ? windows : [contextWindow],
    maxTokens: MAX_OUTPUT_TOKENS,
    isDefault: raw.is_default === true,
    isNew: raw.is_new === true,
  };
}

/**
 * 从上游 catalog 响应里取出可用模型列表。
 *
 * 只读 `qwork` 分组：那是普通对话模型的归属（实测其余分组 chat / developer /
 * assistant / inline / quest / nap / experts 均为空数组）。
 *
 * @param {any} payload `/api/v2/model/list` 的 JSON 响应
 * @returns {Array<object>} 按上游顺序（已含 is_default 优先的语义）
 */
export function extractCatalogModels(payload) {
  const list = payload?.qwork;
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const model = normalizeCatalogEntry(raw);
    if (model === null) continue;
    if (seen.has(model.id)) continue; // 上游理论上不会重复，防御性去重
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/**
 * 按白名单过滤模型。
 *
 * @param {Array<object>} models
 * @param {readonly string[] | null | undefined} allowed
 *        未提供时用 `DEFAULT_ALLOWED_MODEL_IDS`；显式传空数组表示不限制。
 * @returns {Array<object>}
 */
export function filterModels(models, allowed) {
  if (!Array.isArray(models)) return [];
  const whitelist = allowed === undefined || allowed === null ? DEFAULT_ALLOWED_MODEL_IDS : allowed;
  if (whitelist.length === 0) return models;
  const keep = new Set(whitelist);
  return models.filter((m) => keep.has(m.id));
}

/**
 * 拉取并规范化上游模型目录。
 *
 * @param {{
 *   signer: { signRequest: Function },
 *   fetchImpl?: typeof fetch,
 *   endpoint?: string,
 *   timeoutMs?: number,
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 * @returns {Promise<Array<object>>} 失败时抛错，由调用方决定是否降级
 */
export async function fetchUpstreamModels(deps) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const endpoint = deps.endpoint ?? 'https://gateway.qwenwork.cn';
  const timeoutMs = deps.timeoutMs ?? 15_000;

  const signed = await deps.signer.signRequest({ path: MODEL_LIST_PATH, method: 'GET' });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${endpoint}${MODEL_LIST_PATH}`, {
      method: 'GET',
      headers: { ...signed.headers, accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`模型目录请求失败：HTTP ${res.status}`);
    }
    const json = await res.json();
    return extractCatalogModels(json);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析本次运行最终使用的模型目录。
 *
 * 顺序：
 *   1. 调用方显式给定的 `models`（测试/覆盖）
 *   2. 上游动态目录（成功后按白名单过滤）
 *   3. 静态回退目录（同样过滤）——保证 provider 永不为空
 *
 * ⚠️ 过滤后若为空，**回退到静态目录再过滤一次**；仍为空则不加过滤地返回
 * 静态目录。理由：白名单配错（例如上游把 `deepseek-flash` 改名）不应该让
 * 用户失去所有模型，宁可多显示一个也不显示零个。
 *
 * @param {{ models?: Array<object>, allowed?: readonly string[], signer?: any,
 *           fetchImpl?: typeof fetch, logger?: any }} [opts]
 * @returns {Promise<{ models: Array<object>, source: 'override'|'upstream'|'fallback'|'fallback-unfiltered' }>}
 */
export async function resolveModelCatalog(opts = {}) {
  const allowed = opts.allowed ?? DEFAULT_ALLOWED_MODEL_IDS;

  if (Array.isArray(opts.models)) {
    return { models: filterModels(opts.models, allowed), source: 'override' };
  }

  if (opts.signer !== undefined && opts.signer !== null) {
    try {
      const upstream = await fetchUpstreamModels({
        signer: opts.signer,
        fetchImpl: opts.fetchImpl,
        logger: opts.logger,
      });
      const filtered = filterModels(upstream, allowed);
      if (filtered.length > 0) {
        return { models: filtered, source: 'upstream' };
      }
      opts.logger?.warn?.(
        `dsh-qwen-connect: 上游有 ${upstream.length} 个模型，但白名单 [${allowed.join(', ')}] 全部未命中；改用静态目录`,
      );
    } catch (error) {
      opts.logger?.warn?.(
        `dsh-qwen-connect: 拉取上游模型目录失败（${error?.message ?? error}），改用静态目录`,
      );
    }
  }

  const fallback = filterModels(FALLBACK_QWENWORK_MODELS, allowed);
  if (fallback.length > 0) {
    return { models: fallback, source: 'fallback' };
  }
  // 白名单与静态目录也不相交：宁可多给一个可用模型，也不要给空列表
  opts.logger?.warn?.(
    `dsh-qwen-connect: 白名单 [${allowed.join(', ')}] 与静态目录无交集，回退为不过滤`,
  );
  return { models: [...FALLBACK_QWENWORK_MODELS], source: 'fallback-unfiltered' };
}
