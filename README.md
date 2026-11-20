# dsh-qwen-connect

把**千问办公（QwenWorkCN）桌面 App** 的登录态自动接入 DeepSeek Harness ——
零配置，不需要 API Key，不需要另外登录。

## 它做什么

| 能力 | 状态 |
|---|---|
| Provider 注册（模型出现在 DSH 模型选择器，名称含倍率） | ✅ |
| 设置卡片：账号 / 积分 / 套餐 / 模型列表（含配额进度条） | ✅ |
| 输入框积分胶囊（仅在选中千问模型时出现） | ✅ |
| 设置页配置项（模型白名单 / 积分显示 / 思考深度开关） | ✅ |
| **思考深度**（低→最高 5 档，`reasoning_effort` 真实透传上游） | ✅ |
| 模型目录热更新（改配置或上游变化无需重启 DSH） | ✅ |
| 凭据解密（Chromium v10/v11 + Windows DPAPI / Linux Secret Service） | ✅ |
| 账号 / 额度 / 套餐 REST 查询 | ✅ |
| **真实对话**（WASM 签名 + SSE 聊天端点） | ✅ |
| **流式输出 + 多轮上下文** | ✅ |
| **工具调用**（`tools` 透传 + `tool_calls` 协议转换） | ✅ |
| **图片输入**（DSH 附件服务 → `chat_context.imageUrls`） | ✅ |
| **token 统计**（上游 `raw_usage` → OpenAI `usage`） | ✅ |
| **上游重试**（交给 DSH 重试层：限流 / 5xx / 空回复 / 传输中断，5 轮指数退避） | ✅ |
| **请求方鉴别**（shim 共享密钥 + 常量时间比较） | ✅ |
| **动态模型目录**（签名请求 `/api/v2/model/list` + 白名单过滤） | ✅ |

## 配置项

配置表单出现在 **侧边栏「插件」面板 → 打开 `dsh-qwen-connect` 这一行 → 配置**
（它是 `plugins.row.config` 槽位的 keyed 条目 `<包名>#<行 id>`，即
`dsh-qwen-connect#llm-qwenwork`）。注意「插件」是顶层面板，不在「设置」里面。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `allowedModelIds` | `['deepseek-flash']` | 模型白名单。留空表示不限制（显示上游全部模型）。 |
| `refreshCatalogOnStart` | `true` | 启动时从上游拉取模型目录。关闭后只使用内置目录。 |
| `showCredits` | `true` | 在输入框右侧显示千问剩余积分。 |
| `thinkingEnabled` | `true` | 思考总开关。关闭后一律按「不思考」发出。 |
| `thinkingLow` … `thinkingMax` | 各自 `true` | 哪几档出现在模型选择器的「思考深度」里。 |

### 表单由谁画

⚠️ 更正一条曾经的错误结论：**导出 `Config` 不会自动生成表单**。
DSH 用 `Config` 校验 `config`，而表单本身来自客户端注册的
`plugins.row.config` / `plugins.bundle.config` 槽位——owner 只把
`form.state`（已接受的值 + revision + 可写性）和 `form.mutate`（带版本围栏
的写入）交过来，控件要自己画。不注册这两个槽位，插件页面上就什么都不会出现。

槽位的 key 是 **`<包名>#<行 id>`**，而本插件的包名（`dsh-qwen-connect`）与
patch 里的行 id（`llm-qwenwork`）**不相等**，两者还可能带 `include:` 组合层
前缀。因此 `lib/client.js` 把各种组合都注册了一遍：keyed 槽位里没被
dispatch 的键不渲染任何东西，多注册没有代价；漏注册才会让页面空白且不报错。

### 实现说明

- **`showCredits=false` 落在数据层**：状态路由直接不返回额度字段，而不是
  让客户端拿到数据后再藏起来。
- **改配置不需要重启**：provider 的 `models` 与思考档位都是 getter，
  目录变化后经 `registerAdapter().replace()` 触发 `llm/adapters-updated`，
  客户端随即重拉。

## 思考深度（reasoning effort）

### 上游支持哪几档

`deepseek-flash` 属于 `is_reasoning: true` 且 `is_vl: true` 的模型。上游目录
里所有 13 个模型的 `thinking_config` 字段都是 `null`（即目录本身**没有**声明
思考档位），但这不代表上游不认这个字段——实测它认。

用同一道需要分步推理的题目、5 档轮转各测 3 次，思考链长度如下
（`deepseek-flash`，`research` 探针见 `tools/` 之外的本机记录）：

| 档位 | 思考链长度均值 | 结论 |
|---|---|---|
| `low` | 3.1 K 字 | 可用 |
| `medium` | 3.8 K 字 | 可用 |
| `high` | 5.1 K 字 | 可用 |
| `xhigh` | 9.3 K 字 | 可用，明显更长 |
| `max` | 7.8 K 字 | **可用**（上游接受，且长度高于 high） |

所以：**千问的 DeepSeek 支持 `max`**，`xhigh` 也给，单调梯度真实存在。

### DSH 与上游的两套词表

| pi-ai 档位 | 上游 `reasoning_effort` | 备注 |
|---|---|---|
| `off` | `none` | 关闭 |
| `minimal` | —— | 上游没有这一档，映射为 `low` |
| `low` / `medium` / `high` / `xhigh` / `max` | 同名 | |

`off` 与 `minimal` 在 `lib/models.js` 的 `thinkingLevelMap` 里恒为 `null`：
pi-ai 的信道里「选 off」和「什么都不选」发出去**完全相同**，一旦暴露 `off`，
任何没动过选择器的会话都会变成关闭思考——那是实现细节泄漏成默认行为。
关闭思考走配置里的总开关（显式、不会误伤）。

### 请求侧要改三处，少一处就无效

按上游 SDK 的语义（`qoder-worker-runtime.obf.mjs` 偏移 8817042 附近），
关闭思考时三件事**同时**发生；只改 `parameters` 而不动
`model_config.is_reasoning` 时，实测看不出档位差异：

```js
parameters.reasoning_effort = 'none'
parameters.enable_thinking  = false
model_config.is_reasoning   = false     // 关键：少这行就等于没关
```

`lib/signer-session.js` 的 `buildInferBody` 复刻了这三点。
**不发 `reasoning_effort` 不等于关闭**——那表示「用户没选档位」，上游用自己的默认档。

### 曾经的缺陷

pi-ai 一直在请求体顶层发 `reasoning_effort`，而 `lib/chat-shim.js` 整条丢弃：
表现为「模型选择器里能选档位，但选什么都一样」。修复后 shim 从
`body.reasoning_effort` 读取并透传。

## 图片输入（视觉）

上游模型具备视觉能力，本插件已打通完整链路。DSH 侧的三个条件必须同时成立：

1. 模型描述符声明 `image` 模态（`lib/models.js`）
2. pi-ai 配置了 `resolveAttachments`（`lib/index.js` 从 `ctx.get('attachments')` 取）
3. shim 把图片转成上游认的形态

**前两条是联动的**：插件按附件服务是否可用动态决定是否声明 image
（`createQwenWorkAdapter` 的 `imagesAvailable`）——避免「声明了却用不了」
（DSH 会抛 `pi-ai image input requires the durable attachment service`）。

**上游要同时收到两样东西才认图**（六变体对照实验的结论，
见 `research/probes-2026-09-14/probe-image-format.mjs`）：

| 条件 | 位置 |
|---|---|
| ① 有图标记 | `chat_context.imageUrls`（data URL 数组，无图时为 `null`） |
| ② 多模态内容 | `messages[].content` 是含 `image_url` 的**数组** |

任一缺失，模型都会回复「我没有看到您上传的图片」。因此 `toQwenWorkMessages`
对含图消息**保留数组 content**（不再塌缩成纯文本），`collectImageUrls`
只取**最后一条 user 消息**里的图（避免重复分析历史图）。

## 架构

```
lib/index.js            host 侧入口：注册 qwenwork provider + 挂载状态路由
lib/client.js           浏览器侧入口：设置卡片（__ModuleLoader__.load 包装）
lib/web-status.js       状态路由：loopback-only + JWT 脱敏，汇总卡片数据
lib/credentials-seam.js 与凭据层的唯一接缝（不重复实现解密）
lib/secret-service.js   Linux：从系统密钥环保留的 Safe Storage 口令
lib/signer-session.js   WASM 签名会话 + 请求体构造
lib/chat-shim.js        环回聊天 shim：OpenAI ↔ QwenWork 协议转换 + 工具调用 + token 统计
lib/signer-shim.js      chat-shim 的稳定转发层（集成方从此导入）
lib/sse.js              健壮 SSE 解析 + OpenAI 分块编码 + usage 归一化
lib/runtime-identity.js Cosy-Version / machineId 的动态解析与多级回退
lib/models.js           静态模型目录（取自 App 日志的 rawModels，未臆造）
lib/loopback.js         环回访问判定（挡 DNS-rebinding）
lib/status-paths.js     host / client 共享常量
```

凭据与 REST 实现（`lib/credentials.js`、`lib/auth.js`、`lib/rest.js`、
`lib/errors.js`、`lib/dpapi.js`）。集成层**只通过接缝消费**，
不重复实现任何解密逻辑。

## 模型目录

三个模型均取自 App 日志的 `rawModels`，无臆造：

| id | 名称 | 倍率 | 视觉 | 上下文 |
|---|---|---|---|---|
| `pro` | 高级 | 1.00x | ✅ | 1M（默认） |
| `flash` | 标准｜Qwen3.8-Flash | 0.10x | ✅ | 1M |
| `qwen3.8-max-preview` | Qwen3.8-Max | 1.10x | ✅ | 1M |

`maxOutputTokens: 32000`；可选上下文档位 200K / 400K / 1M。

## 安全边界

1. **绝不下发凭据**：状态路由只回状态摘要，token 从不跨到浏览器。
2. **错误信息脱敏**：`eyJ...` 形态 JWT、`Bearer xxx`、`token=...` 一律替换后
   才下发（卡片是浏览器渲染面，泄漏即等于泄漏到 DOM 与 devtools）。
3. **只信任环回**：Host 必须是 `127.0.0.1` / `localhost` / `[::1]`，非空
   Origin 也必须是环回 —— 挡掉 DNS-rebinding 页面。
4. **不编造数值**：上游返回 `null` 的额度字段保持缺失，不会 `Number(null) → 0`
   显示成「已用 0」。
5. **失败降级**：凭据缺失 / 加载失败时显式抛 `QwenAuthError`，卡片显示可操作
   的修复提示；`apply()` 永不抛异常（避免 DSH 红色 "Failed to load plugins" 横幅）。

## 验证

```powershell
node tools/verify-all.mjs        # 一键跑全部 5 项
```

| 项目 | 内容 |
|---|---|
| `test/web-status.test.mjs` | 12 项：脱敏、环回 403、凭据错误降级、null 不变成 0 |
| `tools/client-load-check.mjs` | 9 项：`__ModuleLoader__` 契约、两个槽位的注册参数形态、胶囊文案与归属判定（含"不匹配时 0 次请求"）、slot API 损坏时降级 |
| `tools/host-load-check.mjs` | host 入口可加载性 |
| `tools/apply-check.mjs` | provider 注册行为 12 项断言（含两条降级路径） |
| `tools/seam-live-check.mjs` | 端到端真实 API 实测 + JWT 不下发断言 |

端到端实测输出（合成示例，实际值随账号与消耗变化）：
```
nickname: Test User   account: testuser01   remaining: 2100   tierName: Free
```

## 安装

插件通过 Junction 挂载进 profile（源码改动即时生效，无需重新物化）：

```powershell
$d = "E:\Codex开发\DHS开发\dsh-qwen-connect"
$w = "$env:APPDATA\dsh-desktop\harness\profiles\web"

# 1) 依赖桥：让 peer 依赖可解析（源码目录不在 profiles 树下）
foreach ($ns in @("@deepseek-ai", "@earendil-works")) {
  cmd /c mklink /J "$d\node_modules\$ns" `
         "$env:APPDATA\dsh-desktop\harness\profiles\node_modules\$ns"
}

# 2) 挂进 profile
cmd /c mklink /J "$w\node_modules\dsh-qwen-connect" "$d"

# 3) 在 profile 的 package.json 里登记
#    dependencies: "dsh-qwen-connect": "file:./node_modules/dsh-qwen-connect"
#    dsh.profile.bundles: "dsh-qwen-connect"
```

### 回滚

```powershell
$w = "$env:APPDATA\dsh-desktop\harness\profiles\web"
cmd /c rmdir "$w\node_modules\dsh-qwen-connect"
cmd /c rmdir "E:\Codex开发\DHS开发\dsh-qwen-connect\node_modules\@deepseek-ai"
cmd /c rmdir "E:\Codex开发\DHS开发\dsh-qwen-connect\node_modules\@earendil-works"
# 再用备份覆盖 profile 配置
Copy-Item "$w\_backup-qwen-connect-20260911-141226\package.json" "$w\package.json" -Force
Copy-Item "$w\_backup-qwen-connect-20260911-141226\cordis.patch.yml" "$w\cordis.patch.yml" -Force
```

## 已知限制

1. **平台**：Windows（DPAPI）与 Linux（Secret Service）均已支持；macOS 未实现。
2. **DPAPI 依赖 PowerShell 兜底**：本机未装 `koffi`/`ffi-napi`，走 PowerShell
   子进程（每进程约几十毫秒）。
3. **默认只放行一个模型**：`DEFAULT_ALLOWED_MODEL_IDS = ['deepseek-flash']`。
   企业版上游有 13 个模型（倍率 0.1~2.4），全量暴露容易误选到最贵的那个，
   因此默认收敛到一个。需要别的模型时改 `lib/model-catalog.js` 的白名单。
4. **`quota.total` 对 Free 套餐为 null**：卡片按「未提供」处理，不显示 0%。
5. **签名依赖官方 WASM**：`research/wasm.bin` 是从 App 产物提取的签名模块，
   **不随插件发布**；换机器需重新提取（`node research/wasm-extract.mjs`）。
6. **`Cosy-Version` 动态解析**：优先读 App 产物里 SDK 的 `COSY_VERSION`
   常量（实测 `1.1.32`），失败时回退安装目录版本号，最后回退常量。
   来源会记在 `signerSession.describe().cosyVersion.source` 里。
7. **Linux 需要 python3 + python3-gi**：读取系统密钥环走 Gio 的 D-Bus，
   不引入 npm 依赖（保持零运行时依赖）。
8. **重试只有一层，且不重试超时**：插件自身的转发层是单次尝试，重试完全交给
   DSH 的 `llm-retry`（5 轮指数退避）。`TIMEOUT` 被刻意排除在可重试集合外——
   上游响应头超时是 180 秒，超时几乎总是高峰排队，重试只是再等 180 秒。代价是
   超时场景下一次请求就明确失败，用户需要自己重发。

## 模型目录：动态拉取 + 白名单

模型目录**不再静态内置**。早期结论说 `/api/v2/model/list`「需要 WASM 签名（403），
只能静态内置」——那只对**未签名**请求成立。带上签名会话后该端点返回
**HTTP 200** 和完整 catalog（含 `is_vl` / `price_factor` / `context_config`）。

现在的流程（`lib/model-catalog.js`）：

```
启动 → 先用「静态目录 ∩ 白名单」顶上（选择器立刻有内容）
     → 后台签名请求 /api/v2/model/list
     → 解析 qwork 分组 → 按白名单过滤 → 原地替换 activeModels
```

三条降级路径，**任何一条都不会让模型选择器变空**：

| 情况 | 结果 | source |
|---|---|---|
| 上游可用且白名单命中 | 上游模型（默认只有 `deepseek-flash`） | `upstream` |
| 上游失败 / 离线 / 无签名会话 | 静态目录 ∩ 白名单 | `fallback` |
| 白名单与静态目录无交集 | 不过滤的静态目录 | `fallback-unfiltered` |

最后一条是刻意的：白名单配错（比如上游把模型改名了）时，宁可多显示一个
可用模型，也不要给用户一个空列表——那会连原本能用的对话能力都失去。

实测（App 1.3.1 / 企业基础版）：

```
source = upstream | count = 1
  deepseek-flash | DeepSeek-V4.1-Flash | x0.1 | vl true | ctx 1000000
```

诊断：`describeModelCatalog()` 返回 `{ source, models }`。

改白名单：编辑 `lib/model-catalog.js` 的 `DEFAULT_ALLOWED_MODEL_IDS`，
或调用 `resolveModelCatalog({ allowed: [...] })` 显式传入（空数组=不限制）。

### 图片与工具调用：均已实测可用

早期版本把这两项列为「未支持」，那是过时结论。2026-11-16 在本机
（App 1.3.1 / Ubuntu 26.04）做了端到端实测，两项都通过。

**图片输入** — 发送一张 64×64 的 PNG（红色背景、中央白色方块），
模型回答「这张图的主色调是红色，中间有一个白色的正方形」。

链路：DSH 附件服务 → pi-ai 的 `prepareRequestImages` 把附件解成 base64 →
shim 的 `extractImageUrl` 转 data URL → `chat_context.imageUrls` 与多模态
`content` 数组双写（见「图片输入」一节：两者缺一，上游就不认图）。

前置条件是附件服务可用（`ctx.get('attachments')`）。不可用时插件**不会**
声明 image 模态，pi-ai 会在发图前就拒绝——而不是发出去再失败。

**工具调用** — `tools` 透传与 `tool_calls` 协议转换均已实现
（`toQwenWorkMessages` 保留 assistant 的 tool_calls，`chat-shim` 处理
tool 角色消息与 `tool_call_id`）。

## Linux 凭据解密（实测于 App 1.3.1 / Ubuntu 26.04）

Windows 用 DPAPI 解 `Local State` 里的主密钥；Linux 没有 DPAPI，Electron 改把
口令交给**系统密钥环**（`org.freedesktop.secrets`），凭据文件则是 `v11` 前缀。

实测链路（`lib/secret-service.js` + `lib/credentials.js`）：

```
auth-v2.dat (v11)  ← AES-128-CBC, IV = 16 个空格
                 ↑ key = PBKDF2-HMAC-SHA1(口令, "saltysalt", 1 轮, 16 字节)
口令 ← Secret Service 条目 {'application': 'QwenWorkCN',
                          'xdg:schema': 'chrome_libsecret_os_crypt_password_v2'}
```

**两条与上游文档不符的实测结论**（以实测为准）：

1. Chromium 的 `os_crypt_linux.cc` 在 v11 用 AES-128-**GCM**（nonce 前置 12 字节），
   但本机 App 1.3.1 的产物**不是**该形态——GCM 的全部参数组合都认证失败，
   只有 CBC + 空格 IV 能解出合法 JSON。因此 `decryptV11` 按「先 GCM 后 CBC」尝试。
2. App 的启动参数含 `--password-store=gnome-libsecret`，所以口令在
   **GNOME Keyring / Secret Service**，不在 KWallet——尽管本机运行的是 KDE。

回写同样保持 v11/CBC，否则 App 下次启动会读不出登录态。

## 聊天接入架构（阶段 A-2）

```
DSH / pi-ai ──OpenAI 协议──▶ 环回 shim ──WASM 签名+加密──▶ gateway.qwenwork.cn
            ◀──OpenAI SSE──           ◀──双层信封 SSE──
```

- shim 由 `lib/chat-shim.js` 实现，监听 `127.0.0.1` 随机端口，**仅接受环回
  请求**（Host/Origin 双校验，挡 DNS-rebinding）。
- provider 的 `baseUrl` 在 shim 就绪后指向
  `http://127.0.0.1:<port>/v1/chat/completions`。
- **签名头 `Authorization: Bearer COSY.<...>` 由官方 WASM 生成，绝不能被
  `Bearer <accessToken>` 覆盖**（覆盖即 403 Signature invalid）。
