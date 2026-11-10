// HRUFT部署和配置脚本
const fs = require('fs');

console.log('🔧 NetTestTool Pro - HRUFT部署工具');
console.log('==================================');

const platform = process.platform;
const arch = process.arch;

console.log(`检测到系统: ${platform} ${arch}`);

// 检查目录结构
const directories = ['bin', 'bin/windows', 'bin/linux', 'bin/mac'];

directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 创建目录: ${dir}`);
    }
});

// 检查HRUFT可执行文件
const hruftFiles = {
    windows: 'bin/windows/hruft.exe',
    linux: 'bin/linux/hruft',
    darwin: 'bin/mac/hruft'
};

const currentFile = hruftFiles[platform];
if (currentFile && fs.existsSync(currentFile)) {
    console.log(`✅ HRUFT可执行文件已存在: ${currentFile}`);

    // 设置执行权限
    if (platform !== 'win32') {
        fs.chmodSync(currentFile, 0o755);
        console.log('✅ 已设置执行权限');
    }
} else {
    console.warn(`⚠️  HRUFT可执行文件未找到: ${currentFile || '未知平台'}`);
    console.log('\n请按照以下步骤操作:');
    console.log('1. 编译HRUFT C++项目');
    console.log('2. 将可执行文件复制到对应目录:');
    console.log('   - Windows: bin/windows/hruft.exe');
    console.log('   - Linux: bin/linux/hruft');
    console.log('   - macOS: bin/mac/hruft');
}

console.log('\n🎯 部署完成！');
console.log('运行以下命令启动应用:');
console.log('  npm start              # 启动开发模式');
console.log('  npm run build          # 构建应用');
console.log('\n需要手动下载HRUFT二进制文件并放置到对应目录。');