const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const iconv = require('iconv-lite');
const fs = require('fs');
const crypto = require('crypto');

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

// === 工具函数：解决 Windows 命令行中文乱码 ===
function decodeOutput(data) {
    const isWin = os.platform() === 'win32';
    return isWin ? iconv.decode(data, 'cp936') : data.toString();
}

// === 1. 网络环境查询 (Interface Info) ===
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

// === 2. Ping 测试 (ICMP) ===
let pingTimer = null;

ipcMain.on('net:ping-start', (event, config) => {
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

// ==========================================================
// === 4. 网段扫描功能 (类似 CPing) ===
// ==========================================================
let scanInProgress = false;

// 计算网段范围
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

// 生成IP列表
function generateIPList(networkParts, broadcastParts) {
    const ips = [];

    // 简化版：只扫描最后一个字节
    for (let i = networkParts[3] + 1; i < broadcastParts[3]; i++) {
        ips.push(`${networkParts[0]}.${networkParts[1]}.${networkParts[2]}.${i}`);
    }

    return ips;
}

// 快速Ping检测（超时时间短）
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

                // 提取响应时间
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

// 获取MAC地址和主机名
async function getDeviceDetails(ip) {
    return new Promise((resolve) => {
        // 获取MAC地址（通过ARP）
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

// 简化的厂商识别（基于MAC地址前缀）
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

// 开始网段扫描
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

// 停止扫描
ipcMain.on('net:scan-stop', () => {
    scanInProgress = false;
    mainWindow.webContents.send('scan-status', {
        status: 'stopped',
        message: '扫描已停止'
    });
});

// ==========================================================
// === 5. TCP/UDP 吞吐量测试 (iperf 模式) ===
// ==========================================================
let throughputServer = null;
let throughputSocket = null;
let udpServer = null;
let udpClient = null;
let udpClientTimer = null;

let totalBytesReceived = 0;
let lastCheckTime = Date.now();
let speedTimer = null;

// --- Server Logic ---
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

// 启动服务端
ipcMain.handle('net:tp-server', (event, { port, protocol }) => {
    return new Promise((resolve) => {
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
});

// --- Speed Calculation ---
function calculateSpeed() {
    const now = Date.now();
    const duration = (now - lastCheckTime) / 1000;

    if (duration >= 1) {
        const speedMbps = ((totalBytesReceived * 8) / (1024 * 1024)) / duration; // Mbps
        mainWindow.webContents.send('tp-data', speedMbps.toFixed(2));
        totalBytesReceived = 0;
        lastCheckTime = now;
    }
}

// --- Client Logic ---
let testing = false;

function startTcpClient(ip, port) {
    throughputSocket = new net.Socket();
    const chunkSize = 64 * 1024; // 64KB
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

// 启动客户端
ipcMain.on('net:tp-client-start', (event, config) => {
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
});

ipcMain.on('net:tp-stop', () => {
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
});

// ==========================================================
// === 6. 文件传输功能 (TCP + UDT/ReliableUDP) ===
// ==========================================================
let fileTransferServer = null; // TCP Server
let udtTransferServer = null;  // UDP Server
let currentSavePath = app.getPath('downloads');

// --- UDT 协议常量 ---
const UDT_CHUNK_SIZE = 1400; // 适配以太网 MTU (1500 - IP头 - UDP头 - 协议头)
const UDT_HEADER_SIZE = 5;   // 1 byte Type + 4 bytes Seq
const UDT_CMD_META = 0x01;
const UDT_CMD_DATA = 0x02;
const UDT_CMD_ACK = 0x03;
const UDT_CMD_FIN = 0x04;
const UDT_WINDOW_SIZE = 20;  // 滑动窗口大小
const UDT_CMD_RTT = 0x05;    // 新增：RTT探测包
const UDT_CMD_NAK = 0x06;    // 新增：否定应答（用于快速重传）

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

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
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

// 启动文件传输服务器 (同时启动 TCP 和 UDP)
ipcMain.handle('file:start-server', (event, config) => {
    return new Promise((resolve) => {
        const { port, savePath } = config;
        currentSavePath = savePath;

        // 清理旧服务
        if (fileTransferServer) fileTransferServer.close();
        if (udtTransferServer) udtTransferServer.close();

        // 1. 启动 TCP Server
        fileTransferServer = net.createServer((socket) => handleTcpConnection(socket));
        fileTransferServer.listen(port, '0.0.0.0', () => {
            // 2. 启动 UDP Server (UDT Receiver)
            udtTransferServer = dgram.createSocket('udp4');
            handleUdtReceiver(udtTransferServer, savePath);
            udtTransferServer.bind(port, '0.0.0.0', () => {
                resolve(`接收服务已启动 (TCP/UDT) 端口: ${port}\n保存路径: ${currentSavePath}`);
            });
            udtTransferServer.on('error', (err) => {
                mainWindow.webContents.send('transfer-log', `UDP监听失败: ${err.message}`);
            });
        });

        fileTransferServer.on('error', (err) => {
            resolve(`TCP服务器启动失败: ${err.message}`);
        });
    });
});

ipcMain.on('file:stop-server', () => {
    if (fileTransferServer) fileTransferServer.close();
    if (udtTransferServer) udtTransferServer.close();
    fileTransferServer = null;
    udtTransferServer = null;
    mainWindow.webContents.send('transfer-log', '文件传输服务器已停止');
});

// === TCP 接收逻辑 (保持原样) ===
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

// === UDT/Reliable UDP 接收逻辑 ===
function handleUdtReceiver(socket, savePath) {
    // 存储当前会话状态：key=senderIp:Port
    const sessions = new Map();

    socket.on('message', (msg, rinfo) => {
        const senderKey = `${rinfo.address}:${rinfo.port}`;
        const type = msg[0];

        // 1. 处理元数据握手
        if (type === UDT_CMD_META) {
            try {
                const metaJson = msg.slice(1).toString();
                const meta = JSON.parse(metaJson);

                // 初始化新会话
                const session = {
                    fileInfo: meta,
                    filePath: path.join(savePath, meta.fileName),
                    fd: fs.openSync(path.join(savePath, meta.fileName), 'w'),
                    receivedBytes: 0,
                    nextSeq: 0, // 期望接收的下一个包序号
                    startTime: Date.now(),
                    lastProgressTime: Date.now(),
                    lastReceivedBytes: 0,
                    md5: crypto.createHash('md5')
                };

                sessions.set(senderKey, session);

                // 发送 ACK (确认收到元数据)
                const ackBuf = Buffer.alloc(1);
                ackBuf[0] = UDT_CMD_ACK;
                socket.send(ackBuf, rinfo.port, rinfo.address);

                mainWindow.webContents.send('file-transfer-start', {
                    fileName: meta.fileName,
                    fileSize: meta.fileSize,
                    sourceMD5: meta.md5
                });
                mainWindow.webContents.send('transfer-log', `[UDT] 开始接收: ${meta.fileName} (来自 ${rinfo.address})`);

            } catch (e) {
                console.error('Meta parse error', e);
            }
        }
        // 2. 处理数据包
        else if (type === UDT_CMD_DATA) {
            const session = sessions.get(senderKey);
            if (!session) return;

            const seq = msg.readUInt32BE(1);
            const data = msg.slice(5);

            // 简单 ARQ：只接受期望序号的包，否则丢弃（触发发送端超时重传）
            // 优化：发送期望的 ACK
            if (seq === session.nextSeq) {
                // 写入文件 (同步写简单可靠，系统会自动缓存)
                fs.writeSync(session.fd, data);
                session.md5.update(data);
                session.receivedBytes += data.length;
                session.nextSeq++;

                // 更新进度
                const now = Date.now();
                if (now - session.lastProgressTime >= 200 || session.receivedBytes === session.fileInfo.fileSize) {
                    const progress = (session.receivedBytes / session.fileInfo.fileSize) * 100;
                    const duration = (now - session.lastProgressTime) / 1000;
                    const speed = duration > 0 ? (session.receivedBytes - session.lastReceivedBytes) / duration : 0;

                    mainWindow.webContents.send('file-transfer-progress', {
                        received: session.receivedBytes,
                        total: session.fileInfo.fileSize,
                        progress: progress.toFixed(2),
                        speed: (speed / (1024 * 1024)).toFixed(2)
                    });
                    session.lastProgressTime = now;
                    session.lastReceivedBytes = session.receivedBytes;
                }
            }

            // 始终回复 ACK，告知接收方期望的下一个序号
            const ackBuf = Buffer.alloc(5);
            ackBuf[0] = UDT_CMD_ACK;
            ackBuf.writeUInt32BE(session.nextSeq, 1);
            socket.send(ackBuf, rinfo.port, rinfo.address);
        }
        // 3. 处理结束包
        else if (type === UDT_CMD_FIN) {
            const session = sessions.get(senderKey);
            if (!session) return;

            fs.closeSync(session.fd);
            const receivedMD5 = session.md5.digest('hex');
            const totalDuration = ((Date.now() - session.startTime) / 1000).toFixed(2);
            const match = receivedMD5 === session.fileInfo.md5;

            mainWindow.webContents.send('file-transfer-complete', {
                fileName: session.fileInfo.fileName,
                fileSize: session.fileInfo.fileSize,
                sourceMD5: session.fileInfo.md5,
                receivedMD5: receivedMD5,
                match: match,
                duration: totalDuration,
                protocol: 'UDT'
            });

            // 回复 Fin ACK
            const ackBuf = Buffer.alloc(1);
            ackBuf[0] = UDT_CMD_FIN;
            socket.send(ackBuf, rinfo.port, rinfo.address);

            sessions.delete(senderKey);
        }
    });
}

// === 发送文件主入口 ===
ipcMain.on('file:send', async (event, config) => {
    const {ip, port, filePath, protocol, udtConfig} = config;

    if (!fs.existsSync(filePath)) {
        mainWindow.webContents.send('file-send-error', {error: '文件不存在'});
        return;
    }

    const stats = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const fileSize = stats.size;

    mainWindow.webContents.send('transfer-log', `正在计算 MD5...`);
    const md5 = await calculateFileMD5(filePath);

    mainWindow.webContents.send('transfer-log', `模式: ${protocol === 'udt' ? 'UDT (可靠UDP)' : 'TCP'}`);

    if (protocol === 'udt') {
        sendUdtFile(ip, port, filePath, fileName, fileSize, md5, udtConfig);
    } else {
        sendTcpFile(ip, port, filePath, fileName, fileSize, md5);
    }
});

// === TCP 发送逻辑 ===
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

// === UDT 发送逻辑 (Reliable UDP) ===
function sendUdtFile(ip, port, filePath, fileName, fileSize, md5, udtConfig) {
    const socket = dgram.createSocket('udp4');
    const fd = fs.openSync(filePath, 'r');

    // 使用配置参数
    const config = {
        windowSize: udtConfig?.windowSize || 32,
        packetSize: udtConfig?.packetSize || 1400,
        rto: udtConfig?.rto || 1000,  // ms
        maxRetransmit: udtConfig?.maxRetransmit || 5,
        sendInterval: udtConfig?.sendInterval || 10,  // ms
        bandwidth: udtConfig?.bandwidth || 100,  // Mbps
        fastRetransmit: udtConfig?.fastRetransmit !== false,
        congestionControl: udtConfig?.congestionControl !== false
    };

    // 状态管理
    let seq = 0;
    let bytesSent = 0;
    let confirmedSeq = 0;
    let isFinished = false;
    const startTime = Date.now();
    let lastProgressTime = Date.now();
    let lastSentBytes = 0;

    // 包管理
    const packetBuffer = new Map();  // 存储已发送但未确认的包
    const sendTimestamps = new Map();  // 存储发送时间
    const retransmitCount = new Map();  // 存储重传次数
    const rttSamples = [];  // RTT样本
    let estimatedRTT = 500;  // 初始RTT估计值 (ms)
    let deviationRTT = 250;  // RTT偏差

    // 拥塞控制
    let cwnd = 1;  // 拥塞窗口
    let ssthresh = config.windowSize;  // 慢启动阈值
    let dupAckCount = 0;  // 重复ACK计数
    let lastAckSeq = -1;
    let inSlowStart = true;

    // 定时器
    let handshakeTimer = null;
    let retransmitTimer = null;
    let rttProbeTimer = null;
    let pacingTimer = null;

    // 发送统计
    let totalPacketsSent = 0;
    let totalPacketsRetransmitted = 0;

    // 1. 发送元数据握手
    const meta = JSON.stringify({
        fileName,
        fileSize,
        md5,
        config: config  // 发送配置给接收端
    });
    const metaBuf = Buffer.concat([Buffer.from([UDT_CMD_META]), Buffer.from(meta)]);

    mainWindow.webContents.send('transfer-log', `[UDT] 配置: 窗口=${config.windowSize}, 包大小=${config.packetSize}, RTO=${config.rto}ms`);

    const sendHandshake = () => {
        socket.send(metaBuf, port, ip);
    };

    handshakeTimer = setInterval(sendHandshake, 500);
    sendHandshake();

    // 监听响应
    socket.on('message', (msg) => {
        const type = msg[0];

        // 握手确认
        if (type === UDT_CMD_ACK && msg.length === 1) {
            clearInterval(handshakeTimer);
            mainWindow.webContents.send('file-send-start', {fileName, fileSize, md5});
            mainWindow.webContents.send('transfer-log', '[UDT] 握手成功，开始传输数据');
            startDataTransmission();
        }
        // 数据 ACK
        else if (type === UDT_CMD_ACK && msg.length === 5) {
            const ackedSeq = msg.readUInt32BE(1);

            // 处理重复ACK（快速重传）
            if (ackedSeq === lastAckSeq) {
                dupAckCount++;
                if (config.fastRetransmit && dupAckCount >= 3 && packetBuffer.has(ackedSeq + 1)) {
                    // 快速重传
                    mainWindow.webContents.send('transfer-log', `[UDT] 快速重传 seq=${ackedSeq + 1}`);
                    retransmitPacket(ackedSeq + 1);
                }
            } else {
                dupAckCount = 0;
                lastAckSeq = ackedSeq;
            }

            if (ackedSeq > confirmedSeq) {
                // 滑动窗口：释放已确认的包
                for (let s = confirmedSeq; s < ackedSeq; s++) {
                    if (packetBuffer.has(s)) {
                        packetBuffer.delete(s);
                        sendTimestamps.delete(s);
                        retransmitCount.delete(s);
                    }
                }
                confirmedSeq = ackedSeq;

                // 拥塞控制
                if (config.congestionControl) {
                    if (inSlowStart) {
                        cwnd = Math.min(cwnd + 1, config.windowSize);
                        if (cwnd >= ssthresh) {
                            inSlowStart = false;
                            mainWindow.webContents.send('transfer-log', `[UDT] 进入拥塞避免阶段`);
                        }
                    } else {
                        cwnd = Math.min(cwnd + 1.0 / cwnd, config.windowSize);
                    }
                }
            }

            // 计算RTT
            if (sendTimestamps.has(ackedSeq - 1)) {
                const rtt = Date.now() - sendTimestamps.get(ackedSeq - 1);
                updateRTTEstimate(rtt);
                sendTimestamps.delete(ackedSeq - 1);
            }

            // 检查是否完成
            if (confirmedSeq * config.packetSize >= fileSize && !isFinished) {
                sendFin();
            }
        }
        // RTT探测响应
        else if (type === UDT_CMD_RTT) {
            const probeSeq = msg.readUInt32BE(1);
            if (sendTimestamps.has(probeSeq)) {
                const rtt = Date.now() - sendTimestamps.get(probeSeq);
                updateRTTEstimate(rtt);
                sendTimestamps.delete(probeSeq);
            }
        }
    });

    // 更新RTT估计
    function updateRTTEstimate(sampleRtt) {
        rttSamples.push(sampleRtt);
        if (rttSamples.length > 10) rttSamples.shift();

        // Jacobson/Karels算法
        const alpha = 0.125;
        const beta = 0.25;
        estimatedRTT = (1 - alpha) * estimatedRTT + alpha * sampleRtt;
        deviationRTT = (1 - beta) * deviationRTT + beta * Math.abs(sampleRtt - estimatedRTT);

        // 动态调整RTO
        config.rto = Math.max(estimatedRTT + 4 * deviationRTT, 200);
    }

    // 发送RTT探测包
    function sendRttProbe() {
        if (isFinished) return;

        const probeSeq = confirmedSeq;
        const probeBuf = Buffer.alloc(5);
        probeBuf[0] = UDT_CMD_RTT;
        probeBuf.writeUInt32BE(probeSeq, 1);

        socket.send(probeBuf, port, ip);
        sendTimestamps.set(probeSeq, Date.now());

        rttProbeTimer = setTimeout(sendRttProbe, 5000);
    }

    // 重传单个包
    function retransmitPacket(seq) {
        if (!packetBuffer.has(seq) || isFinished) return;

        const count = retransmitCount.get(seq) || 0;
        if (count >= config.maxRetransmit) {
            mainWindow.webContents.send('file-send-error', {error: `包${seq}达到最大重传次数`});
            isFinished = true;
            return;
        }

        // 读取数据
        const position = seq * config.packetSize;
        if (position >= fileSize) return;

        const buffer = Buffer.alloc(config.packetSize);
        const readLen = fs.readSync(fd, buffer, 0, Math.min(config.packetSize, fileSize - position), position);

        const header = Buffer.alloc(5);
        header[0] = UDT_CMD_DATA;
        header.writeUInt32BE(seq, 1);
        const packet = Buffer.concat([header, buffer.slice(0, readLen)]);

        socket.send(packet, port, ip);
        retransmitCount.set(seq, count + 1);
        sendTimestamps.set(seq, Date.now());
        totalPacketsRetransmitted++;

        // 拥塞控制：快速恢复
        if (config.congestionControl) {
            ssthresh = Math.max(Math.floor(cwnd / 2), 2);
            cwnd = ssthresh + 3;
            inSlowStart = false;
        }
    }

    // 重传检测定时器
    function startRetransmitTimer() {
        if (retransmitTimer) clearInterval(retransmitTimer);

        retransmitTimer = setInterval(() => {
            if (isFinished) {
                clearInterval(retransmitTimer);
                return;
            }

            const now = Date.now();
            for (const [seq, sendTime] of sendTimestamps.entries()) {
                if (now - sendTime > config.rto) {
                    mainWindow.webContents.send('transfer-log', `[UDT] 超时重传 seq=${seq}`);
                    retransmitPacket(seq);
                }
            }
        }, config.rto / 2);
    }

    // 发送数据包（带拥塞控制）
    function sendDataPacket(seq) {
        if (seq * config.packetSize >= fileSize || isFinished) return;

        // 检查拥塞窗口
        const packetsInFlight = seq - confirmedSeq;
        if (packetsInFlight >= cwnd) {
            return false; // 拥塞窗口已满
        }

        // 读取数据
        const position = seq * config.packetSize;
        const buffer = Buffer.alloc(config.packetSize);
        const readLen = fs.readSync(fd, buffer, 0, Math.min(config.packetSize, fileSize - position), position);

        // 构建包
        const header = Buffer.alloc(5);
        header[0] = UDT_CMD_DATA;
        header.writeUInt32BE(seq, 1);
        const packet = Buffer.concat([header, buffer.slice(0, readLen)]);

        // 发送
        socket.send(packet, port, ip);

        // 记录状态
        packetBuffer.set(seq, packet);
        sendTimestamps.set(seq, Date.now());
        retransmitCount.set(seq, 0);
        totalPacketsSent++;

        // 更新进度
        bytesSent = seq * config.packetSize + readLen;
        const now = Date.now();
        if (now - lastProgressTime >= 200) {
            const progress = (bytesSent / fileSize) * 100;
            const duration = (now - lastProgressTime) / 1000;
            const speed = duration > 0 ? (bytesSent - lastSentBytes) / duration : 0;

            mainWindow.webContents.send('file-send-progress', {
                sent: bytesSent,
                total: fileSize,
                progress: progress.toFixed(2),
                speed: (speed / (1024 * 1024)).toFixed(2),
                windowSize: cwnd,
                rtt: Math.round(estimatedRTT),
                lossRate: totalPacketsRetransmitted / totalPacketsSent * 100
            });

            lastProgressTime = now;
            lastSentBytes = bytesSent;
        }

        return true;
    }

    // 速率控制发送
    function startPacedTransmission() {
        let nextSeq = confirmedSeq;
        let lastSendTime = Date.now();

        function pacedSend() {
            if (isFinished) return;

            const now = Date.now();
            const elapsed = now - lastSendTime;

            // 计算允许发送的包数（基于带宽配置）
            const targetPacketsPerSecond = (config.bandwidth * 1024 * 1024 / 8) / config.packetSize;
            const maxPacketsThisCycle = Math.floor(targetPacketsPerSecond * elapsed / 1000);

            let packetsSentThisCycle = 0;

            // 发送数据包
            while (packetsSentThisCycle < maxPacketsThisCycle &&
            nextSeq - confirmedSeq < cwnd &&
            nextSeq * config.packetSize < fileSize) {

                if (sendDataPacket(nextSeq)) {
                    packetsSentThisCycle++;
                    nextSeq++;
                } else {
                    break; // 拥塞窗口已满
                }
            }

            lastSendTime = now;
            setTimeout(pacedSend, config.sendInterval);
        }

        pacedSend();
    }

    // 开始数据传输
    function startDataTransmission() {
        startRetransmitTimer();
        startPacedTransmission();
        sendRttProbe();

        mainWindow.webContents.send('transfer-log',
            `[UDT] 开始传输，拥塞控制: ${config.congestionControl ? '开启' : '关闭'}, 快速重传: ${config.fastRetransmit ? '开启' : '关闭'}`);
    }

    // 发送结束包
    function sendFin() {
        isFinished = true;

        const finBuf = Buffer.alloc(1);
        finBuf[0] = UDT_CMD_FIN;
        socket.send(finBuf, port, ip);

        // 清理资源
        clearInterval(retransmitTimer);
        clearTimeout(rttProbeTimer);

        // 等待最后的ACK
        setTimeout(() => {
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            const avgSpeed = (fileSize / duration) / (1024 * 1024);

            mainWindow.webContents.send('file-send-complete', {
                fileName,
                fileSize,
                md5,
                duration,
                protocol: 'UDT',
                stats: {
                    avgSpeed: avgSpeed.toFixed(2),
                    packetsSent: totalPacketsSent,
                    packetsRetransmitted: totalPacketsRetransmitted,
                    lossRate: totalPacketsRetransmitted / totalPacketsSent * 100,
                    finalWindowSize: cwnd,
                    finalRTT: Math.round(estimatedRTT)
                }
            });

            mainWindow.webContents.send('transfer-log',
                `[UDT] 传输完成: ${duration}s, 平均速度: ${avgSpeed.toFixed(2)} MB/s, 丢包率: ${(totalPacketsRetransmitted / totalPacketsSent * 100).toFixed(2)}%`);

            socket.close();
            fs.closeSync(fd);
        }, 1000);
    }

    // 错误处理
    socket.on('error', (err) => {
        mainWindow.webContents.send('file-send-error', {error: `UDT错误: ${err.message}`});
        isFinished = true;
        cleanup();
    });

    // 清理函数
    function cleanup() {
        clearInterval(handshakeTimer);
        clearInterval(retransmitTimer);
        clearTimeout(rttProbeTimer);
        if (socket) socket.close();
        if (fd) fs.closeSync(fd);
    }
}

// 在 main.js 中添加以下代码 (保持不变)
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