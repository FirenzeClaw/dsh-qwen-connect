# Linux 密钥环：为什么锁着，以及怎么让它自己开

## 现象

重启电脑后，对话报：

```
503: 读取 QwenWorkCN 的 Safe Storage 口令失败（退出码 6）：系统密钥环已锁定
```

## 根因（本机实测，Ubuntu 26.04 / KDE Plasma 6 / gnome-keyring 50.0）

Linux 上没有 DPAPI，Electron 把 Safe Storage 口令交给系统密钥环
（`org.freedesktop.secrets`）。本机这条链路上有三件事同时成立，才导致失败：

| 事实 | 证据 |
|---|---|
| Secret Service 本身**在运行** | `org.freedesktop.secrets` 由 `gnome-keyring-daemon` 持有（pid 1818） |
| 但它**不会自动解锁** Default_Keyring | 启动参数是 `--foreground --components=pkcs11,secrets --control-directory=...`，**没有** `--unlock` |
| 目标条目就在那个被锁的集合里 | `/org/freedesktop/secrets/collection/Default_5fKeyring/4`，`Locked=true` |

而 `Unlock()` 在本机是**免口令**的：返回 `prompt='/'`，不弹窗、不要密码。
原因是这个密钥环是**明文格式**（文件头是 `[keyring]`，不是 `GnomeKeyring`
魔数）且 `lock-on-idle=false`。

所以原来的行为等于：**每次开机都要求用户做一件机器能自己做完的事。**

## 两层修复

### 1. 插件侧：探测脚本自己解锁

`lib/secret-service.js` 的 python 探测脚本在 `GetSecret` 遇到锁定错误时，先
解锁该条目所属集合，成功就重读一次。三类结果分开报：

| 标记 | 含义 | 该怎么办 |
|---|---|---|
| `LOCKED_PROMPT_NEEDED` | 解锁要你在桌面上确认 | 输入口令，或改用下面的开机自启 |
| `LOCKED_UNLOCK_FAILED` | 自动解锁失败 | 看附带的真实原因 |
| `READ_FAILED` | 可访问但读取失败 | 不是锁定问题，重新登录千问办公 |

这一层保证：**只要登录后 gnome-keyring 被启动，插件就能自己把口令读出来。**

### 2. 系统侧：开机自动解锁（可选，但更稳）

插件侧依赖「首次读取时 D-Bus 已就绪」。若某些会话里 gnome-keyring 起得比
DSH 晚，第一次读取仍可能撞上「服务不可用」。把解锁提前到登录阶段更稳：

```bash
cp tools/linux/qwen-unlock-keyring.sh ~/.local/bin/
chmod +x ~/.local/bin/qwen-unlock-keyring.sh

mkdir -p ~/.config/autostart
cat > ~/.config/autostart/qwen-unlock-keyring.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=解锁千问凭据密钥环
Exec=/home/<你的用户名>/.local/bin/qwen-unlock-keyring.sh
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
OnlyShowIn=KDE;GNOME;
DESKTOP
```

脚本只改变锁状态，不解密任何内容、不读写凭据值。

## 一个需要知道的安全事实

本机的 `Default_Keyring.keyring` **未加密**（明文格式，权限 600）：

```
Default_Keyring.keyring     5329B  加密=false
login.keyring                720B  加密=true
default.keyring               71B  加密=true
```

这意味着**任何以你这个用户身份运行的进程**都能直接读到里面所有条目的明文，
包括千问的 Safe Storage 口令。600 权限只挡别的用户，挡不住同用户进程。

这不是插件引入的，是这台机器密钥环的既有配置；插件只是消费它。若要收紧：

- 用 `seahorse`（「密码和密钥」）把 Default_Keyring 改成需要口令解锁，
  或把条目迁移到已加密的 `login` keyring；
- 代价是**每次开机/解锁都要输入一次口令**，且插件侧的免交互自动解锁会失效
  ——那时 `LOCKED_PROMPT_NEEDED` 分支会接管，如实告诉用户去解锁。

两者是明确的取舍：**免口令 = 免维护，但也免保护。**

## 排查命令

```bash
# 哪条收藏集锁着、各有多少条目（不读任何值）
node -e '
const {spawnSync}=require("node:child_process");
const S=`from gi.repository import Gio,GLib
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
def c(p,i,m,s,a,r):
    return bus.call_sync("org.freedesktop.secrets",p,i,m,GLib.Variant(s,a),GLib.VariantType(r),Gio.DBusCallFlags.NONE,20000,None).unpack()
for coll in c("/org/freedesktop/secrets","org.freedesktop.DBus.Properties","Get","(ss)",("org.freedesktop.Secret.Service","Collections"),"(v)")[0]:
    p=c(coll,"org.freedesktop.DBus.Properties","GetAll","(s)",("org.freedesktop.Secret.Collection",),"(a{sv})")[0]
    print(coll, "locked=" + str(p.get("Locked")), "items=" + str(len(p.get("Items",[]))))';
echo(S)`; console.log(spawnSync("python3",["-c",S],{encoding:"utf8"}).stdout)'

# 手动解锁一次
~/.local/bin/qwen-unlock-keyring.sh

# 插件侧能否读到口令（只看长度，不打印内容）
node -e 'import("./lib/secret-service.js").then(m=>console.log("口令长度:", m.readSecretServicePassword().length))'
```
