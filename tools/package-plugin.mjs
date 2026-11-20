/**
 * 打包 dsh-qwen-connect 为可移植的发布包。
 *
 * 产物：`dist/dsh-qwen-connect-<version>.zip` + 同目录的解包版 `dist/dsh-qwen-connect/`
 *
 * 打包原则：
 *   - 只含运行必需文件（lib/、cordis.patch.yml、package.json、README、LICENSE）
 *   - WASM 二进制（research/wasm.bin 与 research/qoder-wasm-glue.mjs）是**运行依赖**，
 *     必须一并打包 —— 它们虽在 research/ 下，但 signer-session.js 会加载它们
 *   - 排除 test/、tests/、docs/、tools/、research/ 的其余部分（开发期产物）
 *
 * 用法：
 *   node tools/package-plugin.mjs              # 打包
 *   node tools/package-plugin.mjs --out <dir>  # 指定输出目录
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

/**
 * python3 兜底打包脚本：用标准库 zipfile 递归打包一个目录。
 *
 * 之所以选 python3 而不是引入 zip 依赖：本仓库已有 python3 运行时依赖
 * （Secret Service 口令读取走 python3 + Gio），且打包工具不该为压缩格式
 * 引入第三方包。
 *
 * 用法：python3 -c <script> <zipPath> <dirName>
 */
const ZIPPACK_SCRIPT = [
  'import os, sys, zipfile',
  'out, root = sys.argv[1], sys.argv[2]',
  'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:',
  '    for base, dirs, files in os.walk(root):',
  '        dirs.sort()',
  '        for name in sorted(files):',
  '            full = os.path.join(base, name)',
  '            z.write(full, full)',
].join('\n');

/** 读取插件 package.json。 */
function readPluginManifest() {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
}

/**
 * 计算需要打包的文件清单（相对 PLUGIN_ROOT 的 POSIX 路径）。
 *
 * 运行必需：
 *   - lib/**                       全部模块
 *   - cordis.patch.yml             loader 条目声明
 *   - package.json                 dsh.bundle / dsh.client 元数据
 *   - README.md                    安装说明
 *   - research/wasm.bin            签名 WASM（运行期加载）
 *   - research/qoder-wasm-glue.mjs glue 代码（运行期动态 import）
 */
function collectFiles() {
  const out = [];
  const addIfFile = (rel) => {
    const abs = path.join(PLUGIN_ROOT, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.push(rel);
  };

  // lib/ 全量
  const libDir = path.join(PLUGIN_ROOT, 'lib');
  if (fs.existsSync(libDir)) {
    for (const name of fs.readdirSync(libDir)) {
      if (name.endsWith('.js')) out.push(`lib/${name}`);
    }
  }

  // 顶层必需文件
  for (const name of ['cordis.patch.yml', 'package.json', 'README.md', 'INSTALL-新电脑.md', 'LICENSE']) {
    addIfFile(name);
  }

  // WASM 运行依赖
  addIfFile('research/wasm.bin');
  addIfFile('research/qoder-wasm-glue.mjs');

  // 注入器：新机器上需要它来完成 DSH 接线，必须随包分发
  addIfFile('tools/install-to-dsh.mjs');
  // profile 自动探测：安装器依赖它适配不同 DSH 版本（Desktop / CLI / 自定义）
  addIfFile('tools/detect-dsh.mjs');
  // 一键脚本：双击即可安装/卸载，免去手敲命令
  addIfFile('一键安装.cmd');
  addIfFile('一键卸载.cmd');
  // 渲染自检：无浏览器也能验证卡片组件不崩、数据渲染正确
  addIfFile('tools/client-render-check.mjs');
  // 上面两个渲染自检的共享依赖定位器（找不到 react 时给出可操作的指引，
  // 而不是硬编码某个平台的路径）。它们 import 它，缺了就装完即崩。
  addIfFile('tools/render-deps.mjs');
  addIfFile('tools/client-mount-check.mjs');
  // 模型显示预览：确认倍率/标记映射到选择器的效果
  addIfFile('tools/models-preview.mjs');
  // token 统计自检：确认 usage 已下发（DSH 靠它显示 token 数）
  addIfFile('tools/usage-e2e.mjs');

  // 排障文档：新机器上遇到问题的第一手参考
  addIfFile('docs/已知上游边界.md');
  // 多版本安装说明
  addIfFile('安装说明.md');

  return out.sort();
}
/** 递归统计目录大小与文件数。 */
function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirStats(abs);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(abs).size;
    }
  }
  return { files, bytes };
}

/** 生成发布用的 package.json（去掉开发期字段，补上 files/engines）。 */
function buildPublishManifest(manifest, files) {
  const published = { ...manifest };
  // files 字段：让 npm pack / 人工核对都知道发布内容
  const dirs = new Set();
  for (const rel of files) dirs.add(rel.includes('/') ? `${rel.split('/')[0]}/` : rel);
  published.files = [...dirs].sort();
  // 本地插件不发布到 registry，保持 private 以免误发
  published.private = true;
  // 去掉只对开发有意义的脚本
  if (published.scripts !== undefined) {
    const keep = {};
    for (const [k, v] of Object.entries(published.scripts)) {
      if (k.startsWith('test') || k.startsWith('probe')) continue;
      keep[k] = v;
    }
    if (Object.keys(keep).length > 0) published.scripts = keep;
    else delete published.scripts;
  }
  return published;
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outRoot = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : path.join(PLUGIN_ROOT, 'dist');

  const manifest = readPluginManifest();
  const files = collectFiles();
  const pkgName = manifest.name;
  const version = manifest.version;
  const stageDir = path.join(outRoot, pkgName);

  console.log(`打包 ${pkgName}@${version}`);
  console.log(`  源目录: ${PLUGIN_ROOT}`);
  console.log(`  输出:   ${outRoot}`);
  console.log('');

  // 1) 清空并重建 stage 目录
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // 2) 复制文件
  for (const rel of files) {
    const src = path.join(PLUGIN_ROOT, rel);
    const dst = path.join(stageDir, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  // 3) 写入发布版 package.json
  const publishManifest = buildPublishManifest(manifest, files);
  fs.writeFileSync(path.join(stageDir, 'package.json'), `${JSON.stringify(publishManifest, null, 2)}\n`, 'utf8');

  const stats = dirStats(stageDir);
  console.log(`✅ 已生成 ${path.relative(PLUGIN_ROOT, stageDir)}/`);
  console.log(`   文件 ${stats.files} 个，合计 ${(stats.bytes / 1024).toFixed(1)} KB`);
  console.log('');

  // 4) 打印清单分组
  const groups = new Map();
  for (const rel of files) {
    const key = rel.includes('/') ? `${rel.split('/')[0]}/` : '(根)';
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  console.log('   内容分组：');
  for (const [key, count] of [...groups.entries()].sort()) {
    console.log(`     ${key.padEnd(24)} ${count} 个文件`);
  }
  console.log('');
  console.log('   运行依赖（务必随包分发）：');
  console.log('     research/wasm.bin            签名 WASM');
  console.log('     research/qoder-wasm-glue.mjs glue 代码');
  console.log('');

  // 5) 生成 zip（供拷到别的电脑）
  //
  // ⚠️ 这里必须**验证产物真的是 zip**，不能只看命令有没有报错。
  //
  // 实测事故：`tar -a -c -f x.zip` 在 Windows（内置 bsdtar）上能生成真 zip，
  // 但在 GNU tar（Linux/macOS 的默认 tar）上 `-a` 只认 gzip/xz/zstd 等后缀，
  // `.zip` 不在支持列表里——于是它**静默产出一个纯 tar 文件**，命令退出码仍是 0。
  // 结果是一个 770 KB、名为 .zip、实际 `unzip` 打不开的产物（本机已复现）。
  //
  // 因此改为「按顺序尝试多种方式，每步都用魔数验证」：
  //   ① bsdtar 形态的 tar -a（Windows 10+ / macOS）
  //   ② zip 命令（Linux 常见）
  //   ③ python3 的 zipfile（本机已有；零第三方依赖）
  const zipPath = path.join(outRoot, `${pkgName}-${version}.zip`);
  fs.rmSync(zipPath, { force: true });

  /** 真 zip 的魔数：`PK\x03\x04`。 */
  const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

  /** 产物是否真的是 zip（而不是被改名的 tar）。 */
  const looksLikeZip = () => {
    try {
      const fd = fs.openSync(zipPath, 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      return head.equals(ZIP_MAGIC);
    } catch {
      return false;
    }
  };

  const zipStrategies = [
    {
      name: 'tar -a',
      // tar 打包必须用相对路径且 cwd 在 outRoot，否则压缩包内会带完整绝对路径
      run: () => execFileSync('tar', ['-a', '-c', '-f', zipPath, pkgName], {
        cwd: outRoot, stdio: 'pipe', timeout: 120000,
      }),
    },
    {
      name: 'zip',
      run: () => execFileSync('zip', ['-r', '-q', zipPath, pkgName], {
        cwd: outRoot, stdio: 'pipe', timeout: 120000,
      }),
    },
    {
      name: 'python3 zipfile',
      run: () => execFileSync('python3', ['-c', ZIPPACK_SCRIPT, zipPath, pkgName], {
        cwd: outRoot, stdio: 'pipe', timeout: 120000,
      }),
    },
  ];

  let zipped = false;
  const attempts = [];
  for (const strategy of zipStrategies) {
    try {
      strategy.run();
    } catch (e) {
      attempts.push(`${strategy.name}: ${String(e.message).split('\n')[0].slice(0, 60)}`);
      continue;
    }
    if (looksLikeZip()) {
      zipped = true;
      break;
    }
    // 命令成功但产物不是 zip（GNU tar 的静默行为）——删掉再试下一种
    attempts.push(`${strategy.name}: 产物不是 zip（命令退出码为 0，但魔数不符）`);
    fs.rmSync(zipPath, { force: true });
  }
  if (!zipped && attempts.length > 0) {
    console.log('   ⚠️ 未能生成可用的 zip，尝试记录：');
    for (const a of attempts) console.log(`      · ${a}`);
    console.log(`      可只分发解包目录 ${pkgName}/（安装效果相同）。`);
  }
  if (zipped) {
    const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
    console.log(`✅ 已生成 ${path.relative(PLUGIN_ROOT, zipPath)}（${kb} KB）`);
    console.log('');
  }

  console.log('下一步（在本机）：');
  console.log(`  node tools/install-to-dsh.mjs --source "${stageDir}"`);
  console.log('');
  console.log('拷到别的电脑：');
  console.log(`  1. 把 ${zipped ? path.basename(zipPath) + '（或解包后的 ' + pkgName + '/ 目录）' : `${pkgName}/ 整个目录`} 复制过去`);
  console.log('  2. 解压到任意目录');
  console.log('  3. 双击其中的「一键安装.cmd」');
  console.log('  详见包内「安装说明.md」');
}

main();
