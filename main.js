const {app, BrowserWindow, ipcMain, dialog} = require('electron');
const path = require('path');
const {spawn, exec} = require('child_process');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const crypto = require('crypto');
const iconv = require('iconv-lite');

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
    return path.join(resourcesPath, 'bin');
}

// HRUFT 路径配置 (根据 README)
const HRUFT_CONFIG = {
    win32: {path: 'bin/windows/hruft.exe', cmd: 'hruft.exe'},
    linux: {path: 'bin/linux/hruft', cmd: './hruft'},
    darwin: {path: 'bin/mac/hruft', cmd: './hruft'}
};

// 在全局配置中添加 iPerf 路径
const IPERF_CONFIG = {
    win32: {
        iperf2: 'bin/windows/iperf2.exe',
        iperf3: 'bin/windows/iperf3.exe'
    },
    linux: {
        iperf2: 'bin/linux/iperf2',
        iperf3: 'bin/linux/iperf3'
    },
    darwin: {
        iperf2: 'bin/mac/iperf2',
        iperf3: 'bin/mac/iperf3'
    }
};

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

    console.log('[HRUFT] 路径解析:', {
        isDev,
        platform,
        resourcesPath: getResourcesPath(),
        binDir,
        execPath,
        exists: fs.existsSync(execPath)
    });

    // 检查文件是否存在
    if (!fs.existsSync(execPath)) {
        console.error(`[HRUFT] 可执行文件不存在: ${execPath}`);

        // 尝试查找备用路径 (开发环境)
        if (isDev) {
            const devPath = path.join(__dirname, 'bin', platform === 'darwin' ? 'mac' : platform, execName);
            if (fs.existsSync(devPath)) {
                console.log(`[HRUFT] 使用开发路径: ${devPath}`);
                return { path: devPath, command: execName };
            }
        }

        return { path: null, command: execName };
    }

    // 设置执行权限 (Linux/Mac)
    if (platform !== 'win32') {
        try {
            fs.chmodSync(execPath, 0o755);
        } catch (e) {
            console.warn('[HRUFT] 设置权限失败:', e.message);
        }
    }

    return { path: execPath, command: execName };
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

    console.log(`[iPerf] 路径解析 (${version}):`, {
        isDev,
        platform,
        binDir,
        execPath,
        exists: fs.existsSync(execPath)
    });

    if (!fs.existsSync(execPath)) {
        console.error(`[iPerf] ${version} 不存在: ${execPath}`);

        // 尝试开发环境路径
        if (isDev) {
            const devPath = path.join(__dirname, 'bin', platform === 'darwin' ? 'mac' : platform, execName);
            if (fs.existsSync(devPath)) {
                console.log(`[iPerf] 使用开发路径: ${devPath}`);
                return devPath;
            }
        }

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

// 退出前清理所有子进程
/*app.on('before-quit', () => {
    FileTransferModule.cleanup();
    ScanModule.cleanup();
    PingModule.cleanup();
    ThroughputModule.cleanup();
});*/

// ============================================================================
//                               IPC 路由注册
// ============================================================================

function setupIpcHandlers() {
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

    start: (config) => {
        PingModule.stop();
        const { target, interval, size } = config;
        const intervalMs = Math.max(100, interval * 1000);

        safeSend('ping-reply', `开始 Ping ${target}...\n`); // 使用 safeSend

        PingModule.timer = setInterval(() => {
            let cmd;
            if (isWin) {
                cmd = `cmd.exe /C "chcp 437 && ping -n 1 -l ${size} ${target}"`;
            } else {
                cmd = `ping -c 1 -s ${size} ${target}`;
            }

            const env = isWin ? process.env : { ...process.env, LC_ALL: 'C' };

            exec(cmd, { encoding: 'binary', env, timeout: 2000 }, (err, stdout, stderr) => {
                const output = decodeOutput(Buffer.from(stdout, 'binary'));
                let reply = '';

                if (output.includes('TTL=') || output.includes('ttl=')) {
                    const timeMatch = output.match(/time[=<]([\d\.]+)ms/i);
                    const time = timeMatch ? `时间=${timeMatch[1]}ms` : '';
                    reply = `来自 ${target} 的回复: 字节=${size} ${time}`;
                } else if (output.includes('timed out')) {
                    reply = `请求超时`;
                } else {
                    reply = isWin ? output.split('\n')[2] : output;
                }

                safeSend('ping-reply', `${reply}\n`); // 使用 safeSend
            });
        }, intervalMs);
    },

    stop: () => {
        if (PingModule.timer) {
            clearInterval(PingModule.timer);
            PingModule.timer = null;
            safeSend('ping-reply', `\n--- Ping 已停止 ---\n`); // 使用 safeSend
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
            exec('arp -a', {encoding: 'binary'}, (err, stdout, stderr) => {
                if (err) resolve(`Error: ${err.message}`);
                resolve(decodeOutput(Buffer.from(stdout, 'binary')));
            });
        });
    }
};

const ScanModule = {
    inProgress: false,

    start: async (config) => {
        if (ScanModule.inProgress) return;
        ScanModule.inProgress = true;

        const { ip, timeout } = config;

        try {
            // 1. 计算网段
            const subnet = ip.split('.').slice(0, 3).join('.');
            const ips = [];
            for (let i = 1; i < 255; i++) ips.push(`${subnet}.${i}`);

            const totalIps = ips.length;
            let scannedCount = 0;
            let foundCount = 0;

            // 发送初始状态
            safeSend('scan-status', {
                status: 'scanning',
                message: `正在扫描 ${totalIps} 个地址...`,
                total: totalIps,
                current: 0,
                found: 0
            });

            // 2. 定义单个 IP 扫描任务
            const scanTask = async (targetIp) => {
                if (!ScanModule.inProgress) return;

                const pingCmd = isWin
                    ? `ping -n 1 -w ${timeout} ${targetIp}`
                    : `ping -c 1 -W ${timeout/1000} ${targetIp}`;

                try {
                    await new Promise((resolve) => {
                        exec(pingCmd, { timeout: timeout + 500 }, (err, stdout) => {
                            scannedCount++;

                            // 🔧 修复点 1: 改进进度更新逻辑
                            const shouldUpdate =
                                scannedCount % 5 === 0 ||           // 每5个更新
                                scannedCount === totalIps ||         // 最后一个必须更新
                                scannedCount === 1;                  // 第一个也更新

                            if (shouldUpdate) {
                                const percent = Math.round((scannedCount / totalIps) * 100);
                                safeSend('scan-status', {
                                    status: 'scanning',
                                    message: `扫描中... ${percent}% (${scannedCount}/${totalIps})`,
                                    total: totalIps,
                                    current: scannedCount,
                                    found: foundCount
                                });
                            }

                            // 检查是否 Ping 通
                            if (!err && (stdout.includes('TTL=') || stdout.includes('ttl='))) {
                                foundCount++;

                                // 获取 MAC 地址
                                exec(`arp -a ${targetIp}`, (e, out) => {
                                    let mac = 'Unknown';
                                    if (!e) {
                                        const match = out.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
                                        if (match) mac = match[0];
                                    }

                                    safeSend('scan-device-found', {
                                        ip: targetIp,
                                        mac: mac,
                                        vendor: 'Unknown',
                                        time: `<${timeout}ms`
                                    });

                                    resolve();
                                });
                            } else {
                                resolve();
                            }
                        });
                    });
                } catch (e) {
                    scannedCount++;
                    // 超时也算扫描完成
                }
            };

            // 3. 并发执行扫描 (限制并发数 20)
            await runWithConcurrency(
                ips.map(ip => () => scanTask(ip)),
                20
            );

            // 🔧 修复点 2: 确保最终状态为 100%
            if (ScanModule.inProgress) {
                safeSend('scan-status', {
                    status: 'completed',
                    message: `扫描完成 - 发现 ${foundCount} 台设备`,
                    total: totalIps,
                    current: totalIps,  // 确保是总数
                    found: foundCount,
                    percent: 100        // 明确指定 100%
                });
            }

        } catch (e) {
            safeSend('scan-status', {
                status: 'error',
                error: e.message,
                message: `扫描出错: ${e.message}`
            });
        } finally {
            ScanModule.inProgress = false;
        }
    },

    stop: () => {
        ScanModule.inProgress = false;
        safeSend('scan-status', {
            status: 'stopped',
            message: '扫描已停止',
            percent: 0  // 重置进度
        });
    },

    cleanup: () => ScanModule.stop()
};

// ============================================================================
//                          模块 4: 重写吞吐量测试模块 (iPerf 版本)
// ============================================================================

const ThroughputModule = {
    serverProcess: null,
    clientProcess: null,

    startServer: (config) => {
        return new Promise((resolve, reject) => {
            ThroughputModule.stopServer();

            const { port, protocol, version } = config;
            const iperfPath = getIperfPath(version);

            if (!iperfPath) {
                return resolve(`错误: ${version} 未找到`);
            }

            const args = [];

            if (version === 'iperf3') {
                args.push('-s', '-p', port.toString());
                if (protocol === 'udp') args.push('--udp');
            } else {
                args.push('-s', '-p', port.toString());
                if (protocol === 'udp') args.push('-u');
            }

            const child = spawn(iperfPath, args);
            ThroughputModule.serverProcess = child;

            child.stdout.on('data', data => {
                safeSend('tp-log', decodeOutput(data));
            });

            child.stderr.on('data', data => {
                safeSend('tp-log', `[错误] ${decodeOutput(data)}`);
            });

            child.on('close', code => {
                safeSend('tp-log', `服务端已停止 (code: ${code})`);
                ThroughputModule.serverProcess = null;
            });

            resolve(`${version} 服务端已启动 (端口: ${port}, 协议: ${protocol.toUpperCase()})`);
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
            safeSend('tp-log', '服务端已停止');
        }
    },

    startClient: (config) => {
        ThroughputModule.stopClient();

        const { ip, port, protocol, duration, bandwidth, version } = config;
        const iperfPath = getIperfPath(version);

        if (!iperfPath) {
            safeSend('tp-log', `错误: ${version} 未找到`);
            return;
        }

        const args = [];

        if (version === 'iperf3') {
            args.push('-c', ip, '-p', port.toString(), '-t', duration.toString());
            if (protocol === 'udp') {
                args.push('--udp', '-b', `${bandwidth}M`);
            }
            args.push('-i', '1');
        } else {
            args.push('-c', ip, '-p', port.toString(), '-t', duration.toString(), '-i', '1');
            if (protocol === 'udp') {
                args.push('-u', '-b', `${bandwidth}M`);
            }
        }

        const child = spawn(iperfPath, args);
        ThroughputModule.clientProcess = child;

        safeSend('tp-log', `开始测试: ${ip}:${port} (${protocol.toUpperCase()})`);

        child.stdout.on('data', data => {
            const output = decodeOutput(data);
            safeSend('tp-log', output);

            const speedMatch = output.match(/([\d\.]+)\s+(M|G)bits\/sec/);
            if (speedMatch) {
                let speed = parseFloat(speedMatch[1]);
                if (speedMatch[2] === 'G') speed *= 1000;
                safeSend('tp-data', speed.toFixed(2));
            }
        });

        child.stderr.on('data', data => {
            safeSend('tp-log', `[错误] ${decodeOutput(data)}`);
        });

        child.on('close', code => {
            safeSend('tp-log', `测试完成 (code: ${code})`);
            ThroughputModule.clientProcess = null;
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
            safeSend('tp-log', '测试已停止');
        }
    },

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

        // 🔧 修复点 1: 更新命令行参数以匹配新版 HRUFT
        // 新版命令: hruft send <ip> <port> <filepath> [--mss N] [--window N] [--detailed]
        const args = ['send', ip, port.toString(), filePath];

        // 添加可选参数
        if (udtConfig) {
            if (udtConfig.packetSize) {
                args.push('--mss', udtConfig.packetSize.toString());
            }
            if (udtConfig.windowSize) {
                // 窗口大小单位为字节
                args.push('--window', udtConfig.windowSize.toString());
            }
        }

        // 🔧 修复点 2: 始终启用详细输出以获取 JSON 统计
        args.push('--detailed');

        if (mainWindow) {
            mainWindow.webContents.send('transfer-log', `[CMD] ${hruft.command} ${args.join(' ')}`);
            // 通知 UI 开始
            mainWindow.webContents.send('file-send-start', {
                fileName,
                fileSize: fs.statSync(filePath).size,
                md5: '计算中(HRUFT)...'
            });
        }

        const child = spawn(hruft.path, args, {
            cwd: path.dirname(hruft.path) // 设置工作目录
        });

        FileTransferModule.hruftProcesses.set(transferId, child);

        // 🔧 修复点 3: 改进输出处理 - 分别处理 stdout 和 stderr
        let stdoutBuffer = '';
        let stderrBuffer = '';

        child.stdout.on('data', (data) => {
            stdoutBuffer += data.toString();
            const lines = stdoutBuffer.split('\n');
            stdoutBuffer = lines.pop() || ''; // 保留不完整的行

            lines.forEach(line => {
                FileTransferModule.parseHruftOutput(line, {mode: 'send', fileName});
            });
        });

        child.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
            const lines = stderrBuffer.split('\n');
            stderrBuffer = lines.pop() || '';

            lines.forEach(line => {
                if (line.trim()) {
                    safeSend('transfer-log', `[HRUFT Log] ${line.trim()}`);
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
            const { port, savePath, protocol } = config;
            FileTransferModule.currentProtocol = protocol;

            if (protocol === 'hruft') {
                // 🔧 修复点 4: 更新 HRUFT 接收命令
                // 新版命令: hruft recv <port> <save_directory_or_path> [--detailed]
                const hruft = getHruftPath();

                if (!hruft.path) {
                    resolve('❌ HRUFT 可执行文件未找到');
                    return;
                }

                const args = ['recv', port.toString(), savePath, '--detailed'];

                const child = spawn(hruft.path, args, {
                    cwd: path.dirname(hruft.path)
                });

                const pid = `recv-${port}`;
                FileTransferModule.hruftProcesses.set(pid, child);

                let stdoutBuffer = '';
                let stderrBuffer = '';

                child.stdout.on('data', data => {
                    stdoutBuffer += data.toString();
                    const lines = stdoutBuffer.split('\n');
                    stdoutBuffer = lines.pop() || '';

                    lines.forEach(line => {
                        FileTransferModule.parseHruftOutput(line, {
                            mode: 'receive',
                            fileName: 'Incoming...'
                        });
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
                });

                resolve(`HRUFT 接收服务已启动\n监听端口: ${port}\n保存路径: ${savePath}`);

            } else {
                // TCP 接收模式
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

    // TCP 服务端实现 (简化版)
    startTcpServer: (port, savePath) => {
        const server = net.createServer(socket => {
            let fileName = `recv_${Date.now()}.bin`;
            let fileSize = 0;
            let received = 0;
            let metaReceived = false;
            let writeStream = null;

            socket.on('data', chunk => {
                if (!metaReceived) {
                    const str = chunk.toString();
                    if (str.includes('###END_METADATA###')) {
                        const parts = str.split('###END_METADATA###');
                        try {
                            const meta = JSON.parse(parts[0]);
                            fileName = meta.fileName || fileName;
                            fileSize = meta.fileSize || 0;
                            metaReceived = true;

                            writeStream = fs.createWriteStream(path.join(savePath, fileName));

                            if (mainWindow) {
                                mainWindow.webContents.send('file-transfer-start', { fileName, fileSize });
                            }

                            if (parts[1]) {
                                writeStream.write(parts[1]);
                                received += Buffer.byteLength(parts[1]);
                            }
                        } catch(e) {
                            console.error('[TCP] 元数据解析失败:', e);
                        }
                    }
                } else {
                    writeStream.write(chunk);
                    received += chunk.length;

                    if (mainWindow) {
                        mainWindow.webContents.send('file-transfer-progress', {
                            received,
                            total: fileSize,
                            progress: (received / fileSize * 100).toFixed(1),
                            speed: 0
                        });
                    }
                }
            });

            socket.on('end', () => {
                if (writeStream) writeStream.end();
                if (mainWindow) {
                    mainWindow.webContents.send('file-transfer-complete', {
                        fileName,
                        fileSize: received,
                        protocol: 'TCP'
                    });
                }
            });

            socket.on('error', (err) => {
                console.error('[TCP] Socket 错误:', err);
                if (writeStream) writeStream.end();
            });
        });

        server.listen(port, () => {
            FileTransferModule.tcpServer = server;
            if (mainWindow) {
                mainWindow.webContents.send('transfer-log', `TCP 服务端监听端口: ${port}`);
            }
        });

        server.on('error', (err) => {
            console.error('[TCP] 服务器错误:', err);
            safeSend('transfer-log', `❌ TCP 服务器错误: ${err.message}`);
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

    // ---------------- 辅助函数 ----------------

    parseHruftOutput: (line, context) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        line = line.trim();
        if (!line) return;

        // 🔧 修复点 5: 改进 JSON 解析 - 处理新版 HRUFT 的输出格式
        if (line.startsWith('{') && line.endsWith('}')) {
            try {
                const json = JSON.parse(line);
                FileTransferModule.handleHruftJson(json, context);
            } catch (e) {
                // 不是有效的 JSON,作为普通日志输出
                safeSend('transfer-log', `[HRUFT] ${line}`);
            }
        } else {
            // 普通文本输出
            safeSend('transfer-log', `[HRUFT] ${line}`);
        }
    },

    handleHruftJson: (json, context) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        const { mode } = context;
        const isSend = mode === 'send';

        // 🔧 修复点 6: 适配新版 HRUFT 的 JSON 消息类型
        switch (json.type) {
            case 'status':
                // 状态消息
                safeSend('transfer-log', `📋 ${json.message || JSON.stringify(json)}`);
                break;

            case 'progress':
                // 进度报告
                const current = json.current || 0;
                const total = json.total || 1;
                // 🔧 修复: 确保进度不超过 100%，并处理边界情况
                let progress = json.percent !== undefined ? json.percent : ((current / total) * 100);
                progress = Math.min(100, Math.max(0, progress)); // 限制在 0-100

                const payload = {
                    sent: isSend ? current : 0,
                    received: !isSend ? current : 0,
                    total: total,
                    progress: progress,
                    speed: (json.speed_mbps || 0) / 8, // 转换为 MB/s
                    remainingBytes: Math.max(0, json.remaining_bytes || (total - current)),
                    elapsedSeconds: json.elapsed_seconds || 0
                };

                safeSend(isSend ? 'file-send-progress' : 'file-transfer-progress', payload);
                break;

            case 'verify':
            case 'final_verify':
                // MD5 校验结果
                const verifyData = {
                    success: json.success || false,
                    expected: json.expected || '',
                    actual: json.actual || '',
                    message: json.success ? '✅ MD5 校验通过' : '❌ MD5 校验失败'
                };
                safeSend('transfer-log', verifyData.message);
                break;

            case 'statistics':
                // 🔧 修复点 7: 处理详细统计信息
                const completeData = {
                    fileName: context.fileName,
                    fileSize: json.total_bytes || 0,
                    sourceMD5: json.source_md5 || 'N/A',
                    receivedMD5: json.received_md5 || 'N/A',
                    match: json.md5_match !== undefined ? json.md5_match : true,
                    duration: json.total_time_seconds || 0,
                    protocol: 'HRUFT',
                    stats: json,
                    // 新增字段
                    averageSpeed: json.average_speed_mbps || 0,
                    maxSpeed: json.max_speed_mbps || 0,
                    networkQuality: json.network_quality_assessment?.quality_level || 'unknown'
                };

                safeSend(isSend ? 'file-send-complete' : 'file-transfer-complete', completeData);

                // 输出网络质量评估
                if (json.network_quality_assessment) {
                    const qa = json.network_quality_assessment;
                    safeSend('transfer-log', `📊 网络质量: ${qa.quality_level}`);
                    if (qa.recommendations) {
                        safeSend('transfer-log', `💡 建议: ${qa.recommendations}`);
                    }
                }
                break;

            case 'error':
                // 错误消息
                safeSend(isSend ? 'file-send-error' : 'file-transfer-error', {
                    error: json.message || '未知错误'
                });
                safeSend('transfer-log', `❌ 错误: ${json.message || '未知错误'}`);
                break;

            case 'success':
                // 成功消息
                safeSend('transfer-log', `✅ ${json.message || '操作成功'}`);
                break;

            case 'warning':
                // 警告消息
                safeSend('transfer-log', `⚠️ ${json.message || '警告'}`);
                break;

            default:
                // 未知类型,输出原始 JSON
                safeSend('transfer-log', `[JSON] ${JSON.stringify(json)}`);
                break;
        }
    },

    // ---------------- TCP 备用逻辑 (简化版) ----------------
    sendTcp: (ip, port, filePath) => {
        const socket = new net.Socket();
        const fileName = path.basename(filePath);
        const fileSize = fs.statSync(filePath).size;
        let sent = 0;

        socket.connect(port, ip, () => {
            mainWindow.webContents.send('file-send-start', {fileName, fileSize, md5: 'N/A'});
            // 发送元数据头
            const meta = JSON.stringify({fileName, fileSize});
            socket.write(meta + '\n###END_METADATA###\n');

            const stream = fs.createReadStream(filePath);
            stream.on('data', chunk => {
                const ok = socket.write(chunk);
                sent += chunk.length;
                if (!ok) stream.pause();

                // 进度通知
                if (mainWindow) {
                    mainWindow.webContents.send('file-send-progress', {
                        sent, total: fileSize, progress: (sent / fileSize * 100).toFixed(1), speed: 0
                    });
                }
            });
            socket.on('drain', () => stream.resume());
            stream.on('end', () => {
                socket.end();
                if (mainWindow) mainWindow.webContents.send('file-send-complete', {
                    fileName,
                    fileSize,
                    protocol: 'TCP'
                });
            });
        });

        socket.on('error', (err) => {
            console.error('[TCP] 发送错误:', err);
            safeSend('file-send-error', {error: err.message});
        });
    },

    cleanup: () => {
        FileTransferModule.stopServer();
    }
};