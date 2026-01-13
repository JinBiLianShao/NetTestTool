/**
 * pre-build-check.js - 打包前检查脚本
 * 验证所有必需的二进制文件是否存在
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 NetTestTool Pro - 打包前检查\n');

const platform = process.platform;
let errors = [];
let warnings = [];

// 检查目录结构
const binDirs = {
    windows: 'bin/windows',
    linux: 'bin/linux',
    darwin: 'bin/mac'
};

const requiredFiles = {
    windows: [
        'bin/windows/hruft.exe',
        'bin/windows/iperf2.exe',
        'bin/windows/iperf3.exe'
    ],
    linux: [
        'bin/linux/hruft',
        'bin/linux/iperf2',
        'bin/linux/iperf3'
    ],
    darwin: [
        'bin/mac/hruft',
        'bin/mac/iperf2',
        'bin/mac/iperf3'
    ]
};

// 当前平台必须文件
const currentPlatformFiles = requiredFiles[platform] || [];

console.log(`📦 当前平台: ${platform}\n`);

// 检查目录
Object.entries(binDirs).forEach(([name, dir]) => {
    if (fs.existsSync(dir)) {
        console.log(`✅ 目录存在: ${dir}`);
    } else {
        if (name === platform) {
            errors.push(`❌ 缺少必需目录: ${dir}`);
        } else {
            warnings.push(`⚠️  目录不存在: ${dir} (其他平台,可忽略)`);
        }
    }
});

console.log();

// 检查文件
currentPlatformFiles.forEach(file => {
    if (fs.existsSync(file)) {
        const stats = fs.statSync(file);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`✅ ${file} (${sizeMB} MB)`);

        // 检查权限 (Linux/Mac)
        if (platform !== 'win32') {
            const mode = stats.mode.toString(8);
            if (!mode.endsWith('755') && !mode.endsWith('777')) {
                warnings.push(`⚠️  ${file} 可能缺少执行权限 (${mode})`);
            }
        }
    } else {
        errors.push(`❌ 缺少文件: ${file}`);
    }
});

console.log();

// 检查其他平台 (跨平台打包)
Object.entries(requiredFiles).forEach(([platName, files]) => {
    if (platName === platform) return; // 跳过当前平台

    const exists = files.filter(f => fs.existsSync(f));
    if (exists.length > 0) {
        console.log(`📁 ${platName} 平台文件: ${exists.length}/${files.length}`);
    }
});

console.log('\n' + '='.repeat(60));

// 输出结果
if (errors.length > 0) {
    console.log('\n❌ 发现错误:');
    errors.forEach(e => console.log(`  ${e}`));
}

if (warnings.length > 0) {
    console.log('\n⚠️  警告:');
    warnings.forEach(w => console.log(`  ${w}`));
}

if (errors.length === 0) {
    console.log('\n✅ 所有检查通过! 可以开始打包\n');
    console.log('运行打包命令:');
    console.log('  npm run build:win    # Windows');
    console.log('  npm run build:mac    # macOS');
    console.log('  npm run build:linux  # Linux');
    process.exit(0);
} else {
    console.log('\n❌ 检查失败! 请先修复上述问题\n');
    console.log('解决方案:');
    console.log('1. 编译 HRUFT 项目并复制可执行文件到 bin/ 目录');
    console.log('2. 下载 iPerf:');
    console.log('   - iPerf3: https://iperf.fr/iperf-download.php');
    console.log('   - iPerf2: https://iperf.fr/iperf-download.php');
    console.log('3. 或运行自动下载脚本: npm run setup:binaries');
    process.exit(1);
}