'use strict';
/**
 * 打包前检查：只校验当前目标平台真正需要的二进制文件。
 * - HRUFT: 各平台自带
 * - iPerf: 本项目仅支持 iPerf 2，不再要求 iperf3
 * - macOS: 由 GitHub Actions 的 macOS runner 构建，本脚本不强行要求其二进制
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const platform = process.platform;
const target = process.env.NTT_TARGET_OS || platform; // win32 | linux | darwin
const binDirByTarget = { win32: 'bin/windows', linux: 'bin/linux', darwin: 'bin/mac' };
const hruftName = { win32: 'hruft.exe', linux: 'hruft', darwin: 'hruft' };
const iperfName = { win32: 'iperf2.exe', linux: 'iperf2', darwin: 'iperf2' };

const binDir = binDirByTarget[target];
if (!binDir) {
  console.error(`❌ 未知的目标平台: ${target}`);
  process.exit(1);
}

const required = [hruftName[target], iperfName[target]].map(n => path.join(root, binDir, n));
const errors = [];

console.log(`🔍 NetTestTool Pro - 打包前检查 (目标平台: ${target})\n`);
for (const file of required) {
  if (!fs.existsSync(file)) {
    errors.push(`缺少文件: ${path.relative(root, file)}`);
    continue;
  }
  const st = fs.statSync(file);
  console.log(`✅ ${path.relative(root, file)} (${(st.size / 1024 / 1024).toFixed(2)} MB)`);
  if (target !== 'win32' && !(st.mode & 0o111)) {
    console.log(`   ⚠️  缺少执行权限，构建时将自动 chmod`);
    try { fs.chmodSync(file, 0o755); } catch (e) { errors.push(`无法设置执行权限: ${file}`); }
  }
}

// 构建资源是 electron-builder 的硬性要求
for (const asset of ['build/icon.icns', 'build/background.png', 'build/icons/256x256.png', 'main.ico']) {
  const f = path.join(root, asset);
  if (!fs.existsSync(f)) errors.push(`缺少构建资源: ${asset}`);
  else console.log(`✅ ${asset}`);
}

if (errors.length) {
  console.error('\n❌ 检查失败:');
  errors.forEach(e => console.error('  ' + e));
  console.error('\n请运行 npm run build:assets 及 npm run setup:binaries 补齐资源。');
  process.exit(1);
}
console.log('\n✅ 所有检查通过，可以开始打包。');
