// 构建资产文件脚本
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('📦 构建应用资产文件...');

// 清理旧构建
const distDir = 'dist';
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true });
    console.log('🗑️  清理旧构建文件');
}

// 创建必要目录
['dist', 'build'].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// 复制图标文件（如果有）
const iconSources = {
    win: 'assets/icons/icon.ico',
    mac: 'assets/icons/icon.icns',
    linux: 'assets/icons/'
};

Object.entries(iconSources).forEach(([platform, source]) => {
    if (fs.existsSync(source)) {
        const target = path.join('build', path.basename(source));
        fs.copyFileSync(source, target);
        console.log(`✅ 复制图标文件: ${source} -> ${target}`);
    }
});

// 检查依赖
try {
    execSync('npm list', { stdio: 'pipe' });
    console.log('✅ 依赖检查完成');
} catch (error) {
    console.warn('⚠️  依赖检查失败，请运行: npm install');
}

console.log('\n🎉 资产构建完成！');
console.log('运行以下命令构建应用:');
console.log('  npm run build          # 构建应用');
console.log('  npm run build:win      # 仅构建Windows版本');
console.log('  npm run build:mac      # 仅构建macOS版本');
console.log('  npm run build:linux    # 仅构建Linux版本');