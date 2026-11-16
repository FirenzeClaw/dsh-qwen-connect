/**
 * 真实挂载渲染检查：用真 react + react-dom/client + jsdom **执行 effect**，
 * 观察客户端组件真正渲染出什么。
 *
 * 为什么需要它（与 client-load-check / client-render-check 的分工）：
 *   - client-load-check   证明「注册到了哪个槽位、参数形态对不对」——用逻辑桩。
 *   - client-render-check 证明「卡片在给定 state 下的文案」——用 SSR 静态渲染。
 *   - 本文件              证明「组件挂载后真的产出内容」——SSR 做不到，因为
 *                         胶囊的首帧永远是 null（数据要等 effect 拉回来），
 *                         只有让 effect 真跑起来才能区分「没归属」与「有归属
 *                         但还没读到数」。这是积分胶囊归属判定的唯一有效证据。
 *
 * 依赖：react / react-dom / jsdom。本仓库自身不装这些（零运行时依赖），
 * 因此按以下顺序查找，找不到就**明确跳过**而不是假装通过：
 *   1. 环境变量 QWEN_RENDER_DEPS 指向的目录（其下含 node_modules）
 *   2. 本包的 node_modules
 *   3. DSH profile 的 node_modules（由 --profile-dir 或 DSH_PROFILE_DIR 指定）
 *
 * 用法：
 *   node tools/client-mount-check.mjs
 *   QWEN_RENDER_DEPS=/path/to/dir node tools/client-mount-check.mjs
 *   node tools/client-mount-check.mjs --profile-dir ~/.dsh/profiles/web
 *
 * 退出码：0 全部通过；1 有断言失败；2 依赖缺失（跳过）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

const line = (s) => process.stdout.write(`${s}\n`);

// ---- 定位渲染依赖 ---------------------------------------------------------
/** 收集候选的 node_modules 目录（按优先级）。 */
function depCandidates() {
  const list = [];
  const fromEnv = process.env.QWEN_RENDER_DEPS;
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    // 允许直接指向 node_modules，也允许指向其父目录
    list.push(fromEnv);
    list.push(path.join(fromEnv, 'node_modules'));
  }
  list.push(path.join(PLUGIN_ROOT, 'node_modules'));

  const argv = process.argv.slice(2);
  const profileFlag = argv.indexOf('--profile-dir');
  const profileDir =
    profileFlag >= 0 ? argv[profileFlag + 1] : process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir !== '') {
    list.push(path.join(profileDir, 'node_modules'));
    list.push(path.resolve(profileDir, '..', 'node_modules'));
  }
  return list;
}

/**
 * 找一个能解析出 react 与 jsdom 的 node_modules。
 *
 * 两者必须在**同一个**目录下解析成功，否则会出现两份 React 实例，
 * hooks 会以 "Invalid hook call" 失败。
 */
function findDeps() {
  for (const dir of depCandidates()) {
    const marker = path.join(dir, 'react', 'package.json');
    const jsdomMarker = path.join(dir, 'jsdom', 'package.json');
    if (!fs.existsSync(marker) || !fs.existsSync(jsdomMarker)) continue;
    try {
      const req = createRequire(path.join(dir, 'noop.js'));
      req.resolve('react');
      req.resolve('react-dom/client');
      req.resolve('jsdom');
      return { dir, req };
    } catch {
      /* 该目录不完整，继续找下一个 */
    }
  }
  return null;
}

const deps = findDeps();
if (deps === null) {
  line('⚠️  跳过：未找到 react / react-dom / jsdom。');
  line('   这是可选检查——本仓库零运行时依赖，不预装这些包。');
  line('   启用方式（任选其一）：');
  line('     QWEN_RENDER_DEPS=/path/to/dir node tools/client-mount-check.mjs');
  line('     node tools/client-mount-check.mjs --profile-dir ~/.dsh/profiles/web');
  line('   准备依赖：');
  line('     mkdir -p /tmp/render-deps && cd /tmp/render-deps \\');
  line('       && npm i react react-dom jsdom --no-audit --no-fund');
  line('     QWEN_RENDER_DEPS=/tmp/render-deps node tools/client-mount-check.mjs');
  process.exit(2);
}

line(`使用渲染依赖：${deps.dir}`);

// ---- 建立浏览器环境 -------------------------------------------------------
// 顺序要求：先把 window/document 装到全局，再 import react-dom/client，
// 否则 react-dom 会在没有 DOM 的环境下完成初始化。
const { JSDOM } = deps.req('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:3080/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Node 22+ 的 globalThis.navigator 只有 getter，不能直接赋值
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});

const react = deps.req('react');
const jsxRuntime = deps.req('react/jsx-runtime');
const { createRoot } = deps.req('react-dom/client');

// ---- 装载 client.js -------------------------------------------------------
const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8');

let registered = null;
dom.window.__ModuleLoader__ = {
  load(spec) {
    registered = spec;
  },
};

const fakeRequire = (id) => {
  if (id === 'react') return react;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  throw new Error(`client.js 请求了未预期的模块: ${id}`);
};

new Function('window', 'require', source)(dom.window, fakeRequire);
const mod = registered.factory(fakeRequire);

const registrations = [];
let localeCopy = null;
const ctx = {
  effect(fn) {
    fn();
    return () => {};
  },
  locale: {
    register(_ns, copy) {
      localeCopy = copy;
      return () => {};
    },
    bind() {
      return (key) => key;
    },
  },
  slots: {
    inject(_name, fn) {
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

const pillReg = registrations.find(
  (r) => r.descriptor.name === 'conversation.input.right',
);
if (pillReg === undefined) {
  line('❌ 未注册积分胶囊，后续检查无意义');
  process.exit(1);
}

// ---- 渲染辅助 -------------------------------------------------------------
// 用 client.js 真正注册的 zh 字典做 t()，而不是自造键值表：这样
// 「文案键是否存在」也会被一并验证（缺键会以键名显示，被下面的断言抓到）。
if (localeCopy === null || typeof localeCopy.zh !== 'object') {
  line('❌ client.js 未注册 zh 文案字典');
  process.exit(1);
}
const zh = localeCopy.zh;
const t = (key) => zh[key] ?? key;

/**
 * 挂载胶囊并等 effect 落地，返回容器 HTML。
 *
 * @param {object|undefined} projection modelSelection 投影（undefined 模拟能力缺失）
 * @param {object} status 状态路由返回体
 * @param {{fetchCalls?: {count: number}}} [spy] 传入则统计 fetch 次数
 */
async function mountPill(projection, status, spy) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);

  globalThis.fetch = async () => {
    if (spy !== undefined) spy.count += 1;
    return { ok: true, json: async () => status };
  };

  const root = createRoot(container);
  await react.act(async () => {
    root.render(
      react.createElement(pillReg.component, {
        t,
        useProjection: (k) => (k === 'modelSelection' ? projection : undefined),
      }),
    );
  });
  // 让 fetch 的 promise 链跑完，再触发一次渲染
  await react.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const html = container.innerHTML;
  await react.act(async () => {
    root.unmount();
  });
  container.remove();
  return html;
}

// ---- 检查项 ---------------------------------------------------------------
let failures = 0;
const pass = (msg) => line(`✔ ${msg}`);
const fail = (msg) => {
  line(`❌ ${msg}`);
  failures += 1;
};

const liveStatus = { remaining: 779.7358, total: 2000 };
const qwenSelection = {
  next: { provider: 'qwenwork', model: 'deepseek-flash' },
  lastUsed: null,
};

line('\n--- 积分胶囊：归属与渲染 ---');

// ① 选中其他 provider：不渲染，且**不发起任何请求**
{
  const spy = { count: 0 };
  const html = await mountPill(
    { next: { provider: 'deepseek', model: 'x' }, lastUsed: null },
    liveStatus,
    spy,
  );
  if (html !== '') fail(`其他 provider 时不应渲染，实际输出：${html}`);
  else if (spy.count !== 0) fail(`其他 provider 时不应发请求，实际 ${spy.count} 次`);
  else pass('选中其他 provider：不渲染，且 0 次请求');
}

// ② 选中千问：渲染出余额
{
  const html = await mountPill(qwenSelection, liveStatus);
  if (html === '') fail('选中千问时应渲染余额，实际为空');
  else if (!html.includes('779.7')) fail(`渲染内容缺少余额读数：${html}`);
  else if (!html.includes('2,000')) fail(`渲染内容缺少总量：${html}`);
  else pass('选中千问：渲染出「积分 779.7 / 2,000」');
}

// ③ showCredits=false：host 不返回额度字段，客户端不渲染
{
  const html = await mountPill(qwenSelection, { config: { showCredits: false } });
  if (html !== '') fail(`showCredits=false 时不应渲染，实际输出：${html}`);
  else pass('showCredits=false：不渲染');
}

// ④ next 优先于 lastUsed：已切换但未被请求消费的选择才是输入框显示的
{
  const html = await mountPill(
    {
      next: { provider: 'qwenwork', model: 'deepseek-flash' },
      lastUsed: { provider: 'deepseek', model: 'x' },
    },
    liveStatus,
  );
  if (html === '') fail('next 指向千问时应按 next 渲染（next 优先于 lastUsed）');
  else pass('next 优先于 lastUsed：按 next 判定归属');
}

// ⑤ 投影缺失（能力不可用）：保守地不渲染
{
  const spy = { count: 0 };
  const html = await mountPill(undefined, liveStatus, spy);
  if (html !== '') fail('投影缺失时不应渲染');
  else if (spy.count !== 0) fail(`投影缺失时不应发请求，实际 ${spy.count} 次`);
  else pass('投影缺失：不渲染，且 0 次请求');
}

// ⑥ 低额度变色：剩余不足 10% 时用警示色
{
  const html = await mountPill(qwenSelection, { remaining: 50, total: 2000 });
  if (!html.includes('label-warning')) {
    fail(`剩余不足 10% 时应使用警示色：${html}`);
  } else {
    pass('剩余不足 10%：切换为警示色');
  }
}

// ⑦ 状态路由不可用（非 2xx）：不崩，也不渲染
{
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  const root = createRoot(container);
  let threw = null;
  try {
    await react.act(async () => {
      root.render(
        react.createElement(pillReg.component, {
          t,
          useProjection: (k) => (k === 'modelSelection' ? qwenSelection : undefined),
        }),
      );
    });
    await react.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  } catch (error) {
    threw = error;
  }
  if (threw !== null) fail(`状态路由失败时组件抛异常：${threw.message}`);
  else if (container.innerHTML !== '') fail('状态路由失败时不应渲染');
  else pass('状态路由返回非 2xx：不渲染且不抛异常');
  await react.act(async () => {
    root.unmount();
  });
  container.remove();
}

// ---- 设置卡片也要能真实渲染 ----------------------------------------------
// 卡片迁到 settings.models.provider-card 后，owner 会把 provider 行信息作为
// props 传进来；这里只验证它在最小 props 下不崩、且渲染出账号区。
line('\n--- 设置卡片 ---');
{
  const cardReg = registrations.find(
    (r) => r.descriptor.name === 'settings.models.provider-card',
  );
  if (cardReg === undefined) {
    fail('未注册设置卡片');
  } else {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        status: 'signed-in',
        nickname: '测试用户',
        remaining: 100,
        total: 200,
        models: [],
      }),
    });
    const root = createRoot(container);
    let threw = null;
    try {
      await react.act(async () => {
        root.render(
          react.createElement(cardReg.component, {
            t,
            provider: { id: 'qwenwork', displayName: 'QwenWork' },
            configured: true,
            keyConfigured: true,
          }),
        );
      });
      await react.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    } catch (error) {
      threw = error;
    }
    if (threw !== null) fail(`设置卡片渲染抛异常：${threw.message}`);
    else if (!container.innerHTML.includes('千问办公')) {
      fail(`设置卡片未渲染标题：${container.innerHTML.slice(0, 200)}`);
    } else {
      pass(`设置卡片渲染成功（${container.innerHTML.length} 字节）`);
    }
    await react.act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

// ---- 插件配置表单：真挂载 + 真实点击 --------------------------------------
//
// 配置页是本次要交付的能力，必须验证到「点了开关，mutate 收到正确的
// 字段与值」这一层——只断言「注册了槽位」证明不了表单能用。
line('\n--- 插件配置表单 ---');
{
  const rowReg = registrations.find(
    (r) => r.descriptor.name === 'plugins.row.config'
      && r.descriptor.key === 'dsh-qwen-connect#llm-qwenwork',
  );
  if (rowReg === undefined) {
    fail('未注册行配置表单（plugins.row.config 的「包名#行 id」键）');
  } else {
    /**
     * 挂载表单并返回 { html, mutations }。
     *
     * @param {object} value 已接受的配置值
     * @param {{ writable?: boolean, status?: string }} [opts]
     */
    const mountForm = async (value, opts = {}) => {
      const mutations = [];
      const container = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(container);
      const form = {
        state: {
          status: opts.status ?? 'ready',
          value,
          base: undefined,
          user: undefined,
          revision: opts.revision ?? 7,
          writable: opts.writable !== false,
        },
        mutate: async (ops, revision) => {
          mutations.push({ ops, revision });
          return true;
        },
      };
      const root = createRoot(container);
      let threw = null;
      try {
        await react.act(async () => {
          root.render(
            react.createElement(rowReg.component, { t, form, view: 'page' }),
          );
        });
      } catch (error) {
        threw = error;
      }
      return {
        html: container.innerHTML,
        mutations,
        threw,
        async click(labelText) {
          // 按 aria-label / 文案找到 checkbox 并触发 change
          const inputs = [...container.querySelectorAll('input[type="checkbox"]')];
          const index = inputs.findIndex((input) => {
            const row = input.closest('label');
            return row !== null && row.textContent.includes(labelText);
          });
          if (index < 0) throw new Error(`未找到开关「${labelText}」`);
          await react.act(async () => {
            inputs[index].click();
          });
        },
        async unmount() {
          await react.act(async () => {
            root.unmount();
          });
          container.remove();
        },
      };
    };

    const FULL = {
      allowedModelIds: ['deepseek-flash'],
      refreshCatalogOnStart: true,
      showCredits: true,
      thinkingEnabled: true,
      thinkingLow: true,
      thinkingMedium: true,
      thinkingHigh: true,
      thinkingXhigh: true,
      thinkingMax: true,
    };

    // ① 渲染出思考深度分区与全部档位
    {
      const view = await mountForm(FULL);
      if (view.threw !== null) {
        fail(`配置表单渲染抛异常：${view.threw.message}`);
      } else {
        const missing = ['思考深度', '允许模型思考', '最高（max）', '超高（xhigh）', '模型白名单']
          .filter((needle) => !view.html.includes(needle));
        if (missing.length > 0) fail(`配置表单缺少内容：${missing.join('、')}`);
        else pass(`配置表单渲染成功（${view.html.length} 字节，含 5 个档位）`);
      }
      await view.unmount();
    }

    // ② 点「允许模型思考」开关 → mutate 收到 thinkingEnabled=false
    {
      const view = await mountForm(FULL);
      try {
        await view.click('允许模型思考');
        const last = view.mutations.at(-1);
        if (last === undefined) fail('点击开关后没有发起任何写入');
        else if (last.ops[0]?.path?.[0] !== 'thinkingEnabled' || last.ops[0]?.value !== false) {
          fail(`开关写入内容不对：${JSON.stringify(last.ops)}`);
        } else if (last.revision !== 7) {
          fail(`写入没有带上读取时的 revision（并发围栏），实际 ${last.revision}`);
        } else pass('点「允许模型思考」→ mutate(thinkingEnabled=false, revision=7)');
      } catch (error) {
        fail(`点击开关失败：${error.message}`);
      }
      await view.unmount();
    }

    // ③ 关掉某一档 → mutate 收到该档的字段名
    {
      const view = await mountForm(FULL);
      try {
        await view.click('最高（max）');
        const last = view.mutations.at(-1);
        if (last === undefined) fail('点击档位后没有发起写入');
        else if (last.ops[0]?.path?.[0] !== 'thinkingMax' || last.ops[0]?.value !== false) {
          fail(`档位写入内容不对：${JSON.stringify(last.ops)}`);
        } else pass('点「最高（max）」→ mutate(thinkingMax=false)');
      } catch (error) {
        fail(`点击档位失败：${error.message}`);
      }
      await view.unmount();
    }

    // ④ 总开关关闭时，档位区不出现（避免用户以为还能选）
    {
      const view = await mountForm({ ...FULL, thinkingEnabled: false });
      if (view.html.includes('在模型选择器里提供以下档位')) {
        fail('总开关关闭时不应显示档位勾选区');
      } else if (!view.html.includes('允许模型思考')) {
        fail('总开关关闭时仍应显示总开关本身');
      } else {
        pass('总开关关闭：档位勾选区隐藏，总开关仍可见');
      }
      await view.unmount();
    }

    // ⑤ 只读时控件禁用，点也不写入
    {
      const view = await mountForm(FULL, { writable: false });
      let wrote = false;
      try {
        await view.click('允许模型思考');
        wrote = view.mutations.length > 0;
      } catch {
        /* 禁用时点不动也接受 */
      }
      if (wrote) fail('只读状态下不应写入');
      else if (!view.html.includes('只读')) fail('只读时应说明原因');
      else pass('只读：控件不可写，且说明原因');
      await view.unmount();
    }

    // ⑥ summary 视图给一行摘要（插件列表页用）
    {
      const container = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(container);
      const root = createRoot(container);
      await react.act(async () => {
        root.render(
          react.createElement(rowReg.component, {
            t,
            view: 'summary',
            form: { state: { status: 'ready', value: FULL, revision: 1, writable: true }, mutate: async () => true },
          }),
        );
      });
      const summary = container.textContent;
      if (!summary.includes('思考深度')) fail(`summary 未给出摘要：${summary}`);
      else pass(`summary 视图: ${summary.slice(0, 40)}`);
      await react.act(async () => {
        root.unmount();
      });
      container.remove();
    }
  }
}

line('');
if (failures === 0) {
  line('全部检查通过。');
  process.exit(0);
}
line(`有 ${failures} 项检查失败。`);
process.exit(1);
