/**
 * 思考深度的**配置面**测试。
 *
 * 与 `reasoning-effort.test.mjs` 分开：那个文件验证的是「档位如何声明与
 * 如何构造进请求」，本文件验证的是「用户怎么开关它」。两者改动动机不同，
 * 分开放便于定位回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_THINKING_LEVELS, THINKING_LEVEL_IDS } from '../../lib/models.js';
import {
  Config,
  apply,
  describeEffectiveConfig,
  enabledThinkingLevels,
  stopChatShim,
  thinkingFieldOf,
} from '../../lib/index.js';

/** 从 schema 里取字段名（schemastery 的 toJSON 是引用表形态，见 export-surface 测试）。 */
function configFieldNames() {
  const json = Config.toJSON();
  const root = json.refs?.[json.uid] ?? json;
  return Object.keys(root.dict ?? {});
}

test('Config：暴露总开关与每一档的开关', () => {
  const fields = configFieldNames();
  assert.ok(fields.includes('thinkingEnabled'), `缺少 thinkingEnabled，实际：${fields.join(', ')}`);
  for (const level of THINKING_LEVEL_IDS) {
    const field = thinkingFieldOf(level);
    assert.ok(fields.includes(field), `缺少 ${field}，实际：${fields.join(', ')}`);
  }
});

test('thinkingFieldOf：档位名转成配置字段名', () => {
  assert.equal(thinkingFieldOf('low'), 'thinkingLow');
  assert.equal(thinkingFieldOf('xhigh'), 'thinkingXhigh');
  assert.equal(thinkingFieldOf('max'), 'thinkingMax');
});

test('enabledThinkingLevels：默认全开，顺序从低到高', () => {
  assert.deepEqual(enabledThinkingLevels({}), [...THINKING_LEVEL_IDS]);
  assert.deepEqual(enabledThinkingLevels({}), [...DEFAULT_THINKING_LEVELS]);
});

test('enabledThinkingLevels：总开关关闭时一档都不返回', () => {
  assert.deepEqual(enabledThinkingLevels({ thinkingEnabled: false, thinkingMax: true }), []);
});

test('enabledThinkingLevels：逐档关闭只影响该档', () => {
  assert.deepEqual(
    enabledThinkingLevels({ thinkingEnabled: true, thinkingLow: false, thinkingMax: false }),
    ['medium', 'high', 'xhigh'],
  );
});

test('enabledThinkingLevels：入参非法时退回默认，不抛错', () => {
  assert.deepEqual(enabledThinkingLevels(null), [...THINKING_LEVEL_IDS]);
  assert.deepEqual(enabledThinkingLevels(undefined), [...THINKING_LEVEL_IDS]);
});

// ---- 真实装配路径：Config 解析 → apply → 生效配置 --------------------------
//
// 上面几条只验「schema 长什么样」。但用户改配置走的是**另一条路**：
// Cordis 用 `Config` 校验后把结果交给 `apply()`，而 volatile 字段送进来的是
// 只读引用（`{ get() }`）而不是普通值。直接读会拿到 `{}`，于是
// `Array.isArray(...)` 为假、`!== false` 恒为真 —— 用户的配置被静默忽略、
// 全部退回默认值，而表单那边写入是成功的也不报错。
//
// 这条测试因此必须走「真实解析形态」，不能手工造普通对象。

/** 用 Cordis 的方式解析配置（`~standard.validate` 是 cordis 的调用点）。 */
function resolveConfigLikeCordis(raw) {
  const result = Config['~standard'].validate(raw);
  if (result.issues !== undefined) throw new Error(String(result.issues));
  return result.value;
}

/**
 * 一个够用的假 ctx：`apply` 只用到 logger / effect / inject / get / llm。
 *
 * `inject` 不回调——webServer 与 settings 都不是本测试关心的事，
 * 而 provider 注册走 `ctx.llm.*`。
 */
function makeCtx() {
  return {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject() {},
    get() {
      return undefined;
    },
    llm: {
      registerAdapter: () => () => {},
      registerConfigurableProviders: () => () => {},
    },
  };
}

test('apply 必须解开 volatile 引用，用户配置要真的生效', () => {
  const config = resolveConfigLikeCordis({
    allowedModelIds: ['pro', 'flash'],
    refreshCatalogOnStart: false,
    showCredits: false,
    thinkingEnabled: true,
    thinkingLow: false,
    thinkingMedium: false,
    thinkingHigh: true,
    thinkingXhigh: false,
    thinkingMax: true,
  });
  apply(makeCtx(), config);
  const effective = describeEffectiveConfig();

  assert.deepEqual(effective.allowedModelIds, ['pro', 'flash'], '白名单没生效：volatile 引用未解开');
  assert.equal(effective.refreshCatalogOnStart, false, 'refreshCatalogOnStart 没生效');
  assert.equal(effective.showCredits, false, 'showCredits 没生效');
  assert.equal(effective.thinkingEnabled, true);
  assert.equal(effective[thinkingFieldOf('low')], false, '逐档开关没生效');
  assert.deepEqual(effective.thinkingLevels, ['high', 'max'], '启用的档位应只剩 high / max');

  // 收尾：apply 会异步拉起 chat shim，不关掉会让测试进程挂着。
  return stopChatShim();
});

test('apply 收到普通对象（未标 volatile 的 DSH 版本）时同样正确', () => {
  apply(makeCtx(), {
    allowedModelIds: ['flash'],
    showCredits: false,
    thinkingEnabled: false,
  });
  const effective = describeEffectiveConfig();
  assert.deepEqual(effective.allowedModelIds, ['flash']);
  assert.equal(effective.showCredits, false);
  assert.deepEqual(effective.thinkingLevels, [], '总开关关闭时不应有任何档位');
  return stopChatShim();
});

test('改配置后重新 apply 必须用新值，缺省档位按「全开」解释', () => {
  // DSH 的配置修改不需要重启进程：改了之后框架会重新执行 apply()。
  // 所以 apply 必须是「每次全量重算」，不能依赖上一次留下的模块级状态。
  apply(makeCtx(), {
    allowedModelIds: ['flash'],
    showCredits: true,
    thinkingEnabled: true,
    thinkingLow: true,
  });
  const first = describeEffectiveConfig();
  assert.deepEqual(first.allowedModelIds, ['flash']);
  assert.ok(first.thinkingLevels.includes('low'), '第一次应包含 low');

  // 第二次只显式写了 low=false 与 max=true，其余档位**缺省**
  apply(makeCtx(), {
    allowedModelIds: ['pro'],
    showCredits: false,
    thinkingEnabled: true,
    thinkingLow: false,
    thinkingMax: true,
  });
  const second = describeEffectiveConfig();
  assert.deepEqual(second.allowedModelIds, ['pro'], '第二次的白名单没生效');
  assert.equal(second.showCredits, false, '第二次的 showCredits 没生效');
  assert.equal(second.thinkingLevels.includes('low'), false, 'low 已显式关闭');
  // 缺省即全开，与 Config 的 default 一致：medium/high/xhigh 不应因「上一次开过」而保留，
  // 也不应因「没写」而关闭 —— 两者在这里表现相同，故再断言一次字段来源。
  assert.deepEqual(
    second.thinkingLevels,
    ['medium', 'high', 'xhigh', 'max'],
    '缺省档位应全开，显式关闭的 low 应缺席',
  );
  return stopChatShim();
});
