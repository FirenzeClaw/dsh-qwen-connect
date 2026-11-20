/**
 * 装配实例（Runtime）的生命周期。
 *
 * 这一层存在的理由：可变的运行时状态原先散在 `lib/index.js` 的 7 个模块级
 * `let` 里，与「一次装配」不是同一种生命周期。宿主改配置会
 * `restart()` → dispose → 重新 `apply()`，旧状态若残留就污染新实例。
 *
 * 本文件断言的是**归属**与**清理**，不是具体功能：
 *   1. 两次装配之间配置与目录互不可见
 *   2. 释放是幂等的
 *   3. 释放后不再广播（否则会指向已不存在的路由）
 *   4. 从未装配时排障入口仍可用（FR-008）
 *   5. 释放后热更新停用
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  apply,
  describeEffectiveConfig,
  describeModelCatalog,
  refreshModelCatalog,
  stopChatShim,
} from '../../lib/index.js';
import { THINKING_LEVEL_IDS } from '../../lib/models.js';
import { thinkingFieldOf } from '../../lib/runtime.js';

/**
 * 最小 ctx 桩件。
 *
 * `effect` 按 Cordis 的真实语义实现：**立刻执行 fn 并收集它返回的清理器**
 * （`_execute` 里 `runner.collect(effect)`）。收集到清理器后由测试决定何时
 * 调用——这样既能测「装配后清理」，也能测「清理一次再清理一次」。
 */
function makeCtx() {
  /** @type {Array<() => void>} */
  const cleanups = [];
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => {};
    },
    inject(_names, cb) {
      // webServer.register 返回注销函数；路由本身不需要真的监听端口
      cb({ ...ctx, webServer: { register: () => () => {} } });
    },
    get() {
      return undefined;
    },
    llm: {
      registerAdapter(providers, adapter) {
        const handle = () => {};
        // 记录 replace 调用次数：热更新的唯一可观测信号
        handle.replace = () => {
          registered.push({ providers, adapter });
        };
        handle.providerCount = providers.length;
        return handle;
      },
      registerConfigurableProviders() {
        return () => {};
      },
    },
  };
  return { ctx, cleanups, registered };
}

/** 触发上一次装配登记的全部清理器（模拟宿主卸载/重启），后登记的先执行。 */
function disposeAll(cleanups) {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}

// ⚠️ 这条必须是本文件的**第一个**用例：它断言的是「从未装配过」的状态。
// 独立运行时（`--test-name-pattern`）自然成立；在整份文件里跑则要靠顺序，
// 放到后面就会被前面的 apply 污染。
test('从未装配时：排障入口给出默认值而不抛错（FR-008）', async () => {
  // 上一个用例已 dispose，此刻没有任何实例
  const effective = describeEffectiveConfig();
  assert.deepEqual(effective.allowedModelIds, ['deepseek-flash'], '应回默认白名单');
  assert.equal(effective.showCredits, true);
  assert.deepEqual(effective.thinkingLevels, [...THINKING_LEVEL_IDS], '默认档位应全开');

  const catalog = describeModelCatalog();
  assert.equal(catalog.source, 'fallback');
  assert.ok(catalog.models.length >= 1, '默认目录不该为空——选择器要有内容');

  // 从未装配时刷新目录：明确返回「没有变化」，不抛错
  const result = await refreshModelCatalog({ notify: true });
  assert.equal(result.changed, false);
  assert.equal(result.count, 0);
});

test('apply 必须返回 undefined（否则 Cordis 会记 Invalid effect）', () => {
  // Cordis 的 `_execute` 把返回值当 effect：函数 / null / undefined /
  // thenable / 可迭代之外的一切都会记 `TypeError: Invalid effect`（不抛给
  // 调用方，只在日志里红）。因此实例不能 return 出去，只能留在模块级指针。
  const { ctx, cleanups } = makeCtx();
  const returned = apply(ctx, { refreshCatalogOnStart: false });
  assert.equal(returned, undefined, `apply 返回了 ${typeof returned}，Cordis 会拒绝`);
  disposeAll(cleanups);
  return stopChatShim();
});

test('两次装配之间：配置快照互不可见', () => {
  const first = makeCtx();
  apply(first.ctx, { allowedModelIds: ['pro'], showCredits: false, refreshCatalogOnStart: false });
  assert.deepEqual(describeEffectiveConfig().allowedModelIds, ['pro']);
  assert.equal(describeEffectiveConfig().showCredits, false);

  // 宿主改配置：dispose 旧实例，再用完全不同的配置装配
  disposeAll(first.cleanups);

  const second = makeCtx();
  apply(second.ctx, {
    allowedModelIds: ['deepseek-flash'],
    showCredits: true,
    refreshCatalogOnStart: false,
  });

  const effective = describeEffectiveConfig();
  assert.deepEqual(effective.allowedModelIds, ['deepseek-flash'], '新实例读到了上一次的白名单');
  assert.equal(effective.showCredits, true, '新实例读到了上一次的 showCredits');

  disposeAll(second.cleanups);
  return stopChatShim();
});

test('两次装配之间：模型目录互不可见', () => {
  const first = makeCtx();
  apply(first.ctx, { allowedModelIds: ['pro'], refreshCatalogOnStart: false });
  const firstCatalog = describeModelCatalog();
  assert.ok(firstCatalog.models.includes('pro'), `首选装配应含 pro，实际 ${firstCatalog.models}`);

  disposeAll(first.cleanups);

  const second = makeCtx();
  apply(second.ctx, { allowedModelIds: ['deepseek-flash'], refreshCatalogOnStart: false });
  const secondCatalog = describeModelCatalog();
  assert.ok(
    !secondCatalog.models.includes('pro'),
    `新实例不该继承上一次的目录，实际 ${secondCatalog.models}`,
  );

  disposeAll(second.cleanups);
  return stopChatShim();
});

test('释放是幂等的：重复调用不抛错', () => {
  const { ctx, cleanups } = makeCtx();
  apply(ctx, { refreshCatalogOnStart: false });

  assert.ok(cleanups.length > 0, 'apply 应至少登记一个清理器');
  // dispose 是其中一个清理器内部的动作；直接重复执行全部清理器两次，
  // 第二次不得抛错（FR-007：释放幂等）。
  const all = [...cleanups];
  for (const cleanup of all) cleanup();
  assert.doesNotThrow(() => {
    for (const cleanup of all) cleanup();
  }, '第二次清理不该抛错——dispose 必须幂等');

  return stopChatShim();
});

test('释放后热更新停用，不再广播', async () => {
  const { ctx, cleanups, registered } = makeCtx();
  apply(ctx, { refreshCatalogOnStart: false });
  const before = registered.length;

  // 未释放时刷新目录（离线环境会走 fallback，不一定触发广播），
  // 这里直接用一次显式刷新把路径走通，然后释放。
  await refreshModelCatalog({ notify: true });
  disposeAll(cleanups);

  const afterDispose = registered.length;
  const result = await refreshModelCatalog({ notify: true });

  assert.equal(result.changed, false, '释放后刷新应直接返回无变化');
  assert.equal(
    registered.length,
    afterDispose,
    '释放后不得再调用 handle.replace()——那条路由已经不存在了',
  );
  assert.ok(afterDispose >= before, '释放前的广播计数应单调不减');

  return stopChatShim();
});
