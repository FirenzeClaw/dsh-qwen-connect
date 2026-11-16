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
  FALLBACK_QWENWORK_MODELS,
  QWENWORK_PROVIDER,
  catalogForCard,
  toPiModel,
} from './models.js';
import { DEFAULT_ALLOWED_MODEL_IDS, filterModels } from './model-catalog.js';
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
 * ⚠️ 这份导出是设置页能出现配置项的唯一前提：DSH 的 `settings` 服务从
 * **插件的 `Config` 导出**自动生成表单（`dsh-settings` 的 plainSchema 走
 * schemastery）。旧版用 `settings.installSection(...)` 手工注册，但该方法在
 * 当前 DSH 里已不存在——那段调用一直被 try/catch 静默吞掉，所以设置页
 * 从来没有出现过千问的配置项。
 *
 * 字段都是「用户真正会改」的：
 *   - allowedModelIds：模型白名单（本插件最常改的一项）
 *   - refreshCatalogOnStart：启动时是否从上游拉目录
 *   - showCredits：是否在输入框旁显示积分
 */
export const Config = z.object({
  allowedModelIds: z
    .array(z.string())
    .default([...DEFAULT_ALLOWED_MODEL_IDS])
    .description('允许出现在模型选择器里的模型 id。留空表示不限制（显示上游全部模型）。'),
  refreshCatalogOnStart: z
    .boolean()
    .default(true)
    .description('启动时从上游拉取模型目录。关闭后只使用内置目录。'),
  showCredits: z
    .boolean()
    .default(true)
    .description('在输入框右侧显示千问剩余积分。'),
});

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

  const buildModels = () =>
    currentModels().map((info) =>
      toPiModel(info, getBaseUrl(), { supportsImages: imagesAvailable }),
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
      models: buildModels(),
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
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-qwen-connect retryPolicy'),
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
 * 当前生效的模型目录（进程级单例）。
 *
 * 初始值**已按默认白名单过滤**：模型选择器在插件加载瞬间就要给出正确答案，
 * 而动态拉取是异步的。若初始值用未过滤的静态目录，选择器会先闪出 4 个模型
 * （apply-check 实测能看到 `[deepseek-flash,pro,flash,qwen3.8-max-preview]`），
 * 用户可能正好在这段时间选到不想暴露的模型。
 *
 * `apply()` 在后台解析上游目录后原地替换数组内容，`buildModels()` 每次读取
 * 都会看到最新值——无需重建 provider。
 *
 * @type {Array<object>}
 */
let activeModels = filterModels(FALLBACK_QWENWORK_MODELS, DEFAULT_ALLOWED_MODEL_IDS);

/** 动态目录的解析状态，供诊断与测试读取。 */
let catalogSource = 'fallback';

/**
 * 当前生效的配置（由 apply() 写入）。
 *
 * 读它的地方有两类：模型解析要按 `allowedModelIds` 过滤，状态路由要按
 * `showCredits` 决定是否给出积分。放在模块级而不是闭包里，是因为状态路由
 * 的 handler 在 apply() 之外构造。
 *
 * @type {{ allowedModelIds: string[], refreshCatalogOnStart: boolean, showCredits: boolean }}
 */
let currentConfig = {
  allowedModelIds: [...DEFAULT_ALLOWED_MODEL_IDS],
  refreshCatalogOnStart: true,
  showCredits: true,
};

/**
 * 供状态路由/诊断读取当前配置（脱敏，无凭据）。
 *
 * 必须**深拷贝**数组：浅拷贝会把 `allowedModelIds` 的数组引用直接交出去，
 * 调用方一次 `push` 就改掉了插件的实际白名单——外部读一个「描述」却能
 * 无声地改变行为。配置项少，逐字段复制比通用深拷贝更清楚。
 */
export function describeEffectiveConfig() {
  return {
    allowedModelIds: [...currentConfig.allowedModelIds],
    refreshCatalogOnStart: currentConfig.refreshCatalogOnStart,
    showCredits: currentConfig.showCredits,
  };
}

/**
 * 在后台解析动态模型目录并替换 `activeModels`。
 *
 * 失败只记日志，不抛出——目录解析不该阻断插件加载。
 *
 * 签名会话由 `credentials-seam.getValidCredential()` + `createSignerSession`
 * 现场构建（与 chat-shim 的 getSession 同源），用完即 dispose：
 * 这里只需一次 GET，没必要缓存会话。
 *
 * @param {{ logger?: any }} [opts]
 * @returns {Promise<{ source: string, count: number }>}
 */
export async function refreshModelCatalog(opts = {}) {
  let signer = null;
  try {
    const { resolveModelCatalog } = await import('./model-catalog.js');
    const { getValidCredential } = await import('./credentials-seam.js');
    const { createSignerSession, DEFAULT_ENDPOINT } = await import('./signer-session.js');

    const credential = await getValidCredential();
    signer = await createSignerSession({ credential, endpoint: DEFAULT_ENDPOINT });
    // 白名单来自配置：改 `allowedModelIds` 后下次解析即按新值过滤。
    const resolved = await resolveModelCatalog({
      signer,
      allowed: currentConfig.allowedModelIds,
      logger: opts.logger,
    });

    if (Array.isArray(resolved.models) && resolved.models.length > 0) {
      activeModels = [...resolved.models];
      catalogSource = resolved.source;
      opts.logger?.info?.(
        `dsh-qwen-connect: 模型目录已解析（${resolved.source}，${activeModels.length} 个：${activeModels.map((m) => m.id).join(', ')}）`,
      );
    }
    return { source: catalogSource, count: activeModels.length };
  } catch (error) {
    opts.logger?.warn?.(
      `dsh-qwen-connect: 解析模型目录失败（${error?.message ?? error}），沿用 ${activeModels.length} 个静态模型`,
    );
    return { source: catalogSource, count: activeModels.length };
  } finally {
    try {
      signer?.dispose?.();
    } catch {
      /* dispose 失败不影响结果 */
    }
  }
}

/** 供诊断/测试读取当前目录与来源。 */
export function describeModelCatalog() {
  return { source: catalogSource, models: activeModels.map((m) => m.id) };
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
        // 动态目录：上游新模型（如 deepseek-flash）的 is_vl 不在静态目录里
        getModelCatalog: () => activeModels,
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
      models: () => catalogForCard({ supportsImages: cardImagesAvailable, models: activeModels }),
      // 生效配置：卡片据此显示白名单/开关状态，并在 showCredits=false 时
      // 不产出额度字段（把「关闭积分」落在数据层，而不是客户端藏起来）。
      config: describeEffectiveConfig,
      // 上游实测性能（首 token 延迟 / 输出速率）——由 shim 采样累积。
      perf: perfSummary,
      provider: QWENWORK_PROVIDER,
    });
  });

  // ---- 生效配置 ------------------------------------------------------
  //
  // `config` 由 DSH 按上面导出的 `Config` schema 校验并注入。旧版这里用
  // `settings.installSection(...)` 手工注册表单，但该方法在当前 DSH 已不存在
  // ——那段代码一直被下面的 try/catch 静默吞掉，所以设置页从来没有出现过
  // 千问的配置项。改为导出 `Config` 后由 settings 服务自动生成表单。
  //
  // 白名单从配置读：用户改了 `allowedModelIds` 后，下次解析（或重启）即生效。
  const allowedModelIds = Array.isArray(config?.allowedModelIds)
    ? config.allowedModelIds
    : [...DEFAULT_ALLOWED_MODEL_IDS];
  const refreshOnStart = config?.refreshCatalogOnStart !== false;
  const showCredits = config?.showCredits !== false;
  currentConfig = { allowedModelIds, refreshCatalogOnStart: refreshOnStart, showCredits };
  // 初始目录立即按配置的白名单收敛，避免选择器先显示未过滤的模型
  activeModels = filterModels(FALLBACK_QWENWORK_MODELS, allowedModelIds);

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

  // ---- 动态模型目录 --------------------------------------------------
  //
  // 首次刷新在 provider 注册之后发起（见下方），保证适配器已就绪。
  // 选择器在解析完成前先显示静态目录 ∩ 白名单，不会有空窗。

  try {
    const { adapter } = createQwenWorkAdapter(
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
      // 动态目录：每次读取返回当前生效的模型形状。
      { models: () => activeModels },
    );
    let releaseAdapter;
    let releaseDirectory;
    try {
      releaseAdapter = ctx.llm.registerAdapter([QWENWORK_PROVIDER], adapter);
      releaseDirectory = ctx.llm.registerConfigurableProviders([
        {
          provider: QWENWORK_PROVIDER,
          displayName: 'QwenWork',
          settingsNs: QWENWORK_SETTINGS_NS,
          settingsPath: [],
          declared: false,
        },
      ]);
    } finally {
      if (releaseAdapter === undefined || releaseDirectory === undefined) {
        releaseAdapter?.();
        releaseDirectory?.();
      }
    }
    try {
      ctx.effect(() => () => {
        releaseAdapter?.();
        releaseDirectory?.();
      });
    } catch {
      releaseAdapter?.();
      releaseDirectory?.();
    }
    ctx.logger?.info?.('dsh-qwen-connect: qwenwork provider registered (phase A-2, shim-backed)');

    // provider 已注册，现在才做首次目录解析。
    // `refreshCatalogOnStart=false` 时跳过：用户明确要求只用内置目录。
    if (refreshOnStart) {
      void refreshModelCatalog({ logger: ctx.logger });
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
