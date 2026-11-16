// test/unit/export-surface.test.mjs
//
// 契约护栏：`signer-shim.js` 是 `chat-shim.js` 的**稳定转发层**，
// 集成方按 signer-shim 找、实现却在 chat-shim。一旦转发列表漏掉新增导出，
// 调用方拿到 undefined 却不会报错——静默失效最难查。
//
// 本测试自动比对两侧导出面，漏一个就失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as chatShim from '../../lib/chat-shim.js';
import * as signerShim from '../../lib/signer-shim.js';
import * as sse from '../../lib/sse.js';
import * as index from '../../lib/index.js';

test('signer-shim 必须完整转发 chat-shim 的全部导出', () => {
  const source = Object.keys(chatShim).sort();
  const forwarded = Object.keys(signerShim).sort();
  const missing = source.filter((name) => !forwarded.includes(name));
  assert.deepEqual(
    missing,
    [],
    `signer-shim 漏掉这些转发：${missing.join(', ')} —— 调用方会拿到 undefined`,
  );
});

test('signer-shim 不得凭空多出 chat-shim 没有的导出', () => {
  const source = new Set(Object.keys(chatShim));
  const extra = Object.keys(signerShim).filter((name) => !source.has(name));
  assert.deepEqual(extra, [], `signer-shim 多出的导出：${extra.join(', ')}`);
});

test('sse 层的 usage 解析导出存在（DSH 依赖它显示 token 数）', () => {
  assert.equal(typeof sse.parseRawUsage, 'function');
  assert.equal(typeof sse.parseQwenWorkFrame, 'function');
  assert.equal(typeof sse.encodeOpenAiChunk, 'function');
});

test('index 暴露的装配入口齐全（apply/name/inject）', () => {
  assert.equal(typeof index.apply, 'function');
  assert.equal(typeof index.name, 'string');
  assert.ok(Array.isArray(index.inject));
  // 排障入口：新机器接线后可用它们确认 shim 状态
  assert.equal(typeof index.ensureChatShim, 'function');
  assert.equal(typeof index.stopChatShim, 'function');
  assert.equal(typeof index.chatShimBaseUrl, 'function');
  assert.equal(typeof index.chatShimSharedSecret, 'function');
});

// ---- 配置面 -------------------------------------------------------------
//
// `Config` 是设置页能出现配置项的**唯一**前提：DSH 的 settings 服务从插件
// 的 Config 导出自动生成表单。它一旦丢失或被改成空对象，设置页会安静地
// 什么都不显示——没有报错，只是配置项消失，所以需要一条显式护栏。

/**
 * 取 schemastery schema 的字段表（字段名 → 该字段的 schema 节点）。
 *
 * `toJSON()` 在本机 DSH 0.2.1-rc.5（schemastery）返回**引用表**形态：
 * `{ uid, refs: { '<id>': node } }`，根节点的字段映射在 `refs[uid].dict`，
 * 而 dict 的值是 **uid 数字**而非节点本身——必须再查一次 refs 才能拿到
 * description 等元信息。这里把两步都做完，调用方拿到的是真节点。
 *
 * 同时兼容更直白的 `{ properties }` 形态，避免被上游格式变更误伤。
 */
function configProps(schema) {
  const json = schema.toJSON();
  if (json?.properties !== undefined) return json.properties;
  const refs = json?.refs;
  const root = refs?.[json?.uid];
  if (root?.dict !== undefined) {
    const resolved = {};
    for (const [key, value] of Object.entries(root.dict)) {
      resolved[key] = typeof value === 'number' ? refs[value] : value;
    }
    return resolved;
  }
  assert.fail(`无法从 Config.toJSON() 读出字段表：${JSON.stringify(json).slice(0, 200)}`);
}

test('必须导出非空的 Config schema（否则设置页不显示任何配置项）', () => {
  assert.ok(index.Config !== undefined, '缺少 Config 导出，设置页将没有配置项');
  const props = configProps(index.Config);
  for (const key of ['allowedModelIds', 'refreshCatalogOnStart', 'showCredits']) {
    assert.ok(key in props, `Config 缺少字段 ${key}`);
  }
});

test('Config 的每个字段都带中文描述（设置页直接展示这段文字）', () => {
  const props = configProps(index.Config);
  for (const [key, node] of Object.entries(props)) {
    // schemastery 把 description 放在元信息里；不同节点形态取法不同：
    //   - 引用表形态：node.meta.description
    //   - 直白形态：node.description
    const description = node?.meta?.description ?? node?.description;
    assert.equal(
      typeof description,
      'string',
      `Config.${key} 缺少 description，设置页只会显示字段名`,
    );
    assert.ok(
      /[\u4e00-\u9fa5]/.test(description),
      `Config.${key} 的 description 应为中文：${description}`,
    );
  }
});

/**
 * 取 volatile 字段的真实值。
 *
 * ⚠️ 标了 `.volatile()` 的配置字段，Cordis 校验后交给插件的是**只读引用**
 * （`{ get() }`），不是普通值——直接读会拿到对象、`JSON.stringify` 是 `{}`。
 * 测试必须按运行时形态取值，否则会误以为 schema 没生效。
 */
function resolvedValue(field) {
  return typeof field?.get === 'function' ? field.get() : field;
}

test('默认白名单只放行 DeepSeek-V4.1-Flash', () => {
  const defaults = index.Config({});
  assert.deepEqual(resolvedValue(defaults.allowedModelIds), ['deepseek-flash']);
  assert.equal(resolvedValue(defaults.refreshCatalogOnStart), true);
  assert.equal(resolvedValue(defaults.showCredits), true);
});

test('配置字段必须可编辑：每个字段都标了 volatile', () => {
  // 这是「配置页有控件但点了没反应」的根因护栏：
  // dsh-settings 的 describe() 在没有任何 volatile 字段时**整条丢弃**该条目，
  // 于是客户端拿不到 form、页面永远「正在读取配置…」；write() 也会拒绝。
  // 两个症状都不报错，只能靠这条断言守住。
  const fields = configProps(index.Config);
  const plain = Object.entries(fields).filter(([, node]) => node.meta?.volatile !== true);
  assert.deepEqual(
    plain.map(([key]) => key),
    [],
    '以下字段没标 .volatile()，DSH 不会把它们暴露成可编辑配置',
  );
});

test('Config 校验后字段变成 volatile 引用（apply 必须解引用）', () => {
  // 这条固定运行时契约：不是普通值，必须 .get()。
  const resolved = index.Config({ thinkingEnabled: false });
  const field = resolved.thinkingEnabled;
  assert.equal(typeof field?.get, 'function', 'volatile 字段应带 get()');
  assert.equal(field.get(), false);
});

test('describeEffectiveConfig 返回脱敏的生效配置副本', () => {
  const effective = index.describeEffectiveConfig();
  assert.ok(Array.isArray(effective.allowedModelIds), 'allowedModelIds 必须是数组');
  assert.equal(typeof effective.refreshCatalogOnStart, 'boolean');
  assert.equal(typeof effective.showCredits, 'boolean');
  // 必须是副本：调用方改返回值不能影响插件内部状态
  effective.allowedModelIds.push('should-not-leak');
  assert.equal(
    index.describeEffectiveConfig().allowedModelIds.includes('should-not-leak'),
    false,
    'describeEffectiveConfig 必须返回副本，否则外部能改插件状态',
  );
});
