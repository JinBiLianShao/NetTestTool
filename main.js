const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const iconv = require('iconv-lite');
const fs = require('fs');
const crypto = require('crypto');
// 引入高性能 UDP 库
const { UdpSenderStream, UdpReceiverStream, CONSTANTS } = require('./hpr-udp');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.loadFile('index.html');
}

// === 工具函数 ===
function decodeOutput(data) {
    const isWin = os.platform() === 'win32';
    return isWin ? iconv.decode(data, 'cp936') : data.toString();
}

// === 1. 网络环境查询 ===
ipcMain.handle('net:interfaces', () => {
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
});

// === 2. Ping 测试 ===
let pingTimer = null;

ipcMain.on('net:ping-start', (event, config) => {
    if (pingTimer) clearInterval(pingTimer);

    const { target, interval, size } = config;
    const intervalMs = Math.max(100, interval * 1000);

    const logHeader = `开始 Ping ${target} (间隔: ${interval}s, 包大小: ${size} bytes)...\n`;
    mainWindow.webContents.send('ping-reply', logHeader);

    pingTimer = setInterval(() => {
        let command;
        let decode_encoding = 'utf8';

        if (os.platform() === 'win32') {
            command = `cmd.exe /C "chcp 437 && ping -n 1 -l ${size} ${target}"`;
            decode_encoding = 'cp437';
        } else {
            command = `ping -c 1 -s ${size} ${target}`;
        }

        const env = os.platform() === 'win32' ? process.env : { ...process.env, LC_ALL: 'C', LANG: 'C' };

        exec(command, { encoding: 'binary', env, timeout: 5000 }, (err, stdout, stderr) => {
            let replyText;

            const outputBuffer = Buffer.from(stdout, 'binary');
            const errorBuffer = Buffer.from(stderr, 'binary');

            const output = iconv.decode(outputBuffer, decode_encoding);
            const errorOutput = iconv.decode(errorBuffer, decode_encoding);

            if (err) {
                if (output.includes('Request timed out') || output.includes('Destination host unreachable')) {
                    replyText = `请求超时或目标不可达: ${target}\n`;
                } else {
                    replyText = `Ping 发生错误: ${output || errorOutput || err.message}\n`;
                }
            } else {
                const lessThanOneMatch = output.match(/time<1ms/i);
                const regularTimeMatch = output.match(/time=(\d+)ms/i);

                let time;
                if (lessThanOneMatch) {
                    time = '<1ms';
                } else if (regularTimeMatch) {
                    time = `${regularTimeMatch[1]}ms`;
                } else {
                    time = 'N/A';
                }

                const ttlMatch = output.match(/TTL=(\d+)/i);
                const bytesMatch = output.match(/Bytes=(\d+)|bytes=(\d+)/i);

                const ttl = ttlMatch ? ttlMatch[1] : 'N/A';
                const bytes = bytesMatch ? (bytesMatch[1] || bytesMatch[2] || size) : size;

                if (output.includes('Reply from') || output.includes('transmitted, 1 received')) {
                    replyText = `来自 ${target} 的回复：字节=${bytes} 时间=${time} TTL=${ttl}\n`;
                } else {
                    replyText = `请求超时或目标不可达: ${target}\n`;
                }
            }
            mainWindow.webContents.send('ping-reply', replyText);
        });
    }, intervalMs);
});

ipcMain.on('net:ping-stop', () => {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
        mainWindow.webContents.send('ping-reply', '\n--- Ping 已停止 ---');
    }
});

// === 3. ARP 表查询 ===
ipcMain.handle('net:arp', async () => {
    return new Promise((resolve) => {
        exec('arp -a', { encoding: 'binary' }, (err, stdout, stderr) => {
            if (err) return resolve(`Error: ${decodeOutput(Buffer.from(stderr, 'binary'))}`);
            resolve(decodeOutput(Buffer.from(stdout, 'binary')));
        });
    });
});

// === 4. 网段扫描功能 ===
let scanInProgress = false;

function calculateNetworkRange(ip, netmask) {
    const ipParts = ip.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);

    const networkParts = ipParts.map((part, i) => part & maskParts[i]);
    const broadcastParts = ipParts.map((part, i) => part | (~maskParts[i] & 255));

    return {
        start: networkParts.join('.'),
        end: broadcastParts.join('.'),
        networkParts,
        broadcastParts
    };
}

function generateIPList(networkParts, broadcastParts) {
    const ips = [];
    for (let i = networkParts[3] + 1; i < broadcastParts[3]; i++) {
        ips.push(`${networkParts[0]}.${networkParts[1]}.${networkParts[2]}.${i}`);
    }
    return ips;
}

function quickPing(ip) {
    return new Promise((resolve) => {
        const isWin = os.platform() === 'win32';
        const command = isWin
            ? `ping -n 1 -w 500 ${ip}`
            : `ping -c 1 -W 1 ${ip}`;

        exec(command, { timeout: 2000 }, (err, stdout) => {
            if (err) {
                resolve({ ip, online: false });
            } else {
                const online = stdout.includes('TTL=') || stdout.includes('ttl=') ||
                    stdout.includes('bytes from') || stdout.includes('Reply from');

                let time = 'N/A';
                const timeMatch = stdout.match(/time[=<](\d+)ms|time=(\d+\.\d+)/i);
                if (timeMatch) {
                    time = timeMatch[1] || timeMatch[2];
                    time = time + 'ms';
                } else if (stdout.includes('time<1ms')) {
                    time = '<1ms';
                }

                resolve({ ip, online, time });
            }
        });
    });
}

async function getDeviceDetails(ip) {
    return new Promise((resolve) => {
        exec('arp -a', { encoding: 'binary' }, (err, stdout) => {
            let mac = 'N/A';
            let vendor = '';

            if (!err) {
                const arpOutput = decodeOutput(Buffer.from(stdout, 'binary'));
                const lines = arpOutput.split('\n');

                for (const line of lines) {
                    if (line.includes(ip)) {
                        const macMatch = line.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
                        if (macMatch) {
                            mac = macMatch[0].toUpperCase().replace(/-/g, ':');
                            vendor = getVendorFromMAC(mac);
                        }
                        break;
                    }
                }
            }
            resolve({ mac, vendor, hostname: '' });
        });
    });
}

function getVendorFromMAC(mac) {
    const prefix = mac.substring(0, 8).replace(/:/g, '').toUpperCase();
    const vendors = {
        '001122': 'CIMSYS Inc', '0050F2': 'Microsoft', '00155D': 'Microsoft',
        '000C29': 'VMware', '005056': 'VMware', '0A0027': 'VirtualBox',
        '080027': 'VirtualBox', '001DD8': 'HP', '001E68': 'HP',
        '7054D9': 'Apple', '001451': 'Apple', 'D89695': 'Apple',
        '8863DF': 'Apple', 'F0D1A9': 'Apple', '3C0754': 'Apple',
        '44D884': 'Apple', '001C42': 'Parallels', '000D3A': 'D-Link',
        'B0C090': 'Intel', '000E0C': 'Intel', 'AC220B': 'Intel',
        'F4B301': 'Realtek', '001FC6': 'Realtek', '00E04C': 'Realtek',
    };
    for (const [key, value] of Object.entries(vendors)) {
        if (prefix.startsWith(key)) return value;
    }
    return 'Unknown';
}

ipcMain.on('net:scan-start', async (event, config) => {
    if (scanInProgress) {
        mainWindow.webContents.send('scan-status', { error: '扫描正在进行中...' });
        return;
    }

    scanInProgress = true;
    const { ip, netmask } = config;

    try {
        mainWindow.webContents.send('scan-status', {
            status: 'calculating',
            message: '正在计算网段范围...'
        });

        const range = calculateNetworkRange(ip, netmask);
        const ipList = generateIPList(range.networkParts, range.broadcastParts);

        mainWindow.webContents.send('scan-status', {
            status: 'scanning',
            message: `开始扫描 ${ipList.length} 个IP地址...`,
            total: ipList.length,
            current: 0
        });

        const batchSize = 10;
        const results = [];

        for (let i = 0; i < ipList.length; i += batchSize) {
            if (!scanInProgress) break;
            const batch = ipList.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(quickPing));

            for (const result of batchResults) {
                if (result.online) {
                    const details = await getDeviceDetails(result.ip);
                    results.push({
                        ip: result.ip,
                        time: result.time,
                        mac: details.mac,
                        vendor: details.vendor,
                        hostname: details.hostname
                    });

                    mainWindow.webContents.send('scan-device-found', {
                        ip: result.ip,
                        time: result.time,
                        mac: details.mac,
                        vendor: details.vendor
                    });
                }
            }

            mainWindow.webContents.send('scan-status', {
                status: 'scanning',
                message: `扫描中... ${Math.min(i + batchSize, ipList.length)}/${ipList.length}`,
                total: ipList.length,
                current: Math.min(i + batchSize, ipList.length),
                found: results.length
            });
        }

        if (scanInProgress) {
            mainWindow.webContents.send('scan-status', {
                status: 'completed',
                message: `扫描完成！发现 ${results.length} 台在线设备`,
                total: ipList.length,
                current: ipList.length,
                found: results.length,
                devices: results
            });
        }

    } catch (error) {
        mainWindow.webContents.send('scan-status', {
            status: 'error',
            error: error.message
        });
    } finally {
        scanInProgress = false;
    }
});

ipcMain.on('net:scan-stop', () => {
    scanInProgress = false;
    mainWindow.webContents.send('scan-status', {
        status: 'stopped',
        message: '扫描已停止'
    });
});

// === 5. 吞吐量测试 (TCP/UDP/HPR-UDP) ===
let throughputServer = null;
let throughputSocket = null;
let udpServer = null;
let udpClient = null;
let udpClientTimer = null;
let hprUdpServer = null;
let hprUdpClient = null;

let totalBytesReceived = 0;
let lastCheckTime = Date.now();
let speedTimer = null;
let testStats = {
    startTime: null,
    bytesTransferred: 0,
    peakSpeed: 0
};

function startTcpServer(port, resolve) {
    throughputServer = net.createServer((socket) => {
        socket.on('data', (data) => {
            totalBytesReceived += data.length;
        });
        socket.on('close', () => {
            mainWindow.webContents.send('tp-log', 'TCP 连接关闭');
        });
        socket.on('error', (err) => {
            mainWindow.webContents.send('tp-log', `TCP Server Socket 错误: ${err.message}`);
        });
    });

    throughputServer.listen(port, '0.0.0.0', () => {
        resolve(`TCP 服务端已启动，监听端口: ${port}`);
    });

    throughputServer.on('error', (err) => {
        resolve(`TCP 服务端启动失败: ${err.message}`);
    });
}

function startUdpServer(port, resolve) {
    udpServer = dgram.createSocket('udp4');

    udpServer.on('message', (msg) => {
        totalBytesReceived += msg.length;
    });

    udpServer.on('listening', () => {
        resolve(`UDP 服务端已启动，监听端口: ${port}`);
    });

    udpServer.on('error', (err) => {
        resolve(`UDP 服务端错误: ${err.message}`);
        udpServer.close();
    });

    udpServer.bind(port, '0.0.0.0');
}

function startHprUdpServer(port, resolve) {
    hprUdpServer = new UdpReceiverStream(port, { log: false });

    hprUdpServer.on('data', (chunk) => {
        totalBytesReceived += chunk.length;
    });

    hprUdpServer.on('error', (err) => {
        mainWindow.webContents.send('tp-log', `HPR-UDP 服务器错误: ${err.message}`);
    });

    resolve(`HPR-UDP 服务端已启动，监听端口: ${port}`);
}

ipcMain.handle('net:tp-server', (event, { port, protocol }) => {
    return new Promise((resolve) => {
        // 清理旧的服务器
        stopThroughputServers();

        totalBytesReceived = 0;
        lastCheckTime = Date.now();
        testStats = {
            startTime: Date.now(),
            bytesTransferred: 0,
            peakSpeed: 0
        };

        if (speedTimer) clearInterval(speedTimer);
        speedTimer = setInterval(calculateSpeed, 1000);

        if (protocol === 'tcp') {
            startTcpServer(port, resolve);
        } else if (protocol === 'udp') {
            startUdpServer(port, resolve);
        } else if (protocol === 'hpr-udp') {
            startHprUdpServer(port, resolve);
        } else {
            resolve('错误：未知的协议');
        }
    });
});

function calculateSpeed() {
    const now = Date.now();
    const duration = (now - lastCheckTime) / 1000;

    if (duration >= 1) {
        const speedMbps = ((totalBytesReceived * 8) / (1024 * 1024)) / duration;

        // 更新统计
        testStats.bytesTransferred += totalBytesReceived;
        if (speedMbps > testStats.peakSpeed) {
            testStats.peakSpeed = speedMbps;
        }

        mainWindow.webContents.send('tp-data', {
            currentSpeed: speedMbps.toFixed(2),
            avgSpeed: ((testStats.bytesTransferred * 8) / (1024 * 1024) / ((now - testStats.startTime) / 1000)).toFixed(2),
            peakSpeed: testStats.peakSpeed.toFixed(2),
            duration: Math.floor((now - testStats.startTime) / 1000)
        });

        totalBytesReceived = 0;
        lastCheckTime = now;
    }
}

let testing = false;

function startTcpClient(ip, port) {
    throughputSocket = new net.Socket();
    const chunkSize = 64 * 1024;
    const buffer = Buffer.alloc(chunkSize, 'x');

    throughputSocket.connect(port, ip, () => {
        mainWindow.webContents.send('tp-log', `已连接到 ${ip}:${port} (TCP)，开始发送数据...`);

        function write() {
            if (!testing) return;
            let ok = true;
            do {
                ok = throughputSocket.write(buffer);
            } while (ok && testing);

            if (testing) throughputSocket.once('drain', write);
        }
        write();
    });

    throughputSocket.on('error', (err) => {
        testing = false;
        mainWindow.webContents.send('tp-log', `TCP 连接错误: ${err.message}`);
    });

    throughputSocket.on('close', () => {
        testing = false;
        mainWindow.webContents.send('tp-log', `TCP 连接已关闭`);
    });
}

function startUdpClient(ip, port, bandwidthMbps, packetSize) {
    const buffer = Buffer.alloc(packetSize, 'x');
    const targetBitsPerSecond = bandwidthMbps * 1024 * 1024;
    const bitsPerPacket = packetSize * 8;
    const packetsPerSecond = targetBitsPerSecond / bitsPerPacket;
    const intervalMs = Math.max(1, 1000 / packetsPerSecond);

    udpClient = dgram.createSocket('udp4');
    mainWindow.webContents.send('tp-log', `已启动 UDP 客户端。目标: ${ip}:${port}，速率: ${bandwidthMbps}Mbps`);

    udpClientTimer = setInterval(() => {
        if (!testing) {
            clearInterval(udpClientTimer);
            return;
        }
        udpClient.send(buffer, port, ip, (err) => {
            if (err) {
                mainWindow.webContents.send('tp-log', `UDP 发送错误: ${err.message}`);
                testing = false;
                clearInterval(udpClientTimer);
            }
        });
    }, intervalMs);

    udpClient.on('error', (err) => {
        testing = false;
        clearInterval(udpClientTimer);
        mainWindow.webContents.send('tp-log', `UDP Client 错误: ${err.message}`);
    });
}

function startHprUdpClient(ip, port, bandwidthMbps, packetSize) {
    hprUdpClient = new UdpSenderStream(port, ip, {
        mss: packetSize || 8192,
        windowSize: 10000,
        rto: 500,
        log: true
    });

    mainWindow.webContents.send('tp-log', `[HPR-UDP] 连接目标: ${ip}:${port}，MSS: ${packetSize || 8192}`);

    hprUdpClient.connect();

    hprUdpClient.on('connect', () => {
        testing = true;
        mainWindow.webContents.send('tp-log', `[HPR-UDP] 连接已建立，开始发送数据...`);

        // 计算发送速率
        const targetBitsPerSecond = (bandwidthMbps || 10) * 1024 * 1024;
        const chunkSize = Math.min(packetSize || 8192, CONSTANTS.DEFAULT_MSS);
        const bitsPerChunk = chunkSize * 8;
        const chunksPerSecond = targetBitsPerSecond / bitsPerChunk;
        const intervalMs = Math.max(1, 1000 / chunksPerSecond);

        const buffer = Buffer.alloc(chunkSize, 'x');
        let lastSendTime = Date.now();

        const sendLoop = () => {
            if (!testing || hprUdpClient.state !== 'ESTABLISHED') {
                return;
            }

            const now = Date.now();
            const elapsed = now - lastSendTime;

            if (elapsed >= intervalMs) {
                if (hprUdpClient.writable) {
                    const canWrite = hprUdpClient.write(buffer);
                    if (!canWrite) {
                        hprUdpClient.once('drainWindow', sendLoop);
                    } else {
                        lastSendTime = now;
                        setTimeout(sendLoop, 0);
                    }
                }
            } else {
                setTimeout(sendLoop, Math.max(0, intervalMs - elapsed));
            }
        };

        sendLoop();
    });

    hprUdpClient.on('error', (err) => {
        testing = false;
        mainWindow.webContents.send('tp-log', `[HPR-UDP] 客户端错误: ${err.message}`);
    });

    hprUdpClient.on('stats', (stats) => {
        mainWindow.webContents.send('tp-stats', stats);
    });

    hprUdpClient.on('close', () => {
        testing = false;
        mainWindow.webContents.send('tp-log', '[HPR-UDP] 连接已关闭');
    });
}

ipcMain.on('net:tp-client-start', (event, config) => {
    testing = true;
    const { ip, port, protocol, bandwidth, size } = config;

    // 清理旧的客户端
    if (throughputSocket) throughputSocket.end();
    if (udpClientTimer) clearInterval(udpClientTimer);
    if (udpClient) udpClient.close(() => udpClient = null);
    if (hprUdpClient) {
        hprUdpClient.destroy();
        hprUdpClient = null;
    }

    if (protocol === 'tcp') {
        startTcpClient(ip, port);
    } else if (protocol === 'udp') {
        startUdpClient(ip, port, bandwidth, size);
    } else if (protocol === 'hpr-udp') {
        startHprUdpClient(ip, port, bandwidth, size);
    }
});

function stopThroughputServers() {
    if (throughputServer) throughputServer.close();
    if (udpServer) udpServer.close();
    if (hprUdpServer) {
        hprUdpServer.close();
        hprUdpServer = null;
    }
}

ipcMain.on('net:tp-stop', () => {
    testing = false;
    if (speedTimer) clearInterval(speedTimer);

    stopThroughputServers();

    if (throughputSocket) throughputSocket.end();
    if (udpClientTimer) clearInterval(udpClientTimer);
    if (udpClient) udpClient.close();
    if (hprUdpClient) {
        hprUdpClient.destroy();
        hprUdpClient = null;
    }

    throughputServer = null;
    udpServer = null;
    throughputSocket = null;
    udpClient = null;
    udpClientTimer = null;
    speedTimer = null;

    mainWindow.webContents.send('tp-log', '测试已停止');
});

// === 6. 文件传输功能 (TCP + HPR-UDP) ===
let fileTransferServer = null;
let hprUdpFileReceiver = null;
let currentSavePath = app.getPath('downloads');

// 计算文件MD5
function calculateFileMD5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
}

// 选择保存路径
ipcMain.handle('file:select-save-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        defaultPath: currentSavePath
    });
    if (!result.canceled && result.filePaths.length > 0) {
        currentSavePath = result.filePaths[0];
        return currentSavePath;
    }
    return null;
});

// 选择要发送的文件
ipcMain.handle('file:select-send-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title: '选择要发送的文件'
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        const stats = fs.statSync(filePath);
        return {
            path: filePath,
            name: path.basename(filePath),
            size: stats.size
        };
    }
    return null;
});

// 启动文件传输服务器
ipcMain.handle('file:start-server', (event, config) => {
    return new Promise((resolve) => {
        const { port, savePath } = config;
        currentSavePath = savePath;

        // 清理旧服务
        if (fileTransferServer) fileTransferServer.close();
        if (hprUdpFileReceiver) {
            hprUdpFileReceiver.close();
            hprUdpFileReceiver = null;
        }

        // 1. 启动 TCP Server
        fileTransferServer = net.createServer((socket) => {
            handleStreamConnection(socket, 'TCP');
        });

        fileTransferServer.listen(port, '0.0.0.0', () => {
            // 2. 启动 HPR-UDP Server
            try {
                hprUdpFileReceiver = new UdpReceiverStream(port, { log: true });

                // 为每个HPR-UDP连接创建独立的处理器
                const connectionProcessors = new Map();
                let connectionIdCounter = 0;

                hprUdpFileReceiver.on('data', (chunk) => {
                    // 为每个新的数据块创建或获取连接处理器
                    // 这里简化处理：假设每次传输都是新的连接
                    const connectionId = `hpr-${connectionIdCounter}`;

                    if (!connectionProcessors.has(connectionId)) {
                        // 创建新的处理器
                        const processor = new HprUdpFileProcessor(connectionId, 'HPR-UDP');
                        connectionProcessors.set(connectionId, processor);
                    }

                    const processor = connectionProcessors.get(connectionId);
                    processor.processData(chunk);
                });

                hprUdpFileReceiver.on('error', (err) => {
                    mainWindow.webContents.send('transfer-log', `[HPR-UDP] 服务器错误: ${err.message}`);
                });

                resolve(`接收服务已启动 (TCP/HPR-UDP) 端口: ${port}\n保存路径: ${currentSavePath}`);
            } catch (err) {
                resolve(`HPR-UDP 启动失败: ${err.message}`);
            }
        });

        fileTransferServer.on('error', (err) => {
            resolve(`TCP 服务器启动失败: ${err.message}`);
        });
    });
});

// === HPR-UDP 发送 ===
function sendHprUdpFile(ip, port, filePath, fileSize, metadataBuf, metaObj, hprUdpConfig) {
    const hprSender = new UdpSenderStream(port, ip, {
        mss: hprUdpConfig?.packetSize || 8192,
        windowSize: hprUdpConfig?.windowSize || 32768,
        rto: hprUdpConfig?.rto || 100,
        log: true
    });

    mainWindow.webContents.send('transfer-log', `[HPR-UDP] 初始化完成。目标: ${ip}:${port}, MSS: ${hprSender.mss}, Window: ${hprSender.windowSize}`);

    hprSender.on('connect', () => {
        mainWindow.webContents.send('transfer-log', '[HPR-UDP] 连接已建立，开始发送文件...');

        // 发送元数据
        hprSender.write(metadataBuf);
        // 发送文件
        sendWithProgress(hprSender, filePath, fileSize, metaObj, 'HPR-UDP');
    });

    hprSender.on('error', (err) => {
        mainWindow.webContents.send('file-send-error', { error: `HPR-UDP错误: ${err.message}` });
    });

    hprSender.on('stats', (stats) => {
        // 只在调试时显示，避免日志过多
        if (stats.seq % 100 === 0) {
            mainWindow.webContents.send('transfer-log', `[HPR状态] RTT: ${stats.rtt}ms, Window: ${stats.window}/${stats.windowSize}, RTO: ${stats.rto}ms`);
        }
    });

    // 开始连接
    hprSender.connect();
}

ipcMain.on('file:stop-server', () => {
    if (fileTransferServer) fileTransferServer.close();
    if (hprUdpFileReceiver) hprUdpFileReceiver.close();
    fileTransferServer = null;
    hprUdpFileReceiver = null;
    mainWindow.webContents.send('transfer-log', '文件传输服务器已停止');
});

// TCP流处理逻辑
function handleStreamConnection(inputStream, protocolName) {
    let fileInfo = null;
    let metadataBuffer = Buffer.alloc(0);
    let metadataReceived = false;
    let writeStream = null;
    let fileHash = null;
    let receivedBytes = 0;
    let startTime = 0;
    let lastProgressTime = 0;
    let lastReceivedBytes = 0;

    const cleanup = () => {
        if (writeStream) writeStream.end();
    };

    inputStream.on('data', (chunk) => {
        if (!metadataReceived) {
            metadataBuffer = Buffer.concat([metadataBuffer, chunk]);
            const delimiter = Buffer.from('\n###END_METADATA###\n');
            const delimiterIndex = metadataBuffer.indexOf(delimiter);

            if (delimiterIndex !== -1) {
                const metadataStr = metadataBuffer.slice(0, delimiterIndex).toString('utf8');
                try {
                    fileInfo = JSON.parse(metadataStr);
                    metadataReceived = true;
                    startTime = Date.now();
                    lastProgressTime = Date.now();

                    const filePath = path.join(currentSavePath, fileInfo.fileName);
                    writeStream = fs.createWriteStream(filePath);
                    fileHash = crypto.createHash('md5');

                    mainWindow.webContents.send('file-transfer-start', {
                        fileName: fileInfo.fileName,
                        fileSize: fileInfo.fileSize,
                        sourceMD5: fileInfo.md5
                    });
                    mainWindow.webContents.send('transfer-log', `[${protocolName}] 开始接收: ${fileInfo.fileName}`);

                    const remainingData = metadataBuffer.subarray(delimiterIndex + delimiter.length);
                    metadataBuffer = null;

                    if (remainingData.length > 0) {
                        writeStream.write(remainingData);
                        fileHash.update(remainingData);
                        receivedBytes += remainingData.length;
                    }
                } catch (err) {
                    mainWindow.webContents.send('transfer-log', `[${protocolName}] 元数据解析错误: ${err.message}`);
                }
            }
        } else {
            if (writeStream && !writeStream.destroyed) {
                const canWrite = writeStream.write(chunk);
                fileHash.update(chunk);
                receivedBytes += chunk.length;

                if (!canWrite && inputStream.pause) {
                    inputStream.pause();
                    writeStream.once('drain', () => inputStream.resume());
                }

                const now = Date.now();
                if (now - lastProgressTime >= 200 || receivedBytes >= fileInfo.fileSize) {
                    const progress = (receivedBytes / fileInfo.fileSize) * 100;
                    const duration = (now - lastProgressTime) / 1000;
                    const speed = duration > 0 ? (receivedBytes - lastReceivedBytes) / duration : 0;

                    mainWindow.webContents.send('file-transfer-progress', {
                        received: receivedBytes,
                        total: fileInfo.fileSize,
                        progress: progress.toFixed(2),
                        speed: (speed / (1024 * 1024)).toFixed(2)
                    });
                    lastProgressTime = now;
                    lastReceivedBytes = receivedBytes;
                }
            }
        }
    });

    inputStream.on('end', () => {
        if (fileInfo && writeStream) {
            writeStream.end(() => {
                const receivedMD5 = fileHash.digest('hex');
                const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
                const match = receivedMD5 === fileInfo.md5;

                mainWindow.webContents.send('file-transfer-complete', {
                    fileName: fileInfo.fileName,
                    fileSize: fileInfo.fileSize,
                    sourceMD5: fileInfo.md5,
                    receivedMD5: receivedMD5,
                    match: match,
                    duration: totalDuration,
                    protocol: protocolName
                });
                mainWindow.webContents.send('transfer-log', `[${protocolName}] 接收完成。校验: ${match ? '通过' : '失败'}`);
            });
        }
    });

    inputStream.on('error', (err) => {
        mainWindow.webContents.send('transfer-log', `[${protocolName}] 传输错误: ${err.message}`);
        cleanup();
    });
}

// 发送文件主入口
ipcMain.on('file:send', async (event, config) => {
    const { ip, port, filePath, protocol, hprUdpConfig } = config;

    if (!fs.existsSync(filePath)) {
        mainWindow.webContents.send('file-send-error', { error: '文件不存在' });
        return;
    }

    const stats = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const fileSize = stats.size;

    mainWindow.webContents.send('transfer-log', `正在计算 MD5...`);
    const md5 = await calculateFileMD5(filePath);

    // 构造元数据
    const metaObj = { fileName, fileSize, md5 };
    const metadataStr = JSON.stringify(metaObj) + '\n###END_METADATA###\n';
    const metadataBuf = Buffer.from(metadataStr);

    if (protocol === 'hpr-udp') {
        sendHprUdpFile(ip, port, filePath, fileSize, metadataBuf, metaObj, hprUdpConfig);
    } else {
        sendTcpFile(ip, port, filePath, fileSize, metadataBuf, metaObj);
    }
});

// 带有进度监控的通用发送函数（修复版）
function sendWithProgress(outputStream, filePath, fileSize, metaObj, protocolName) {
    mainWindow.webContents.send('file-send-start', metaObj);

    const fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    let bytesRead = 0;
    let startTime = Date.now();
    let lastProgressTime = Date.now();
    let lastBytes = 0;

    // 监听文件读取进度
    fileStream.on('data', (chunk) => {
        bytesRead += chunk.length;

        const now = Date.now();
        if (now - lastProgressTime >= 200 || bytesRead === fileSize) {
            const duration = (now - lastProgressTime) / 1000;
            const speed = duration > 0 ? (bytesRead - lastBytes) / duration : 0;

            mainWindow.webContents.send('file-send-progress', {
                sent: bytesRead,
                total: fileSize,
                progress: ((bytesRead / fileSize) * 100).toFixed(2),
                speed: (speed / (1024 * 1024)).toFixed(2)
            });
            lastProgressTime = now;
            lastBytes = bytesRead;
        }
    });

    // 监听文件读取完成
    fileStream.on('end', () => {
        console.log(`文件读取完成: ${bytesRead} bytes`);
    });

    // 监听错误
    fileStream.on('error', (err) => {
        mainWindow.webContents.send('file-send-error', { error: `文件读取错误: ${err.message}` });
    });

    // 建立管道
    fileStream.pipe(outputStream, { end: true });

    // 监听输出流完成
    outputStream.on('finish', () => {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`传输完成，总耗时: ${duration}s`);

        mainWindow.webContents.send('file-send-complete', {
            fileName: metaObj.fileName,
            fileSize: fileSize,
            md5: metaObj.md5,
            duration: duration,
            protocol: protocolName
        });
    });

    // 监听输出流错误
    outputStream.on('error', (err) => {
        mainWindow.webContents.send('file-send-error', { error: `传输错误: ${err.message}` });
        fileStream.destroy();
    });
}

// TCP 发送
function sendTcpFile(ip, port, filePath, fileSize, metadataBuf, metaObj) {
    const client = new net.Socket();

    client.connect(port, ip, () => {
        client.write(metadataBuf);
        sendWithProgress(client, filePath, fileSize, metaObj, 'TCP');
    });

    client.on('error', (err) => {
        mainWindow.webContents.send('file-send-error', { error: err.message });
    });
}

// === HPR-UDP 发送 ===
function sendHprUdpFile(ip, port, filePath, fileSize, metadataBuf, metaObj, hprUdpConfig) {
    console.log(`开始HPR-UDP文件传输: ${filePath}, 大小: ${fileSize} bytes`);

    const hprSender = new UdpSenderStream(port, ip, {
        mss: hprUdpConfig?.packetSize || 8192,
        windowSize: hprUdpConfig?.windowSize || 32768,
        rto: hprUdpConfig?.rto || 100,
        log: true
    });

    mainWindow.webContents.send('transfer-log', `[HPR-UDP] 初始化完成。目标: ${ip}:${port}, MSS: ${hprUdpConfig?.packetSize || 8192}`);

    let transferStarted = false;

    hprSender.on('connect', () => {
        console.log('HPR-UDP连接已建立');
        mainWindow.webContents.send('transfer-log', '[HPR-UDP] 连接已建立，开始发送文件...');

        // 发送元数据
        console.log('发送元数据...');
        const canWrite = hprSender.write(metadataBuf);
        if (!canWrite) {
            hprSender.once('drainWindow', () => {
                console.log('缓冲区已清空，开始发送文件数据');
                startFileTransfer();
            });
        } else {
            startFileTransfer();
        }

        function startFileTransfer() {
            transferStarted = true;
            // 发送文件
            sendWithProgress(hprSender, filePath, fileSize, metaObj, 'HPR-UDP');
        }
    });

    hprSender.on('error', (err) => {
        console.error('HPR-UDP发送错误:', err);
        mainWindow.webContents.send('file-send-error', { error: `HPR-UDP错误: ${err.message}` });
    });

    hprSender.on('stats', (stats) => {
        // 只在调试时显示，避免日志过多
        if (stats.seq % 500 === 0) {
            mainWindow.webContents.send('transfer-log', `[HPR状态] Seq: ${stats.seq}, RTT: ${stats.rtt}ms, Window: ${stats.window}/${stats.windowSize}`);
        }
    });

    hprSender.on('close', () => {
        console.log('HPR-UDP连接已关闭');
        if (!transferStarted) {
            mainWindow.webContents.send('file-send-error', { error: 'HPR-UDP连接关闭，传输未开始' });
        }
    });

    // 开始连接
    console.log('开始HPR-UDP连接...');
    hprSender.connect();
}

// === App Lifecycle ===
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// HPR-UDP文件处理器类
class HprUdpFileProcessor {
    constructor(connectionId, protocolName) {
        this.connectionId = connectionId;
        this.protocolName = protocolName;
        this.metadataBuffer = Buffer.alloc(0);
        this.metadataReceived = false;
        this.fileInfo = null;
        this.writeStream = null;
        this.fileHash = null;
        this.receivedBytes = 0;
        this.startTime = Date.now();
        this.lastProgressTime = Date.now();
        this.lastReceivedBytes = 0;
        this.delimiter = Buffer.from('\n###END_METADATA###\n');
    }

    processData(chunk) {
        if (!this.metadataReceived) {
            this.metadataBuffer = Buffer.concat([this.metadataBuffer, chunk]);
            const delimiterIndex = this.metadataBuffer.indexOf(this.delimiter);

            if (delimiterIndex !== -1) {
                const metadataStr = this.metadataBuffer.slice(0, delimiterIndex).toString('utf8');
                try {
                    this.fileInfo = JSON.parse(metadataStr);
                    this.metadataReceived = true;
                    this.startTime = Date.now();
                    this.lastProgressTime = Date.now();

                    const filePath = path.join(currentSavePath, this.fileInfo.fileName);
                    this.writeStream = fs.createWriteStream(filePath);
                    this.fileHash = crypto.createHash('md5');

                    // 发送开始事件
                    mainWindow.webContents.send('file-transfer-start', {
                        fileName: this.fileInfo.fileName,
                        fileSize: this.fileInfo.fileSize,
                        sourceMD5: this.fileInfo.md5
                    });
                    mainWindow.webContents.send('transfer-log', `[${this.protocolName}] 开始接收: ${this.fileInfo.fileName}`);

                    // 处理剩余的数据
                    const remainingData = this.metadataBuffer.subarray(delimiterIndex + this.delimiter.length);
                    if (remainingData.length > 0) {
                        this.writeFileData(remainingData);
                    }
                    this.metadataBuffer = null;
                } catch (err) {
                    mainWindow.webContents.send('transfer-log', `[${this.protocolName}] 元数据解析错误: ${err.message}`);
                }
            }
        } else {
            this.writeFileData(chunk);
        }
    }

    writeFileData(chunk) {
        if (this.writeStream && !this.writeStream.destroyed) {
            const canWrite = this.writeStream.write(chunk);
            this.fileHash.update(chunk);
            this.receivedBytes += chunk.length;

            // 更新进度
            const now = Date.now();
            if (now - this.lastProgressTime >= 200 || this.receivedBytes >= this.fileInfo.fileSize) {
                const progress = (this.receivedBytes / this.fileInfo.fileSize) * 100;
                const duration = (now - this.lastProgressTime) / 1000;
                const speed = duration > 0 ? (this.receivedBytes - this.lastReceivedBytes) / duration : 0;

                mainWindow.webContents.send('file-transfer-progress', {
                    received: this.receivedBytes,
                    total: this.fileInfo.fileSize,
                    progress: progress.toFixed(2),
                    speed: (speed / (1024 * 1024)).toFixed(2)
                });
                this.lastProgressTime = now;
                this.lastReceivedBytes = this.receivedBytes;
            }

            // 检查是否传输完成
            if (this.receivedBytes >= this.fileInfo.fileSize) {
                this.completeTransfer();
            }
        }
    }

    completeTransfer() {
        if (this.writeStream) {
            this.writeStream.end(() => {
                const receivedMD5 = this.fileHash.digest('hex');
                const totalDuration = ((Date.now() - this.startTime) / 1000).toFixed(2);
                const match = receivedMD5 === this.fileInfo.md5;

                mainWindow.webContents.send('file-transfer-complete', {
                    fileName: this.fileInfo.fileName,
                    fileSize: this.fileInfo.fileSize,
                    sourceMD5: this.fileInfo.md5,
                    receivedMD5: receivedMD5,
                    match: match,
                    duration: totalDuration,
                    protocol: this.protocolName
                });
                mainWindow.webContents.send('transfer-log', `[${this.protocolName}] 接收完成。校验: ${match ? '通过' : '失败'}`);
            });
        }
    }

    end() {
        // 如果没有收到结束标志但处理器已经创建，尝试完成传输
        if (this.metadataReceived && this.fileInfo && this.receivedBytes > 0) {
            this.completeTransfer();
        }
    }
}