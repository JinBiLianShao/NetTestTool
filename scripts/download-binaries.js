/**
 * download-binaries.js - 自动下载 iPerf2/iPerf3 二进制文件
 * 使用方法: node scripts/download-binaries.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('📦 NetTestTool Pro - 二进制文件下载工具\n');

// iPerf 下载配置
const IPERF_URLS = {
    windows: {
        iperf3: 'https://iperf.fr/download/windows/iperf-3.1.3-win64.zip',
        iperf2: 'https://iperf.fr/download/windows/iperf-2.0.9-win64.zip'
    },
    linux: {
        // Linux 建议通过包管理器安装,这里提供手动下载链接
        note: '建议使用: sudo apt install iperf iperf3 (Debian/Ubuntu)'
    },
    darwin: {
        note: '建议使用: brew install iperf iperf3'
    }
};

// 创建必要目录
const dirs = [
    'bin',
    'bin/windows',
    'bin/linux',
    'bin/mac',
    'temp'
];

dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ 创建目录: ${dir}`);
    }
});

// 下载文件函数
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const lib = url.startsWith('https') ? https : http;

        console.log(`📥 下载中: ${url}`);

        lib.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // 处理重定向
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                console.log(`✅ 下载完成: ${dest}`);
                resolve();
            });
        }).on('error', (err) => {
            fs.unlinkSync(dest);
            reject(err);
        });
    });
}

// Windows 平台下载
async function downloadWindows() {
    console.log('\n🪟 检测到 Windows 平台');

    const tempDir = 'temp';

    try {
        // 下载 iPerf3
        const iperf3Zip = path.join(tempDir, 'iperf3.zip');
        await downloadFile(IPERF_URLS.windows.iperf3, iperf3Zip);

        // 解压 (需要 7-Zip 或 PowerShell)
        console.log('📦 解压 iPerf3...');
        try {
            execSync(`powershell -command "Expand-Archive -Path '${iperf3Zip}' -DestinationPath '${tempDir}/iperf3' -Force"`);

            // 查找可执行文件
            const files = fs.readdirSync(path.join(tempDir, 'iperf3'), { recursive: true });
            const exeFile = files.find(f => f.endsWith('iperf3.exe'));

            if (exeFile) {
                fs.copyFileSync(
                    path.join(tempDir, 'iperf3', exeFile),
                    'bin/windows/iperf3.exe'
                );
                console.log('✅ iPerf3 已安装');
            }
        } catch (e) {
            console.warn('⚠️  解压失败,请手动解压并放置到 bin/windows/');
        }

        // 同样处理 iPerf2
        // ...

    } catch (error) {
        console.error('❌ 下载失败:', error.message);
        console.log('\n请手动下载:');
        console.log('iPerf3: https://iperf.fr/iperf-download.php');
        console.log('iPerf2: https://iperf.fr/iperf-download.php');
    }
}

// Linux/Mac 提示
function showUnixInstructions() {
    const platform = process.platform;
    console.log(`\n🐧 检测到 ${platform} 平台`);
    console.log('\n推荐安装方式:');

    if (platform === 'linux') {
        console.log('  Debian/Ubuntu: sudo apt install iperf iperf3');
        console.log('  RHEL/CentOS:   sudo yum install iperf iperf3');
        console.log('  Arch Linux:    sudo pacman -S iperf iperf3');
    } else if (platform === 'darwin') {
        console.log('  Homebrew:      brew install iperf iperf3');
    }

    console.log('\n安装后创建软链接:');
    console.log(`  ln -s $(which iperf) bin/${platform === 'darwin' ? 'mac' : 'linux'}/iperf2`);
    console.log(`  ln -s $(which iperf3) bin/${platform === 'darwin' ? 'mac' : 'linux'}/iperf3`);
}

// HRUFT 检查
function checkHruft() {
    console.log('\n🚀 HRUFT 可执行文件检查:');

    const hruftPaths = {
        windows: 'bin/windows/hruft.exe',
        linux: 'bin/linux/hruft',
        darwin: 'bin/mac/hruft'
    };

    Object.entries(hruftPaths).forEach(([platform, filePath]) => {
        if (fs.existsSync(filePath)) {
            console.log(`  ✅ ${platform}: ${filePath}`);
        } else {
            console.log(`  ❌ ${platform}: ${filePath} (未找到)`);
        }
    });

    console.log('\n💡 请将编译好的 HRUFT 可执行文件放置到对应目录');
}

// 主函数
async function main() {
    const platform = process.platform;

    if (platform === 'win32') {
        await downloadWindows();
    } else {
        showUnixInstructions();
    }

    checkHruft();

    console.log('\n🎉 完成! 请查看上述输出了解缺失的文件');
}

main().catch(console.error);