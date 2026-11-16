/**
 * 验证 client.js 能被 DSH 的浏览器模块加载器正确求值，并真的注册到
 * `settings.models.provider-card` 与 `conversation.input.right` 两个 slot。
 *
 * 这里用一个最小的 `window.__ModuleLoader__` / `react` / `react/jsx-runtime`
 * 桩来跑 factory，不需要浏览器。
 *
 * 用法：node tools/client-load-check.mjs
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const line = (s) => process.stdout.write(`${s}\n`);
const require = createRequire(import.meta.url);

/** 建一个假的 DOM-free React 桩：只需满足 jsx runtime 的调用形态。 */
function makeReactStub() {
  const h = (type, props, key) => ({ type, props, key });
  return {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    createElement: h,
  };
}

/**
 * 会**真的执行** effect 的 React 桩，用来验证副作用（是否发起请求）。
 *
 * `useEffect` 在渲染时同步调用回调：判断「没归属时连 fetch 都不启动」
 * 只能靠副作用是否发生，靠返回值区分不了（两种情况都返回 null）。
 */
function makeEffectfulReactStub() {
  const cleanups = [];
  const h = (type, props, key) => ({ type, props, key });
  return {
    cleanups,
    stub: {
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: (fn) => {
        const result = fn();
        if (typeof result === 'function') cleanups.push(result);
      },
      useMemo: (fn) => fn(),
      createElement: h,
    },
  };
}

const jsxRuntimeStub = {
  jsx: (type, props, key) => ({ type, props, key }),
  jsxs: (type, props, key) => ({ type, props, key }),
  Fragment: Symbol('Fragment'),
};

// ---- 装载 client.js -------------------------------------------------------
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

/** 捕获 load() 的入参。 */
let loaded = null;
const windowStub = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec;
    },
  },
};

// client.js 是脚本（引用全局 window），用 Function 求值而非 import
const evaluate = new Function('window', `${source}\n`);
evaluate(windowStub);

assert.ok(loaded !== null, 'client.js 必须调用 window.__ModuleLoader__.load()');
line(`✔ 调用了 __ModuleLoader__.load()，id = ${loaded.id}`);
assert.equal(loaded.id, 'dsh-qwen-connect', 'id 必须与包名一致');
assert.equal(typeof loaded.factory, 'function', 'factory 必须是函数');

// ---- 执行 factory ---------------------------------------------------------
const fakeRequire = (spec) => {
  if (spec === 'react') return makeReactStub();
  if (spec === 'react/jsx-runtime') return jsxRuntimeStub;
  throw new Error(`client.js 请求了未预期的模块: ${spec}`);
};

const mod = loaded.factory(fakeRequire);
assert.equal(typeof mod.apply, 'function', '必须导出 apply 函数');
assert.ok(Array.isArray(mod.inject), 'inject 必须是数组（cordis 依赖声明）');
assert.equal(typeof mod.name, 'string', 'name 必须是字符串');

line(`✔ factory 返回 apply / inject / name = ${JSON.stringify(mod.inject)}, name=${mod.name}`);

// ---- 跑 apply，检查 slot 注册 --------------------------------------------
/** 记录注册进去的 slot 描述。 */
const registrations = [];
let localeRegistered = null;

const ctx = {
  effect(fn) {
    fn();
    return () => {};
  },
  locale: {
    register(ns, copy) {
      localeRegistered = { ns, copy };
      return () => {};
    },
    bind() {
      return (key) => key;
    },
  },
  slots: {
    inject(slotName, fn) {
      fn();
      return () => {};
    },
    register(descriptor, component) {
      registrations.push({ descriptor, component });
      return () => {};
    },
  },
};

mod.apply(ctx);

/**
 * 注册数量：卡片 1 + 胶囊 1 + 配置页（包名 2 × 行 id 2 = 4 行配置 + 2 包配置）。
 *
 * 配置页之所以注册多个 key，是因为 key 是 `<包名>#<行 id>`，而我们的包名
 * （`dsh-qwen-connect`）与 patch 里的行 id（`llm-qwenwork`）**不相等**，
 * 且两者都可能带 `include:` 组合层前缀。keyed 槽位里没被 dispatch 的键
 * 不会渲染任何东西，多注册没有代价；漏注册才会让配置页一片空白且不报错。
 */
assert.equal(
  registrations.length,
  8,
  `期望 8 个注册（卡片 1 + 胶囊 1 + 行配置 4 + 包配置 2），实际 ${registrations.length}`,
);

/** 按槽位名取全部注册项。 */
const regsOf = (slotName) => registrations.filter((r) => r.descriptor.name === slotName);

/** 按槽位名取唯一注册项，缺失或多于一个都直接失败。 */
const regOf = (slotName) => {
  const found = regsOf(slotName);
  assert.equal(found.length, 1, `期望 ${slotName} 只注册一处，实际 ${found.length} 处`);
  return found[0];
};

// ---- 设置卡片：provider 卡片扩展区 ---------------------------------------
const card = regOf('settings.models.provider-card');
assert.equal(card.descriptor.key, 'qwenwork', 'keyed 槽位用 provider 的 settingsNs 作键');
assert.equal(typeof card.component, 'function', '第二参数必须是组件函数');
line(`✔ 设置卡片: name=${card.descriptor.name} key=${card.descriptor.key}`);

// ---- 积分胶囊：输入框右侧 -------------------------------------------------
const pill = regOf('conversation.input.right');
assert.equal(pill.descriptor.id, 'dsh-qwen-connect-credits', 'list 槽位用 id 区分自己');
assert.equal(typeof pill.descriptor.order, 'number', 'list 槽位用 order 排序');
assert.equal(typeof pill.component, 'function', '第二参数必须是组件函数');
line(`✔ 积分胶囊: name=${pill.descriptor.name} id=${pill.descriptor.id} order=${pill.descriptor.order}`);

// list 槽位用 id、keyed 槽位用 key——混用会让注册静默落到错误的格子
assert.equal('id' in card.descriptor, false, 'keyed 槽位不应使用 id');
assert.equal('key' in pill.descriptor, false, 'list 槽位不应使用 key');

assert.ok(localeRegistered !== null, '必须注册文案');
line(`✔ locale: ns=${localeRegistered.ns} 语言=${Object.keys(localeRegistered.copy).join('/')}`);
assert.ok('zh' in localeRegistered.copy && 'en' in localeRegistered.copy, 'zh 与 en 都要有');

// 胶囊引用的两个键必须存在，否则 t() 会把键名原样显示给用户
for (const localeId of ['zh', 'en']) {
  const dict = localeRegistered.copy[localeId];
  for (const key of ['pill.title', 'pill.credits']) {
    assert.equal(
      typeof dict[key],
      'string',
      `${localeId} 字典缺少胶囊文案 ${key}（t() 会退回键名）`,
    );
  }
}
line('✔ 胶囊文案 pill.title / pill.credits 在 zh、en 中都存在');

// ---- 插件配置页：`plugins.row.config` / `plugins.bundle.config` -----------
//
// 这两个槽位是配置表单唯一的入口。不注册它们，DSH 只会校验 Config、
// 页面上什么控件都不会出现（曾经误以为「导出 Config 就会自动生成表单」）。
const rowConfigs = regsOf('plugins.row.config');
const bundleConfigs = regsOf('plugins.bundle.config');
assert.ok(rowConfigs.length > 0, '必须注册 plugins.row.config（插件行详情页的配置表单）');
assert.ok(bundleConfigs.length > 0, '必须注册 plugins.bundle.config（插件包页面上的配置表单）');

// key 形态：行配置必须含 `#`，且左右两侧都不能是空串
for (const entry of rowConfigs) {
  const key = entry.descriptor.key;
  assert.equal(typeof key, 'string', 'keyed 槽位必须给 key');
  assert.ok(key.includes('#'), `行配置的 key 必须是「包名#行 id」，实际 ${key}`);
  const [bundle, rowId] = key.split('#');
  assert.ok(bundle !== '' && rowId !== '', `行配置 key 两侧都不能为空：${key}`);
  assert.equal(typeof entry.component, 'function', '行配置第二参数必须是组件函数');
}
// 包名与行 id 不相等是本次的真实形态，必须两种都覆盖到
const rowKeys = rowConfigs.map((entry) => entry.descriptor.key);
assert.ok(
  rowKeys.includes('dsh-qwen-connect#llm-qwenwork'),
  `行配置必须覆盖「包名#行 id」这一真实形态，实际：${rowKeys.join(', ')}`,
);
assert.ok(
  rowKeys.some((key) => key.includes('include:')),
  '行配置要覆盖 include: 前缀形态（profile 组合层会加这个前缀）',
);
line(`✔ 配置表单: 行配置 ${rowConfigs.length} 个 key、包配置 ${bundleConfigs.length} 个`);

// ---- 积分胶囊的归属判定：只在选中千问模型时渲染 ---------------------------
/**
 * 用假 React 渲染胶囊，观察它的返回值。
 *
 * 桩里的 useState 直接返回初值、useEffect 不执行，因此这里验证的是
 * **同步判定路径**：provider 不匹配时必须立刻 return null（连 effect
 * 都不会被安排），provider 匹配时才继续走读数逻辑。
 */
function renderPill(projection) {
  const fakeProps = {
    t: (key) => key,
    useProjection: (key) => (key === 'modelSelection' ? projection : undefined),
  };
  // 胶囊用 react.createElement('span', ...) 或返回 null
  return pill.component(fakeProps);
}

// 1) 未选中千问 → 不渲染
assert.equal(
  renderPill({ next: { provider: 'deepseek', model: 'x' }, lastUsed: null }),
  null,
  '其他 provider 的会话不得显示千问积分',
);

// 2) 完全没有投影（能力缺失）→ 不渲染（保守）
assert.equal(renderPill(undefined), null, '投影缺失时必须保守地不渲染');

// 3) next 优先于 lastUsed：已切换但未消费的选择才是输入框显示的
assert.equal(
  renderPill({ next: { provider: 'qwenwork', model: 'deepseek-flash' }, lastUsed: { provider: 'deepseek' } }),
  null,
  '选中千问但还没拿到读数时应返回 null（不是渲染空壳）',
);

line('✔ 胶囊归属判定：非千问 provider / 投影缺失 / 尚无读数 均不渲染');

// ---- 副作用验证：没归属时不得发起任何请求 ---------------------------------
// 上面用的是「不执行 effect」的桩，只能证明返回值；这里换一个有副作用的桩
// 重新加载一次，统计 fetch 次数——归属判定不通过时连 fetch 都不该启动。
{
  let loaded2 = null;
  const windowStub2 = {
    __ModuleLoader__: {
      load(spec) {
        loaded2 = spec;
      },
    },
  };
  const effectful = makeEffectfulReactStub();
  const fakeRequire2 = (spec) => {
    if (spec === 'react') return effectful.stub;
    if (spec === 'react/jsx-runtime') return jsxRuntimeStub;
    throw new Error(`client.js 请求了未预期的模块: ${spec}`);
  };
  new Function('window', `${source}\n`)(windowStub2);
  const mod2 = loaded2.factory(fakeRequire2);

  // 记录所有注册项，取出胶囊组件
  const regs2 = [];
  const ctx2 = {
    effect(fn) {
      fn();
      return () => {};
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, fn) => {
        fn();
        return () => {};
      },
      register: (descriptor, component) => {
        regs2.push({ descriptor, component });
        return () => {};
      },
    },
  };
  mod2.apply(ctx2);
  const pill2 = regs2.find((r) => r.descriptor.name === 'conversation.input.right');
  assert.ok(pill2 !== undefined, '第二次加载也必须注册胶囊');

  // 拦掉真实网络：任何 fetch 都计数，避免测试真的打到 127.0.0.1:3080
  const realFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: false, json: async () => ({}) };
  };
  try {
    // (a) 选中其他 provider：必须 0 次
    pill2.component({
      t: (key) => key,
      useProjection: () => ({ next: { provider: 'deepseek', model: 'x' }, lastUsed: null }),
    });
    assert.equal(fetchCount, 0, '其他 provider 会话不得发起千问状态请求（不该白开轮询）');

    // (b) 选中千问：必须发起
    pill2.component({
      t: (key) => key,
      useProjection: () => ({ next: { provider: 'qwenwork', model: 'deepseek-flash' }, lastUsed: null }),
    });
    assert.equal(fetchCount, 1, '选中千问后应读取一次状态');
  } finally {
    globalThis.fetch = realFetch;
  }
  line('✔ 副作用：非千问 provider 时 0 次请求；选中千问后 1 次请求');
}

// ---- 关键健壮性：slot API 坏掉时必须降级而非抛出 --------------------------
const brokenCtx = {
  effect(fn) {
    fn();
  },
  locale: {
    register() {
      return () => {};
    },
    bind() {
      return (k) => k;
    },
  },
  slots: {
    inject() {
      throw new Error('模拟 slot API 破坏性变更');
    },
  },
};

let threw = false;
const originalError = console.error;
console.error = () => {};
try {
  mod.apply(brokenCtx);
} catch {
  threw = true;
} finally {
  console.error = originalError;
}
assert.equal(threw, false, 'slot API 损坏时 apply 必须吞掉异常，否则会触发 DSH 红色横幅');
line('✔ slot API 损坏时 apply 未抛出（降级安全，不会触发红色横幅）');

line('\n全部检查通过。');

// 显式退出：`apply()` 会启动环回聊天 shim（真实监听的 HTTP server），
// 其句柄让事件循环继续存活，进程不会自己退出。测试脚本需显式结束。
process.exit(0);
