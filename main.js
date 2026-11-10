const {app, BrowserWindow, ipcMain, dialog} = require('electron');
const path = require('path');
const {spawn} = require('child_process');
const os = require('os');
const net = require('net');
const fs = require('fs');
const iconv = require('iconv-lite');
const core = require('./lib/core');

// ============================================================================
//                               全局配置 & 状态
// ============================================================================

let mainWindow = null;
const isWin = process.platform === 'win32';
const isDev = !app.isPackaged; // 判断是否为开发模式

/**
 * 获取资源根目录
 * 开发环境: __dirname
 * 打包后: process.resourcesPath
 */
function getResourcesPath() {
    if (isDev) {
        return __dirname;
    }
    // 打包后: resources 目录
    return process.resourcesPath;
}

/**
 * 获取二进制文件目录
 * 开发: bin/windows, bin/linux, bin/mac
 * 打包: resources/bin
 */
function getBinPath() {
    const resourcesPath = getResourcesPath();
    if (!isDev) return path.join(resourcesPath, 'bin');
    const folder = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    return path.join(resourcesPath, 'bin', folder);
}

// ============================================================================
//                               核心工具函数
// ============================================================================

/**
 * 获取 HRUFT 可执行文件路径 (修复版)
 */
function getHruftPath() {
    const platform = process.platform;
    const binDir = getBinPath();

    let execName;
    switch (platform) {
        case 'win32':
            execName = 'hruft.exe';
            break;
        case 'darwin':
            execName = 'hruft';
            break;
        default: // linux
            execName = 'hruft';
    }

    const execPath = path.join(binDir, execName);

    if (!fs.existsSync(execPath)) {
        console.warn(`[HRUFT] 可执行文件不存在: ${execPath}`);
        return {path: null, command: execName};
    }

    // 设置执行权限 (Linux/Mac)
    if (platform !== 'win32') {
        try {
            fs.chmodSync(execPath, 0o755);
        } catch (e) {
            console.warn('[HRUFT] 设置权限失败:', e.message);
        }
    }

    return {path: execPath, command: execName};
}

/**
 * 获取 iPerf 可执行文件路径 (修复版)
 * @param {string} version - 'iperf2' | 'iperf3'
 */
function getIperfPath(version) {
    const platform = process.platform;
    const binDir = getBinPath();

    let execName;
    switch (platform) {
        case 'win32':
            execName = `${version}.exe`;
            break;
        default:
            execName = version;
    }

    const execPath = path.join(binDir, execName);

    if (!fs.existsSync(execPath)) {
        console.warn(`[iPerf] ${version} 不存在: ${execPath}`);
        return null;
    }

    // 设置执行权限 (Linux/Mac)
    if (platform !== 'win32') {
        try {
            fs.chmodSync(execPath, 0o755);
        } catch (e) {
            console.warn(`[iPerf] 设置权限失败:`, e.message);
        }
    }

    return execPath;
}

/**
 * 安全地向渲染进程发送消息
 * @param {string} channel - IPC 通道名
 * @param {any} data - 要发送的数据
 */
function safeSend(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.webContents.send(channel, data);
        } catch (error) {
            console.warn(`[IPC] 发送失败 (${channel}):`, error.message);
        }
    }
}

/**
 * 并发控制器：限制同时运行的 Promise 数量
 * 用于网段扫描，防止瞬间 Ping 太多导致死锁
 */
async function runWithConcurrency(tasks, limit) {
    const results = [];
    const executing = [];
    for (const task of tasks) {
        const p = task().then(result => {
            executing.splice(executing.indexOf(p), 1);
            return result;
        });
        results.push(p);
        executing.push(p);
        if (executing.length >= limit) {
            await Promise.race(executing);
        }
    }
    return Promise.all(results);
}

/**
 * 解码命令行输出 (处理 Windows 中文乱码)
 */
function decodeOutput(data) {
    return isWin ? iconv.decode(data, 'cp936') : data.toString();
}

// ============================================================================
//                               窗口生命周期管理
// ============================================================================

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        minWidth: 1000,
        minHeight: 700,
        backgroundColor: '#0f0f1e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');

    // 开发模式打开 DevTools
    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    // 添加窗口销毁事件
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 打印路径调试信息
    console.log('[启动信息]', {
        isDev,
        __dirname,
        resourcesPath: getResourcesPath(),
        binPath: getBinPath(),
        platform: process.platform
    });
}

app.whenReady().then(() => {
    createWindow();
    setupIpcHandlers(); // 注册所有模块的 IPC
});

app.on('window-all-closed', () => {
    // 先清理所有模块
    try {
        FileTransferModule.cleanup();
        ScanModule.cleanup();
        PingModule.cleanup();
        ThroughputModule.cleanup();
    } catch (e) {
        console.warn('[Cleanup] 清理失败:', e.message);
    }

    // 再退出应用
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 退出前清理所有子进程（window-all-closed 在 macOS 上不触发，这里兜底）
app.on('before-quit', () => {
    for (const mod of [FileTransferModule, ScanModule, PingModule, ThroughputModule]) {
        try { mod.cleanup(); } catch (e) { console.warn('[Cleanup] 清理失败:', e.message); }
    }
});

// ============================================================================
//                               IPC 路由注册
// ============================================================================

function setupIpcHandlers() {
    ipcMain.on('app:devtools', () => {
        if (mainWindow && !mainWindow.isDestroyed() && isDev) {
            mainWindow.webContents.openDevTools();
        }
    });

    // 1. 系统信息
    ipcMain.handle('net:interfaces', SystemInfoModule.getInterfaces);

    // 2. Ping 测试
    ipcMain.on('net:ping-start', (e, c) => PingModule.start(c));
    ipcMain.on('net:ping-stop', () => PingModule.stop());

    // 3. ARP & 扫描
    ipcMain.handle('net:arp', ArpModule.getTable);
    ipcMain.on('net:scan-start', (e, c) => ScanModule.start(c));
    ipcMain.on('net:scan-stop', () => ScanModule.stop());

    // 4. 吞吐量测试
    ipcMain.handle('net:tp-server', (e, c) => ThroughputModule.startServer(c));
    ipcMain.on('net:tp-server-stop', () => ThroughputModule.stopServer());
    ipcMain.on('net:tp-client-start', (e, c) => ThroughputModule.startClient(c));
    ipcMain.on('net:tp-stop', () => ThroughputModule.stopClient());

    // 5. 文件传输 (TCP & HRUFT)
    ipcMain.handle('file:select-save-path', FileTransferModule.selectSavePath);
    ipcMain.handle('file:select-send-file', FileTransferModule.selectSendFile);
    ipcMain.handle('file:start-server', (e, c) => FileTransferModule.startServer(c));
    ipcMain.on('file:stop-server', () => FileTransferModule.stopServer());
    ipcMain.on('file:send', (e, c) => FileTransferModule.send(c));
    // HRUFT 特定操作
    ipcMain.on('file:cancel-transfer', (e, id) => FileTransferModule.cancelHruft(id));
}

// ============================================================================
//                          模块 1: System Info (系统信息)
// ============================================================================
const SystemInfoModule = {
    getInterfaces: () => {
        const interfaces = os.networkInterfaces();
        const results = [];
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    results.push({
                        name: name,
                        ip: iface.address,
                        netmask: iface.netmask,
                        mac: iface.mac
                    });
                }
            }
        }
        return results;
    }
};

// ============================================================================
//                          模块 2: Ping Test (Ping 测试)
// ============================================================================
const PingModule = {
    timer: null,
    children: new Set(),

    start: (config) => {
        PingModule.stop();
        const {target, interval, size} = config || {};
        const intervalMs = Math.max(100, core.clampInt(interval, 0.1, 3600, 1) * 1000);

        let args;
        try {
            args = core.pingArgs(target, size, process.platform);
        } catch (e) {
            safeSend('ping-reply', `❌ ${e.message}\n`);
            return;
        }

        safeSend('ping-reply', `开始 Ping ${target}...\n`);

        const tick = () => {
            // 上一轮尚未结束时跳过，避免子进程堆积。
            if (PingModule.children.size > 0) return;
            let child;
            try {
                child = spawn('ping', args, {windowsHide: true, env: {...process.env, LC_ALL: 'C'}});
            } catch (e) {
                safeSend('ping-reply', `❌ 无法启动 ping: ${e.message}\n`);
                return;
            }
            PingModule.children.add(child);
            let out = Buffer.alloc(0);
            const timer = setTimeout(() => child.kill(), 3000);
            child.stdout.on('data', d => { out = Buffer.concat([out, d]); });
            child.on('error', e => safeSend('ping-reply', `❌ ${e.message}\n`));
            child.on('close', () => {
                clearTimeout(timer);
                PingModule.children.delete(child);
                const output = decodeOutput(out);
                let reply;
                if (/ttl=/i.test(output)) {
                    const m = output.match(/time[=<]([\d.]+)\s*ms/i);
                    reply = `来自 ${target} 的回复: 字节=${args[3]} ${m ? `时间=${m[1]}ms` : ''}`;
                } else if (/timed out|超时|100% packet loss/i.test(output)) {
                    reply = '请求超时';
                } else {
                    reply = output.trim().split('\n')[0] || '无响应';
                }
                safeSend('ping-reply', `${reply}\n`);
            });
        };

        tick();
        PingModule.timer = setInterval(tick, intervalMs);
    },

    stop: () => {
        if (PingModule.timer) {
            clearInterval(PingModule.timer);
            PingModule.timer = null;
            PingModule.children.forEach(c => c.kill());
            PingModule.children.clear();
            safeSend('ping-reply', '\n--- Ping 已停止 ---\n');
        }
    },

    cleanup: () => PingModule.stop()
};

// ============================================================================
//                          模块 3: ARP & Network Scan (扫描)
// ============================================================================
const ArpModule = {
    getTable: async () => {
        return new Promise((resolve) => {
            const child = spawn('arp', ['-a'], {windowsHide: true});
            let out = Buffer.alloc(0);
            child.stdout.on('data', d => { out = Buffer.concat([out, d]); });
            child.on('error', e => resolve(`Error: ${e.message}`));
            child.on('close', () => resolve(decodeOutput(out)));
        });
    }
};

const ScanModule = {
    inProgress: false,
    children: new Set(),

    start: async (config) => {
        if (ScanModule.inProgress) return;
        const {ip, timeout} = config || {};
        if (!core.isValidIPv4(ip)) {
            safeSend('scan-status', {status: 'error', error: '无效的 IP 地址', message: '扫描出错: 无效的 IP 地址'});
            return;
        }
        ScanModule.inProgress = true;

        const subnet = ip.split('.').slice(0, 3).join('.');
        const ips = [];
        for (let i = 1; i < 255; i++) ips.push(`${subnet}.${i}`);

        const totalIps = ips.length;
        let scannedCount = 0;
        let foundCount = 0;
        let lastEmit = 0;

        const emit = (force) => {
            const now = Date.now();
            if (!force && now - lastEmit < 100 && scannedCount !== totalIps) return;
            lastEmit = now;
            const percent = Math.round((scannedCount / totalIps) * 100);
            safeSend('scan-status', {
                status: 'scanning',
                message: `扫描中... ${percent}% (${scannedCount}/${totalIps})`,
                total: totalIps, current: scannedCount, found: foundCount, percent
            });
        };

        safeSend('scan-status', {status: 'scanning', message: `正在扫描 ${totalIps} 个地址...`, total: totalIps, current: 0, found: 0, percent: 0});

        const scanTask = (targetIp) => new Promise((resolve) => {
            if (!ScanModule.inProgress) return resolve();
            let args;
            try { args = core.scanPingArgs(targetIp, timeout, process.platform); }
            catch (e) { return resolve(); }
            let child;
            try { child = spawn('ping', args, {windowsHide: true, env: {...process.env, LC_ALL: 'C'}}); }
            catch (e) { scannedCount++; return resolve(); }
            ScanModule.children.add(child);
            let out = Buffer.alloc(0);
            const timer = setTimeout(() => child.kill(), core.clampInt(timeout, 50, 10000, 500) + 1000);
            child.stdout.on('data', d => { out = Buffer.concat([out, d]); });
            child.on('error', () => {});
            child.on('close', () => {
                clearTimeout(timer);
                ScanModule.children.delete(child);
                if (!ScanModule.inProgress) return resolve();
                scannedCount++;
                emit(false);
                const text = decodeOutput(out);
                if (/ttl=/i.test(text)) {
                    foundCount++;
                    const arp = spawn('arp', ['-a', targetIp], {windowsHide: true});
                    let arpOut = Buffer.alloc(0);
                    arp.stdout.on('data', d => { arpOut = Buffer.concat([arpOut, d]); });
                    arp.on('error', () => {});
                    arp.on('close', () => {
                        const match = decodeOutput(arpOut).match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
                        safeSend('scan-device-found', {
                            ip: targetIp,
                            mac: match ? match[0] : 'Unknown',
                            vendor: 'Unknown',
                            time: `<${core.clampInt(timeout, 50, 10000, 500)}ms`
                        });
                        resolve();
                    });
                } else {
                    resolve();
                }
            });
        });

        try {
            await runWithConcurrency(ips.map(target => () => scanTask(target)), 20);
            if (ScanModule.inProgress) {
                scannedCount = totalIps;
                safeSend('scan-status', {
                    status: 'completed',
                    message: `扫描完成 - 发现 ${foundCount} 台设备`,
                    total: totalIps, current: totalIps, found: foundCount, percent: 100
                });
            }
        } catch (e) {
            safeSend('scan-status', {status: 'error', error: e.message, message: `扫描出错: ${e.message}`});
        } finally {
            ScanModule.inProgress = false;
        }
    },

    stop: () => {
        ScanModule.inProgress = false;
        ScanModule.children.forEach(c => c.kill());
        ScanModule.children.clear();
        safeSend('scan-status', {status: 'stopped', message: '扫描已停止', percent: 0});
    },

    cleanup: () => ScanModule.stop()
};

// ============================================================================
//                          模块 4:// ============================================================================
//                          模块 4: 重写吞吐量测试模块 (iPerf 版本)
// ============================================================================

const ThroughputModule = {
    serverProcess: null,
    clientProcess: null,
    currentSession: null, // 当前测试会话信息

    startServer: (config) => {
        return new Promise((resolve, reject) => {
            ThroughputModule.stopServer();

            const {port, protocol, version} = config;
            const iperfPath = getIperfPath(version);

            if (!iperfPath) {
                return resolve(`错误: ${version} 未找到`);
            }

            let args;
            try { args = core.iperfServerArgs(port, protocol, version); }
            catch (e) { return resolve(`错误: ${e.message}`); }

            const child = spawn(iperfPath, args, {windowsHide: true});
            ThroughputModule.serverProcess = child;

            // 修复点：确保 session 在进程启动瞬间初始化
            ThroughputModule.currentSession = {
                role: 'server',
                startTime: Date.now(),
                version: version
            };

            let outputBuffer = '';
            let isFirstOutput = true;

            child.stdout.on('data', data => {
                const text = decodeOutput(data);
                outputBuffer += text;

                // 按行处理
                const lines = outputBuffer.split('\n');
                outputBuffer = lines.pop() || ''; // 保留不完整的行

                lines.forEach(line => {
                    const formatted = ThroughputModule.formatServerOutput(line, isFirstOutput);
                    if (formatted) {
                        safeSend('tp-log', formatted);
                        isFirstOutput = false;
                    }
                });
            });

            child.stderr.on('data', data => {
                const text = decodeOutput(data);
                const formatted = ThroughputModule.formatErrorOutput(text);
                safeSend('tp-log', formatted);
            });

            child.on('error', (e) => {
                safeSend('tp-log', `❌ 无法启动 ${version}: ${e.message}`);
            });

            child.on('close', (code) => {
                // 修复点：增加安全检查，防止读取 null
                const session = ThroughputModule.currentSession;
                const duration = session ? Math.floor((Date.now() - session.startTime) / 1000) : 0;

                safeSend('tp-log', ThroughputModule.formatServerClose(code, duration));
                ThroughputModule.serverProcess = null;
                ThroughputModule.currentSession = null;
            });

            resolve(`✅ ${version === 'iperf3' ? 'iPerf3' : 'iPerf2'} 服务端已启动\n📡 监听端口: ${port}\n🔗 协议: ${protocol.toUpperCase()}\n⏰ 等待客户端连接...`);
        });
    },

    stopServer: () => {
        if (ThroughputModule.serverProcess) {
            try {
                ThroughputModule.serverProcess.kill();
            } catch (e) {
                console.warn('[Throughput] 停止服务端失败:', e.message);
            }
            ThroughputModule.serverProcess = null;
            safeSend('tp-log', '🛑 服务端已手动停止');
        }
    },

    startClient: (config) => {
        ThroughputModule.stopClient();

        const {ip, port, protocol, duration, bandwidth, version} = config;
        const iperfPath = getIperfPath(version);

        if (!iperfPath) {
            safeSend('tp-log', `❌ 错误: ${version} 未找到`);
            return;
        }

        // 修复点 1：必须在 spawn 之前初始化 session，防止 close 事件过快触发
        ThroughputModule.currentSession = {
            role: 'client',
            protocol: protocol.toUpperCase(),
            version: version,
            target: `${ip}:${port}`,
            duration: duration,
            startTime: Date.now(),
            intervals: []
        };

        // 修复点 2：严格按照 iperf3 帮助文档格式构建参数
        // Usage: iperf3 -c <host> -p <port> -t <time> -i 1 -f m
        let args;
        try { args = core.iperfClientArgs(config); }
        catch (e) {
            safeSend('tp-log', `❌ 错误: ${e.message}`);
            return;
        }

        const child = spawn(iperfPath, args, {windowsHide: true});
        ThroughputModule.clientProcess = child;

        // 发送开始消息
        safeSend('tp-log', ThroughputModule.formatClientStart(config));

        let outputBuffer = '';

        child.stdout.on('data', data => {
            const text = decodeOutput(data);
            outputBuffer += text;

            // 按行处理
            const lines = outputBuffer.split('\n');
            outputBuffer = lines.pop() || '';

            lines.forEach(line => {
                const formatted = ThroughputModule.formatClientOutput(line);
                if (formatted.message) {
                    safeSend('tp-log', formatted.message);
                }
                if (formatted.speed !== null) {
                    safeSend('tp-data', formatted.speed);
                }
            });
        });

        child.stderr.on('data', data => {
            const text = decodeOutput(data);
            const formatted = ThroughputModule.formatErrorOutput(text);
            safeSend('tp-log', formatted);
        });

        child.on('error', (e) => {
            safeSend('tp-log', `❌ 无法启动 ${version}: ${e.message}`);
        });

        child.on('close', (code) => {
            // 修复点 4：安全读取 session
            const summary = ThroughputModule.formatClientClose(code);
            safeSend('tp-log', summary);

            ThroughputModule.clientProcess = null;
            ThroughputModule.currentSession = null;
        });
    },

    stopClient: () => {
        if (ThroughputModule.clientProcess) {
            try {
                ThroughputModule.clientProcess.kill();
            } catch (e) {
                console.warn('[Throughput] 停止客户端失败:', e.message);
            }
            ThroughputModule.clientProcess = null;
            safeSend('tp-log', '🛑 测试已手动停止');
        }
    },

    // ========== 格式化函数 ==========

    formatServerOutput: (line, isFirst) => {
        const parsed = core.parseIperfLine(line);
        if (parsed.message === null) return null;
        const text = parsed.message;
        if (text.includes('Server listening')) {
            const m = text.match(/listening on (\d+)/);
            return `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 服务器监听中 | 端口: ${m ? m[1] : 'unknown'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        }
        if (text.includes('Accepted connection')) {
            const m = text.match(/from ([0-9.]+), port (\d+)/);
            if (m) return `\n📥 客户端已连接\n   来源: ${m[1]}:${m[2]}\n   时间: ${new Date().toLocaleTimeString()}`;
        }
        if (parsed.speed !== null) safeSend('tp-data', parsed.speed.toFixed(2));
        return text;
    },

    formatClientStart: (config) => {
        const {ip, port, protocol, duration, bandwidth, version} = config;

        let message = `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `🚀 开始测试\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `   目标服务器: ${ip}:${port}\n`;
        message += `   协议: ${protocol.toUpperCase()}\n`;
        message += `   测试时长: ${duration} 秒\n`;

        if (protocol === 'udp') {
            message += `   目标带宽: ${bandwidth} Mbps\n`;
        }

        message += `   工具版本: ${version === 'iperf3' ? 'iPerf3' : 'iPerf2'}\n`;
        message += `   开始时间: ${new Date().toLocaleTimeString()}\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        return message;
    },

    formatClientOutput: (line) => {
        const parsed = core.parseIperfLine(line);
        if (parsed.message === null) return {message: null, speed: null};
        const text = parsed.message;
        if (text.includes('Connecting to host')) {
            const m = text.match(/Connecting to host ([^,]+), port (\d+)/);
            if (m) return {message: `🔗 正在连接到 ${m[1]}:${m[2]}...`, speed: null};
        }
        if (/sender|receiver/.test(text) && /\[\s*\d+\]/.test(text)) {
            const m = text.match(/\[\s*\d+\]\s+([\d.]+)-([\d.]+)\s+sec\s+([\d.]+\s+\w+Bytes)\s+([\d.]+\s+\w+bits\/sec)\s+(sender|receiver)/);
            if (m) {
                const role = m[5];
                return {
                    message: `\n${'━'.repeat(60)}\n${role === 'sender' ? '📤 发送端' : '📥 接收端'}汇总 (${m[1]}-${m[2]}秒)\n   总传输: ${m[3]}\n   平均速度: ${m[4]}\n${'━'.repeat(60)}`,
                    speed: null
                };
            }
        }
        const lossMatch = text.match(/([\d.]+)\s*\/\s*([\d.]+)\s*\(([\d.]+)%\)\s*$/);
        if (lossMatch && /datagrams|Jitter|Lost|ms/i.test(text)) {
            const loss = parseFloat(lossMatch[3]);
            const emoji = loss < 1 ? '✅' : loss < 5 ? '⚠️' : '❌';
            return {message: `${emoji} UDP 丢包率: ${loss}% (${lossMatch[1]}/${lossMatch[2]})`, speed: null};
        }
        if (parsed.speed !== null && ThroughputModule.currentSession) {
            ThroughputModule.currentSession.intervals.push({
                interval: text.match(/[\d.]+-[\d.]+/)?.[0] || '',
                transfer: '', bandwidth: '', speed: parsed.speed
            });
        }
        return {message: text, speed: parsed.speed !== null ? parsed.speed.toFixed(2) : null};
    },

    formatClientClose: (code) => {
        const session = ThroughputModule.currentSession;
        if (!session) {
            return code === 0 ? '✅ 测试完成' : `⚠️ 测试异常退出 (代码: ${code})`;
        }

        const duration = Math.floor((Date.now() - session.startTime) / 1000);

        // 计算统计信息
        let avgSpeed = 0;
        let maxSpeed = 0;
        let minSpeed = Infinity;

        if (session.intervals && session.intervals.length > 0) {
            session.intervals.forEach(interval => {
                if (interval.speed !== null) {
                    avgSpeed += interval.speed;
                    maxSpeed = Math.max(maxSpeed, interval.speed);
                    minSpeed = Math.min(minSpeed, interval.speed);
                }
            });
            avgSpeed = avgSpeed / session.intervals.length;
        }

        let summary = `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        summary += `📊 测试完成\n`;
        summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        summary += `   总时长: ${duration} 秒\n`;

        if (avgSpeed > 0) {
            summary += `   平均速度: ${avgSpeed.toFixed(2)} Mbps\n`;
            summary += `   最高速度: ${maxSpeed.toFixed(2)} Mbps\n`;
            if (minSpeed < Infinity) {
                summary += `   最低速度: ${minSpeed.toFixed(2)} Mbps\n`;
            }
        }

        summary += `   结束时间: ${new Date().toLocaleTimeString()}\n`;

        if (code === 0) {
            summary += `   状态: ✅ 正常完成\n`;
        } else {
            summary += `   状态: ⚠️ 异常退出 (代码: ${code})\n`;
        }

        summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        return summary;
    },

    formatServerClose: (code, duration) => {
        let message = `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `🛑 服务端已停止\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `   运行时长: ${duration} 秒\n`;

        if (code === 0) {
            message += `   状态: ✅ 正常关闭\n`;
        } else {
            message += `   状态: ⚠️ 异常退出 (代码: ${code})\n`;
        }

        message += `   结束时间: ${new Date().toLocaleTimeString()}\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        return message;
    },

    formatErrorOutput: (text) => core.formatIperfError(text) || '',

    cleanup: () => {
        ThroughputModule.stopClient();
        ThroughputModule.stopServer();
    }
};


// ============================================================================
//                          模块 5: File Transfer (文件传输 & HRUFT)
// ============================================================================
const FileTransferModule = {
    hruftProcesses: new Map(), // 存储运行中的 HRUFT 子进程
    tcpServer: null,
    currentProtocol: 'hruft', // 记录当前接收协议

    selectSavePath: async () => {
        const {filePaths} = await dialog.showOpenDialog(mainWindow, {properties: ['openDirectory']});
        return filePaths[0] || null;
    },

    selectSendFile: async () => {
        const {filePaths} = await dialog.showOpenDialog(mainWindow, {properties: ['openFile']});
        if (filePaths.length > 0) {
            const s = fs.statSync(filePaths[0]);
            return {path: filePaths[0], name: path.basename(filePaths[0]), size: s.size};
        }
        return null;
    },

    // ---------------- HRUFT 逻辑 ----------------

    send: (config) => {
        const {ip, port, filePath, protocol, udtConfig} = config;

        // 1. TCP 模式 (保留原有逻辑作为备用)
        if (protocol === 'tcp') {
            FileTransferModule.sendTcp(ip, port, filePath);
            return;
        }

        // 2. HRUFT (UDT) 模式
        const hruft = getHruftPath();

        if (!hruft.path) {
            safeSend('transfer-log', '❌ HRUFT 可执行文件未找到');
            safeSend('file-send-error', {error: 'HRUFT executable not found'});
            return;
        }

        const fileName = path.basename(filePath);
        const transferId = `send-${Date.now()}`;
        const absoluteFilePath = path.resolve(filePath);

        let args;
        try {
            args = core.hruftSendArgs(ip, port, absoluteFilePath, udtConfig);
        } catch (e) {
            safeSend('transfer-log', `❌ ${e.message}`);
            safeSend('file-send-error', {error: e.message});
            return;
        }

        if (mainWindow) {
            mainWindow.webContents.send('transfer-log', `[CMD] ${hruft.command} ${args.join(' ')}`);
            mainWindow.webContents.send('transfer-log', `[INFO] 使用 BLAKE3 哈希算法 (HRUFT Pro)`);
            mainWindow.webContents.send('file-send-start', {
                fileName,
                fileSize: fs.statSync(filePath).size,
                hash: '计算中(BLAKE3)...'
            });
        }

        // 设置环境变量
        const spawnOptions = {
            cwd: path.dirname(hruft.path)
        };

        // 在 Windows 上设置 UTF-8 代码页
        if (isWin) {
            spawnOptions.env = {...process.env, CHCP: '65001'};
        }

        const child = spawn(hruft.path, args, spawnOptions);
        FileTransferModule.hruftProcesses.set(transferId, child);

        // 处理输出
        let stdoutBuffer = '';
        let stderrBuffer = '';

        child.stdout.on('data', (data) => {
            stdoutBuffer += decodeOutput(data);
            const lines = stdoutBuffer.split(/\r\n|\n|\r/);
            stdoutBuffer = lines.pop() || '';
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed) {
                    FileTransferModule.parseHruftOutput(trimmed, {
                        mode: 'send', fileName, filePath: absoluteFilePath, startTime: Date.now()
                    });
                }
            });
        });

        child.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
            const lines = stderrBuffer.split('\n');
            stderrBuffer = lines.pop() || '';

            lines.forEach(line => {
                if (line.trim()) {
                    safeSend('transfer-log', `[HRUFT 错误] ${line.trim()}`);
                }
            });
        });

        child.on('close', (code) => {
            FileTransferModule.hruftProcesses.delete(transferId);
            if (code === 0) {
                safeSend('transfer-log', '✅ HRUFT 发送完成');
            } else {
                safeSend('transfer-log', `⚠️ HRUFT 进程退出码: ${code}`);
                safeSend('file-send-error', {error: `进程退出码: ${code}`});
            }
        });

        child.on('error', (err) => {
            FileTransferModule.hruftProcesses.delete(transferId);
            safeSend('transfer-log', `❌ HRUFT 启动失败: ${err.message}`);
            safeSend('file-send-error', {error: err.message});
        });
    },

    startServer: (config) => {
        return new Promise((resolve) => {
            const {port, savePath, protocol} = config;
            FileTransferModule.currentProtocol = protocol;

            if (protocol === 'hruft') {
                const absoluteSavePath = path.resolve(savePath);
                const hruft = getHruftPath();

                if (!hruft.path) {
                    resolve('❌ HRUFT 可执行文件未找到');
                    return;
                }

                let args;
                try {
                    args = core.hruftRecvArgs(port, absoluteSavePath);
                } catch (e) {
                    resolve(`❌ ${e.message}`);
                    return;
                }

                const spawnOptions = {
                    cwd: path.dirname(hruft.path)
                };

                if (isWin) {
                    spawnOptions.env = {...process.env, CHCP: '65001'};
                }

                const child = spawn(hruft.path, args, spawnOptions);
                const pid = `recv-${port}`;
                FileTransferModule.hruftProcesses.set(pid, child);

                // 接收上下文
                const receiveContext = {
                    mode: 'receive',
                    fileName: '等待文件...',
                    savePath: absoluteSavePath,
                    startTime: Date.now(),
                    lastProgressTime: Date.now(),
                    lastBytes: 0
                };

                let stdoutBuffer = '';
                let stderrBuffer = '';

                child.stdout.on('data', data => {
                    stdoutBuffer += decodeOutput(data);
                    const lines = stdoutBuffer.split(/\r\n|\n|\r/);
                    stdoutBuffer = lines.pop() || '';
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (trimmed) FileTransferModule.parseHruftOutput(trimmed, receiveContext);
                    });
                });

                child.stderr.on('data', data => {
                    stderrBuffer += data.toString();
                    const lines = stderrBuffer.split('\n');
                    stderrBuffer = lines.pop() || '';

                    lines.forEach(line => {
                        if (line.trim()) {
                            safeSend('transfer-log', `[HRUFT] ${line.trim()}`);
                        }
                    });
                });

                child.on('close', code => {
                    FileTransferModule.hruftProcesses.delete(pid);
                    if (code === 0) {
                        safeSend('transfer-log', '✅ HRUFT 接收完成');
                    } else {
                        safeSend('transfer-log', `⚠️ HRUFT 服务已停止 (code: ${code})`);
                    }
                });

                child.on('error', err => {
                    FileTransferModule.hruftProcesses.delete(pid);
                    safeSend('transfer-log', `❌ HRUFT 启动失败: ${err.message}`);
                    safeSend('file-transfer-error', {error: err.message});
                });

                resolve(`HRUFT Pro (BLAKE3) 接收服务已启动\n监听端口: ${port}\n保存路径: ${absoluteSavePath}`);
            } else {
                // TCP 接收模式保持不变
                FileTransferModule.startTcpServer(port, savePath);
                resolve(`TCP 接收服务已启动\n监听端口: ${port}\n保存路径: ${savePath}`);
            }
        });
    },

    stopServer: () => {
        FileTransferModule.hruftProcesses.forEach((p, id) => {
            try {
                p.kill('SIGTERM'); // 优雅关闭
                setTimeout(() => {
                    if (!p.killed) {
                        p.kill('SIGKILL'); // 强制关闭
                    }
                }, 2000);
            } catch (e) {
                console.warn('[FileTransfer] 停止进程失败:', e.message);
            }
        });
        FileTransferModule.hruftProcesses.clear();

        if (FileTransferModule.tcpServer) {
            try {
                FileTransferModule.tcpServer.close();
            } catch (e) {
                console.warn('[FileTransfer] 停止 TCP 服务失败:', e.message);
            }
            FileTransferModule.tcpServer = null;
        }

        safeSend('transfer-log', '所有传输服务已停止');
    },

    // ---------------- 进度解析和事件发送 ----------------

    parseHruftOutput: (line, context) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        line = line.trim();
        if (!line) return;

        // 1. 先尝试解析 JSON（处理最终的统计报告）
        try {
            if (line.startsWith('{') && line.endsWith('}')) {
                const json = JSON.parse(line);
                console.log('[HRUFT JSON]', json);
                FileTransferModule.handleHruftJson(json, context);
                return;
            }
        } catch (e) {
            // 不是 JSON，继续处理
        }

        // 2. 解析文件开始信息
        if (line.includes('Receiving file:') || line.includes('Sending file:')) {
            const fileMatch = line.match(/(?:Receiving|Sending) file:\s*(.+?)\s*\(([\d\.]+)\s*([KMG]?B)\)/i);
            if (fileMatch) {
                const fileName = fileMatch[1].trim();
                const fileSize = parseFloat(fileMatch[2]);
                const fileUnit = fileMatch[3].toUpperCase();

                // 转换为字节
                const sizeInBytes = core.toBytes(fileSize, fileUnit);

                context.fileName = fileName;
                context.totalBytes = sizeInBytes;

                if (context.mode === 'receive') {
                    // 发送接收开始事件
                    safeSend('file-transfer-start', {
                        fileName: fileName,
                        fileSize: sizeInBytes
                    });
                }

                safeSend('transfer-log', `📁 ${context.mode === 'send' ? '发送' : '接收'}文件: ${fileName} (${fileSize} ${fileUnit})`);
                return;
            }
        }

        // 3. 解析进度信息 - 关键修复：支持回车符进度行
        if (line.startsWith('[Progress]') || line.startsWith('Progress')) {
            // 增强的进度解析，支持带和不带回车符
            const progressData = core.parseProgressLine(line);
            if (progressData) {
                const { percent, currentBytes, totalBytes, speedMbps } = progressData;

                // 更新上下文中的总大小
                if (totalBytes > 0) {
                    context.totalBytes = totalBytes;
                }

                // 如果还没有总大小，跳过进度更新
                if (!context.totalBytes || context.totalBytes <= 0) {
                    console.log('[HRUFT] 等待文件大小信息...');
                    return;
                }

                // 计算速度
                let speedMBps = speedMbps > 0 ? speedMbps / 8 : 0;

                // 准备进度数据
                const progressPayload = {
                    progress: percent,
                    received: context.mode === 'receive' ? currentBytes : 0,
                    sent: context.mode === 'send' ? currentBytes : 0,
                    total: context.totalBytes,
                    speed: speedMBps,
                    remainingBytes: Math.max(0, context.totalBytes - currentBytes),
                    elapsedSeconds: (Date.now() - (context.startTime || Date.now())) / 1000
                };

                // 发送正确的进度事件
                if (context.mode === 'receive') {
                    safeSend('file-transfer-progress', progressPayload);
                } else if (context.mode === 'send') {
                    safeSend('file-send-progress', progressPayload);
                }

                return;
            }
        }

        // 4. 解析连接信息
        if (line.includes('Connecting to') || line.includes('Listening on')) {
            safeSend('transfer-log', `🔗 ${line}`);
            return;
        }

        // 5. 解析其他日志信息
        if (line.includes('[INFO]')) {
            const info = line.replace(/\[INFO\]\s*/, '').trim();
            safeSend('transfer-log', `ℹ️ ${info}`);
            return;
        }

        if (line.includes('[ERROR]')) {
            const error = line.replace(/\[ERROR\]\s*/, '').trim();
            safeSend('transfer-log', `❌ ${error}`);
            return;
        }

        if (line.includes('[WARNING]')) {
            const warning = line.replace(/\[WARNING\]\s*/, '').trim();
            safeSend('transfer-log', `⚠️ ${warning}`);
            return;
        }

        // 6. 其他信息
        safeSend('transfer-log', `📝 ${line}`);
    },

    // 处理 JSON 数据
    handleHruftJson: (json, context) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        const { mode, fileName } = context;
        const isSend = mode === 'send';

        // 处理 meta 部分（最终的统计报告）
        if (json.meta) {
            const meta = json.meta;
            const completeData = {
                fileName: meta.filename || fileName || '未知文件',
                fileSize: meta.filesize || 0,
                sourceMD5: meta.remote_hash || 'N/A',
                receivedMD5: meta.local_hash || 'N/A',
                match: meta.hash_match !== undefined ? meta.hash_match : true,
                duration: meta.duration_sec || 0,
                protocol: 'HRUFT',
                stats: json,
                averageSpeed: meta.avg_speed_mbps || 0,
                maxSpeed: json.max_speed_mbps || 0,
                networkQuality: json.network_health || 'unknown'
            };

            const completeEventName = isSend ? 'file-send-complete' : 'file-transfer-complete';
            safeSend(completeEventName, completeData);

            // 输出详细统计
            safeSend('transfer-log', `✅ 传输完成: ${meta.filename || fileName || '未知文件'}`);
            safeSend('transfer-log', `📊 文件大小: ${meta.filesize_human || 'N/A'}`);
            safeSend('transfer-log', `⏱️ 传输时间: ${meta.duration_sec || 0} 秒`);
            safeSend('transfer-log', `📈 平均速度: ${meta.avg_speed_mbps || 0} Mbps`);

            if (meta.hash_match !== undefined) {
                const matchText = meta.hash_match ? '✅ 哈希校验通过' : '❌ 哈希校验失败';
                safeSend('transfer-log', matchText);
            }

            // 网络分析信息
            if (json.analysis) {
                const analysis = json.analysis;
                safeSend('transfer-log', `🌐 网络健康度: ${analysis.network_health || 'unknown'}`);
                if (analysis.advice && analysis.advice.length > 0) {
                    analysis.advice.forEach(advice => {
                        safeSend('transfer-log', `💡 建议: ${advice}`);
                    });
                }
            }
        } else if (json.type === 'progress') {
            // 处理 JSON 格式的进度信息
            const payload = {
                progress: json.percent || 0,
                sent: isSend ? (json.current || 0) : 0,
                received: !isSend ? (json.current || 0) : 0,
                total: json.total || 1,
                speed: (json.speed_mbps || 0) / 8,
                remainingBytes: json.remaining_bytes || 0,
                elapsedSeconds: json.elapsed_seconds || 0
            };

            const eventName = isSend ? 'file-send-progress' : 'file-transfer-progress';
            safeSend(eventName, payload);
        } else {
            // 其他 JSON 消息
            safeSend('transfer-log', `[JSON] ${JSON.stringify(json)}`);
        }
    },

    // ---------------- TCP 服务器 ----------------
    startTcpServer: (port, savePath) => {
        const server = net.createServer(socket => {
            const parser = core.createMetadataParser();
            let fileName = `recv_${Date.now()}.bin`;
            let fileSize = 0;
            let received = 0;
            let writeStream = null;
            let finished = false;
            const startTime = Date.now();
            let lastProgressTime = startTime;
            let lastBytes = 0;

            const emitProgress = (force) => {
                if (fileSize <= 0) return;
                const now = Date.now();
                if (!force && now - lastProgressTime < 100) return;
                const elapsed = (now - startTime) / 1000;
                const speed = elapsed > 0 ? ((received - lastBytes) / ((now - lastProgressTime) / 1000)) / (1024 * 1024) : 0;
                safeSend('file-transfer-progress', {
                    progress: Math.min(100, received / fileSize * 100),
                    received, total: fileSize,
                    speed: Math.max(0, speed),
                    remainingBytes: Math.max(0, fileSize - received),
                    elapsedSeconds: elapsed
                });
                lastProgressTime = now;
                lastBytes = received;
            };

            const complete = () => {
                if (finished) return;
                finished = true;
                const elapsed = (Date.now() - startTime) / 1000;
                const avg = elapsed > 0 ? (received / elapsed) / (1024 * 1024) : 0;
                if (writeStream) writeStream.end();
                safeSend('file-transfer-progress', {
                    progress: 100, received, total: fileSize || received,
                    speed: 0, remainingBytes: 0, elapsedSeconds: elapsed
                });
                safeSend('file-transfer-complete', {
                    fileName, fileSize: received,
                    sourceMD5: 'N/A', receivedMD5: 'N/A', match: true,
                    duration: elapsed, protocol: 'TCP',
                    stats: {transfer: {bytes: received, time: elapsed}},
                    averageSpeed: avg * 8, maxSpeed: avg * 8, networkQuality: 'unknown'
                });
                safeSend('transfer-log', `✅ TCP 接收完成: ${fileName} (${core.formatFileSize(received)})`);
            };

            socket.on('data', chunk => {
                let payload = chunk;
                if (!parser.done) {
                    try {
                        payload = parser.push(chunk);
                    } catch (e) {
                        safeSend('transfer-log', `❌ TCP 元数据解析失败: ${e.message}`);
                        safeSend('file-transfer-error', {error: e.message});
                        socket.destroy();
                        return;
                    }
                    if (!parser.done) return;
                    const meta = parser.meta;
                    fileName = meta.fileName;
                    fileSize = meta.fileSize;
                    // 双重防护：即使解析器被绕过，也只写 savePath 内的安全文件名。
                    const fullSavePath = path.join(savePath, core.safeFileName(fileName, `recv_${Date.now()}.bin`));
                    writeStream = fs.createWriteStream(fullSavePath);
                    writeStream.on('error', e => {
                        safeSend('transfer-log', `❌ 写入文件失败: ${e.message}`);
                        socket.destroy();
                    });
                    safeSend('file-transfer-start', {fileName, fileSize});
                    safeSend('transfer-log', `📁 开始接收文件: ${fileName} (${core.formatFileSize(fileSize)})`);
                }
                if (payload.length && writeStream) {
                    writeStream.write(payload);
                    received += payload.length;
                    emitProgress(false);
                    if (fileSize > 0 && received >= fileSize) complete();
                }
            });

            socket.on('end', complete);
            socket.on('error', err => {
                safeSend('transfer-log', `❌ TCP 接收错误: ${err.message}`);
                safeSend('file-transfer-error', {error: err.message});
                if (writeStream) writeStream.destroy();
            });
        });

        server.on('error', err => {
            safeSend('transfer-log', `❌ TCP 服务器错误: ${err.message}`);
            safeSend('file-transfer-error', {error: err.message});
        });
        server.listen(core.clampInt(port, 1, 65535, 5201), () => {
            FileTransferModule.tcpServer = server;
            safeSend('transfer-log', `✅ TCP 服务端监听端口: ${port}`);
        });
    },

    // ---------------- TCP 发送端 ----------------
    sendTcp: (ip, port, filePath) => {
        let fileSize;
        try {
            fileSize = fs.statSync(filePath).size;
        } catch (err) {
            safeSend('file-send-error', {error: `无法读取文件: ${err.message}`});
            return;
        }
        const fileName = path.basename(filePath);
        const socket = new net.Socket();
        let sent = 0;
        let startTime = Date.now();
        let lastProgressTime = startTime;
        let lastBytes = 0;
        let stream = null;
        let finished = false;

        const emitProgress = () => {
            if (fileSize <= 0) return;
            const now = Date.now();
            if (now - lastProgressTime < 100) return;
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? ((sent - lastBytes) / ((now - lastProgressTime) / 1000)) / (1024 * 1024) : 0;
            safeSend('file-send-progress', {
                sent, total: fileSize,
                progress: Math.min(100, sent / fileSize * 100),
                speed: Math.max(0, speed),
                remainingBytes: Math.max(0, fileSize - sent),
                elapsedSeconds: elapsed
            });
            lastProgressTime = now;
            lastBytes = sent;
        };

        socket.connect(core.clampInt(port, 1, 65535, 5201), ip, () => {
            safeSend('file-send-start', {fileName, fileSize, hash: 'N/A (TCP模式)'});
            safeSend('transfer-log', `📤 开始发送文件: ${fileName} (${core.formatFileSize(fileSize)})`);
            socket.write(core.createMetadata(fileName, fileSize));
            stream = fs.createReadStream(filePath);
            stream.on('data', chunk => {
                if (!socket.write(chunk)) stream.pause();
                sent += chunk.length;
                emitProgress();
            });
            socket.on('drain', () => stream && stream.resume());
            stream.on('end', () => socket.end());
            stream.on('error', err => {
                socket.destroy();
                safeSend('file-send-error', {error: `文件读取错误: ${err.message}`});
            });
        });

        socket.on('end', () => {
            if (finished) return;
            finished = true;
            const elapsed = (Date.now() - startTime) / 1000;
            const avg = elapsed > 0 ? (sent / elapsed) / (1024 * 1024) : 0;
            safeSend('file-send-complete', {
                fileName, fileSize,
                sourceMD5: 'N/A', receivedMD5: 'N/A', match: true,
                duration: elapsed, protocol: 'TCP',
                stats: {transfer: {bytes: sent, time: elapsed}},
                averageSpeed: avg * 8, maxSpeed: avg * 8, networkQuality: 'unknown'
            });
            safeSend('transfer-log', `✅ TCP 发送完成: ${fileName}`);
        });

        socket.on('error', err => {
            safeSend('file-send-error', {error: `TCP连接错误: ${err.message}`});
            safeSend('transfer-log', `❌ TCP 发送错误: ${err.message}`);
        });
        socket.setTimeout(30000, () => {
            socket.destroy();
            safeSend('file-send-error', {error: '连接超时'});
        });
    },

    cancelHruft: (id) => {
        const process = FileTransferModule.hruftProcesses.get(id);
        if (process) {
            process.kill('SIGTERM');
            FileTransferModule.hruftProcesses.delete(id);
            safeSend('transfer-log', `传输已取消: ${id}`);
        }
    },

    cleanup: () => {
        FileTransferModule.stopServer();
    },
    // 添加在 FileTransferModule 对象内
    formatFileSize: (bytes) => core.formatFileSize(bytes),
};