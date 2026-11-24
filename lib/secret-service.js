/**
 * Linux Secret Service 读取：拿到 Electron/Chromium 的 Safe Storage 口令。
 *
 * ── 为什么要有这个模块 ──────────────────────────────────────────────
 * Windows 上凭据的根密钥由 DPAPI 保护，`Local State` 里就存着密文；Linux 上
 * 没有 DPAPI，Electron 改把口令交给系统密钥环（gnome-keyring / KWallet 经
 * `org.freedesktop.secrets` 暴露）。拿不到这条口令，v11 凭据就解不开。
 *
 * ── 实现选择：调用系统的 python3，而不是引入 npm dbus 依赖 ──────────
 * 本插件「零运行时依赖」是既定约束（安装说明第一节），而 `dbus-next` /
 * `secret-service` 都会打破它。glib 的 Gio 几乎在所有带桌面环境的发行版上
 * 已随系统存在，因此走子进程读 D-Bus。代价是每次读密钥约几十毫秒——只在
 * 加载凭据时发生，不进请求热路径。
 *
 * ── 安全边界 ────────────────────────────────────────────────────────
 * 口令只经 stdout 回传，不写临时文件、不进命令行参数（脚本走 stdin）；
 * 本模块任何路径都不得把口令写入日志或错误信息。
 *
 * @module dsh-qwen-connect/secret-service
 */

import { spawnSync } from 'node:child_process';
import { QwenAuthError, ErrorCode } from './errors.js';

/** Secret Service 里 Chromium 系应用的 schema 标识（实测值，不要臆造） */
export const CHROME_SCHEMA = 'chrome_libsecret_os_crypt_password_v2';
/** 条目标签；application 属性才是真正的区分依据 */
export const CHROME_LABEL = 'Chromium Safe Storage';

/**
 * 读取 Safe Storage 口令的 python 脚本。
 *
 * 通过 stdin 传入参数（application 名），避免出现在进程列表里。
 * 找不到条目时以非零退出码 + 中文提示结束，便于上层翻译成可操作错误。
 */
export function buildProbeScript() {
  return String.raw`
import sys, json
from gi.repository import Gio, GLib

def main():
    application = sys.stdin.read().strip()
    svc = 'org.freedesktop.secrets'
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except Exception as e:
        sys.stderr.write('NO_SESSION_BUS:' + str(e))
        return 3

    def call(path, iface, method, sig, args, rsig):
        return bus.call_sync(svc, path, iface, method, GLib.Variant(sig, args),
                             GLib.VariantType(rsig), Gio.DBusCallFlags.NONE, 20000, None).unpack()

    try:
        _, session = call('/org/freedesktop/secrets', 'org.freedesktop.Secret.Service',
                          'OpenSession', '(sv)', ('plain', GLib.Variant('s', '')), '(vo)')
        props = call('/org/freedesktop/secrets', 'org.freedesktop.DBus.Properties', 'Get',
                     '(ss)', ('org.freedesktop.Secret.Service', 'Collections'), '(v)')[0]
    except Exception as e:
        sys.stderr.write('NO_SECRET_SERVICE:' + str(e))
        return 4

    found = []
    for coll in props:
        try:
            items = call(coll, 'org.freedesktop.DBus.Properties', 'Get',
                         '(ss)', ('org.freedesktop.Secret.Collection', 'Items'), '(v)')[0]
        except Exception:
            continue
        for it in items:
            try:
                attrs = dict(call(it, 'org.freedesktop.DBus.Properties', 'Get',
                                  '(ss)', ('org.freedesktop.Secret.Item', 'Attributes'), '(v)')[0])
            except Exception:
                continue
            if attrs.get('xdg:schema') != sys.argv[1]:
                continue
            app = attrs.get('application', '')
            if application and app.lower() != application.lower():
                continue
            found.append(it)

    if not found:
        sys.stderr.write('NOT_FOUND')
        return 5

    try:
        secret = call(found[0], 'org.freedesktop.Secret.Item', 'GetSecret',
                      '(o)', (session,), '((oayays))')[0]
    except Exception as e:
        msg = str(e)

        # ---- 锁定：尝试解锁一次再读 ----------------------------------
        #
        # 实测（Ubuntu 26.04 / KDE Plasma 6 / gnome-keyring 50.0）：重启后
        # Default_Keyring 处于锁定态，而 Secret Service 本身运行正常。此前的
        # 实现把「锁定」直接翻译成一句「请手动解锁密钥环」，于是每次开机都
        # 要用户自己动手——即便 Unlock() 在本机是**无交互**成功的
        # （返回 prompt '/'，不弹窗、不需要口令）。
        #
        # 因此这里先调用 Unlock()。三种结果都要区分清楚，不能笼统报「锁定」：
        #   · 解锁成功且能读出     → 正常返回（用户什么都不用做）
        #   · 解锁需要交互(prompt) → 如实说「需要你在桌面上确认」
        #   · 解锁失败             → 报出真实原因，而不是假定「已锁定」
        if 'IsLocked' in msg or 'locked' in msg.lower():
            # 所属集合从**条目路径**推导，不查 Collection 属性。
            #
            # 实测（gnome-keyring 50.0）：Secret.Item 上没有 Collection 属性，
            # 查它会得到 InvalidArgs「无此属性」。而 D-Bus 路径结构由 Secret
            # Service 规范固定：
            #   /org/freedesktop/secrets/collection/<集合名>/<条目序号>
            # 去掉最后一段即得集合路径，这是唯一可靠的来源。
            parts = str(found[0]).rsplit('/', 1)
            coll = parts[0] if len(parts) == 2 and parts[0] else None
            if coll is None or '/collection/' not in coll:
                sys.stderr.write('LOCKED_NO_COLLECTION:' + msg[:200])
                return 6
            try:
                unlocked, prompt = call(
                    '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service',
                    'Unlock', '(ao)', ([coll],), '(aoo)')
            except Exception as e2:
                sys.stderr.write('LOCKED_UNLOCK_FAILED:' + str(e2)[:200])
                return 6
            if coll not in unlocked:
                # 需要用户在桌面上输入口令
                sys.stderr.write('LOCKED_PROMPT_NEEDED:' + str(prompt)[:200])
                return 6
            try:
                secret = call(found[0], 'org.freedesktop.Secret.Item', 'GetSecret',
                              '(o)', (session,), '((oayays))')[0]
            except Exception as e3:
                sys.stderr.write('LOCKED_STILL:' + str(e3)[:200])
                return 6
        else:
            sys.stderr.write('READ_FAILED:' + msg[:200])
            return 6

    # 结果只写 stdout；上层按 utf-8 读取
    sys.stdout.write(bytes(secret[2]).decode('utf-8'))
    return 0

sys.exit(main())
`;
}

/**
 * 读取指定应用的 Safe Storage 口令。
 *
 * @param {{ application?: string, pythonBin?: string, timeoutMs?: number }} [opts]
 * @returns {string} 非空口令
 * @throws {QwenAuthError} 密钥环不可用 / 条目缺失 / 被锁定
 */
export function readSecretServicePassword(opts = {}) {
  const application = opts.application ?? 'QwenWorkCN';
  const pythonBin = opts.pythonBin ?? 'python3';
  const timeoutMs = opts.timeoutMs ?? 20_000;

  let res;
  try {
    res = spawnSync(pythonBin, ['-c', buildProbeScript(), CHROME_SCHEMA], {
      input: application,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MISSING,
      `调用 ${pythonBin} 读取系统密钥环失败：${e.message}`,
      { cause: e, recovery: '请确认系统已安装 python3 与 libglib bindings（python3-gi）。' },
    );
  }

  if (res.error) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MISSING,
      `读取系统密钥环的进程启动失败：${res.error.message}`,
      {
        cause: res.error,
        recovery: `${pythonBin} 与 python3-gi 是 Linux 上解密凭据的必需项；请先安装。`,
      },
    );
  }

  if (res.status !== 0) {
    const err = (res.stderr ?? '').trim();
    const hint = (() => {
      if (err.startsWith('NO_SESSION_BUS')) return '当前没有可用的 D-Bus 会话总线（可能不在桌面会话内运行）。';
      if (err.startsWith('NO_SECRET_SERVICE')) return '系统没有运行 Secret Service（gnome-keyring / KWallet 未启动）。';
      if (err === 'NOT_FOUND') return `系统密钥环里没有 ${application} 的 Safe Storage 条目。`;
      if (err.startsWith('LOCKED_PROMPT_NEEDED')) {
        return '系统密钥环已锁定，且解锁需要在桌面上确认（弹出的解锁对话框）。';
      }
      if (err.startsWith('LOCKED_NO_COLLECTION')) {
        return '系统密钥环已锁定，且无法确定条目所属的密钥环。';
      }
      if (err.startsWith('LOCKED_UNLOCK_FAILED') || err.startsWith('LOCKED_STILL')) {
        return `系统密钥环已锁定，自动解锁失败：${err.split(':').slice(1).join(':').slice(0, 160)}`;
      }
      if (err.startsWith('READ_FAILED')) {
        return `读取 Safe Storage 条目失败（非锁定原因）：${err.slice('READ_FAILED:'.length).slice(0, 160)}`;
      }
      if (err.startsWith('LOCKED')) return '系统密钥环已锁定，无法读取 Safe Storage 条目。';
      return '未知原因。';
    })();
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MISSING,
      `读取 ${application} 的 Safe Storage 口令失败（退出码 ${res.status}）：${hint}`,
      {
        recovery: (() => {
          if (err === 'NOT_FOUND') {
            return '请先安装并登录千问办公桌面应用，让它把口令写入系统密钥环。';
          }
          if (err.startsWith('LOCKED_PROMPT_NEEDED') || err.startsWith('LOCKED_UNLOCK_FAILED')) {
            return '请在桌面上打开「密码和密钥」（seahorse）或 KWallet，解锁 Default Keyring 后重试。';
          }
          if (err.startsWith('READ_FAILED')) {
            return '密钥环可访问但读取失败，请重新登录千问办公桌面应用以刷新该条目。';
          }
          return '请解锁系统密钥环后重试（KDE 用 KWallet，GNOME 用钥匙串）。';
        })(),
      },
    );
  }

  const password = res.stdout ?? '';
  if (password.length === 0) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MISSING,
      '系统密钥环返回的 Safe Storage 口令为空。',
      { recovery: '请重新登录千问办公桌面应用。' },
    );
  }
  return password;
}

/**
 * 探测本机是否具备读取口令的条件（不抛异常，供设置卡片显示状态）。
 * @param {{ application?: string, pythonBin?: string }} [opts]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function probeSecretService(opts = {}) {
  try {
    readSecretServicePassword(opts);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof QwenAuthError ? e.message : String(e?.message ?? e) };
  }
}
