# Windows 安装提示词与排查指南

面向：**在 Windows 上安装 `dsh-qwen-connect`**。三种用法，按需取用：

- [一、给 AI 的安装提示词](#一给-ai-的安装提示词) —— 复制粘贴给装在同一台 Windows 上的助手
- [二、人工三步安装](#二人工三步安装) —— 自己在电脑上做
- [三、快速 QA](#三快速-qa) —— 装之前/装之后最常见的疑问
- [四、Windows 排查指南](#四windows-排查指南) —— 按现象查

适用版本：`dsh-qwen-connect@0.1.0`；DSH Desktop / CLI 均可。

---

## 一、给 AI 的安装提示词

把下面整段（含标题行）复制给对方：

````text
任务：在这台 Windows 电脑上安装并验证 DSH 插件 dsh-qwen-connect。

【先读，不要急着执行】
1. 我已经把安装包解压到某个目录。请先找到它（含 tools/install-to-dsh.mjs 和 一键安装.cmd）。
   若无从判断，问我路径，不要猜。
2. 读一遍该目录下的 Windows安装与排查.md 和 安装说明.md，按里面的说法做，不要自创步骤。

【硬性约束，违反会让 DSH 启动失败】
- 绝对不要修改 DSH profile 里的 cordis.patch.yml。插件自带的 patch 会自动生效；
  再手工加一条会导致 DSH 报 duplicate loader entry id: llm-qwenwork 并整体启动失败。
- 绝对不要从别的电脑拷贝 %APPDATA%\QwenWorkCN 目录。凭据用 Windows DPAPI 加密，
  绑定当前用户账户，拷过来必然解不开，而且会覆盖掉本机正确的那份。
- 不要执行任何会删除用户数据的操作（git reset --hard / rm -rf / 清空 profile）。
  需要回滚时用安装器自带的 --uninstall，或 profile\package.json 旁边的备份文件。

【前置检查（只读）】
按顺序确认，任一项不满足就停下来告诉我，不要强行继续：
a) Windows 版本（10/11 均可）与是否 x64。
b) Node.js 版本 ≥ 22.19 或 ≥ 24（node --version）。若本机没有，安装包内有 node\ 子目录时可用
   其中的 node.exe；都没有就告诉我装 Node。
c) DSH 已安装且至少启动过一次，profile 目录存在。用
   node tools/install-to-dsh.mjs --dry-run 看它探测到哪些 profile。
d) 千问办公桌面版已安装并已登录：%APPDATA%\QwenWorkCN 下同时存在
   auth-v2.dat 与 Local State。缺一个就说明没装好或没登录过，请我登录一次。

【安装】
- 优先：工具目录下执行 node tools/install-to-dsh.mjs（参数见 --help）。
- 需要预览：加 --dry-run，先让我看它要改什么。
- 探测到多个 profile 或选错：加 --profile "<profile 目录>"。
- 报 peer 依赖解析失败：加 --bridge-dir "<一个能向上解析到 DSH node_modules 的目录>"。
- 如果双击 一键安装.cmd 一闪而过看不到错误，改用 PowerShell 在该目录执行
  cmd /c "一键安装.cmd & pause"，把完整输出贴给我。

【验证（必须做，不能只说"装好了"）】
1. 完全退出 DSH —— 包括系统托盘图标，确认进程已消失 —— 然后重新启动。
2. 用浏览器或 curl 请求 http://127.0.0.1:3080/plugins/dsh-qwen-connect/status
   期望 HTTP 200 且 "status":"signed-in"。若返回非 200 或 signed-in 之外的值，
   把响应原文（可以脱敏昵称）贴给我。
   （端口以 DSH 实际监听为准；不确定就问我。）
3. 在插件目录执行 node tools/models-preview.mjs，把输出贴给我。
4. 侧边栏「插件」面板 → 找到 dsh-qwen-connect 这一行 → 打开配置，
   确认能看到白名单与思考深度开关。

【汇报格式】
请分三块回报，不要写成一整段：
- 装了什么：profile 路径、建立的 Junction、依赖桥位置、以及 profile\package.json 三处登记是否写入。
- 验证结果：status 路由返回值、models-preview 输出、配置表单是否可见。
- 没做成的与原因：如果某项没验证，明确说"未验证"及原因，不要说"应该没问题"。
````

---

## 二、人工三步安装

### 0. 前置条件

| 条件 | 怎么确认 |
|---|---|
| Windows 10 / 11（x64） | — |
| Node.js ≥ 22.19 或 ≥ 24 | `node --version`（DSH 自带的 Node 通常也可用） |
| DSH 已装并**启动过至少一次** | 存在 `%APPDATA%\dsh-desktop\harness\profiles\web`（Desktop）或 `%USERPROFILE%\.dsh\profiles\web`（CLI） |
| 千问办公桌面版**已登录** | `%APPDATA%\QwenWorkCN\` 下同时有 `auth-v2.dat` 与 `Local State` |
| 网络可达 `gateway.qwenwork.cn` | — |
| 不需要 npm install | 插件**零运行时依赖** |

> ⚠️ **登录态不能从别的电脑拷**。凭据 = `auth-v2.dat`（AES 加密）← 密钥在 `Local State` ← 该密钥由 **DPAPI** 保护并绑定当前 Windows 用户。跨机器/跨用户必然解不开。正确做法：在新电脑上打开千问办公登录一次。

### 1. 解压并安装

解压到**路径不含特殊字符**的位置（避免 `&`、`^`；中文路径可以），然后双击 `一键安装.cmd`。

等价命令：

```powershell
node tools\install-to-dsh.mjs --dry-run     # 先预览
node tools\install-to-dsh.mjs               # 真正写入
```

安装器做三件事，缺一不可：

```
1. profiles\web\node_modules\dsh-qwen-connect   ← Junction 指向插件源码
2. profiles\web\package.json 三处登记
     dependencies["dsh-qwen-connect"] = "file:./node_modules/dsh-qwen-connect"
     dsh.profile.bundles[]            += "dsh-qwen-connect"
     pnpm.overrides["dsh-qwen-connect"] = "link:./node_modules/dsh-qwen-connect"
3. 插件源码父目录的依赖桥
     node_modules\@deepseek-ai     → profiles\node_modules\@deepseek-ai
     node_modules\@earendil-works  → profiles\node_modules\@earendil-works
```

第 3 条最容易漏：插件的 peer 依赖（`@deepseek-ai/dsh-llm`、`@earendil-works/pi-ai`）由 DSH 提供、不随插件分发；插件不在 DSH 的 `node_modules` 树内，Node 向上查找会找不到。

改动 `package.json` 前自动备份（文件名带时间戳）。

### 2. 完全退出 DSH 再启动

**包括托盘图标**。host 侧代码只在启动时加载一次，没退干净等于没装。

### 3. 验证

| 检查 | 期望 |
|---|---|
| 状态路由 `http://127.0.0.1:3080/plugins/dsh-qwen-connect/status` | HTTP 200，`"status":"signed-in"` |
| 侧边栏「插件」面板 → `dsh-qwen-connect` 行 | 可见，能打开配置 |
| 模型选择器 | 只有一个：`DeepSeek-V4.1-Flash`（x0.10，1M 上下文） |
| 输入框右侧 | 选中千问模型时出现积分胶囊 |
| `node tools/models-preview.mjs` | 打印模型在卡片/选择器里的显示文本 |

模型只有一个不是故障：默认白名单就是 `['deepseek-flash']`。想放开更多模型，在配置里改 `allowedModelIds`（留空 = 不限制）。

---

## 三、快速 QA

**Q1：要不要先 `npm install`？要不要联网装依赖？**
不要。插件零运行时依赖，安装只是「建 Junction + 写三处登记 + 建依赖桥」，不下载任何东西。

**Q2：Node 必须自己装吗？**
需要 Node ≥ 22.19 或 ≥ 24。三个来源任选：把便携版 `node.exe` 放进插件目录的 `node\` 子目录（**优先级最高**）；系统常见安装路径（`%ProgramFiles%\nodejs`、`%LOCALAPPDATA%\Programs\nodejs`）；或 PATH 里的 `node`。`一键安装.cmd` 按这个顺序自己找。

**Q3：能把同事电脑上已经登录好的 `%APPDATA%\QwenWorkCN` 拷过来吗？**
不能，而且有害。凭据由 DPAPI 按 Windows 用户加密，拷过来解不开，还会覆盖本机本来正确的那份。请在新电脑上打开千问办公登录一次。

**Q4：要不要管理员权限？**
一般不需要：Junction 建在用户自己的 profile 目录，`mklink /J` 对用户目录不需要提权。只有 profile 位于受保护目录时才需要「以管理员身份运行」。

**Q5：装完为什么设置里找不到？**
两个常见原因：① DSH 没完全退出（托盘里还活着）；② 装到了另一个 profile。先彻底退出重启；仍看不到就用 `--dry-run` 看探测到哪些 profile，再用 `--profile` 指定。

**Q6：为什么只有 DeepSeek-V4.1-Flash 一个模型？**
默认白名单 `allowedModelIds = ['deepseek-flash']`。上游该账号实际有 13 个模型，改配置即可放开。

**Q7：积分胶囊什么时候出现？**
只在当前会话**选中千问反代出来的模型**时出现（每 60 秒刷新）。选其他 provider 的模型时不渲染，也不发请求。

**Q8：能在 DSH 里改哪些设置？**
侧边栏「插件」面板 → `dsh-qwen-connect` 行 → 配置：模型白名单、启动时是否拉上游目录、是否显示积分、思考总开关、思考深度逐档开关（低/中/高/超高/最高）。改完即时生效，**不需要重启**。

**Q9：思考深度选「最高」上游认吗？**
认。实测 5 档的思考链长度均值分别为 3.1K / 3.8K / 5.1K / 9.3K / 7.8K 字，梯度真实存在。（`xhigh` 略长于 `max`，样本量小，未能区分是封顶还是温度噪声。）

**Q10：能传图片吗？能调工具吗？**
都能。图片需要 DSH 的附件服务可用（不可用时插件会自动声明「仅文本」，不会报错）；工具调用透传 `tools` 并转换 `tool_calls`。

**Q11：会影响本机其他插件吗？**
依赖桥按 scope 共用（`@deepseek-ai` / `@earendil-works`），复用同一目标不会冲突。卸载时**故意保留**依赖桥，因为它可能被其他插件共用。

**Q12：怎么卸载？**
双击 `一键卸载.cmd`，或 `node tools\install-to-dsh.mjs --uninstall`，然后重启 DSH。只移除接线，**不删插件源码**。回滚可用 profile 目录里带时间戳的 `package.json` 备份。

**Q13：会不会把我的凭据传出去？**
不会。凭据只在内存中解密使用；本地环回端口上的请求还需要进程内共享密钥（不下发、不落盘）。插件不做任何遥测。

**Q14：macOS 能用吗？WSL 里能用吗？**
macOS 未实现 Keychain 读取，不可用。WSL 里是 Linux 路径（`~/.config/QwenWorkCN`）而不是 Windows 的 `%APPDATA%`，Linux 侧已支持但需装 `python3` + `python3-gi` 且密钥环已解锁——在 Windows 上装请用原生路径。

---

## 四、Windows 排查指南

### 4.1 先看错误文案对应的原因

| 现象 / 报错 | 原因 | 处理 |
|---|---|---|
| 双击 `一键安装.cmd` 窗口一闪而过 | 脚本 `pause` 之前就退出（少见）、或被杀软拦截 | 在该目录用 PowerShell 执行 `cmd /c "一键安装.cmd & pause"` 看完整输出 |
| `[1/3] ERROR: Node.js not found` | 三个来源都没找到 Node | 装 Node 22.19+/24+，或把 `node.exe` 放进插件目录 `node\` 子目录 |
| `[1/3] ERROR: Node.js cannot run: <路径>` | 找到的 node 无法执行（损坏 / 架构不符） | 换一个 Node，或删掉包内 `node\` 目录改用 PATH 里的 |
| `❌ profile 目录不存在：...` | DSH 从未启动过，或 `--profile` 写错 | 先启动一次 DSH；或用 `--dry-run` 看探测结果后 `--profile` 指定 |
| `FAILED exit code 1` + 上面的 profile 报错 | 同上 | 同上 |
| `Cannot find package '@deepseek-ai/dsh-llm'` | 依赖桥没建好（第 3 条接线） | 重装；仍失败用 `--bridge-dir "<能向上解析到 DSH node_modules 的目录>"` |
| `duplicate loader entry id: llm-qwenwork` **且 DSH 起不来** | profile 的 `cordis.patch.yml` 里有手加的条目 | 删掉那条，重启。插件自带的 patch 已足够 |
| 插件装了但列表里看不到 | DSH 没完全退出（托盘还在）；或装到了另一个 profile | 彻底退出（托盘右键退出 / 任务管理器确认无进程）再启动；`--profile` 重装 |
| 卡片显示「未登录」或 status 不是 `signed-in` | 千问办公没登录 / 凭据过期 / 装到了别的 Windows 用户下 | 打开千问办公 App 登录一次，再重启 DSH |
| 报 `DPAPI_FAILED` | 拷了别的机器的 `%APPDATA%\QwenWorkCN`；或换了 Windows 用户账户 | 删掉拷来的目录，在本机重新登录 |
| 报 `UNSUPPORTED_PLATFORM` | 你在 macOS 上，或以为 WSL 会复用 Windows 凭据 | Windows 上用原生 Node 跑；WSL 走 Linux 路径 |
| 报 `CREDENTIALS_MALFORMED` | `Local State` 缺 `os_crypt.encrypted_key`，或不是合法 JSON | 千问办公升级/重装后再登录一次 |

### 4.2 四步定位法

装完不工作，按这四步缩小范围，不要一上来就重装：

```powershell
# ① 插件模块能否加载（不碰网络、不碰凭据）
node -e "import('file:///<profile>/node_modules/dsh-qwen-connect/lib/index.js').then(m=>console.log('OK', m.name))"

# ② 模型显示是否正确（零依赖、不碰凭据）
node tools\models-preview.mjs

# ③ 安装器认为它做了什么（只读）
node tools\install-to-dsh.mjs --dry-run

# ④ DSH 起没起来（在 DSH 启动后执行）
curl http://127.0.0.1:3080/plugins/dsh-qwen-connect/status
```

判断顺序：
- ① 失败 → 接线问题（Junction / 依赖桥），不是凭据问题。
- ① 成功、② 失败 → 插件代码问题，把输出贴出来。
- ① ② 都成功、④ 401/404 → DSH 没加载插件，或端口不对。
- ④ 返回 200 但 `status` 不是 `signed-in` → 凭据问题（QPAPI / 未登录 / 过期）。
- 全部正常但对话失败 → 上游或网络问题，看 4.3。

### 4.3 装好了、但对话不正常

| 现象 | 说明与处理 |
|---|---|
| 长时间转圈不返回（几分钟） | **已知问题**：上游响应头超时（180 秒）后会被上层重试多轮，最坏约 15 分钟。取消本次请求重发即可；永久修复见 `specs/001-runtime-foundation`（重试只留一个主人）。**这不是安装问题**。 |
| 对话报 `503` / `Model catalog unavailable` | 上游服务端问题，稍后重试 |
| 对话报 `403 Model is not available for this user` | 该模型不在你这个账号的可用列表里（多见于自定义 `allowedModelIds` 写了不存在的 id） |
| 对话报 `Unauthorized` / `401` | 千问办公登录态过期 → 打开 App 重新登录，再重启 DSH |
| 回复里夹着一大段英文推理过程 | 思考链被当正文渲染。检查是否用了非官方模型 id；如稳定复现请附上模型 id |
| 附图片后报 `pi-ai image input requires the durable attachment service` | 本机 DSH 未启用附件服务。插件本应自动声明「仅文本」；若仍报错，说明宿主声明与能力不一致，请附 DSH 版本 |
| 改配置后不生效 | 配置即时生效，但客户端要重新拉一次模型列表。切一次会话或刷新页面；仍不生效再重启 DSH |

### 4.4 需要回滚时

```powershell
# 移除接线（保留源码与依赖桥）
node tools\install-to-dsh.mjs --uninstall

# 若 profile\package.json 被改坏：用同目录里带时间戳的备份覆盖
#   profiles\web\package.json.bak-<时间戳>
```

卸载后**必须重启 DSH** 才生效。

### 4.5 收集排查信息时请附上

1. `node --version`、DSH 版本、Windows 版本
2. `node tools\install-to-dsh.mjs --dry-run` 的完整输出
3. `curl http://127.0.0.1:3080/plugins/dsh-qwen-connect/status` 的响应（昵称可脱敏）
4. 出错时的完整错误文案（不要只截一句）

> ⚠️ 贴日志前请删掉 `token`、`refreshToken`、`loginDeviceId`、账号 id 等字段。凭据文件的**内容**任何情况下都不要贴出来。

---

## 附：本文档覆盖不到的部分

- 上游协议与已知限制：`docs/已知上游边界.md`
- 所有 DSH 形态的安装细节、手动安装参数：`安装说明.md`
- 架构改进计划：`specs/`（三份规格）
