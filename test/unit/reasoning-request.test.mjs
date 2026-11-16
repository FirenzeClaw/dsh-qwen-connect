/**
 * 思考档位**请求构造**测试（`lib/signer-session.js` 的 `buildInferBody`）。
 *
 * 只验这一层：给定档位后，上游请求体里的字段该怎么落。最容易搞错的是
 * 关闭思考——上游 SDK 会同时改三处，只改 `parameters` 而不动
 * `model_config.is_reasoning` 时，实测**完全看不出差异**，所以这里逐个断言。
 *
 * 上游是否真的收到这个字段，由 `reasoning-passthrough.test.mjs` 验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_OUTPUT_TOKENS, buildInferBody } from '../../lib/signer-session.js';

const MESSAGES = [{ role: 'user', content: 'hi' }];

test('不发 reasoningEffort 时不带思考字段（≠ 关闭思考）', () => {
  const body = JSON.parse(buildInferBody({ messages: MESSAGES, isReasoning: true }));
  assert.deepEqual(body.parameters, { max_tokens: MAX_OUTPUT_TOKENS });
  // 没选档位 ≠ 关闭：这时 is_reasoning 仍应为 true
  assert.equal(body.model_config.is_reasoning, true);
});

test('各档位落到 parameters.reasoning_effort', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const body = JSON.parse(
      buildInferBody({ messages: MESSAGES, isReasoning: true, reasoningEffort: effort }),
    );
    assert.equal(body.parameters.reasoning_effort, effort);
    assert.equal(body.parameters.enable_thinking, true);
    assert.equal(body.model_config.is_reasoning, true);
  }
});

test('none 同时关掉 enable_thinking 与 is_reasoning（SDK 语义）', () => {
  // 只改 parameters 而不动 model_config.is_reasoning 时，实测看不出档位差异。
  const body = JSON.parse(
    buildInferBody({ messages: MESSAGES, isReasoning: true, reasoningEffort: 'none' }),
  );
  assert.equal(body.parameters.reasoning_effort, 'none');
  assert.equal(body.parameters.enable_thinking, false);
  assert.equal(body.model_config.is_reasoning, false);
});

test('总开关关闭时即使给了 max 也退回 none', () => {
  const body = JSON.parse(
    buildInferBody({
      messages: MESSAGES,
      isReasoning: true,
      reasoningEffort: 'max',
      thinking: { enabled: false },
    }),
  );
  assert.equal(body.parameters.reasoning_effort, 'none');
  assert.equal(body.model_config.is_reasoning, false);
});

test('未知档位被丢弃，不会带着上游不认识的枚举值发出去', () => {
  const body = JSON.parse(
    buildInferBody({ messages: MESSAGES, isReasoning: true, reasoningEffort: 'ultra' }),
  );
  assert.equal('reasoning_effort' in body.parameters, false);
});

test('pi-ai 的 off 被归一化成上游的 none', () => {
  const body = JSON.parse(
    buildInferBody({ messages: MESSAGES, isReasoning: true, reasoningEffort: 'off' }),
  );
  assert.equal(body.parameters.reasoning_effort, 'none');
  assert.equal(body.parameters.enable_thinking, false);
});
