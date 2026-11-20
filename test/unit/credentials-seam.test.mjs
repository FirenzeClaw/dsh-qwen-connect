/**
 * 凭据接缝的**接口面**与**单次查询**契约。
 *
 * 这两点都曾经坏过，而且坏得无声无息：
 *
 *   · 接口面从 8 个缩到 5 个之前，`fetchQuota()` 与 `fetchPlan()` 各自再调
 *     一次 `getAccountContext()`。数据一样，查询三遍——`tools/seam-live-check.mjs`
 *     实测确实连打三次。规格 SC-006 要求「三次降到一次」。
 *   · `loadImplementation()` 是实现细节（模块加载器），却被导出成公开接口。
 *
 * 测试手法：把接缝复制到临时目录，旁边放**计数桩件**当 `./auth.js` 与
 * `./rest.js`，然后 import 那份副本。这样既不需要网络，也能精确数出
 * 底层被调了几次。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const LIB_DIR = fileURLToPath(new URL('../../lib/', import.meta.url));

/** 期望对外暴露的全部入口——多一个少一个都要说明理由。 */
const EXPECTED_EXPORTS = [
  'getAccountContext',
  'getValidCredential',
  'getValidToken',
  'isWired',
  'loadDiagnostic',
];

/** 已被删除的入口。留在这里是为了防止有人“顺手”加回来。 */
const REMOVED_EXPORTS = ['fetchQuota', 'fetchPlan', 'loadImplementation'];

/**
 * 在隔离目录里装配一份接缝 + 桩件，返回接缝模块与调用计数。
 *
 * @param {{ authSource?: string, restSource?: string }} [opts]
 */
async function loadSeam(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seam-unit-'));
  const lib = join(dir, 'lib');
  mkdirSync(lib, { recursive: true });

  // 接缝与它静态依赖的 errors.js 原样复制
  for (const name of ['credentials-seam.js', 'errors.js']) {
    writeFileSync(join(lib, name), readFileSync(join(LIB_DIR, name), 'utf8'), 'utf8');
  }

  const authSource =
    opts.authSource === undefined
      ? `export async function getValidToken() {
       return { token: 'TOKEN', credentials: { token: 'TOKEN', user: { id: 'u1' } }, refreshed: false };
     }
    `
      : opts.authSource;
  // rest 桩件记录被调次数，并返回含 user / plan / quota 的完整上下文
  const restSource =
    opts.restSource ??
    `export const calls = [];
     export async function fetchAccountOverview(token, opts) {
       calls.push({ token, opts });
       return { user: { name: 'N' }, plan: { name: 'P', pid: 'p' }, quota: { remaining: 1, total: 2 } };
     }
    `;

  // authSource === null 表示「这个模块根本不存在」
  if (authSource !== null) writeFileSync(join(lib, 'auth.js'), authSource, 'utf8');
  writeFileSync(join(lib, 'rest.js'), restSource, 'utf8');
  // credentials.js 只在 auth 退化为纯字符串时才会被加载；这里放一个可用的空壳
  writeFileSync(join(lib, 'credentials.js'), 'export function loadCredentials() { return {}; }\n', 'utf8');

  // 缓存破坏参数：同名路径重复 import 会命中模块缓存，计数就不准了
  const url = `${pathToFileURL(join(lib, 'credentials-seam.js')).href}?t=${Date.now()}${Math.random()}`;
  const seam = await import(url);
  // ⚠️ 必须用接缝看到的那个 URL 形式（不带查询串）来 import，否则得到的是
  // **另一个模块实例**，桩件的计数永远是 0。这里的临时目录本身每次都不同，
  // 因此不存在跨用例的模块缓存串扰。
  const rest = await import(pathToFileURL(join(lib, 'rest.js')).href);
  return { seam, rest, dir };
}

test('接缝只暴露 5 个有消费者的入口', async () => {
  const { seam, dir } = await loadSeam();
  try {
    const names = Object.keys(seam).sort();
    assert.deepEqual(names, EXPECTED_EXPORTS, `接缝导出面发生变化：${names.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('已删除的入口没有回来', async () => {
  const { seam, dir } = await loadSeam();
  try {
    for (const name of REMOVED_EXPORTS) {
      assert.equal(
        typeof seam[name],
        'undefined',
        `${name} 又回到接缝上了——它要么没有消费者，要么把一次查询拆成了多次`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getAccountContext 一次查询就带回 user / plan / quota', async () => {
  const { seam, rest, dir } = await loadSeam();
  try {
    const ctx = await seam.getAccountContext();

    // 三项齐全 —— 调用方因此不需要再查第二次（SC-006）
    assert.equal(ctx.user?.name, 'N');
    assert.equal(ctx.plan?.name, 'P');
    assert.equal(ctx.quota?.remaining, 1);

    // 关键断言：底层只被调用一次
    assert.equal(rest.calls.length, 1, `底层被调用了 ${rest.calls.length} 次，应只有 1 次`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('取 token 与取凭据不会各自触发一次账号查询', async () => {
  // getValidToken / getValidCredential 只该碰 auth 模块，
  // 不应顺手打 REST —— 那会让卡片每次刷新都多一次上游请求。
  const { seam, rest, dir } = await loadSeam();
  try {
    await seam.getValidToken();
    await seam.getValidCredential();
    assert.equal(rest.calls.length, 0, '取 token / 凭据时不应访问账号接口');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getValidCredential 取的是刷新后的凭据，不是重新读盘', async () => {
  const { seam, dir } = await loadSeam();
  try {
    const creds = await seam.getValidCredential();
    assert.equal(creds.user?.id, 'u1', '未能取到 auth 模块返回的 credentials');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('模块存在但缺少所需函数时，入口全部明确失败', async () => {
  // 这种情况 loadDiagnostic 是空的——模块确实加载成功了，问题不在加载。
  const { seam, dir } = await loadSeam({ authSource: 'export const __nope = 1;\n' });
  try {
    assert.equal(await seam.isWired(), false, 'auth 模块无 getValidToken 时应 isWired=false');
    await assert.rejects(() => seam.getValidToken(), (e) => e.code === 'CREDENTIALS_MISSING');
    await assert.rejects(() => seam.getValidCredential(), (e) => e.code === 'CREDENTIALS_MISSING');
    await assert.rejects(() => seam.getAccountContext(), (e) => e.code === 'CREDENTIALS_MISSING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('模块根本不存在时，错误信息指向真实原因', async () => {
  // 接缝在装配时就返回 null，因此 loadDiagnostic 必须给出可诊断的原因。
  const { seam, dir } = await loadSeam({ authSource: null });
  try {
    assert.equal(await seam.isWired(), false);
    await assert.rejects(
      () => seam.getValidToken(),
      (e) => {
        assert.equal(e.code, 'CREDENTIALS_MISSING');
        // recovery 不能是「尚未交付」这类空话，要带上真实原因
        assert.match(e.recovery, /加载失败|MODULE_NOT_FOUND|Cannot find/u);
        return true;
      },
    );
    assert.notEqual(seam.loadDiagnostic(), '', '加载失败时 loadDiagnostic 应给出原因');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
