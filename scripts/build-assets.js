'use strict';
/**
 * 从仓库自带的 main.ico 生成 electron-builder 需要的构建资源。
 * 幂等：已存在且非空的产物默认跳过，--force 可强制重建。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const force = process.argv.includes('--force');
const buildDir = path.join(root, 'build');
const iconsDir = path.join(buildDir, 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

function have(rel) {
  const f = path.join(root, rel);
  return !force && fs.existsSync(f) && fs.statSync(f).size > 0;
}
function run(args) {
  try { execFileSync('magick', args, { cwd: root, stdio: 'pipe' }); }
  catch (e) { execFileSync('convert', args, { cwd: root, stdio: 'pipe' }); }
}

const source = path.join(root, 'main.ico');
if (!fs.existsSync(source)) {
  console.error('❌ 缺少 main.ico，无法生成构建资源');
  process.exit(1);
}

if (!have('build/icon.png')) { run([source + '[0]', '-resize', '256x256', path.join(buildDir, 'icon.png')]); console.log('✅ build/icon.png'); }
for (const s of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
  const rel = `build/icons/${s}x${s}.png`;
  if (have(rel)) continue;
  run([source + '[0]', '-resize', `${s}x${s}`, path.join(root, rel)]);
  console.log('✅ ' + rel);
}
if (!have('build/background.png')) {
  run(['-size', '540x380', 'gradient:#1b1b2f-#0f0f1e', path.join(buildDir, 'background.png')]);
  console.log('✅ build/background.png');
}
if (!have('build/icon.icns')) {
  const script = `from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert('RGBA')
im.save(sys.argv[2], format='ICNS')`;
  try {
    execFileSync('python3', ['-c', script, path.join(buildDir, 'icon.png'), path.join(buildDir, 'icon.icns')], { cwd: root, stdio: 'pipe' });
    console.log('✅ build/icon.icns');
  } catch (e) {
    console.warn('⚠️ 无法生成 ICNS（需要 Pillow）；macOS 构建会失败，Linux/Windows 不受影响。');
  }
}
console.log('\n🎉 构建资源已就绪。');
