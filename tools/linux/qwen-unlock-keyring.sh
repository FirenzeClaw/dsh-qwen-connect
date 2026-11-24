#!/bin/sh
# 开机后自动解锁存放 QwenWorkCN 凭据的 Secret Service 密钥环。
#
# 为什么需要它：gnome-keyring-daemon 由 systemd user service 启动，启动参数里
# 没有 --unlock，所以登录后 Default_Keyring 处于逻辑锁定态。Chromium 系应用
# （含千问办公）的 Safe Storage 口令存在那里，锁着就读不出来。
#
# 做法：向 org.freedesktop.secrets 发 Unlock()。对本机这个密钥环它不需要口令
# （文件是明文格式且 lock-on-idle=false），返回的 prompt 是 '/' 表示不会弹窗。
# 若某天密钥环变成加密格式，Unlock() 会返回一个真实的 prompt 路径，此时本脚本
# 会如实报告「需要交互」并退出 1，而不是假装成功。
#
# 安全边界：脚本不解密任何内容、不读写任何凭据值，只改变锁状态。
set -eu

exec python3 - <<'PY'
import sys
from gi.repository import Gio, GLib

SCHEMA = 'chrome_libsecret_os_crypt_password_v2'

def main():
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except Exception as e:
        print(f'无法连接会话总线：{e}', file=sys.stderr)
        return 2

    svc = 'org.freedesktop.secrets'
    def call(path, iface, method, sig, args, rsig):
        return bus.call_sync(svc, path, iface, method, GLib.Variant(sig, args),
                             GLib.VariantType(rsig), Gio.DBusCallFlags.NONE,
                             20000, None).unpack()

    try:
        _, session = call('/org/freedesktop/secrets', 'org.freedesktop.Secret.Service',
                          'OpenSession', '(sv)', ('plain', GLib.Variant('s', '')), '(vo)')
        collections = call('/org/freedesktop/secrets', 'org.freedesktop.DBus.Properties',
                           'Get', '(ss)',
                           ('org.freedesktop.Secret.Service', 'Collections'), '(v)')[0]
    except Exception as e:
        print(f'Secret Service 不可用：{e}', file=sys.stderr)
        return 3

    # 找出真正存放目标条目的集合（按 schema + application 匹配）
    targets = []
    for coll in collections:
        try:
            props = call(coll, 'org.freedesktop.DBus.Properties', 'GetAll', '(s)',
                         ('org.freedesktop.Secret.Collection',), '(a{sv})')[0]
        except Exception:
            continue
        for item in props.get('Items', []):
            try:
                attrs = dict(call(item, 'org.freedesktop.DBus.Properties', 'Get', '(ss)',
                                  ('org.freedesktop.Secret.Item', 'Attributes'), '(v)')[0])
            except Exception:
                continue
            if attrs.get('xdg:schema') == SCHEMA:
                targets.append(coll)
                break

    if not targets:
        print('没有找到需要解锁的密钥环（条目或许还不存在）')
        return 0

    ok = True
    for coll in sorted(set(targets)):
        try:
            unlocked, prompt = call('/org/freedesktop/secrets',
                                    'org.freedesktop.Secret.Service',
                                    'Unlock', '(ao)', ([coll],), '(aoo)')
        except Exception as e:
            print(f'解锁 {coll} 失败：{e}', file=sys.stderr)
            ok = False
            continue
        if coll in unlocked:
            print(f'已解锁 {coll}')
        else:
            print(f'{coll} 需要交互解锁（prompt={prompt}），跳过', file=sys.stderr)
            ok = False
    return 0 if ok else 1

sys.exit(main())
PY

# ---- 安装为开机自启的说明 ------------------------------------------------
#
# 本脚本**不自己注册**开机自启，因为那会写用户目录、且依赖桌面环境（KDE/GNOME
# 的 autostart 路径不同）。安装方式：
#
#   mkdir -p ~/.config/autostart
#   cat > ~/.config/autostart/qwen-unlock-keyring.desktop <<'DESKTOP'
#   [Desktop Entry]
#   Type=Application
#   Name=解锁千问凭据密钥环
#   Exec=/home/<你>/.local/bin/qwen-unlock-keyring.sh
#   Terminal=false
#   NoDisplay=true
#   X-GNOME-Autostart-enabled=true
#   OnlyShowIn=KDE;GNOME;
#   DESKTOP
#   cp tools/linux/qwen-unlock-keyring.sh ~/.local/bin/
#   chmod +x ~/.local/bin/qwen-unlock-keyring.sh
#
# 验证：手动跑一次应输出「已解锁 /org/freedesktop/secrets/collection/<名字>」，
# 退出码 0。若输出「需要交互解锁」，说明该密钥环已加密，需要先在桌面上输入
# 口令；这种情况下 Unlock() 无法免交互完成，不要把它当成脚本坏了。
