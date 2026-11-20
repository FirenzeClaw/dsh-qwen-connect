// research/probes-2026-09-14/check-install-drift.mjs
//
// 不变量：装进 DSH profile 的那一份，必须**就是**本仓库本身（符号链接），
// 不能是它的副本。
//
// 为什么需要这条检查（真实事故，2026-11-20 发现）：
//   profile 的 package.json 曾把插件声明成 `file:./node_modules/<name>`。
//   2026-11-18 在 profile 里跑了一次 `pnpm install`，pnpm 把这个 file: 依赖
//   **物化成硬链接副本**，覆盖掉安装器建的符号链接。此后：
//
//     · 源码继续改，profile 里那份冻结在 11-18
//     · 界面上一切正常（插件在加载、模型在选择器里）
//     · 只有行为莫名停在旧版本，而没有任何报错
//
//   这是最难发现的一类问题：不是坏了，是**旧的**。所以用一条不变量守着，
//   而不是靠人去记得检查。
//
// 判据：profile/node_modules/<name> 必须是符号链接，且 realpath 等于本仓库根。
//
// 退出码：
//   0  已安装且指向本仓库；或未安装（没什么可漂移的）
//   1  已安装但入口是实体目录（副本），或指向别处
//   2  无法判断（找不到 profile）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PLUGIN_NAME = 'dsh-qwen-connect';

/** profile 目录候选：环境变量优先（DSH 自己会设），否则没有可信来源。 */
function profileCandidates() {
  const out = [];
  if (process.env.DSH_PROFILE_DIR) out.push(process.env.DSH_PROFILE_DIR);
  if (process.env.DSH_HOME) out.push(path.join(process.env.DSH_HOME, 'profiles', 'web'));
  out.push(path.join(process.env.HOME ?? '', '.dsh', 'profiles', 'web'));
  return out.filter((p) => p !== '' && p !== path.join('', '.dsh', 'profiles', 'web'));
}

const profileDir = profileCandidates().find((p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
});

if (profileDir === undefined) {
  console.log('○ 跳过：找不到 DSH profile（本机未安装 DSH，或未设置 DSH_PROFILE_DIR）');
  process.exit(2);
}

const entry = path.join(profileDir, 'node_modules', PLUGIN_NAME);

let stat;
try {
  stat = fs.lstatSync(entry);
} catch {
  // 未安装：没有可漂移的副本。不判失败——很多人只是还没装。
  console.log(`[OK] 未安装到 profile（${entry} 不存在），无漂移可言`);
  process.exit(0);
}

const repoReal = fs.realpathSync(REPO);

if (stat.isSymbolicLink()) {
  const target = fs.realpathSync(entry);
  if (path.resolve(target) === path.resolve(repoReal)) {
    console.log(`[OK] profile 里装的是本仓库（符号链接 → ${target}）`);
    process.exit(0);
  }
  console.error(`[FAIL] profile 里的插件指向别处：${target}`);
  console.error(`       期望指向：${repoReal}`);
  console.error('       修复：node tools/install-to-dsh.mjs');
  process.exit(1);
}

if (stat.isDirectory()) {
  console.error('[FAIL] profile 里装的是**副本**而非符号链接，它已与仓库分叉');
  console.error(`       入口：${entry}`);
  console.error('');
  console.error('       成因：profile 的 package.json 用 `file:` 声明本插件，');
  console.error('       一次 pnpm install 就会把它物化成硬链接副本，覆盖符号链接。');
  console.error('       症状：界面正常、插件在加载，但行为停在副本生成的那一天，无任何报错。');
  console.error('');
  console.error('       修复：node tools/install-to-dsh.mjs（会重建符号链接并改用 link: 声明）');
  console.error('       注意：修复后必须完全退出并重启 DSH；运行中替换会让新旧代码混用。');
  process.exit(1);
}

console.error(`[FAIL] profile 里的插件入口既不是符号链接也不是目录：${entry}`);
process.exit(1);
