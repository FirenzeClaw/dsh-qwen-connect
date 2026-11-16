/**
 * 思考档位**透传**测试（`lib/chat-shim.js`）。
 *
 * 这是最容易漏的一层，也是「选择器里能选档位、但选什么都一样」的直接原因：
 * pi-ai 一直在请求体顶层发 `reasoning_effort`，而 shim 构造上游请求时
 * 从不读它——整条链路断在这里，声明和 UI 都无从生效。
 *
 * 用真 HTTP（假上游捕获请求体）而不是纯函数断言，因为要验证的正是
 * 「客户端 → shim → 上游」这一段真的接上了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createChatShimHandler } from '../../lib/chat-shim.js';

/**
 * 起一个假上游，把收到的请求体记下来。
 *
 * @returns {Promise<{ base: string, received: object[], close: () => Promise<void> }>}
 */
async function startCapturingUpstream() {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        received.push(JSON.parse(raw));
      } catch {
        received.push(null);
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 一个足够让 shim 收尾的最小 SSE 帧
      res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 起 shim，把请求转给假上游（签名器直接回传真实 bodyJson）。 */
async function startShimForwarding(upstreamBase, opts = {}) {
  const sharedSecret = 'test-shared-secret';
  const handler = createChatShimHandler({
    getCredential: async () => ({
      token: 'fake-token',
      user: { id: 'u1' },
      loginDeviceId: 'dev-1',
    }),
    endpoint: upstreamBase,
    sharedSecret,
    signerFactory: async () => ({
      describe: () => ({}),
      dispose: () => {},
      signInferRequest: (bodyJson) => ({
        url: upstreamBase,
        headers: { 'Content-Type': 'application/json' },
        body: bodyJson,
        headerCount: 1,
      }),
    }),
    ...opts,
  });

  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res).catch(() => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/v1/chat/completions`,
    secret: sharedSecret,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 发一次对话请求（客户端视角，只关心请求被接受）。 */
async function sendChat(base, secret, body) {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      ...body,
    }),
  });
  // 读完流，确保上游请求已经发生
  await res.text().catch(() => '');
  return res.status;
}

test('客户端请求的 reasoning_effort 被透传到上游请求体', async () => {
  const upstream = await startCapturingUpstream();
  const shim = await startShimForwarding(upstream.base);
  try {
    await sendChat(shim.base, shim.secret, { reasoning_effort: 'max' });
    assert.equal(upstream.received.length, 1);
    assert.equal(upstream.received[0].parameters.reasoning_effort, 'max');
    assert.equal(upstream.received[0].parameters.enable_thinking, true);
    assert.equal(upstream.received[0].model_config.is_reasoning, true);
  } finally {
    await shim.close();
    await upstream.close();
  }
});

test('未带 reasoning_effort 时上游请求体不含该字段', async () => {
  const upstream = await startCapturingUpstream();
  const shim = await startShimForwarding(upstream.base);
  try {
    await sendChat(shim.base, shim.secret, {});
    assert.equal(upstream.received.length, 1);
    assert.equal('reasoning_effort' in upstream.received[0].parameters, false);
    // 没选档位 ≠ 关闭思考
    assert.equal(upstream.received[0].model_config.is_reasoning, true);
  } finally {
    await shim.close();
    await upstream.close();
  }
});

test('总开关关闭后，客户端即使带 max 也被强制退回 none', async () => {
  const upstream = await startCapturingUpstream();
  const shim = await startShimForwarding(upstream.base, {
    getThinking: () => ({ enabled: false, levels: [] }),
  });
  try {
    await sendChat(shim.base, shim.secret, { reasoning_effort: 'max' });
    assert.equal(upstream.received[0].parameters.reasoning_effort, 'none');
    assert.equal(upstream.received[0].parameters.enable_thinking, false);
    assert.equal(upstream.received[0].model_config.is_reasoning, false);
  } finally {
    await shim.close();
    await upstream.close();
  }
});

test('getThinking 抛错时不影响请求（思考开关不该让对话失败）', async () => {
  const upstream = await startCapturingUpstream();
  const shim = await startShimForwarding(upstream.base, {
    getThinking: () => {
      throw new Error('boom');
    },
  });
  try {
    const status = await sendChat(shim.base, shim.secret, { reasoning_effort: 'high' });
    assert.equal(status, 200);
    assert.equal(upstream.received[0].parameters.reasoning_effort, 'high');
  } finally {
    await shim.close();
    await upstream.close();
  }
});
