const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const net = require('net');
const iconv = require('iconv-lite');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
}

// === 工具函数：解决 Windows 命令行中文乱码 (主要用于 ARP) ===
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

// === 2. Ping 测试 (ICMP) - 修复中文解析和间隔问题 ===
let pingTimer = null;

ipcMain.on('net:ping-start', (event, config) => {
  if (pingTimer) clearInterval(pingTimer);

  const { target, interval, size } = config;
  const intervalMs = Math.max(100, interval * 1000);

  const logHeader = `开始 Ping ${target} (间隔: ${interval}s, 包大小: ${size} bytes)...\n`;
  mainWindow.webContents.send('ping-reply', logHeader);
  mainWindow.webContents.send('ping-reply', `[提示] 启用原生 Ping 命令，强制英文环境解析 TTL/时间，精确间隔 (${intervalMs}ms)。\n`);

  pingTimer = setInterval(() => {

    let command;
    let decode_encoding = 'utf8';

    if (os.platform() === 'win32') {
      // 核心修复: 强制使用 cmd.exe /C chcp 437 来确保英文输出 (Code Page 437 is US English)
      command = `cmd.exe /C "chcp 437 && ping -n 1 -l ${size} ${target}"`;
      decode_encoding = 'cp437'; // 必须使用 CP437 解码
    } else {
      // Linux/macOS
      command = `ping -c 1 -s ${size} ${target}`;
    }

    // Windows 上环境变量可能干扰 chcp 437 的效果，所以我们只在非 Windows 上设置。
    const env = os.platform() === 'win32' ? process.env : { ...process.env, LC_ALL: 'C', LANG: 'C' };

    // 必须使用 encoding: 'binary' 来捕获原始字节流
    exec(command, { encoding: 'binary', env, timeout: 5000 }, (err, stdout, stderr) => {
      let replyText;

      const outputBuffer = Buffer.from(stdout, 'binary');
      const errorBuffer = Buffer.from(stderr, 'binary');

      // 使用正确的编码进行解码
      const output = iconv.decode(outputBuffer, decode_encoding);
      const errorOutput = iconv.decode(errorBuffer, decode_encoding);

      if (err) {
        // 检查常见的超时/不可达错误（英文输出）
        if (output.includes('Request timed out') || output.includes('Destination host unreachable')) {
          replyText = `请求超时或目标不可达: ${target}\n`;
        } else {
          replyText = `Ping 发生错误: ${output || errorOutput || err.message}\n`;
        }
      } else {
        // === 时间解析修复 START ===
        const lessThanOneMatch = output.match(/time<1ms/i);
        const regularTimeMatch = output.match(/time=(\d+)ms/i);

        let time;
        if (lessThanOneMatch) {
          time = '<1ms'; // 匹配 time<1ms
        } else if (regularTimeMatch) {
          time = `${regularTimeMatch[1]}ms`; // 匹配 time=Xms
        } else {
          time = 'N/A'; // 其他未匹配情况
        }
        // === 时间解析修复 END ===

        // TTL 和 Bytes 解析保持不变
        const ttlMatch = output.match(/TTL=(\d+)/i);
        const bytesMatch = output.match(/Bytes=(\d+)|bytes=(\d+)/i);

        const ttl = ttlMatch ? ttlMatch[1] : 'N/A';
        const bytes = bytesMatch ? (bytesMatch[1] || bytesMatch[2] || size) : size;

        // 检查是否成功收到回复 (英文输出: 'Reply from' 或 'transmitted, 1 received')
        if (output.includes('Reply from') || output.includes('transmitted, 1 received')) {
          replyText = `来自 ${target} 的回复：字节=${bytes} 时间=${time} TTL=${ttl}\n`;
        } else {
          // 仍然失败或无法解析
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

// === 3. ARP 表查询 (保持不变) ===
ipcMain.handle('net:arp', async () => {
  return new Promise((resolve) => {
    exec('arp -a', { encoding: 'binary' }, (err, stdout, stderr) => {
      if (err) return resolve(`Error: ${decodeOutput(Buffer.from(stderr, 'binary'))}`);
      resolve(decodeOutput(Buffer.from(stdout, 'binary')));
    });
  });
});

// === 4. 吞吐量测试 (TCP Throughput) (保持不变) ===
let throughputServer = null;
let throughputSocket = null;

// 启动服务端
ipcMain.handle('net:tp-server', (event, port) => {
  return new Promise((resolve) => {
    if (throughputServer) throughputServer.close();

    throughputServer = net.createServer((socket) => {
      socket.on('data', () => {});
    });

    throughputServer.listen(port, '0.0.0.0', () => {
      resolve(`服务端已启动，监听端口: ${port}`);
    });

    throughputServer.on('error', (err) => {
      resolve(`启动失败: ${err.message}`);
    });
  });
});

// 启动客户端并开始测试
ipcMain.on('net:tp-client-start', (event, { ip, port }) => {
  throughputSocket = new net.Socket();
  const chunkSize = 64 * 1024;
  const buffer = Buffer.alloc(chunkSize, 'x');
  let bytesSent = 0;
  let lastCheck = Date.now();
  let testing = true;

  throughputSocket.connect(port, ip, () => {
    mainWindow.webContents.send('tp-log', `已连接到 ${ip}:${port}，开始发送数据...`);

    function write() {
      if (!testing) return;
      let ok = true;
      do {
        ok = throughputSocket.write(buffer);
        bytesSent += chunkSize;
      } while (ok && testing);

      if (testing) throughputSocket.once('drain', write);
    }
    write();

    const timer = setInterval(() => {
      if (!testing) {
        clearInterval(timer);
        return;
      }
      const now = Date.now();
      const duration = (now - lastCheck) / 1000;
      if (duration >= 1) {
        const speedMbps = ((bytesSent * 8) / (1024 * 1024)) / duration;
        mainWindow.webContents.send('tp-data', speedMbps.toFixed(2));
        bytesSent = 0;
        lastCheck = now;
      }
    }, 1000);
  });

  throughputSocket.on('error', (err) => {
    testing = false;
    mainWindow.webContents.send('tp-log', `连接错误: ${err.message}`);
  });

  ipcMain.once('net:tp-stop', () => {
    testing = false;
    if (throughputSocket) throughputSocket.end();
    mainWindow.webContents.send('tp-log', '测试已停止');
  });
});

app.whenReady().then(createWindow);