# 架构深化设计共识（7 个候选）

来源：`/tmp/architecture-review-20261116.html`（2026-11-16 架构审查报告）。
本文件仅记录**已确认的事实与约束**，供后续 brainstorming 与 spec 使用。

## 已核实的上游事实（2026-11-16 实测）

调用 `/api/v2/model/list`（签名后 HTTP 200），qwork 分组 13 个模型：

| 字段 | 取值集合 | 含义 |
|---|---|---|
| `is_reasoning` | `true`（全部 13 个） | 没有区分度 |
| `is_vl` | `true`（全部 13 个） | 没有区分度 |
| `thinking_config` | `null`（全部 13 个） | 目录**不声明**档位 |
| `enable` | `true` | |
| `max_input_tokens` | `1000000` | |

后果：`lib/chat-shim.js:482` 的 `isReasoning: true` 硬编码**今天恰好正确**，属于结构欠账
而非进行中的缺陷。`lib/model-catalog.js:84` 只取 `is_vl`、不取 `is_reasoning`，因此
模型形状里没有该字段可查——上游一旦差异化，会照发 `true` 且无测试可发现。

## 已核实的历史缺陷（可追溯到具体提交）

| 缺陷 | 根因 | 修复提交 |
|---|---|---|
| 卡片写「仅文本」而选择器声明 image | 同一信息两个判据：`describeModel()` 自判、`toPiModel()` 另判 | `7703115` |
| 配置项点了没反应 | `Config` 缺 `.volatile()`；且 volatile 字段送来只读引用未被解开 | `14b0d48` |
| 配置表单永远「正在读取配置…」 | `plugins.bundle.config` 不传 `form`，`loading` 分支无限转 | `7c50fe5` |
| 档位清单与 lib 层漂移 | `client.js` 手抄 `THINKING_LEVELS` | 护栏 `a1e8d82`（结构未解） |
| `client-render-check` 长期静默跳过 | 依赖路径写死 Windows `%APPDATA%` | `126ea9d` |

## 已核实的当前状态

- ~~插件运行时状态是 **7 个模块级 `let`**~~
  已解决（本项提交）：配置快照、模型目录、注册句柄都收进 `lib/runtime.js` 的
  装配实例，随 `dispose()` 消失。`lib/index.js` 只剩 4 个：shim 三件套
  （**有意**进程级）与 `activeRuntime` 指针。
- `stopChatShim()` 定义在 `lib/index.js`，在 `lib/` 内**没有调用者**——这是
  **设计如此**：shim 随进程退出，不随装配释放（用户选定，代价是禁用插件后
  仍监听一个只绑环回、要求内存共享密钥的端点，不可利用）。
- Cordis 的 `update()`（`node_modules/@deepseek-ai/cordis/lib/index.js:1424`）会走 `restart()` → dispose → 重新 apply。
- ~~重试叠两层：`lib/index.js:321` 用 `resolveRetryPolicy(undefined)` → `maxRetries: 5`；`lib/chat-shim.js:74` `UPSTREAM_MAX_ATTEMPTS = 3`。~~
  已解决（本项提交）：shim 层重试全部删除，退化为单次尝试；`retryPolicy`
  显式配置为 4 类可重试码且**不含 `TIMEOUT`**。`dsh-base/cordis.patch.yml:99`
  启用 `llm-retry`；`dsh-llm-pi-ai/lib/index.js:1454` 把含 `5\d\d` 的错误消息
  归为可重试的 `SERVER` —— 这正是重试该待的那一层。
- ~~`lib/auth-api.js` 导出 43 个名字，唯一消费者是 `test/unit/index-exports.test.mjs`。~~
  已解决（`39bc286`、本项提交）：桶文件与其测试一并删除；仍有价值的错误分类断言
  迁到 `test/unit/error-taxonomy.test.mjs`，直接测 `lib/errors.js`。
- ~~`.portable-check/dsh-qwen-connect/` 有 36 个受跟踪文件（716K）……~~
  已解决（`8cab548`）：产物全部出库，受跟踪文件 2407 → 284。
- `lib/chat-shim.js` 的 `handleChatShim` 376 行、35 个局部声明；`test/unit/stream-robustness.test.mjs` 91 条测试每条都起假上游 + shim 两个 server。
- 三个客户端工具合计 1382 行，各自重写「捕获 `__ModuleLoader__.load` + `fakeRequire` + ctx 桩」；`tools/render-deps.mjs` 是唯一已共享的部分。

## 规格实施进展（`specs/001-runtime-foundation`）

| 候选 | 状态 |
|---|---|
| C7 构建产物出库 | ✅ `8cab548` / `89bf1a4` |
| C6 删没有消费者的契约层 | ✅ `39bc286` 起 |
| C2 重试只留一个主人 | ✅ 本项提交 |
| C3 运行时状态跟着 apply 走 | ✅ 本项提交 |

## 约束与惯例（来自用户与本仓库）

- 零运行时依赖（`react` / `jsdom` 只作可选检查依赖，不入 `package.json`）。
- 不改 profile 的 `cordis.patch.yml`（插件自带 patch 有 `insert llm-qwenwork`，重复会导致 duplicate loader entry id 使 DSH 启动失败）。
- **DSH 由用户自己重启**，代理不代为执行。
- 破坏性 git 操作前确认。
- 临时文件放 `/home/firenzeclaw/tmp/`。
- 提交作者 `huxin0426 <huxin0426@gmail.com>`，不 push。
- 断言针对不变量，不针对具体模型 id。
- 回复中文；中文注释；注释解释 why。
