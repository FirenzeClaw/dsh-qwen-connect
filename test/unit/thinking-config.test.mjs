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
  enabledThinkingLevels,
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
