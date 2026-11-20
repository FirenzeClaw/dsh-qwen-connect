// research/probes-2026-09-14/check-no-tracked-artifacts.mjs
//
// 不变量：构建产物不得进版本库。
//
// 为什么需要这条检查（而不是运行时护栏）：
//   历史上 `.portable-check/` 与 `dist/` 都被提交过。当时的处理是在
//   `check-portable-package.mjs` 结尾加了一段「若已被跟踪就跳过清理」的
//   护栏——它能防止误删，但**把问题静默掩盖了**：产物继续留在版本库里，
//   与源码逐渐漂移，搜一个函数名会命中两处，其中一处是过时的。
//
//   一旦产物真的出库，那次护栏就没有存在理由；取而代之的是这条**不变量**：
//   直接断言「没有产物被跟踪」，发现即失败，让人要么清理、要么说明理由。
//
// 判据：`git ls-files .portable-check dist` 必须为空。
//
// 退出码：
//   0  没有产物被跟踪
//   1  发现产物被跟踪（列出前若干条）
//   2  无法判断（不是 git 仓库 / 没有 git）——按「跳过」语义
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/** 不应被版本库跟踪的构建产物目录。 */
const ARTIFACT_PATHS = ['.portable-check', 'dist'];

let out;
try {
  // -z 用 NUL 分隔，避免 git 把中文路径转成带引号的八进制转义
  out = execFileSync('git', ['ls-files', '-z', '--', ...ARTIFACT_PATHS], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  // 不是 git 仓库，或环境里没有 git：无从判断，按跳过处理
  console.log('○ 跳过：无法读取 git 索引（不是仓库，或没有 git）');
  process.exit(2);
}

const tracked = out
  .split('\0')
  .map((line) => line.trim())
  .filter((line) => line !== '');

if (tracked.length === 0) {
  console.log(`[OK] 构建产物未被跟踪（检查了 ${ARTIFACT_PATHS.join('、')}）`);
  process.exit(0);
}

console.error(`[FAIL] 有 ${tracked.length} 个构建产物被版本库跟踪`);
console.error('  这些目录应由打包／验证工具生成，不入库：');
for (const p of ARTIFACT_PATHS) console.error(`    · ${p}/`);
console.error('');
console.error('  前 10 条：');
for (const line of tracked.slice(0, 10)) console.error(`    ${line}`);
if (tracked.length > 10) console.error(`    …（其余 ${tracked.length - 10} 条略）`);
console.error('');
console.error('  修复：git rm -r --cached ' + ARTIFACT_PATHS.join(' '));
console.error('        （加 --cached 只移出索引，工作区文件保留）');
process.exit(1);
