/**
 * 渲染类检查工具的共享依赖定位器。
 *
 * 为什么单独成模块：`client-render-check.mjs`（SSR 静态渲染）与
 * `client-mount-check.mjs`（真实挂载 + effect）都需要 react / react-dom，
 * 而本仓库**零运行时依赖**，不预装它们。定位规则写两份必然漂移——先前
 * `client-render-check.mjs` 就把路径硬编码成 Windows 的
 * `%APPDATA%\dsh-desktop\harness\profiles\node_modules`，在 Linux 上永远
 * 找不到依赖，脚本直接 exit 2（表现为"跳过"，实际是坏的）。
 *
 * 查找顺序（先命中先返回，三者**必须**在同一目录下都解析成功，
 * 否则会加载到两份 React 实例，hooks 报 Invalid hook call）：
 *   1. 环境变量 `QWEN_RENDER_DEPS`（可指向目录本身或其父目录）
 *   2. 本包的 node_modules
 *   3. DSH profile 的 node_modules（`--profile-dir` 或 `DSH_PROFILE_DIR`）
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 参数名 → 是否带值。只解析本模块用得到的那个参数。 */
const PROFILE_FLAG = '--profile-dir';

/**
 * 收集候选的 node_modules 目录（按优先级）。
 *
 * @param {string} pluginRoot 插件根目录（其下可能有 node_modules）
 * @returns {string[]}
 */
export function renderDepCandidates(pluginRoot) {
  const list = [];
  const fromEnv = process.env.QWEN_RENDER_DEPS;
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    list.push(fromEnv);
    list.push(path.join(fromEnv, 'node_modules'));
  }
  list.push(path.join(pluginRoot, 'node_modules'));

  const argv = process.argv.slice(2);
  const flagAt = argv.indexOf(PROFILE_FLAG);
  const profileDir =
    flagAt >= 0 && argv[flagAt + 1] !== undefined
      ? argv[flagAt + 1]
      : process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir !== '') {
    const resolved = path.resolve(profileDir);
    list.push(path.join(resolved, 'node_modules'));
    // DSH 的共享依赖可能落在 profiles/ 那一层，而不是单个 profile 下
    list.push(path.join(resolved, '..', 'node_modules'));
  }
  return list;
}

/**
 * 找一个能同时解析出所需全部依赖的目录。
 *
 * @param {string} pluginRoot
 * @param {string[]} needed 需要解析的模块名，例如 ['react', 'react-dom/server']
 * @returns {{ dir: string, require: NodeJS.Require } | null} 找不到返回 null
 */
export function findRenderDeps(pluginRoot, needed) {
  for (const dir of renderDepCandidates(pluginRoot)) {
    // 先用文件系统粗筛，避免对每个候选都触发一遍模块解析异常
    if (!fs.existsSync(path.join(dir, 'react', 'package.json'))) continue;
    try {
      const req = createRequire(path.join(dir, 'noop.js'));
      for (const name of needed) req.resolve(name);
      return { dir, require: req };
    } catch {
      /* 该目录不完整（例如只有 react 没有 react-dom），继续找下一个 */
    }
  }
  return null;
}

/** 缺依赖时打印可操作的启用指引。 */
export function printMissingDepsHelp(needed, packages) {
  const write = (s) => process.stdout.write(`${s}\n`);
  write('⚠️  跳过：未找到 ' + needed.join(' / '));
  write('   这是可选检查——本仓库零运行时依赖，不预装这些包。');
  write('   启用方式（任选其一）：');
  write('     QWEN_RENDER_DEPS=/path/to/dir node <本脚本>');
  write('     node <本脚本> --profile-dir ~/.dsh/profiles/web');
  write('   准备依赖：');
  write('     mkdir -p /tmp/render-deps && cd /tmp/render-deps \\');
  write(`       && npm i ${packages.join(' ')} --no-audit --no-fund`);
  write(`     QWEN_RENDER_DEPS=/tmp/render-deps node <本脚本>`);
}
