const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const iconv = require('iconv-lite');

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
            // Windows: 192.168.1.1    00-11-22-33-44-55
            // Linux/Mac: 192.168.1.1 ether 00:11:22:33:44:55
            const macMatch = line.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
            if (macMatch) {
              mac = macMatch[0].toUpperCase().replace(/-/g, ':');
              // 简化的厂商识别（基于MAC前缀）
              vendor = getVendorFromMAC(mac);
            }
            break;
          }
        }
      }

      // 获取主机名（可选，可能较慢）
      // 这里简化处理，不进行DNS反向解析
      resolve({ mac, vendor, hostname: '' });
    });
  });
}

// 简化的厂商识别（基于MAC地址前缀）
function getVendorFromMAC(mac) {
  const prefix = mac.substring(0, 8).replace(/:/g, '').toUpperCase();

  const vendors = {
    '001122': 'CIMSYS Inc',
    '0050F2': 'Microsoft',
    '00155D': 'Microsoft',
    '000C29': 'VMware',
    '005056': 'VMware',
    '0A0027': 'VirtualBox',
    '080027': 'VirtualBox',
    '001DD8': 'Hewlett Packard',
    '001E68': 'Hewlett Packard',
    '7054D9': 'Apple',
    '001451': 'Apple',
    'D89695': 'Apple',
    '8863DF': 'Apple',
    'F0D1A9': 'Apple',
    '3C0754': 'Apple',
    '44D884': 'Apple',
    '001C42': 'Parallels',
    '000D3A': 'D-Link',
    'B0C090': 'Intel',
    '000E0C': 'Intel',
    'AC220B': 'Intel',
    'F4B301': 'Realtek',
    '001FC6': 'Realtek',
    '00E04C': 'Realtek',
  };

  for (const [key, value] of Object.entries(vendors)) {
    if (prefix.startsWith(key)) {
      return value;
    }
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

    // 计算网段
    const range = calculateNetworkRange(ip, netmask);
    const ipList = generateIPList(range.networkParts, range.broadcastParts);

    mainWindow.webContents.send('scan-status', {
      status: 'scanning',
      message: `开始扫描 ${ipList.length} 个IP地址...`,
      total: ipList.length,
      current: 0
    });

    // 批量扫描（并发10个）
    const batchSize = 10;
    const results = [];

    for (let i = 0; i < ipList.length; i += batchSize) {
      const batch = ipList.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(quickPing));

      // 只处理在线设备
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

          // 立即发送发现的设备
          mainWindow.webContents.send('scan-device-found', {
            ip: result.ip,
            time: result.time,
            mac: details.mac,
            vendor: details.vendor
          });
        }
      }

      // 更新进度
      mainWindow.webContents.send('scan-status', {
        status: 'scanning',
        message: `扫描中... ${Math.min(i + batchSize, ipList.length)}/${ipList.length}`,
        total: ipList.length,
        current: Math.min(i + batchSize, ipList.length),
        found: results.length
      });
    }

    // 扫描完成
    mainWindow.webContents.send('scan-status', {
      status: 'completed',
      message: `扫描完成！发现 ${results.length} 台在线设备`,
      total: ipList.length,
      current: ipList.length,
      found: results.length,
      devices: results
    });

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

    // 【核心】每 1 秒计算一次原始速度
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
    // 发送原始的 1 秒速率
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

app.whenReady().then(createWindow);