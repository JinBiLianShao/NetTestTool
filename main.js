const {app, BrowserWindow, ipcMain, dialog} = require('electron');
const path = require('path');
const {spawn, exec} = require('child_process');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const crypto = require('crypto');
const iconv = require('iconv-lite'); // 需要确保 package.json 中有此依赖

// ============================================================================
//                               全局配置 & 状态
// ============================================================================

let mainWindow = null;
const isWin = process.platform === 'win32';

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
 * 获取 HRUFT 可执行文件路径（兼容开发环境和打包环境）
 */
function getHruftPath() {
    const platform = process.platform;
    const config = HRUFT_CONFIG[platform] || HRUFT_CONFIG.linux; // 默认回退

    // 1. 优先检查开发环境路径
    let execPath = path.join(__dirname, ...config.path.split('/'));

    // 2. 如果不存在，检查打包后的资源路径 (resources/bin/...)
    if (!fs.existsSync(execPath)) {
        execPath = path.join(process.resourcesPath, config.path);
    }

    // 3. 再次检查，如果还是不存在，打印警告
    if (!fs.existsSync(execPath)) {
        console.warn(`[HRUFT] Binary not found at: ${execPath}`);
    } else if (platform !== 'win32') {
        // 确保有执行权限
        try {
            fs.chmodSync(execPath, 0o755);
        } catch (e) {
        }
    }

    return {path: execPath, command: config.cmd};
}

/**
 * 获取 iPerf 可执行文件路径
 */
function getIperfPath(version) {
    const platform = process.platform;
    const config = IPERF_CONFIG[platform];
    if (!config) return null;

    let execPath = path.join(__dirname, config[version]);

    if (!fs.existsSync(execPath)) {
        execPath = path.join(process.resourcesPath, config[version]);
    }

    if (!fs.existsSync(execPath)) {
        console.warn(`[iPerf] Binary not found: ${execPath}`);
        return null;
    }

    if (platform !== 'win32') {
        try {
            fs.chmodSync(execPath, 0o755);
        } catch (e) {
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

    // 添加窗口销毁事件
    mainWindow.on('closed', () => {
        mainWindow = null;
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
        const fileName = path.basename(filePath);
        const transferId = `send-${Date.now()}`;

        // 构造命令行参数 (参考 README)
        // hruft send <ip> <port> <filepath> [options]
        const args = ['send', ip, port.toString(), filePath, '--detailed'];

        if (udtConfig) {
            if (udtConfig.packetSize) args.push('--mss', udtConfig.packetSize.toString());
            // Window Size (Packets) -> Bytes
            if (udtConfig.windowSize) {
                const mss = udtConfig.packetSize || 1400;
                const windowBytes = udtConfig.windowSize * mss;
                args.push('--window', windowBytes.toString());
            }
            // Bandwidth
            if (udtConfig.bandwidth && udtConfig.bandwidth > 0) {
                // 假设 HRUFT 支持此参数，如果不支持请移除
                // args.push('--bandwidth', udtConfig.bandwidth.toString());
            }
        }

        if (mainWindow) {
            mainWindow.webContents.send('transfer-log', `[CMD] ${hruft.command} ${args.join(' ')}`);
            // 通知 UI 开始
            mainWindow.webContents.send('file-send-start', {
                fileName,
                fileSize: fs.statSync(filePath).size,
                md5: '计算中(HRUFT)...'
            });
        }

        const child = spawn(hruft.path, args);
        FileTransferModule.hruftProcesses.set(transferId, child);

        // 处理输出流
        child.stdout.on('data', (data) => FileTransferModule.parseHruftOutput(data, {mode: 'send', fileName}));
        child.stderr.on('data', (data) => {
            if (mainWindow) mainWindow.webContents.send('transfer-log', `[HRUFT Log] ${data}`);
        });

        child.on('close', (code) => {
            FileTransferModule.hruftProcesses.delete(transferId);
            if (code !== 0 && mainWindow) {
                mainWindow.webContents.send('file-send-error', {error: `进程退出码: ${code}`});
            }
        });
    },

    startServer: (config) => {
        return new Promise((resolve) => {
            const { port, savePath, protocol } = config; // 新增 protocol 参数
            FileTransferModule.currentProtocol = protocol;

            if (protocol === 'hruft') {
                // HRUFT 接收模式
                const hruft = getHruftPath();
                const targetFile = path.join(savePath, `recv_${Date.now()}.bin`);
                const args = ['recv', port.toString(), targetFile, '--detailed'];

                const child = spawn(hruft.path, args);
                const pid = `recv-${port}`;
                FileTransferModule.hruftProcesses.set(pid, child);

                child.stdout.on('data', data =>
                    FileTransferModule.parseHruftOutput(data, { mode: 'receive', fileName: 'Incoming...' })
                );

                child.stderr.on('data', data => {
                    if(mainWindow) mainWindow.webContents.send('transfer-log', `[HRUFT] ${data}`);
                });

                child.on('close', code => {
                    FileTransferModule.hruftProcesses.delete(pid);
                    if (mainWindow) {
                        mainWindow.webContents.send('transfer-log', `HRUFT 服务已停止 (code: ${code})`);
                    }
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
        FileTransferModule.hruftProcesses.forEach(p => {
            try {
                p.kill();
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
                        } catch(e) {}
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
        });

        server.listen(port, () => {
            FileTransferModule.tcpServer = server;
            if (mainWindow) {
                mainWindow.webContents.send('transfer-log', `TCP 服务端监听端口: ${port}`);
            }
        });
    },

    cancelHruft: (id) => {
    },

    // ---------------- 辅助函数 ----------------

    parseHruftOutput: (data, context) => {
        if (!mainWindow || mainWindow.isDestroyed()) return; // 添加检查

        const str = data.toString();
        const lines = str.split('\n');

        lines.forEach(line => {
            line = line.trim();
            if (!line) return;

            if (line.startsWith('{') && line.endsWith('}')) {
                try {
                    const json = JSON.parse(line);
                    FileTransferModule.handleHruftJson(json, context);
                } catch (e) {
                    safeSend('transfer-log', `[Raw] ${line}`);
                }
            } else {
                safeSend('transfer-log', `[HRUFT] ${line}`);
            }
        });
    },

    handleHruftJson: (json, context) => {
        if (!mainWindow || mainWindow.isDestroyed()) return; // 添加检查

        const { mode } = context;
        const isSend = mode === 'send';

        switch (json.type) {
            case 'progress':
                const payload = {
                    sent: isSend ? json.current : 0,
                    received: !isSend ? json.current : 0,
                    total: json.total,
                    progress: json.percent,
                    speed: (json.speed_mbps || 0) / 8,
                    remainingBytes: json.remaining_bytes,
                    elapsedSeconds: json.elapsed_seconds
                };
                safeSend(isSend ? 'file-send-progress' : 'file-transfer-progress', payload);
                break;

            case 'complete':
                const completeData = {
                    fileName: context.fileName,
                    fileSize: json.total_bytes,
                    sourceMD5: json.source_md5,
                    receivedMD5: json.received_md5,
                    match: json.md5_match,
                    duration: json.total_time,
                    protocol: 'HRUFT',
                    stats: json
                };
                safeSend(isSend ? 'file-send-complete' : 'file-transfer-complete', completeData);
                break;

            case 'error':
                safeSend(isSend ? 'file-send-error' : 'file-transfer-error', { error: json.message });
                break;
        }
    },

    // ---------------- TCP 备用逻辑 (简化版) ----------------
    sendTcp: (ip, port, filePath) => {
        // 简化的 TCP 发送实现，保持原有功能
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
    },

    cleanup: () => {
        FileTransferModule.stopServer();
    }
};