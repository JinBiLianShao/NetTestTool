const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const iconv = require('iconv-lite');
const fs = require('fs');
const crypto = require('crypto');

// ==================== 全局变量和状态管理 ====================
let mainWindow = null;

// Ping测试模块状态
let pingTimer = null;
let isPinging = false;

// 网段扫描模块状态
let scanInProgress = false;

// 吞吐量测试模块状态
let throughputServer = null;
let throughputSocket = null;
let udpServer = null;
let udpClient = null;
let udpClientTimer = null;
let totalBytesReceived = 0;
let lastCheckTime = Date.now();
let speedTimer = null;
let testing = false;
let isServerRunning = false;

// 文件传输模块状态
let fileTransferServer = null;
let hruftReceiverProcess = null;
let hruftSenderProcess = null;
let hruftProcesses = new Map();
let currentSavePath = app.getPath('downloads');

// HRUFT配置
const HRUFT_CONFIG = {
    win32: {
        path: path.join(__dirname, 'bin', 'windows', 'hruft.exe'),
        command: 'hruft.exe'
    },
    linux: {
        path: path.join(__dirname, 'bin', 'linux', 'hruft'),
        command: './hruft'
    },
    darwin: {
        path: path.join(__dirname, 'bin', 'mac', 'hruft'),
        command: './hruft'
    }
};

// ==================== 窗口管理模块 ====================
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

// ==================== 工具函数模块 ====================
function decodeOutput(data) {
    const isWin = os.platform() === 'win32';
    return isWin ? iconv.decode(data, 'cp936') : data.toString();
}

function calculateFileMD5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getHruftPath() {
    const platform = process.platform;
    const config = HRUFT_CONFIG[platform];

    if (!config) {
        throw new Error(`不支持的操作系统: ${platform}`);
    }

    if (!fs.existsSync(config.path)) {
        throw new Error(`HRUFT可执行文件未找到: ${config.path}`);
    }

    if (platform !== 'win32') {
        fs.chmodSync(config.path, 0o755);
    }

    return config;
}

function parseHruftOutput(data, context = {}) {
    const lines = data.toString().trim().split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;

        try {
            if (line.startsWith('{') || line.startsWith('[')) {
                const jsonData = JSON.parse(line);
                handleHruftJson(jsonData, context);
            } else {
                mainWindow.webContents.send('transfer-log', `[HRUFT] ${line}`);

                const progressMatch = line.match(/Progress: (\d+\.?\d*)%/);
                if (progressMatch && context.progressCallback) {
                    const progress = parseFloat(progressMatch[1]);
                    context.progressCallback(progress);
                }
            }
        } catch (e) {
            mainWindow.webContents.send('transfer-log', `[HRUFT] ${line}`);
        }
    }
}

function handleHruftJson(jsonData, context) {
    const { mode } = context;
    const eventPrefix = mode === 'send' ? 'file-send' : 'file-transfer';

    switch (jsonData.type) {
        case 'progress':
            if (mode === 'send') {
                mainWindow.webContents.send('file-send-progress', {
                    sent: jsonData.current || 0,
                    total: jsonData.total || 0,
                    progress: jsonData.percent || 0,
                    speed: (jsonData.speed_mbps || 0) / 8,
                    remainingBytes: jsonData.remaining_bytes || 0,
                    elapsedSeconds: jsonData.elapsed_seconds || 0
                });
            } else {
                mainWindow.webContents.send('file-transfer-progress', {
                    received: jsonData.current || 0,
                    total: jsonData.total || 0,
                    progress: jsonData.percent || 0,
                    speed: (jsonData.speed_mbps || 0) / 8,
                    remainingBytes: jsonData.remaining_bytes || 0,
                    elapsedSeconds: jsonData.elapsed_seconds || 0
                });
            }
            break;

        case 'statistics':
            const stats = jsonData;
            mainWindow.webContents.send('transfer-log',
                `📊 传输统计:\n` +
                `  - 平均速度: ${stats.average_speed_mbps || 0} Mbps\n` +
                `  - 最高速度: ${stats.max_speed_mbps || 0} Mbps\n` +
                `  - 丢包率: ${stats.packet_loss_rate || 0}%\n` +
                `  - 网络质量: ${stats.network_quality || 'Unknown'}\n` +
                `  - 传输效率: ${stats.transfer_efficiency || 0}%`);
            break;

        case 'error':
            const errorEvent = mode === 'send' ? 'file-send-error' : 'file-transfer-error';
            mainWindow.webContents.send(errorEvent, {
                error: jsonData.message || 'HRUFT传输错误'
            });
            break;

        case 'complete':
            const completeEvent = mode === 'send' ? 'file-send-complete' : 'file-transfer-complete';
            mainWindow.webContents.send(completeEvent, {
                fileName: context.fileName || '',
                fileSize: jsonData.total_bytes || 0,
                sourceMD5: jsonData.source_md5 || '',
                receivedMD5: jsonData.received_md5 || '',
                match: jsonData.md5_match || false,
                duration: jsonData.total_time || 0,
                protocol: 'UDT',
                stats: jsonData
            });
            break;

        default:
            mainWindow.webContents.send('transfer-log',
                `[HRUFT JSON] ${JSON.stringify(jsonData, null, 2)}`);
    }
}

function stopAllHruftProcesses() {
    hruftProcesses.forEach((process, key) => {
        try {
            process.kill();
            mainWindow.webContents.send('transfer-log', `[HRUFT] 停止进程: ${key}`);
        } catch (e) {
            console.error(`停止进程失败 ${key}:`, e);
        }
    });
    hruftProcesses.clear();
}

// ==================== 网络信息模块 ====================
function getNetworkInterfaces() {
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

// ==================== Ping测试模块 ====================
function startPingTest(config) {
    if (pingTimer) clearInterval(pingTimer);

    const { target, interval, size } = config;
    const intervalMs = Math.max(100, interval * 1000);

    const logHeader = `开始 Ping ${target} (间隔: ${interval}s, 包大小: ${size} bytes)...\n`;
    mainWindow.webContents.send('ping-reply', logHeader);
    mainWindow.webContents.send('ping-reply', `[提示] 使用原生 Ping 命令，强制英文环境解析 TTL/时间，精确间隔 (${intervalMs}ms)。\n`);

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
}

function stopPingTest() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
        mainWindow.webContents.send('ping-reply', '\n--- Ping 已停止 ---');
    }
}

// ==================== ARP表模块 ====================
function getArpTable() {
    return new Promise((resolve) => {
        exec('arp -a', { encoding: 'binary' }, (err, stdout, stderr) => {
            if (err) return resolve(`Error: ${decodeOutput(Buffer.from(stderr, 'binary'))}`);
            resolve(decodeOutput(Buffer.from(stdout, 'binary')));
        });
    });
}

// ==================== 网段扫描模块 ====================
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

function getDeviceDetails(ip) {
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

async function startNetworkScan(config) {
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
}

function stopNetworkScan() {
    scanInProgress = false;
    mainWindow.webContents.send('scan-status', {
        status: 'stopped',
        message: '扫描已停止'
    });
}

// ==================== 吞吐量测试模块 ====================
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

async function startThroughputServer(config) {
    return new Promise((resolve) => {
        const { port, protocol } = config;

        if (throughputServer) throughputServer.close(() => throughputServer = null);
        if (udpServer) udpServer.close(() => udpServer = null);

        totalBytesReceived = 0;
        lastCheckTime = Date.now();
        if (speedTimer) clearInterval(speedTimer);

        speedTimer = setInterval(calculateSpeed, 1000);

        if (protocol === 'tcp') {
            startTcpServer(port, resolve);
        } else if (protocol === 'udp') {
            startUdpServer(port, resolve);
        } else {
            resolve('错误：未知的协议');
        }
    });
}

function calculateSpeed() {
    const now = Date.now();
    const duration = (now - lastCheckTime) / 1000;

    if (duration >= 1) {
        const speedMbps = ((totalBytesReceived * 8) / (1024 * 1024)) / duration;
        mainWindow.webContents.send('tp-data', speedMbps.toFixed(2));
        totalBytesReceived = 0;
        lastCheckTime = now;
    }
}

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
    mainWindow.webContents.send('tp-log', `已启动 UDP 客户端。目标: ${ip}:${port}，速率: ${bandwidthMbps}Mbps，间隔: ${intervalMs.toFixed(2)}ms`);

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

function startThroughputClient(config) {
    testing = true;
    const { ip, port, protocol, bandwidth, size } = config;

    if (throughputSocket) throughputSocket.end();
    if (udpClientTimer) clearInterval(udpClientTimer);
    if (udpClient) udpClient.close(() => udpClient = null);

    if (protocol === 'tcp') {
        startTcpClient(ip, port);
    } else if (protocol === 'udp') {
        startUdpClient(ip, port, bandwidth, size);
    }
}

function stopThroughputTest() {
    testing = false;
    if (speedTimer) clearInterval(speedTimer);
    if (throughputServer) throughputServer.close();
    if (udpServer) udpServer.close();
    if (throughputSocket) throughputSocket.end();
    if (udpClientTimer) clearInterval(udpClientTimer);
    if (udpClient) udpClient.close();

    throughputServer = null;
    udpServer = null;
    throughputSocket = null;
    udpClient = null;
    udpClientTimer = null;
    speedTimer = null;

    mainWindow.webContents.send('tp-log', '测试已停止');
}

// ==================== TCP文件传输模块 ====================
function handleTcpConnection(socket) {
    let fileInfo = null;
    let metadataBuffer = Buffer.alloc(0);
    let metadataReceived = false;
    let writeStream = null;
    let fileHash = null;
    let receivedBytes = 0;
    let startTime = 0;
    let lastProgressTime = 0;
    let lastReceivedBytes = 0;

    socket.on('data', (chunk) => {
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
                    mainWindow.webContents.send('transfer-log', `[TCP] 开始接收: ${fileInfo.fileName}`);

                    const remainingData = metadataBuffer.slice(delimiterIndex + delimiter.length);
                    metadataBuffer = null;
                    if (remainingData.length > 0) handleFileChunk(remainingData);
                } catch (err) {
                    socket.destroy();
                }
            }
        } else {
            handleFileChunk(chunk);
        }
    });

    function handleFileChunk(data) {
        if (!writeStream) return;
        const canWrite = writeStream.write(data);
        fileHash.update(data);
        receivedBytes += data.length;

        if (!canWrite) {
            socket.pause();
            writeStream.once('drain', () => socket.resume());
        }

        const now = Date.now();
        if (now - lastProgressTime >= 200 || receivedBytes === fileInfo.fileSize) {
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

        if (receivedBytes >= fileInfo.fileSize) {
            finishTransfer();
        }
    }

    function finishTransfer() {
        writeStream.end(async () => {
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
                protocol: 'TCP'
            });
            socket.end();
        });
    }
}

function sendTcpFile(ip, port, filePath, fileName, fileSize, md5) {
    const client = new net.Socket();
    let bytesSent = 0;
    const startTime = Date.now();
    let lastProgressTime = Date.now();
    let lastSentBytes = 0;

    client.connect(port, ip, () => {
        mainWindow.webContents.send('file-send-start', { fileName, fileSize, md5 });
        const metadata = JSON.stringify({ fileName, fileSize, md5 });
        client.write(metadata + '\n###END_METADATA###\n');

        const readStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

        readStream.on('data', (chunk) => {
            const canContinue = client.write(chunk);
            bytesSent += chunk.length;

            const now = Date.now();
            if (now - lastProgressTime >= 200) {
                const progress = (bytesSent / fileSize) * 100;
                const duration = (now - lastProgressTime) / 1000;
                const speed = duration > 0 ? (bytesSent - lastSentBytes) / duration : 0;
                mainWindow.webContents.send('file-send-progress', {
                    sent: bytesSent,
                    total: fileSize,
                    progress: progress.toFixed(2),
                    speed: (speed / (1024 * 1024)).toFixed(2)
                });
                lastProgressTime = now;
                lastSentBytes = bytesSent;
            }

            if (!canContinue) {
                readStream.pause();
                client.once('drain', () => readStream.resume());
            }
        });

        readStream.on('end', () => {
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            mainWindow.webContents.send('file-send-complete', { fileName, fileSize, md5, duration, protocol: 'TCP' });
            client.end();
        });

        readStream.on('error', (err) => {
            mainWindow.webContents.send('file-send-error', { error: err.message });
        });
    });

    client.on('error', (err) => {
        mainWindow.webContents.send('file-send-error', { error: err.message });
    });
}

// ==================== HRUFT文件传输模块 ====================
async function startHruftServer(config) {
    return new Promise((resolve, reject) => {
        const { port, savePath } = config;
        currentSavePath = savePath;

        if (hruftReceiverProcess) {
            hruftReceiverProcess.kill();
            hruftReceiverProcess = null;
        }

        try {
            const hruft = getHruftPath();
            const args = [
                'recv',
                port.toString(),
                savePath,
                '--detailed'
            ];

            mainWindow.webContents.send('transfer-log',
                `[HRUFT] 启动接收服务: ${hruft.command} ${args.join(' ')}`);

            hruftReceiverProcess = spawn(hruft.path, args, {
                cwd: path.dirname(hruft.path),
                stdio: ['pipe', 'pipe', 'pipe']
            });

            const processId = `receiver-${port}`;
            hruftProcesses.set(processId, hruftReceiverProcess);

            hruftReceiverProcess.stdout.on('data', (data) => {
                parseHruftOutput(data, {
                    mode: 'receive',
                    type: 'server',
                    port: port
                });
            });

            hruftReceiverProcess.stderr.on('data', (data) => {
                const errorMsg = data.toString();
                if (!errorMsg.includes('warning') && !errorMsg.includes('note')) {
                    mainWindow.webContents.send('transfer-log',
                        `[HRUFT Error] ${errorMsg}`);
                }
            });

            hruftReceiverProcess.on('close', (code) => {
                hruftProcesses.delete(processId);
                hruftReceiverProcess = null;

                if (code !== 0 && code !== null) {
                    mainWindow.webContents.send('transfer-log',
                        `[HRUFT] 接收进程异常退出 (code: ${code})`);
                } else {
                    mainWindow.webContents.send('transfer-log',
                        '[HRUFT] 接收进程已停止');
                }
            });

            hruftReceiverProcess.on('error', (err) => {
                reject(`HRUFT启动失败: ${err.message}`);
            });

            setTimeout(() => {
                resolve(`HRUFT接收服务已启动\n端口: ${port}\n保存路径: ${savePath}`);
            }, 1000);

        } catch (error) {
            reject(error.message);
        }
    });
}

function sendFileWithHruft(ip, port, filePath, udtConfig = {}) {
    const fileName = path.basename(filePath);
    const transferId = `send-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    if (hruftProcesses.has(transferId)) {
        hruftProcesses.get(transferId).kill();
        hruftProcesses.delete(transferId);
    }

    try {
        const hruft = getHruftPath();

        const args = [
            'send',
            ip,
            port.toString(),
            filePath,
            '--detailed'
        ];

        if (udtConfig.packetSize) {
            args.push('--mss', udtConfig.packetSize.toString());
        }

        if (udtConfig.windowSize) {
            const windowBytes = udtConfig.windowSize * (udtConfig.packetSize || 1400);
            args.push('--window', windowBytes.toString());
        }

        if (udtConfig.bandwidth) {
            args.push('--bandwidth', udtConfig.bandwidth.toString());
        }

        mainWindow.webContents.send('transfer-log',
            `[HRUFT] 开始发送: ${fileName}\n` +
            `       命令: ${hruft.command} ${args.slice(0, 4).join(' ')} ...`);

        const senderProcess = spawn(hruft.path, args, {
            cwd: path.dirname(hruft.path),
            stdio: ['pipe', 'pipe', 'pipe']
        });

        hruftProcesses.set(transferId, senderProcess);
        hruftSenderProcess = senderProcess;

        mainWindow.webContents.send('file-send-start', {
            fileName: fileName,
            fileSize: fs.statSync(filePath).size,
            md5: '计算中...'
        });

        senderProcess.stdout.on('data', (data) => {
            parseHruftOutput(data, {
                mode: 'send',
                type: 'client',
                transferId: transferId,
                fileName: fileName,
                progressCallback: (progress) => {
                    const fileSize = fs.statSync(filePath).size;
                    mainWindow.webContents.send('file-send-progress', {
                        sent: (progress / 100) * fileSize,
                        total: fileSize,
                        progress: progress,
                        speed: 0,
                        remainingBytes: fileSize - (progress / 100) * fileSize
                    });
                }
            });
        });

        senderProcess.stderr.on('data', (data) => {
            const errorMsg = data.toString();
            if (errorMsg.includes('error') || errorMsg.includes('Error')) {
                mainWindow.webContents.send('file-send-error', {
                    error: `HRUFT错误: ${errorMsg}`
                });
            } else {
                mainWindow.webContents.send('transfer-log', `[HRUFT] ${errorMsg}`);
            }
        });

        senderProcess.on('close', (code) => {
            hruftProcesses.delete(transferId);

            if (code === 0) {
                mainWindow.webContents.send('transfer-log',
                    `✅ 文件发送完成: ${fileName}`);
            } else {
                mainWindow.webContents.send('file-send-error', {
                    error: `发送失败 (退出码: ${code})`
                });
            }
        });

        senderProcess.on('error', (err) => {
            hruftProcesses.delete(transferId);
            mainWindow.webContents.send('file-send-error', {
                error: `HRUFT进程错误: ${err.message}`
            });
        });

    } catch (error) {
        mainWindow.webContents.send('file-send-error', {
            error: `启动HRUFT失败: ${error.message}`
        });
    }
}

async function handleFileSend(config) {
    const { ip, port, filePath, protocol, udtConfig } = config;

    if (!fs.existsSync(filePath)) {
        mainWindow.webContents.send('file-send-error', {
            error: '文件不存在'
        });
        return;
    }

    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;

    if (protocol === 'tcp') {
        const md5 = await calculateFileMD5(filePath);
        sendTcpFile(ip, port, filePath, fileName, fileSize, md5);
        return;
    }

    if (protocol === 'udt') {
        sendFileWithHruft(ip, port, filePath, udtConfig);
    }
}

function stopHruftServer() {
    stopAllHruftProcesses();
    mainWindow.webContents.send('transfer-log', 'HRUFT接收服务已停止');
}

// ==================== IPC主进程通信处理 ====================
function setupIpcHandlers() {
    // 网络信息模块
    ipcMain.handle('net:interfaces', () => getNetworkInterfaces());

    // Ping测试模块
    ipcMain.on('net:ping-start', (event, config) => startPingTest(config));
    ipcMain.on('net:ping-stop', () => stopPingTest());

    // ARP表模块
    ipcMain.handle('net:arp', async () => await getArpTable());

    // 网段扫描模块
    ipcMain.on('net:scan-start', async (event, config) => await startNetworkScan(config));
    ipcMain.on('net:scan-stop', () => stopNetworkScan());

    // 吞吐量测试模块
    ipcMain.handle('net:tp-server', (event, config) => startThroughputServer(config));
    ipcMain.on('net:tp-client-start', (event, config) => startThroughputClient(config));
    ipcMain.on('net:tp-stop', () => stopThroughputTest());

    // 文件传输模块
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

    ipcMain.handle('file:start-server', (event, config) => startHruftServer(config));
    ipcMain.on('file:stop-server', () => stopHruftServer());
    ipcMain.on('file:send', async (event, config) => await handleFileSend(config));

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
}

// ==================== 应用生命周期管理 ====================
app.whenReady().then(() => {
    createWindow();
    setupIpcHandlers();
});

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

app.on('before-quit', () => {
    stopAllHruftProcesses();
    if (fileTransferServer) fileTransferServer.close();
});