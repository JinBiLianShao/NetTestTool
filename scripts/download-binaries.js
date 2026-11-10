'use strict';
/**
 * 准备 iPerf 2 二进制文件。
 * - 若系统已安装 iperf/iperf2，创建符号链接到 bin/<platform>/iperf2
 * - 否则提示对应平台的安装方式（Windows 可自动下载 zip 并解出 iperf2.exe）
 * 仅处理 iPerf 2：本项目已移除 iPerf 3 支持。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');

const target = process.env.NTT_TARGET_OS || process.platform;
const dirByTarget = { win32: 'windows', linux: 'linux', darwin: 'mac' };
const nameByTarget = { win32: 'iperf2.exe', linux: 'iperf2', darwin: 'iperf2' };
const folder = dirByTarget[target];
if (!folder) { console.error('❌ 未知平台: ' + target); process.exit(1); }
const outDir = path.join(root, 'bin', folder);
const outFile = path.join(outDir, nameByTarget[target]);
fs.mkdirSync(outDir, { recursive: true });

if (fs.existsSync(outFile)) {
  console.log(`✅ 已存在: ${path.relative(root, outFile)}`);
  process.exit(0);
}

function download(url, dest, redirects) {
  redirects = redirects || 0;
  if (redirects > 5) return Promise.reject(new Error('重定向次数过多'));
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return download(next, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', e => { try { fs.unlinkSync(dest); } catch (_) {} reject(e); });
    req.setTimeout(30000, () => req.destroy(new Error('下载超时')));
  });
}

async function main() {
  if (target !== 'win32') {
    for (const cmd of ['iperf', 'iperf2']) {
      try {
        const bin = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
        if (bin) {
          fs.symlinkSync(bin, outFile);
          console.log(`✅ 已链接系统 ${cmd}: ${bin} -> ${path.relative(root, outFile)}`);
          return;
        }
      } catch (_) {}
    }
    const hint = target === 'linux'
      ? 'Debian/Ubuntu: sudo apt install iperf    |    Arch: sudo pacman -S iperf2'
      : 'brew install iperf';
    console.log('⚠️ 未找到系统 iPerf 2，请安装后重跑本脚本：');
    console.log('   ' + hint);
    console.log('   或手动放置二进制到 ' + path.relative(root, outFile));
    process.exit(1);
  }

  const url = 'https://iperf.fr/download/windows/iperf-2.0.9-win64.zip';
  const zip = path.join(root, 'temp', 'iperf2.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  try {
    console.log('📥 下载 ' + url);
    await download(url, zip);
    const tmp = path.join(root, 'temp', 'iperf2-extract');
    fs.rmSync(tmp, { recursive: true, force: true });
    execFileSync('7z', ['x', '-y', '-o' + tmp, zip], { stdio: 'pipe' });
    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/iperf2?\.exe$/i.test(e.name)) found.push(f);
      }
    })(tmp);
    if (!found.length) throw new Error('zip 中未找到 iperf2.exe');
    fs.copyFileSync(found[0], outFile);
    console.log('✅ 已安装 ' + path.relative(root, outFile));
  } catch (e) {
    console.error('❌ 自动下载失败: ' + e.message);
    console.error('   请从 https://iperf.fr/iperf-download.php 手动下载并放到 ' + path.relative(root, outFile));
    process.exit(1);
  }
}
main();
