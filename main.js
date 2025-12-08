const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const os = require('os');
const net = require('net');
const iconv = require('iconv-lite'); // 必须安装: npm install iconv-lite

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

// === 工具函数：解决 Windows 命令行中文乱码 ===
function decodeOutput(data) {
  // Windows 中文版 CMD 通常是 CP936 (GBK)，Mac/Linux 是 UTF-8
  const isWin = os.platform() === 'win32';
  return isWin ? iconv.decode(data, 'cp936') : data.toString();
}

// === 1. 网络环境查询 (Interface Info) ===
ipcMain.handle('net:interfaces', () => {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 仅显示 IPv4 且非内部地址
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
let pingProcess = null;
ipcMain.on('net:ping-start', (event, target) => {
  if (pingProcess) pingProcess.kill(); // 防止多重开启

  const isWin = os.platform() === 'win32';
  const args = isWin ? ['-t', target] : ['-i', '1', target]; // -t: 持续 Ping
  
  pingProcess = spawn('ping', args);

  pingProcess.stdout.on('data', (data) => {
    const text = decodeOutput(data);
    mainWindow.webContents.send('ping-reply', text);
  });

  pingProcess.stderr.on('data', (data) => {
    mainWindow.webContents.send('ping-reply', `Error: ${decodeOutput(data)}`);
  });
  
  pingProcess.on('close', () => {
    mainWindow.webContents.send('ping-reply', '\n--- Ping 已停止 ---');
  });
});

ipcMain.on('net:ping-stop', () => {
  if (pingProcess) {
    pingProcess.kill();
    pingProcess = null;
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

// === 4. 吞吐量测试 (TCP Throughput) ===
let throughputServer = null;
let throughputSocket = null;

// 启动服务端
ipcMain.handle('net:tp-server', (event, port) => {
  return new Promise((resolve) => {
    if (throughputServer) throughputServer.close();
    
    throughputServer = net.createServer((socket) => {
      socket.on('data', () => {}); // 仅接收，不做处理，消耗带宽
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
  const chunkSize = 64 * 1024; // 64KB per chunk
  const buffer = Buffer.alloc(chunkSize, 'x');
  let bytesSent = 0;
  let lastCheck = Date.now();
  let testing = true;

  throughputSocket.connect(port, ip, () => {
    mainWindow.webContents.send('tp-log', `已连接到 ${ip}:${port}，开始发送数据...`);
    
    // 循环写入数据
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

    // 定时计算速度
    const timer = setInterval(() => {
      if (!testing) {
        clearInterval(timer);
        return;
      }
      const now = Date.now();
      const duration = (now - lastCheck) / 1000;
      if (duration >= 1) {
        const speedMbps = ((bytesSent * 8) / (1024 * 1024)) / duration; // Mbps
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

  // 监听前端停止指令
  ipcMain.once('net:tp-stop', () => {
    testing = false;
    if (throughputSocket) throughputSocket.end();
    mainWindow.webContents.send('tp-log', '测试已停止');
  });
});

app.whenReady().then(createWindow);