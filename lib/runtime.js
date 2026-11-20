/**
 * 装配实例（Runtime）：一次 `apply()` 产生的全部可变状态。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 这些状态原先散在 `lib/index.js` 的 7 个模块级 `let` 里：
 *
 *   shimPromise / shimBaseUrl / shimSharedSecret   （shim 三件套）
 *   activeModels / catalogSource                    （模型目录）
 *   adapterRegistration / currentConfig             （注册句柄 / 配置快照）
 *
 * 模块级状态与「一次装配」不是同一种生命周期。宿主改配置时会
 * `restart()` → dispose → 重新 `apply()`（Cordis 的 `update()`，
 * `node_modules/@deepseek-ai/cordis/lib/index.js:1424`）。旧配置若残留在
 * 模块级变量里，新实例会读到上一位的痕迹——用户看到「改配置不需要重启」
 * 的宣传，行为却取决于两次装配的先后顺序。
 *
 * 现在配置快照、模型目录、注册句柄都属于实例，随 `dispose()` 一起消失。
 *
 * ── 哪些状态**故意**留在模块级 ──────────────────────────────────
 * 不是所有状态都该跟着 apply 走，判断标准是「它的生命周期真的是一次装配吗」：
 *
 *   · shim 三件套 —— 一个进程一个登录态、一个环回端口。若跟着实例走，
 *     配置每改一次就换端口，`shimBaseUrl` 短暂为 null，
 *     `getBaseURL()` 会返回占位地址，正在进行的对话直接被打断。
 *   · `activeRuntime` 指针 —— 唯一允许跨装配存在的引用，供排障导出读。
 *   · `lib/perf.js` 的 samples —— 跨装配的性能历史，重置反而丢信息。
 *   · `lib/web-status.js` 的 maxObservedCredits —— 消耗进度的分母，同理。
 *   · `lib/credentials-seam.js` 的 impl / loadNote —— 模块身份级缓存。
 *
 * @module dsh-qwen-connect/runtime
 */

import {
  FALLBACK_QWENWORK_MODELS,
  QWENWORK_PROVIDER,
  THINKING_LEVEL_IDS,
  catalogForCard,
} from './models.js';
import { DEFAULT_ALLOWED_MODEL_IDS, filterModels } from './model-catalog.js';

/**
 * 某档位的配置字段名：`low` → `thinkingLow`。
 *
 * @param {string} level
 * @returns {string}
 */
export function thinkingFieldOf(level) {
  return `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

/**
 * 取出配置字段的**真实值**，兼容 schemastery 的 volatile 引用。
 *
 * 标了 `.volatile()` 的字段，Cordis 校验后交给 `apply()` 的不是普通值，而是
 * 一个只读引用对象（`{ get() }`，JSON 序列化出来是 `{}`）。直接读会得到
 * `{}`，于是 `Array.isArray(...)` 为假、`!== false` 恒为真——**用户的配置被
 * 静默忽略，全部走默认值**，而表单那边写入是成功的、也不报错。
 *
 * 这里按「有 `get()` 就取一次」处理，同时在没打 volatile 标记的 DSH 版本上
 * 仍能读到普通值（两种形态都支持，不需要按版本分支）。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function configValue(value) {
  if (value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value).get) === 'function') {
    return /** @type {any} */ (value).get();
  }
  return value;
}

/**
 * 读一个布尔配置项。
 *
 * @param {unknown} config 原始配置（字段可能是 volatile 引用）
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function readConfigBoolean(config, key, fallback) {
  const value = configValue(/** @type {any} */ (config)?.[key]);
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 读一个字符串数组配置项（逐项过滤掉非字符串）。
 *
 * @param {unknown} config
 * @param {string} key
 * @param {string[]} fallback
 * @returns {string[]}
 */
export function readConfigList(config, key, fallback) {
  const value = configValue(/** @type {any} */ (config)?.[key]);
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item) => typeof item === 'string');
}

/**
 * 从生效配置里算出「启用的思考档位」列表。
 *
 * 顺序沿 `THINKING_LEVEL_IDS`（低 → 高），与选择器的升序一致。
 *
 * @param {{ thinkingEnabled?: boolean } & Record<string, unknown>} config
 * @returns {string[]}
 */
export function enabledThinkingLevels(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  if (source.thinkingEnabled === false) return [];
  return THINKING_LEVEL_IDS.filter((level) => source[thinkingFieldOf(level)] !== false);
}

/**
 * 默认生效配置——从未装配时排障入口读这个（FR-008）。
 *
 * @returns {object}
 */
function defaultConfig() {
  return {
    allowedModelIds: [...DEFAULT_ALLOWED_MODEL_IDS],
    refreshCatalogOnStart: true,
    showCredits: true,
    thinkingEnabled: true,
    ...Object.fromEntries(THINKING_LEVEL_IDS.map((level) => [thinkingFieldOf(level), true])),
  };
}

/**
 * 把原始（可能含 volatile 引用）配置规整成实例自己的快照。
 *
 * @param {unknown} config
 * @returns {object}
 */
function snapshotConfig(config) {
  return {
    allowedModelIds: readConfigList(config, 'allowedModelIds', [...DEFAULT_ALLOWED_MODEL_IDS]),
    refreshCatalogOnStart: readConfigBoolean(config, 'refreshCatalogOnStart', true),
    showCredits: readConfigBoolean(config, 'showCredits', true),
    thinkingEnabled: readConfigBoolean(config, 'thinkingEnabled', true),
    // 每档默认开；显式 false 才关。缺省 true 与 Config 的 default 一致。
    ...Object.fromEntries(
      THINKING_LEVEL_IDS.map((level) => [
        thinkingFieldOf(level),
        readConfigBoolean(config, thinkingFieldOf(level), true),
      ]),
    ),
  };
}

/**
 * 把一份配置快照描述成对外形态（脱敏、深拷贝、附派生字段）。
 *
 * 必须**深拷贝**数组：浅拷贝会把 `allowedModelIds` 的数组引用直接交出去，
 * 调用方一次 `push` 就改掉了插件的实际白名单——外部读一个「描述」却能
 * 无声地改变行为。
 *
 * @param {object} config
 * @returns {object}
 */
function describeConfigOf(config) {
  return {
    allowedModelIds: [...config.allowedModelIds],
    refreshCatalogOnStart: config.refreshCatalogOnStart,
    showCredits: config.showCredits,
    thinkingEnabled: config.thinkingEnabled,
    ...Object.fromEntries(
      THINKING_LEVEL_IDS.map((level) => [
        thinkingFieldOf(level),
        config[thinkingFieldOf(level)],
      ]),
    ),
    // 派生：实际启用的档位。客户端与 shim 都读它，避免两处各算一遍。
    thinkingLevels: [...enabledThinkingLevels(config)],
  };
}

/**
 * 创建一个装配实例。
 *
 * @param {object} deps
 * @param {any} deps.ctx                Cordis 上下文（只用于 registerAdapter）
 * @param {unknown} deps.config         宿主校验后的原始配置
 * @param {() => string} deps.getBaseUrl         模型描述符里的 baseUrl
 * @param {() => Promise<string|null>} deps.getSharedSecret shim 共享密钥
 * @param {object} deps.image          附件服务依赖（透传给 adapter）
 * @param {any} [deps.logger]
 * @returns {object} Runtime
 */
export function createQwenWorkRuntime(deps) {
  const logger = deps.logger;
  /** 本次装配的配置快照。外部只读副本，改不到这里。 */
  const config = snapshotConfig(deps.config);
  /** 本次装配的模型目录；初值已按白名单收敛，选择器不会先闪出多余模型。 */
  let models = filterModels(FALLBACK_QWENWORK_MODELS, config.allowedModelIds);
  /** 目录来源：'fallback' | 'upstream' | ...（见 model-catalog.js） */
  let catalogSource = 'fallback';
  /** registerAdapter 返回的句柄；dispose 后置 null。 */
  let registration = null;
  /** 适配器句柄；dispose 后可用来断言不再广播。 */
  let adapterHandle = null;
  /** 是否已释放。dispose 幂等靠它。 */
  let disposed = false;

  const runtime = {
    /** provider id，便于调用方断言 */
    providerId: QWENWORK_PROVIDER,

    /** 适配器对象（dispose 前有效）。 */
    get adapter() {
      return adapterHandle;
    },

    /** 当前模型目录（内部只读视图）。 */
    models() {
      return models;
    },

    /** 卡片/选择器用的展示形状。 */
    modelsForCard(opts = {}) {
      return catalogForCard({ supportsImages: opts.supportsImages === true, models });
    },

    /** 当前启用的思考档位。 */
    thinkingLevels() {
      return enabledThinkingLevels(config);
    },

    /** 思考档位与总开关，供 shim 读取。 */
    thinking() {
      return {
        enabled: config.thinkingEnabled !== false,
        levels: enabledThinkingLevels(config),
      };
    },

    /** 生效配置的脱敏副本。 */
    describeConfig() {
      return describeConfigOf(config);
    },

    /** 目录来源与模型 id 列表。 */
    describeCatalog() {
      return { source: catalogSource, models: models.map((m) => m.id) };
    },

    /** 是否已释放。 */
    get isDisposed() {
      return disposed;
    },

    /**
     * 在后台解析动态模型目录并原地替换。
     *
     * 失败只记日志，不抛出——目录解析不该阻断插件加载。
     *
     * 签名会话由 `credentials-seam.getValidCredential()` + `createSignerSession`
     * 现场构建（与 chat-shim 的 getSession 同源），用完即 dispose：
     * 这里只需一次 GET，没必要缓存会话。
     *
     * @param {{ notify?: boolean }} [opts]
     * @returns {Promise<{ source: string, count: number, changed: boolean }>}
     */
    async refreshCatalog(opts = {}) {
      if (disposed) {
        return { source: catalogSource, count: models.length, changed: false };
      }
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
          allowed: config.allowedModelIds,
          logger,
        });

        let changed = false;
        if (!disposed && Array.isArray(resolved.models) && resolved.models.length > 0) {
          // 只在**内容真的变了**时替换并广播：无谓的替换会让客户端反复重拉
          // （`llm/adapters-updated` 本身是 payload-free，客户端收到就重新请求）。
          const next = resolved.models.map((m) => m.id).join(',');
          const prev = models.map((m) => m.id).join(',');
          changed = next !== prev || catalogSource !== resolved.source;
          models = [...resolved.models];
          catalogSource = resolved.source;
          logger?.info?.(
            `dsh-qwen-connect: 模型目录已解析（${resolved.source}，${models.length} 个：${models.map((m) => m.id).join(', ')}）`,
          );
        }
        if (changed && opts.notify === true) notifyChanged();
        return { source: catalogSource, count: models.length, changed };
      } catch (error) {
        logger?.warn?.(
          `dsh-qwen-connect: 解析模型目录失败（${error?.message ?? error}），沿用 ${models.length} 个静态模型`,
        );
        return { source: catalogSource, count: models.length, changed: false };
      } finally {
        try {
          signer?.dispose?.();
        } catch {
          /* dispose 失败不影响结果 */
        }
      }
    },

    /**
     * 释放这次装配占用的一切。
     *
     * 幂等：重复调用不抛错、不重复释放（FR-007）。
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      const handle = registration;
      registration = null;
      adapterHandle = null;
      try {
        handle?.();
      } catch (error) {
        // 释放失败不该让插件卸载流程炸掉；记一条即可，无法再补救。
        logger?.warn?.(`dsh-qwen-connect: 释放适配器注册失败（${error?.message ?? error}）`);
      }
    },
  };

  /**
   * 通知 DSH：provider 的模型拓扑变了，请客户端重新拉取。
   *
   * 为什么必须走 `handle.replace()` 而不是自己 emit 事件：
   * `llm/adapters-updated` 只在 `commitRoutes()` 里发布（见 dsh-llm 源码），
   * 插件无法直接 emit 到那个通道。而 `replace()` 的语义正是「同步换掉这条
   * 注册拥有的路由集合，并在唯一的变更点广播」——传同样的 provider 列表
   * 调用它，既不改变路由（仍是 qwenwork），又能让 `emitAdaptersUpdated()`
   * 跑一次。
   *
   * 失败不抛：热更新是增强，不该让目录刷新把插件搞挂。
   */
  function notifyChanged() {
    if (disposed) return; // 已释放：再广播会指向不存在的路由
    const handle = registration;
    if (handle === null || typeof handle.replace !== 'function') {
      logger?.warn?.('dsh-qwen-connect: adapter 注册句柄不可用，模型目录改动需要重启 DSH 才可见');
      return;
    }
    try {
      handle.replace([QWENWORK_PROVIDER]);
      logger?.info?.('dsh-qwen-connect: 已广播 llm/adapters-updated，客户端将重新拉取模型');
    } catch (error) {
      logger?.warn?.(
        `dsh-qwen-connect: 广播模型变更失败（${error?.message ?? error}），需要重启 DSH`,
      );
    }
  }

  /**
   * 注册适配器并记住句柄。
   *
   * 与「创建实例」分开：adapter 需要 `getBaseUrl` / `getSharedSecret`，
   * 而那两个由 `lib/index.js` 提供（shim 是进程级的，不属于实例）。
   *
   * @param {(catalog: object) => { adapter: any, invalidate: Function }} buildAdapter
   *        用实例的目录与档位回调构造适配器
   */
  runtime.register = (buildAdapter) => {
    if (disposed) return false;
    const built = buildAdapter({
      models: () => models,
      thinkingLevels: () => enabledThinkingLevels(config),
    });
    adapterHandle = built.adapter;
    registration = deps.ctx.llm.registerAdapter([QWENWORK_PROVIDER], built.adapter);
    return true;
  };

  return runtime;
}

/** 从未装配时的默认配置描述（FR-008：排障入口始终可用）。 */
export function describeDefaultConfig() {
  return describeConfigOf(defaultConfig());
}
