/**
 * 思考档位**词表与声明**测试（`lib/models.js`）。
 *
 * 只验这一层：DSH（经 pi-ai）与上游用的是两套不同的档位词表，而「哪几档
 * 会出现在选择器里」完全由 `thinkingLevelMap` 的 `null` / 线值决定。
 *
 * 请求侧是否真的把档位发出去，由 `reasoning-request.test.mjs` 与
 * `reasoning-passthrough.test.mjs` 分别验证——三层能各自独立坏掉，
 * 所以分成三个文件，回归时能一眼定位是哪一层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_THINKING_LEVELS,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  THINKING_LEVEL_IDS,
  THINKING_LEVEL_WIRE,
  buildThinkingLevelMap,
  hasThinkingLevels,
  normalizeReasoningEffort,
  toPiModel,
} from '../../lib/models.js';

/** 造一个最小的模型形状。 */
function modelInfo(overrides = {}) {
  return {
    id: 'deepseek-flash',
    shortName: 'DeepSeek-V4.1-Flash',
    billingRate: 0.1,
    supportsImages: false,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    ...overrides,
  };
}

// ---- 词表映射 -------------------------------------------------------------

test('normalizeReasoningEffort：pi-ai 的 off 映射成上游的 none', () => {
  assert.equal(normalizeReasoningEffort('off'), 'none');
  assert.equal(normalizeReasoningEffort('disabled'), 'none');
});

test('normalizeReasoningEffort：minimal 上游没有这一档，降级为 low', () => {
  // 不降级就会把上游不认识的枚举值发出去。
  assert.equal(normalizeReasoningEffort('minimal'), 'low');
});

test('normalizeReasoningEffort：上游线值原样通过（含 max / xhigh）', () => {
  for (const wire of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeReasoningEffort(wire), wire);
  }
});

test('normalizeReasoningEffort：大小写与空白都能容忍', () => {
  assert.equal(normalizeReasoningEffort('  HIGH '), 'high');
  assert.equal(normalizeReasoningEffort('Max'), 'max');
});

test('normalizeReasoningEffort：未知值返回 undefined，不把垃圾发给上游', () => {
  assert.equal(normalizeReasoningEffort('ultra'), undefined);
  assert.equal(normalizeReasoningEffort(''), undefined);
  assert.equal(normalizeReasoningEffort(undefined), undefined);
  assert.equal(normalizeReasoningEffort(42), undefined);
  assert.equal(normalizeReasoningEffort(null), undefined);
});

test('normalizeReasoningEffort：总开关关闭时无视传入档位，一律 none', () => {
  assert.equal(normalizeReasoningEffort('max', { enabled: false }), 'none');
  assert.equal(normalizeReasoningEffort(undefined, { enabled: false }), 'none');
});

test('normalizeReasoningEffort：总开关打开时按传入档位', () => {
  assert.equal(normalizeReasoningEffort('high', { enabled: true }), 'high');
});

// ---- 档位声明 -------------------------------------------------------------

test('buildThinkingLevelMap：off 与 minimal 恒为 null', () => {
  // pi-ai 里「选 off」和「什么都不选」发出去完全相同，暴露 off 会让
  // 任何没动过选择器的会话都变成关闭思考——那不是用户的选择。
  const map = buildThinkingLevelMap(undefined);
  assert.equal(map.off, null);
  assert.equal(map.minimal, null);
});

test('buildThinkingLevelMap：默认开启全部上游支持的档位', () => {
  const map = buildThinkingLevelMap(undefined);
  for (const level of THINKING_LEVEL_IDS) {
    assert.equal(map[level], THINKING_LEVEL_WIRE[level]);
  }
  assert.deepEqual(THINKING_LEVEL_IDS, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('buildThinkingLevelMap：未启用的档位映射为 null（pi-ai 约定=不可选）', () => {
  const map = buildThinkingLevelMap(['high']);
  assert.equal(map.high, 'high');
  assert.equal(map.low, null);
  assert.equal(map.medium, null);
  assert.equal(map.xhigh, null);
  assert.equal(map.max, null);
});

test('hasThinkingLevels：空数组/全关时为 false', () => {
  assert.equal(hasThinkingLevels([]), false);
  assert.equal(hasThinkingLevels(undefined), true);
  assert.equal(hasThinkingLevels(['max']), true);
});

test('toPiModel：声明 reasoning 与 thinkingLevelMap，且 xhigh/max 在其中', () => {
  const model = toPiModel(modelInfo(), 'http://x', {
    thinkingLevels: [...DEFAULT_THINKING_LEVELS],
  });
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap.max, 'max');
  assert.equal(model.thinkingLevelMap.xhigh, 'xhigh');
  // xhigh / max 只有显式映射才会被 pi-ai 视为可选
  assert.equal(model.thinkingLevelMap.off, null);
});

test('toPiModel：一档都不开时不声明 reasoning（DSH 拒绝空 efforts）', () => {
  const model = toPiModel(modelInfo(), 'http://x', { thinkingLevels: [] });
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
});

test('toPiModel：不传 thinkingLevels 时退回「全档启用」', () => {
  // 兼容既有调用方：不传不该变成「一档都没有」。
  const model = toPiModel(modelInfo(), 'http://x');
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap.max, 'max');
});
