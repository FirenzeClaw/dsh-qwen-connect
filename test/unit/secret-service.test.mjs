/**
 * Linux Secret Service 探测脚本的**行为契约**。
 *
 * 这里不碰真实密钥环（那要求桌面会话、且状态随机器而变），而是**执行生成的
 * python 脚本并检查它的源码结构 + 错误分支**。理由：这个脚本是一个跨语言
 * 边界，语法错误、模板字符串转义错误、前缀分支漏写都只会在运行时暴露，
 * 而它们恰好都在这轮出过：
 *
 *   · 注释里写了反引号，直接把 JS 模板字符串截断（SyntaxError）
 *   · 用 `Secret.Item.Collection` 属性取所属集合 —— 该属性不存在，
 *     实测报 InvalidArgs「无此属性」，自动解锁静默走不通
 *   · 把任何 GetSecret 异常都当成「已锁定」，掩盖真实原因
 *
 * 因此断言落在这三点上，而不是「本机密钥环此刻是否锁着」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  CHROME_LABEL,
  CHROME_SCHEMA,
  buildProbeScript,
  probeSecretService,
} from '../../lib/secret-service.js';

const SCRIPT = buildProbeScript();

/** 用 python3 做一次语法编译，不执行（不需要 D-Bus 会话）。 */
function pyCompiles(source) {
  const res = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: source,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (res.error) return { ok: false, reason: res.error.message };
  return { ok: res.status === 0, reason: (res.stderr ?? '').trim().slice(0, 200) };
}

test('常量取自实测，不是臆造', () => {
  // 实测：条目 label='Chromium Safe Storage'，schema 为 v2 变体
  assert.equal(CHROME_SCHEMA, 'chrome_libsecret_os_crypt_password_v2');
  assert.equal(CHROME_LABEL, 'Chromium Safe Storage');
});

test('生成的 python 脚本语法正确', (t) => {
  const r = pyCompiles(SCRIPT);
  if (!r.ok && r.reason.includes('ENOENT')) {
    t.skip('本机无 python3');
    return;
  }
  assert.equal(r.ok, true, `python 语法错误：${r.reason}`);
});

test('脚本不接收命令行参数里的敏感值（口令与查询词都走 stdin）', () => {
  // sys.argv 只允许承载 schema（非敏感）；application 必须来自 stdin
  assert.match(SCRIPT, /sys\.stdin\.read\(\)/u);
  assert.equal(SCRIPT.includes('sys.argv[1]'), true, 'schema 经 argv 传入');
  // 不允许出现「把口令写进 argv」的痕迹
  assert.equal(SCRIPT.includes('subprocess'), false, '脚本不得再派生子进程');
});

test('所属集合从条目路径推导，而不是查不存在的 Collection 属性', () => {
  // 这条是真实缺陷的回归护栏：gnome-keyring 50.0 上 Secret.Item 没有
  // Collection 属性，查它会得到 InvalidArgs，自动解锁因此永远走不通。
  assert.equal(
    SCRIPT.includes("'Collection'"),
    false,
    '不得查询 Secret.Item 的 Collection 属性——该属性不存在',
  );
  assert.match(SCRIPT, /rsplit\('\/', 1\)/u, '应从 D-Bus 路径推导所属集合');
  assert.match(SCRIPT, /\/collection\//u, '应校验路径确实在 collection 下');
});

test('锁定与其它读取失败被区分开', () => {
  // 只有明确是锁定才走 Unlock；其它失败要报真实原因，不能被统称成「已锁定」
  assert.match(SCRIPT, /IsLocked/u);
  assert.match(SCRIPT, /LOCKED_PROMPT_NEEDED/u);
  assert.match(SCRIPT, /LOCKED_UNLOCK_FAILED/u);
  assert.match(SCRIPT, /LOCKED_STILL/u);
  assert.match(SCRIPT, /READ_FAILED/u);
  // 兜底分支不能把非锁定错误也标成 LOCKED
  assert.match(SCRIPT, /else:\s*\n\s*sys\.stderr\.write\('READ_FAILED:/u);
});

test('解锁成功后会重新读取一次，而不是直接放弃', () => {
  assert.match(SCRIPT, /if coll not in unlocked:/u);
  assert.match(SCRIPT, /GetSecret/u);
  // 解锁后应再有且仅有第二次 GetSecret（一次失败 + 一次成功）
  const count = (SCRIPT.match(/GetSecret/g) ?? []).length;
  assert.equal(count, 2, `GetSecret 应出现 2 次（失败一次 + 解锁后重试一次），实际 ${count}`);
});

test('probeSecretService 不抛异常，且给出可操作原因', () => {
  // 这个函数供设置卡片显示状态，任何输入都不该让它炸掉
  const r = probeSecretService({ application: 'DefinitelyNotInstalledApp' });
  assert.equal(typeof r, 'object');
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok === false) {
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0, '失败时必须有原因');
  }
});
