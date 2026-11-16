/**
 * 静态内置的模型目录。
 *
 * 来源：QwenWorkCN 桌面 App 日志中的模型列表（`rawModels` 字段，实测取得）。
 * 阶段 B 不依赖 upstream 动态拉取，保证离线时 provider 不会是空的。
 *
 * 三个模型均取自 App 实际返回，未臆造：
 *   pro                  — 高级（默认模型，isDefault: true）
 *   flash                — 标准｜Qwen3.8-Flash（tags: ["is_recommend"]）
 *   qwen3.8-max-preview  — Qwen3.8-Max（isNew: true，官方描述「千问最强模型」）
 *
 * @module dsh-qwen-connect/models
 */

/** 本插件拥有的 provider 路由 id。 */
export const QWENWORK_PROVIDER = 'qwenwork';

/**
 * 思考深度（reasoning effort）的档位词表与线值映射。
 *
 * ── 为什么需要一张显式映射表 ──────────────────────────────────────
 * DSH（经 pi-ai）与千问上游用的是**两套不同的词表**：
 *
 * | pi-ai 档位 | 上游 `reasoning_effort` | 说明 |
 * |---|---|---|
 * | `off`     | `none`  | 关闭思考 |
 * | `minimal` | ——      | **上游没有这一档**，必须挡住 |
 * | `low`     | `low`   | |
 * | `medium`  | `medium`| |
 * | `high`    | `high`  | |
 * | `xhigh`   | `xhigh` | 不声明就不会出现在选择器里 |
 * | `max`     | `max`   | 同上（实测上游确实接受，见 README） |
 *
 * pi-ai 的 `getSupportedThinkingLevels()` 规则：`xhigh` / `max` 只有在
 * `thinkingLevelMap` 里**显式给了映射**时才可选；其余档位只要没映射成 `null`
 * 就默认可选。所以「支持哪些档位」完全由这张表的 `null` / 线值决定。
 *
 * ── `off` 为什么恒为 null ─────────────────────────────────────────
 * pi-ai 的信道里，「用户选了 off」与「用户什么都没选」**发出去的内容完全相同**
 * （两种情况都走 `thinkingLevelMap.off` 这一个线值）。一旦把 `off` 映射成
 * `'none'`，任何没有主动选过档位的会话都会变成「关闭思考」——那不是用户的
 * 选择，而是实现细节泄漏成了默认行为。
 *
 * 因此这里不暴露 `off`；关闭思考走配置里的**总开关**
 * （见 `lib/index.js` 的 `thinkingEnabled`），那是显式的、不会误伤的路径。
 */
export const THINKING_LEVEL_WIRE = Object.freeze({
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
});

/** 可配置的扩散档位 id（顺序即选择器里的升序）。 */
export const THINKING_LEVEL_IDS = Object.freeze(Object.keys(THINKING_LEVEL_WIRE));

/** 默认全部启用——上游实际支持哪几档就暴露哪几档。 */
export const DEFAULT_THINKING_LEVELS = Object.freeze([...THINKING_LEVEL_IDS]);

/** 上游认得的全部线值（含关闭）。用于校验/归一化传入值。 */
const UPSTREAM_EFFORTS = new Set(['none', ...Object.values(THINKING_LEVEL_WIRE)]);

/**
 * 生成 pi-ai 的 `thinkingLevelMap`：把启用的档位映射成上游线值。
 *
 * 未启用的档位映射为 `null`（pi-ai 约定：`null` = 不提供该档）。
 *
 * @param {readonly string[] | undefined} enabled 启用的档位 id；缺省用全部
 * @returns {Record<string, string | null>}
 */
export function buildThinkingLevelMap(enabled) {
  const allowed = new Set(
    Array.isArray(enabled) ? enabled : DEFAULT_THINKING_LEVELS,
  );
  const map = {
    // 见上方说明：off / minimal 恒不提供。
    off: null,
    minimal: null,
  };
  for (const [level, wire] of Object.entries(THINKING_LEVEL_WIRE)) {
    map[level] = allowed.has(level) ? wire : null;
  }
  return map;
}

/**
 * 是否有任何一个思考档位可用。全关时不能声明 `reasoning`。
 *
 * DSH 的 `normalizeModelInfo` 会拒绝空 efforts（`INVALID_MODEL_REASONING`），
 * 所以「全关」必须走 `reasoning: false` 而不是「声明了但一档都没有」。
 *
 * @param {readonly string[] | undefined} enabled
 * @returns {boolean}
 */
export function hasThinkingLevels(enabled) {
  const allowed = new Set(
    Array.isArray(enabled) ? enabled : DEFAULT_THINKING_LEVELS,
  );
  return THINKING_LEVEL_IDS.some((level) => allowed.has(level));
}

/**
 * 把「客户端请求里的思考深度」归一化成上游线值。
 *
 * 接受两种形态，因为上游请求可能来自 pi-ai（已是线值）也可能来自手工调用
 * （可能是 pi-ai 的档位 id）：
 *   - pi-ai 档位 id：`off` → `none`、`minimal` → `low`（上游无此档）
 *   - 上游线值：`none` / `low` / `medium` / `high` / `xhigh` / `max` 原样通过
 *
 * 未知值返回 `undefined`：宁可不发，也不要让上游因为一个它不认识的枚举值
 * 把整次请求判成 400。
 *
 * @param {unknown} raw
 * @param {{ enabled?: boolean }} [thinking] 总开关；`enabled === false` 强制关闭
 * @returns {'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined}
 */
export function normalizeReasoningEffort(raw, thinking = {}) {
  if (thinking.enabled === false) return 'none';
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  if (value === 'off' || value === 'disabled') return 'none';
  if (value === 'minimal') return 'low';
  return UPSTREAM_EFFORTS.has(value) ? value : undefined;
}

/**
 * 上下文窗口与输出上限。
 *
 * ⚠️ **`MAX_INPUT_TOKENS` 必须与发给上游的 `model_config.max_input_tokens` 一致**
 * （见 `signer-session.js` 的 `buildInferBody`）。
 *
 * 真实上限的确定过程（教训记录）：
 *   1. App 日志表格列标注「1M」
 *   2. Buddy2api 的 `model_config.max_input_tokens` 写 180000
 *   3. 曾照搬 180000 —— **实测证明是错的**：
 *      probe-context-limit*.mjs 的对照实验显示
 *      ≈150K/200K/400K/700K/850K/1.0M/1.2M tokens 全部被上游接受，
 *      ≈1.5M 才被拒（"Error in upstream response"）。
 *      → 真实上限在 1.2M~1.5M 之间，「1M」是保守而合理的声明值。
 *
 * 声明与实现不一致是本项目反复出现的一类缺陷；这次是**照搬外部值未实测**。
 */
export const MAX_INPUT_TOKENS = 1_000_000;
/** 单次回复的输出上限（与 `parameters.max_tokens` 一致）。 */
export const MAX_OUTPUT_TOKENS = 32000;

/**
 * 静态回退目录。
 *
 * 每条都直接取自 App 日志的 `rawModels`，未臆造任何字段：
 * `priceFactor` → `billingRate`，`isVl` → `supportsImages`，
 * `defaultContextWindow` → `contextWindow`，
 * `availableContextWindows` → 原样保留（三档：200K / 400K / 1M）。
 *
 * @type {Array<{
 *   id: string,
 *   name: string,
 *   description: string,
 *   billingRate: number,
 *   supportsImages: boolean,
 *   contextWindow: number,
 *   availableContextWindows: number[],
 *   maxTokens: number,
 *   isDefault?: boolean,
 *   isRecommended?: boolean,
 *   isNew?: boolean,
 * }>}
 */
/**
 * 上游模型**具备视觉能力**（App 的 `rawModels` 里 `is_vl: true`），
 * 因此这里如实声明 `supportsImages: true`。
 *
 * 但声明只是前提之一——DSH 走图片路径还需要**两个条件同时满足**：
 *   ① 模型描述符声明 image 模态
 *   ② pi-ai 配置了 `resolveAttachments`（DSH 的持久化附件服务）
 *
 * 若只有 ① 没有 ②，DSH 会直接抛
 * `pi-ai image input requires the durable attachment service`（连文本对话都失败）；
 * 若只有 ② 没有 ①，图片会被投影成文本占位符，用户传了图却等于没传。
 *
 * 因此 `toPiModel` 接受 `{ supportsImages }` 覆盖：**由调用方按附件服务
 * 是否可用传入**，保证「声明」与「能力」始终一致（见 lib/index.js 的
 * `imageDepsFrom`）。
 *
 * ── 为什么把 deepseek-flash 放在**第一位** ────────────────────────────
 * 它是默认白名单里唯一的模型（见 `lib/model-catalog.js` 的
 * `DEFAULT_ALLOWED_MODEL_IDS`），也是实测本机企业版倍率最低（0.1）的
 * 通用模型。放在首位有两个作用：
 *   1. 动态目录还没解析完时，选择器先显示用户真正想要的那个；
 *   2. 离线 / 目录拉取失败时，白名单过滤能在静态目录里命中，不必降级成
 *      「不过滤」而冒出三个模型。
 * 其余三个是账号类型未知时的保守选项，仅在白名单放行时才可见。
 */
export const FALLBACK_QWENWORK_MODELS = [
  {
    id: 'deepseek-flash',
    shortName: 'DeepSeek-V4.1-Flash',
    billingRate: 0.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isNew: true,
  },
  {
    id: 'pro',
    shortName: '高级',
    billingRate: 1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isDefault: true,
  },
  {
    id: 'flash',
    shortName: '标准｜Qwen3.8-Flash',
    billingRate: 0.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isRecommended: true,
  },
  {
    id: 'qwen3.8-max-preview',
    shortName: 'Qwen3.8-Max',
    billingRate: 1.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isNew: true,
  },
];

/**
 * 把倍率格式化成选择器里显示的文本。
 *
 * 形态对齐 WorkBuddy（`Hy3 · x0.00 · 限时免费`）：
 *   - 0 倍率 → `免费`
 *   - 其它   → `x1.00` / `x0.10` / `x1.10`
 *
 * @param {number} rate
 * @returns {string}
 */
export function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '';
  if (rate === 0) return '免费';
  return `x${rate.toFixed(2)}`;
}

/**
 * 生成模型选择器里显示的名字：`名称 · 倍率 · 标记`。
 *
 * ⚠️ 这是**唯一的显示名来源**——DSH 的模型选择器渲染的就是 pi-ai 模型描述符
 * 的 `name` 字段（见 dsh-workbuddy-connect 的 `toPiModel`，它直接透传
 * 上游 `name`，而该值本身就形如 `Hy3 · x0.00 · 限时免费`）。
 * 倍率必须拼进 `name` 才会出现在选择器里；单独放 `billingRate` 字段
 * 只有设置卡片能看到。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @returns {string}
 */
export function displayName(info) {
  const parts = [info.shortName ?? info.id];
  const rate = formatRate(info.billingRate);
  if (rate !== '') parts.push(rate);
  if (info.isDefault === true) parts.push('默认');
  if (info.isRecommended === true) parts.push('推荐');
  if (info.isNew === true) parts.push('新');
  return parts.join(' · ');
}

/**
 * 卡片与选择器共用的描述文案。
 *
 * 模态文案必须**跟随实际声明**，不能写死：`toPiModel` 会按附件服务是否可用
 * 决定是否声明 image（见 `supportsImages` 的说明）。写死「仅文本」会造成
 * 卡片说不能收图、而选择器实际能收——同一条信息在两个界面上自相矛盾。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @param {{ supportsImages?: boolean }} [opts] 与 toPiModel 使用同一判定结果
 * @returns {string}
 */
function describeModel(info, opts = {}) {
  const rate = formatRate(info.billingRate);
  const ctx = info.contextWindow >= 1000000 ? '1M' : `${Math.round(info.contextWindow / 1000)}K`;
  const supportsImages = opts.supportsImages ?? info.supportsImages === true;
  return [
    supportsImages ? '文本+图片' : '仅文本',
    ctx,
    rate === '' ? undefined : rate === '免费' ? '免费' : rate,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * 供卡片展示的精简模型行。
 *
 * @param {{ supportsImages?: boolean, models?: Array<object> }} [opts]
 *        `supportsImages` 由调用方按附件服务是否可用传入，与 provider 的
 *        模型声明保持同一来源；`models` 是当前生效目录（动态目录解析后为
 *        上游实际可用的模型），缺省时退回静态目录。
 */
export function catalogForCard(opts = {}) {
  const source = Array.isArray(opts.models) ? opts.models : FALLBACK_QWENWORK_MODELS;
  return source.map((model) => ({
    id: model.id,
    // 卡片显示短名（倍率已单独成列），选择器则用带倍率的长名。
    name: model.shortName ?? model.id,
    description: describeModel(model, opts),
    rate: model.billingRate,
    ...(model.isDefault === true ? { isDefault: true } : {}),
    ...(model.isRecommended === true ? { isRecommended: true } : {}),
    ...(model.isNew === true ? { isNew: true } : {}),
  }));
}

/**
 * 把静态目录条目转成 pi-ai 的模型描述符。
 *
 * `name` 是**模型选择器显示的那一行文本**——因此这里用 `displayName()`
 * 把倍率拼进去（形如 `高级 · x1.00 · 默认`），否则选择器只会显示干巴巴的
 * 名称，用户看不到谁贵谁便宜。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @param {string} baseUrl 该 provider 的请求基址
 * @param {{ supportsImages?: boolean, thinkingLevels?: readonly string[] }} [opts]
 *        `supportsImages` 覆盖：**由调用方按附件服务是否可用传入**。
 *        不传则沿用目录里的声明。这样当宿主没有附件服务时，模态会退回
 *        `['text']`，避免 DSH 走图片路径后抛
 *        `pi-ai image input requires the durable attachment service`。
 *
 *        `thinkingLevels` 是**启用的思考档位**（见 `lib/index.js` 的配置项）。
 *        给了才声明 `thinkingLevelMap`；全关时不声明 `reasoning`——DSH 会拒绝
 *        空 efforts（`INVALID_MODEL_REASONING`）。
 */
export function toPiModel(info, baseUrl, opts = {}) {
  const supportsImages = opts.supportsImages ?? info.supportsImages === true;
  const thinkingLevels = opts.thinkingLevels;
  const thinkingEnabled = hasThinkingLevels(thinkingLevels);
  return {
    id: info.id,
    name: displayName(info),
    api: 'openai-completions',
    provider: QWENWORK_PROVIDER,
    baseUrl,
    input: supportsImages ? ['text', 'image'] : ['text'],
    /**
     * 上游确实返回思维链，置 true 让 pi-ai 把 `reasoning_content` 识别为
     * 独立的 thinking 块，而不是混进正文渲染。
     *
     * 实测依据：glm-5.2 在 `choices[0].delta.reasoning_content` 里给出思维链
     * （见 research/probe-reasoning-vs-content.mjs）。此前置 false 时，思维链
     * 会被当作普通 text 输出，用户会在回答里看到模型的内心独白。
     *
     * ⚠️ 这个布尔只决定「能否输出思考」，**不决定思考多深**。深度由
     * `thinkingLevelMap` + 请求里的 `reasoning_effort` 决定（见文件头的映射表）。
     * 用户在设置里把档位全关时，这里必须是 false。
     */
    reasoning: thinkingEnabled,
    ...(thinkingEnabled
      ? { thinkingLevelMap: buildThinkingLevelMap(thinkingLevels) }
      : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  };
}
