// tools/linux/keyring-status.mjs
//
// 只读体检：列出各 Secret Service 集合的锁状态与条目数。
//
// **不读任何凭据值**——只查 `Locked` 与 `Items` 两个属性。这样可以在
// 排障时把输出贴给别人看，不必先做脱敏。
//
// 为什么需要它：`docs/Linux密钥环.md` 里原先内嵌了一段 node -e 单行脚本，
// 引号嵌套在 shell 里直接断掉（实测 SyntaxError），却在文档里躺了很久。
// 一个能跑的文件比一段复制粘贴的单行命令可靠得多。
//
// 用法：node tools/linux/keyring-status.mjs
// 退出码：0 正常；2 环境不具备（无 python3-gi / 无 D-Bus 会话）

import { spawnSync } from 'node:child_process';

const SCRIPT = String.raw`
import json, sys
from gi.repository import Gio, GLib

try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
except Exception as e:
    sys.stderr.write('NO_SESSION_BUS: %s' % e)
    sys.exit(2)

SVC = 'org.freedesktop.secrets'

def call(path, iface, method, sig, args, rsig):
    return bus.call_sync(SVC, path, iface, method, GLib.Variant(sig, args),
                         GLib.VariantType(rsig), Gio.DBusCallFlags.NONE,
                         15000, None).unpack()

try:
    _, session = call('/org/freedesktop/secrets', 'org.freedesktop.Secret.Service',
                      'OpenSession', '(sv)', ('plain', GLib.Variant('s', '')), '(vo)')
    collections = call('/org/freedesktop/secrets', 'org.freedesktop.DBus.Properties',
                       'Get', '(ss)',
                       ('org.freedesktop.Secret.Service', 'Collections'), '(v)')[0]
except Exception as e:
    sys.stderr.write('NO_SECRET_SERVICE: %s' % e)
    sys.exit(2)

rows = []
for coll in collections:
    try:
        props = call(coll, 'org.freedesktop.DBus.Properties', 'GetAll', '(s)',
                     ('org.freedesktop.Secret.Collection',), '(a{sv})')[0]
    except Exception as e:
        rows.append({'path': str(coll), 'error': str(e)[:120]})
        continue
    rows.append({
        'path': str(coll),
        'label': str(props.get('Label', '')),
        'locked': bool(props.get('Locked', True)),
        'items': len(props.get('Items', [])),
    })

print(json.dumps(rows, ensure_ascii=False))
`;

const res = spawnSync('python3', ['-c', SCRIPT], { encoding: 'utf8', timeout: 30_000 });

if (res.error) {
  console.error(`无法启动 python3：${res.error.message}`);
  console.error('Linux 上读密钥环需要 python3 与 python3-gi（零 npm 依赖的代价）。');
  process.exit(2);
}
if (res.status !== 0) {
  const err = (res.stderr ?? '').trim();
  console.error(`读取密钥环状态失败：${err}`);
  process.exit(2);
}

let rows;
try {
  rows = JSON.parse(res.stdout);
} catch {
  console.error('无法解析探测脚本的输出。');
  process.exit(2);
}

if (rows.length === 0) {
  console.log('没有找到任何 Secret Service 集合。');
  process.exit(0);
}

console.log('Secret Service 集合（只读属性，不含凭据值）：\n');
let anyLocked = false;
for (const row of rows) {
  if (row.error !== undefined) {
    console.log(`  ${row.path}`);
    console.log(`    读取失败：${row.error}`);
    continue;
  }
  const mark = row.locked ? '🔒 锁定' : '🔓 已解锁';
  const name = row.label === '' ? '(无标签)' : row.label;
  const short = row.path.split('/').pop();
  console.log(`  ${mark}  ${name}  [${short}]  ${row.items} 个条目`);
  if (row.locked && row.items > 0) anyLocked = true;
}

console.log('');
if (anyLocked) {
  console.log('有锁定的集合且其中有条目。若对话报「密钥环已锁定」，执行：');
  console.log('  ~/.local/bin/qwen-unlock-keyring.sh');
  console.log('（插件侧的探测脚本也会自动尝试解锁，这通常不需要手动做。）');
} else {
  console.log('没有「已锁定且有条目」的集合——密钥环这一层不应该是失败原因。');
}
