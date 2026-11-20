/**
 * host 侧插件入口：注册 `qwenwork` provider，并挂载设置卡片的状态路由。
 *
 * 设计要点：
 *  - provider 路由以**本地登录态**驱动（非 API Key 型），token 由
 *    `./credentials-seam.js` 从 t1 产物按需取得，绝不落盘到本插件。
 *  - 阶段 B 的聊天能力尚未打通（签名生成在阶段 A）：因此**只注册 provider
 *    与其模型目录**，让模型能出现在 DSH 选择器里；真正的 SSE 转发留出清晰
 *    接缝（见 `createQwenWorkAdapter` 的 `baseUrl` 注释）。
 *  - 任何一步失败都不得抛出到 DSH loader —— 抛出去会触发红色
 *    "Failed to load plugins" 横幅，并连累设置卡片一起不可见。
 *
 * @module dsh-qwen-connect
 */

import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

import {
  DEFAULT_THINKING_LEVELS,
  FALLBACK_QWENWORK_MODELS,
  QWENWORK_PROVIDER,
  THINKING_LEVEL_IDS,
  catalogForCard,
  toPiModel,
} from './models.js';
import { DEFAULT_ALLOWED_MODEL_IDS, filterModels } from './model-catalog.js';
import {
  createQwenWorkRuntime,
  describeDefaultConfig,
  enabledThinkingLevels,
  thinkingFieldOf,
} from './runtime.js';
import {
  getAccountContext,
  isWired,
} from './credentials-seam.js';
import { registerQwenWorkStatusRoute } from './web-status.js';
import { perfSummary } from './perf.js';

/** 稳定的 Cordis 插件名。 */
export const name = 'llm-qwenwork';

/** provider 注册前必须就绪的模型注册表。 */
export const inject = ['llm'];

/** 拥有设置卡片的设置命名空间。 */
export const QWENWORK_SETTINGS_NS = 'qwenwork';

/** 单个流读取挂起时的空闲上限。 */
export const QWENWORK_STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * 插件配置 schema。
 *
 * 这份 schema 有两个作用：
 *   1. **校验**：DSH 在加载本行时按它校验 `config`；
 *   2. **描述**：设置页的配置表单据此渲染——但表单本身由本插件的客户端
 *      （`lib/client.js` 的 `plugins.row.config` 槽位）绘制，见那里的说明。
 *
 * ⚠️ 更正一条曾经的错误结论：DSH **不会**因为导出 `Config` 就自动生成表单。
 * 真正提供表单数据/写入通道的是 `plugins.row.config` / `plugins.bundle.config`
 * 这两个槽位——owner 把 `form.state`（已接受的值）与 `form.mutate`（带版本
 * 围栏的写入）交给注册者，由注册者自己画控件。不注册就只剩校验，页面上
 * 什么都不会出现。
 *
 * 字段都是「用户真正会改」的：
 *   - allowedModelIds：模型白名单
 *   - refreshCatalogOnStart：启动时是否从上游拉目录
 *   - showCredits：是否在输入框旁显示积分
 *   - thinkingEnabled：思考总开关（关掉即完全不思考，省积分）
 *   - thinkingLow / Medium / High / Xhigh / Max：允许出现在选择器里的档位
 */
export const Config = z.object({
  // ⚠️ 每个字段都必须 `.volatile()`，否则**整份配置都不会被 DSH 当作可编辑**。
  //
  // dsh-settings 的两道门都要求它：
  //   describe() 里 `if (volatileForm(schema) === undefined) return []`
  //     —— 一个 volatile 字段都没有时，本条目**根本不进配置列表**，
  //        客户端拿到的 form 是 undefined，表单永远显示「正在读取配置…」；
  //   write() 里 `if (form === undefined) throw 'has no volatile fields'`
  //     —— 就算绕过第一道门，每次写入也会被拒。
  // 这两个症状都不报错、只是「没有反应」，所以必须由测试守住
  // （见 test/unit/thinking-config.test.mjs 的 volatile 断言）。
  //
  // volatile 的语义是「可以热改，不需要重启」——与本插件的实现一致：
  // apply() 重新执行即读到新值，模型目录与思考档位都是 getter。
  allowedModelIds: z
    .array(z.string())
    .default([...DEFAULT_ALLOWED_MODEL_IDS])
    .description('允许出现在模型选择器里的模型 id。留空表示不限制（显示上游全部模型）。')
    .volatile(),
  refreshCatalogOnStart: z
    .boolean()
    .default(true)
    .description('启动时从上游拉取模型目录。关闭后只使用内置目录。')
    .volatile(),
  showCredits: z
    .boolean()
    .default(true)
    .description('在输入框右侧显示千问剩余积分。')
    .volatile(),
  thinkingEnabled: z
    .boolean()
    .default(true)
    .description(
      '允许模型思考。关闭后请求一律按「不思考」发出（reasoning_effort=none），'
        + '更快更省积分，但复杂任务的质量会下降。',
    )
    .volatile(),
  ...Object.fromEntries(
    THINKING_LEVEL_IDS.map((level) => [
      `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      z
        .boolean()
        .default(DEFAULT_THINKING_LEVELS.includes(level))
        .description(
          `在模型选择器的思考深度里提供「${level}」档。`
            + '只影响可选项；不选就等于上游默认档。',
        )
        .volatile(),
    ]),
  ),
});

// 配置读取的三个辅助函数（`configValue` / `readConfigBoolean` /
// `readConfigList`）已随实例化一起搬到 `./runtime.js`：它们只服务于
// 「把宿主配置读成实例快照」这一件事，留在入口文件里会让状态归属模糊。
// `thinkingFieldOf` 与 `enabledThinkingLevels` 是纯函数，也从那里转出。
export { thinkingFieldOf, enabledThinkingLevels };

/**
 * pi-ai 的认证面置为惰性：本路由的凭据完全来自 `resolveApiKey`（它在每次
 * 请求时向接缝索取最新 token），pi-ai 自身的凭据生命周期与环境发现都不得
 * 为其凭空制造出一个凭据。
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error('dsh-qwen-connect: the qwenwork route has no pi-ai credential lifecycle');
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    },
  },
};

/** 订阅制额度无法给出按 token 计价，报零。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 阶段 A-2：聊天数据面已接通。
 *
 * `baseUrl` 现在指向**本插件的环回 shim**（`./chat-shim.js`）。shim 负责：
 *   1. 把 pi-ai 的 OpenAI 协议请求转成 QwenWork 的推理请求；
 *   2. 用官方 WASM 生成签名（`Authorization: Bearer COSY.<...>`）并加密 body；
 *   3. 把上游的双层信封 SSE 转回标准 OpenAI SSE。
 *
 * ⚠️ `baseUrl` 在 shim 真正监听成功前是 `null`；此时 `createProvider` 会
 * 拿到一个不可达地址，模型仍会出现在选择器里（不阻断设置卡片），但发起
 * 对话会明确失败——**不会静默失败**。
 *
 * 之所以用 shim 而非直接 fetch 上游：pi-ai 只说 OpenAI 协议，而签名与
 * 加密只能在 Node 侧完成，且签名头绝不能被 `Bearer <accessToken>` 覆盖。
 */
const SHIM_UNAVAILABLE_BASE_URL = 'http://127.0.0.1:1/qwenwork-shim-unavailable';

/**
 * 从 DSH 上下文取图片链路所需的服务。
 *
 * 与官方 provider 完全同构：
 *   - `ctx.get('attachments')`            → 持久化附件服务
 *   - `resolveImageAttachmentAccess(...)` → 把附件引用映射成可读文本
 *
 * 任何一步取不到都**返回空对象**（而不是半套配置）——
 * 这样 `createQwenWorkAdapter` 不会注册 `resolveAttachments`，
 * 模型描述符也就不会声明 image，避免「声明支持却一用就抛
 * `pi-ai image input requires the durable attachment service`」。
 *
 * @param {any} ctx DSH 插件上下文
 * @returns {{ resolveAttachments?: () => any, resolveImageAccess?: Function }}
 */
function imageDepsFrom(ctx) {
  try {
    if (typeof ctx?.get !== 'function') return {};
    const attachments = ctx.get('attachments');
    if (attachments === undefined || attachments === null) return {};
    return {
      resolveAttachments: () => attachments,
      resolveImageAccess: (svc, ref) => {
        // ctx.get('fs') 可能不存在（取决于宿主配置）；缺失时只给附件 id，
        // 不影响图片数据本身的读取（readImageRequest 走 attachments）。
        const mapHostPath =
          typeof ctx.get === 'function'
            ? (hostPath) => ctx.get('fs')?.processPathFromHostPath?.(hostPath)
            : undefined;
        return resolveImageAttachmentAccess(svc, mapHostPath, ref);
      },
    };
  } catch {
    return {};
  }
}

/**
 * 组装 provider。`getModels` 每次读取都重建列表，因此后续接入动态目录时
 * 无需重建 provider 实例。
 *
 * @param {() => string} getBaseUrl 返回当前 shim 的 baseUrl
 * @param {() => (string | null) | Promise<string | null>} getSharedSecret
 *        返回 shim 的共享密钥；未就绪时可为 `null`。允许返回 Promise——
 *        调用方会在未就绪时等待 shim 启动，而不是拿 null 去发无鉴权请求。
 * @param {{ resolveAttachments?: () => any, resolveImageAccess?: (attachments: any, ref: any) => string }} [image]
 *        图片链路接入点。由 apply() 从 ctx 取 DSH 的附件服务后传入
 *        （与官方 provider 的做法一致：`ctx.get('attachments')`）。
 *        不传时模型只能收文本——但那时模型描述符也不应声明 image。
 * @param {{ models?: () => Array<object> }} [catalog]
 *        模型目录来源。`models()` 返回当前应暴露的模型形状数组
 *        （由 `lib/model-catalog.js` 按上游动态目录 + 白名单解析）。
 *        缺省时退回静态内置目录——保证未传入时行为与旧版一致。
 */
function createQwenWorkAdapter(getBaseUrl, getSharedSecret, image = {}, catalog = {}) {
  // 图片能力**由附件服务是否可用决定**：只有 pi-ai 拿到了
  // `resolveAttachments`，声明 image 才是真的能用；否则声明了也会在
  // 发图时抛错。两者必须同步，这是本项目反复出现的「声明与实现一致」原则。
  const imagesAvailable = typeof image.resolveAttachments === 'function';

  /** 当前生效的模型形状；每次读取都重建，便于动态目录热更新。 */
  const currentModels = () =>
    typeof catalog.models === 'function' ? catalog.models() : FALLBACK_QWENWORK_MODELS;

  /**
   * 启用中的思考档位；每次读取都与 config 同步。
   *
   * 必须**每次重建**（与 models 的 getter 同理）：用户改设置后要立刻生效，
   * 不能等到重启——那正是上一个缺陷的形态。
   */
  const enabledLevels = () =>
    typeof catalog.thinkingLevels === 'function'
      ? catalog.thinkingLevels()
      : DEFAULT_THINKING_LEVELS;

  const buildModels = () =>
    currentModels().map((info) =>
      toPiModel(info, getBaseUrl(), {
        supportsImages: imagesAvailable,
        thinkingLevels: enabledLevels(),
      }),
    );

  const provider = {
    ...createProvider({
      id: QWENWORK_PROVIDER,
      name: 'QwenWork',
      auth: {
        apiKey: {
          name: 'QwenWork desktop session',
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: 'QwenWork' };
          },
        },
      },
      /**
       * ⚠️ 必须用 getter，不能在构造时求值一次。
       *
       * `createProvider` 的实现是 `getModels: () => input.models`——它把
       * **构造那一刻的数组引用**捕获下来。若这里写 `models: buildModels()`，
       * 之后无论目录怎么变，`listModels()` 都只返回最初那一份，
       * 模型选择器必须重启 DSH 才能更新。
       *
       * 用 getter 后每次 `getModels()` 都重新执行 buildModels()，目录改动
       * 立即生效（前提是再触发 `llm/adapters-updated` 让客户端重新拉取）。
       */
      get models() {
        return buildModels();
      },
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const buildProfile = () => ({
    provider: QWENWORK_PROVIDER,
    displayName: 'QwenWork',
    streamIdleTimeoutMs: QWENWORK_STREAM_IDLE_TIMEOUT_MS,
    // ⚠️ 显式对齐所有超时点（曾排查「长思考必超时」）：
    //   - timeoutMs                  —— OpenAI SDK 的请求级超时（未设时虽不生效，
    //                                  但显式给出可排除「某层默认 30-120s」的嫌疑）
    //   - websocketConnectTimeoutMs  —— SDK 若走 WS 通道的连接超时
    //   - streamIdleTimeoutMs        —— 流内空闲看门狗
    // 长思考请求总时长可达 1-2 分钟（高峰期响应头都可能 >60s），
    // 任何一层短于此都会把「慢但能成」的请求掐成 TIMEOUT。
    timeoutMs: 300_000,
    websocketConnectTimeoutMs: 300_000,
    // ⚠️ 重试**只由这一层决定**（规格 FR-001..FR-004）：shim 已退化为单次
    // 尝试，两层叠乘会让一次 503 变成最多 3×5=15 次上游请求。
    //
    // 刻意去掉 `TIMEOUT`（默认集合里是有的）：
    //   上游响应头超时是 180 秒，且几乎总是「上游高峰排队」——重试等于再等
    //   180 秒、再撞同一堵墙。保留它会让用户看到「转圈 15 分钟」，而这正是
    //   规格 SC-001 要求从最坏 15 分钟降到 3 分钟以内的那个场景。
    //   其它四类失败（空回复 / 限流 / 服务端 5xx / 传输中断）仍按 5 轮指数
    //   退避重试，且每轮重走 shim 会重新签名。
    retryPolicy: resolveRetryPolicy(
      {
        mode: 'normal',
        retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TRANSPORT'],
      },
      'dsh-qwen-connect retryPolicy',
    ),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    // 图片链路限额：模型声明支持 image 后，pi-ai 会按这些上限决定
    // 「原样内联」还是「降级为文本占位符」。取值与官方 provider 一致。
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    piProvider: provider,
  });

  let profiles = new Map([[QWENWORK_PROVIDER, buildProfile()]]);

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    /**
     * 返回 shim 共享密钥而非 access token：pi-ai 会把它放进
     * `Authorization: Bearer`，shim 用它做进程级鉴别。这样 access token
     * 完全不经过 pi-ai 层，只在 shim 内部使用。
     *
     * ⚠️ **绝不能在 shim 未就绪时返回 `null`**：
     * `dsh-llm-pi-ai` 的 `profileOptions()` 只对 `undefined` 省略 apiKey
     * （`apiKey === void 0 ? {} : { apiKey }`），`null` 会被原样传给 SDK，
     * 于是请求不带鉴权头 → shim 返回 401 → **所有模型全部失败**
     * （表现为 "All models failed"）。
     *
     * 因此这里在未就绪时**等待** shim 就绪；确实起不来才抛错，
     * 让失败原因明确可见，而不是退化成「无密钥」。
     */
    resolveApiKey: async () => {
      const ready = await getSharedSecret();
      if (typeof ready !== 'string' || ready === '') {
        throw new Error(
          'dsh-qwen-connect: chat shim is not ready; cannot obtain the shared secret for pi-ai',
        );
      }
      return ready;
    },
    /**
     * 图片链路：把 DSH 的「持久化附件服务」接给 pi-ai。
     *
     * pi-ai 在消息含图片时要求 `resolveAttachments()` 返回附件服务，
     * 否则直接抛 `pi-ai image input requires the durable attachment service`。
     * 官方 provider（dsh-llm-pi-ai / dsh-llm-deepseek）就是这么接的：
     *   resolveAttachments: () => ctx.get('attachments')
     *   resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(...)
     *
     * 只有**同时**声明模型支持 image，这条链路才会被走到；
     * 两者缺一都会出问题（声明 image 但无服务 → 抛错；有服务但不声明 → 走不到）。
     */
    ...(typeof image.resolveAttachments === 'function'
      ? { resolveAttachments: () => image.resolveAttachments() }
      : {}),
    ...(typeof image.resolveImageAccess === 'function'
      ? {
          resolveImageAccess: (attachments, ref) => image.resolveImageAccess(attachments, ref),
        }
      : {}),
  });

  return {
    adapter,
    invalidate: () => {
      profiles = new Map([[QWENWORK_PROVIDER, buildProfile()]]);
    },
  };
}

/**
 * shim 的进程级单例。多个 provider 实例共享同一个监听端口，避免端口泄漏。
 *
 * @type {Promise<{ baseUrl: string, port: number, close: () => Promise<void> }> | null}
 */
let shimPromise = null;
/** shim 就绪后缓存的 baseUrl；未就绪为 null。 */
let shimBaseUrl = null;
/** shim 就绪后缓存的共享密钥；未就绪为 null（绝不下发浏览器）。 */
let shimSharedSecret = null;

/**
 * 当前生效的装配实例——**唯一允许跨装配存在的运行时引用**。
 *
 * 它只被三类「沙封装」读取：状态路由、排障导出（`describeEffectiveConfig` /
 * `describeModelCatalog` / `refreshModelCatalog`）、以及进程级 shim 里那两个
 * 「读当前配置」的回调。除此之外的所有可变状态都在实例内部，随 `dispose()`
 * 一起消失。
 *
 * 为什么 shim 要读它而不是持有某个实例：shim 是进程级的（一个登录态、一个
 * 端口），实例可能换很多次。若 shim 捕获了旧实例，改配置后它还会按旧白名单
 * 与旧档位工作。
 *
 * @type {ReturnType<typeof createQwenWorkRuntime> | null}
 */
let activeRuntime = null;

/**
 * 供状态路由/诊断读取当前配置（脱敏，无凭据）。
 *
 * 配置属于**装配实例**。从未装配时返回默认值——排障入口必须始终可用
 * （FR-008），不能因为插件没加载就抛错或返回 undefined。
 */
export function describeEffectiveConfig() {
  return activeRuntime === null ? describeDefaultConfig() : activeRuntime.describeConfig();
}

/**
 * 在后台解析动态模型目录并替换实例的目录。
 *
 * 委托给当前实例；从未装配时直接返回默认描述（排障入口始终可用）。
 *
 * @param {{ logger?: any, notify?: boolean }} [opts]
 * @returns {Promise<{ source: string, count: number, changed: boolean }>}
 */
export async function refreshModelCatalog(opts = {}) {
  if (activeRuntime === null) {
    return { source: 'fallback', count: 0, changed: false };
  }
  return activeRuntime.refreshCatalog(opts);
}

/** 供诊断/测试读取当前目录与来源。未装配时给出「静态目录 ∩ 默认白名单」。 */
export function describeModelCatalog() {
  if (activeRuntime !== null) return activeRuntime.describeCatalog();
  return {
    source: 'fallback',
    models: filterModels(FALLBACK_QWENWORK_MODELS, DEFAULT_ALLOWED_MODEL_IDS).map((m) => m.id),
  };
}

/**
 * 惰性启动环回聊天 shim。
 *
 * 失败不抛出：provider 仍要注册（否则模型不会出现在选择器里，设置卡片也
 * 会因 provider 缺失而信息不全），但 `shimBaseUrl` 保持 null，发起对话时
 * 会得到明确错误而非静默失败。
 *
 * @param {{ logger?: any }} [opts]
 * @returns {Promise<string | null>}
 */
export async function ensureChatShim(opts = {}) {
  if (shimBaseUrl !== null) return shimBaseUrl;
  if (shimPromise === null) {
    shimPromise = (async () => {
      // 从约定入口导入（实现在 chat-shim.js，signer-shim.js 是稳定转发层）
      const { startChatShim } = await import('./signer-shim.js');
      const { getValidCredential } = await import('./credentials-seam.js');
      const { DEFAULT_ENDPOINT } = await import('./signer-session.js');
      return startChatShim({
        // 走 t1 接缝而非直读磁盘：接缝内部处理 token 过期自动刷新与
        // refresh-token 轮换回写，避免与 t1 形成两套凭据代际。
        getCredential: async () => getValidCredential(),
        endpoint: DEFAULT_ENDPOINT,
        logger: opts.logger,
        // 动态目录：上游新模型（如 deepseek-flash）的 is_vl 不在静态目录里。
        //
        // ⚠️ 读 `activeRuntime` 而不是捕获某个实例：shim 是进程级的（一个登录态、
        // 一个环回端口），而装配实例可能换很多次。捕获旧实例的话，改配置之后
        // shim 还会按旧白名单与旧档位工作。
        //
        // 插件被禁用（`activeRuntime === null`）时返回空目录：没有任何模型可
        // 解析能力，请求会走「不认识这个模型」的明确失败，而不是悄悄套用旧配置。
        getModelCatalog: () => (activeRuntime === null ? [] : activeRuntime.models()),
        // 思考总开关：关掉后 shim 把每一档都退回 none，而不只是把档位藏起来。
        getThinking: () =>
          activeRuntime === null
            ? { enabled: false, levels: [] }
            : activeRuntime.thinking(),
      });
    })();
    shimPromise.catch((error) => {
      opts.logger?.warn?.('dsh-qwen-connect: chat shim failed to start', error);
      shimPromise = null;
    });
  }
  try {
    const shim = await shimPromise;
    shimBaseUrl = shim.baseUrl;
    shimSharedSecret = shim.sharedSecret ?? null;
    opts.logger?.info?.(`dsh-qwen-connect: chat shim listening on 127.0.0.1:${shim.port}`);
    return shimBaseUrl;
  } catch {
    return null;
  }
}

/** 供测试/卸载使用：关闭 shim 并清空单例。 */
export async function stopChatShim() {
  const pending = shimPromise;
  shimPromise = null;
  shimBaseUrl = null;
  shimSharedSecret = null;
  if (pending === null) return;
  try {
    const shim = await pending;
    await shim.close();
  } catch {
    /* 已失败或已关闭 */
  }
}

/** 当前 shim 的 baseUrl（未就绪返回 null）。 */
export function chatShimBaseUrl() {
  return shimBaseUrl;
}

/** 当前 shim 的共享密钥（未就绪返回 null）。仅供进程内 resolveApiKey 使用，绝不下发。 */
export function chatShimSharedSecret() {
  return shimSharedSecret;
}

/**
 * 插件装配。
 *
 * 关键约束：**返回值必须是 undefined**。Cordis 把 `apply()` 的返回值当 effect
 * 处理——`_execute`（`node_modules/@deepseek-ai/cordis/lib/index.js:1135`）只在
 * 「函数 / null / undefined / thenable / 可迭代」时接受，普通对象会记一条
 * `TypeError: Invalid effect`（不抛给调用方，但日志里是红的）。因此实例留在
 * `activeRuntime` 指针，清理走 `ctx.effect`。
 *
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  // ---- 设置卡片数据源 ------------------------------------------------
  // 无论 provider 是否注册成功，卡片都要能显示——它是阶段 B 的主要可见成果。
  //
  // 模态文案与 provider 的模型声明共用**同一判定来源**（附件服务是否可用），
  // 否则卡片会写着「仅文本」而选择器实际能收图。
  const cardImagesAvailable = typeof imageDepsFrom(ctx).resolveAttachments === 'function';
  ctx.inject(['webServer'], (webCtx) => {
    registerQwenWorkStatusRoute(webCtx, {
      getAccountContext,
      tokenAvailable: isWired,
      // 读 activeRuntime 而非某个捕获的实例：状态路由要反映「此刻生效的东西」。
      models: () =>
        activeRuntime === null
          ? []
          : activeRuntime.modelsForCard({ supportsImages: cardImagesAvailable }),
      // 生效配置：卡片据此显示白名单/开关状态，并在 showCredits=false 时
      // 不产出额度字段（把「关闭积分」落在数据层，而不是客户端藏起来）。
      config: describeEffectiveConfig,
      // 上游实测性能（首 token 延迟 / 输出速率）——由 shim 采样累积。
      perf: perfSummary,
      provider: QWENWORK_PROVIDER,
    });
  });

  // ---- 装配实例 ------------------------------------------------------
  //
  // `config` 由 DSH 按上面导出的 `Config` schema 校验并注入（标了 volatile 的
  // 字段是只读引用，由 runtime 的 `configValue()` 解开）。
  //
  // 所有属于「这一次装配」的状态——配置快照、模型目录、适配器注册句柄——
  // 都收进实例；宿主改配置时 Cordis 走 restart() → dispose → 重新 apply()，
  // 旧状态随实例一起消失，不会污染下一次装配。
  const runtime = createQwenWorkRuntime({
    ctx,
    config,
    getBaseUrl: () => shimBaseUrl ?? SHIM_UNAVAILABLE_BASE_URL,
    getSharedSecret: async () => shimSharedSecret,
    image: imageDepsFrom(ctx),
    logger: ctx.logger,
  });
  activeRuntime = runtime;

  const effective = runtime.describeConfig();

  // ---- provider 注册 --------------------------------------------------
  //
  // 先启动 shim，再注册 provider：`getModels()` 才能拿到真实 baseUrl。
  // 即便 shim 启动失败（例如 wasm.bin 缺失），也照常注册 provider —— 让模型
  // 仍出现在选择器、设置卡片信息完整，同时对话请求给出明确错误。
  void ensureChatShim({ logger: ctx.logger })
    .then((baseUrl) => {
      if (baseUrl === null) {
        ctx.logger?.warn?.(
          'dsh-qwen-connect: chat shim unavailable; qwenwork models will be listed but chat requests will fail',
        );
      }
    })
    .catch(() => {
      /* ensureChatShim 内部已兜底 */
    });

  try {
    // 适配器用**函数**读实例状态：改设置后下一次读取即生效，无需重建 provider。
    runtime.register((catalog) =>
      createQwenWorkAdapter(
        () => shimBaseUrl ?? SHIM_UNAVAILABLE_BASE_URL,
        // 等待 shim 就绪后再取密钥：apply() 里的 ensureChatShim() 是异步的，
        // 而 pi-ai 可能在它就绪前就调用 resolveApiKey。返回 null 会让请求
        // 丢掉鉴权头（见 resolveApiKey 处注释），因此这里必须 await。
        async () => {
          if (shimSharedSecret !== null) return shimSharedSecret;
          await ensureChatShim({ logger: ctx.logger }).catch(() => null);
          return shimSharedSecret;
        },
        // 图片链路：从 ctx 取 DSH 的附件服务（与官方 provider 同一做法）。
        // 服务缺失时 **不** 传 resolveAttachments —— 此时模型描述符也不会声明
        // image（见 resolveImageSupport），保证「声明」与「能力」始终一致。
        imageDepsFrom(ctx),
        catalog,
      ),
    );

    const releaseDirectory = ctx.llm.registerConfigurableProviders([
      {
        provider: QWENWORK_PROVIDER,
        displayName: 'QwenWork',
        settingsNs: QWENWORK_SETTINGS_NS,
        settingsPath: [],
        declared: false,
      },
    ]);

    // 清理登记：实例释放 + 目录注册释放。`ctx.effect` 在 Cordis 里可能不存在
    // （测试桩件、旧版本），退化为立即执行的兜底路径，绝不把异常抛给 loader。
    try {
      ctx.effect(() => () => {
        releaseDirectory?.();
        runtime.dispose();
        if (activeRuntime === runtime) activeRuntime = null;
      });
    } catch (error) {
      // 宿主没有可用的 effect 语义：无法在卸载时清理，因此**主动撤销**这次
      // 注册（fail closed）。宁可 provider 不出现，也不要留下一个无人能释放
      // 的注册与实例——后者会让「禁用插件」看起来生效了、实际仍在服务。
      ctx.logger?.warn?.(
        'dsh-qwen-connect: 宿主未提供 ctx.effect，无法登记清理；已撤销本次注册',
        error,
      );
      releaseDirectory?.();
      runtime.dispose();
      if (activeRuntime === runtime) activeRuntime = null;
      return;
    }
    ctx.logger?.info?.('dsh-qwen-connect: qwenwork provider registered (phase A-2, shim-backed)');

    // provider 已注册、句柄可用，现在才做首次目录解析（可安全广播）。
    // `refreshCatalogOnStart=false` 时跳过：用户明确要求只用内置目录。
    if (effective.refreshCatalogOnStart) {
      void runtime.refreshCatalog({ logger: ctx.logger, notify: true });
    } else {
      ctx.logger?.info?.(
        'dsh-qwen-connect: 已按配置跳过上游目录拉取（refreshCatalogOnStart=false），使用内置目录',
      );
    }
  } catch (error) {
    ctx.logger?.error('dsh-qwen-connect: provider registration failed', error);
  }
}

export {
  FALLBACK_QWENWORK_MODELS,
  QWENWORK_PROVIDER,
  createQwenWorkAdapter,
  SHIM_UNAVAILABLE_BASE_URL,
};
