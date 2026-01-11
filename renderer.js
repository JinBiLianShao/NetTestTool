console.log('renderer.js 加载完成');
// 全局变量
let pingChart, speedChart;
let isPinging = false;
let isScanning = false;
let isClientRunning = false;
let isServerRunning = false;
let isTransferServerRunning = false;
let selectedFilePath = null;

// Ping统计数据
let pingStats = {
    sent: 0,
    received: 0,
    times: [],
    lastUpdateTime: Date.now()
};

// 扫描统计数据
let scanDevices = [];

// 吞吐量统计数据
let speedHistory = [];
let peakSpeed = 0;
let testStartTime = null;
let durationTimer = null;

// 文件传输数据
let transferHistory = [];
let currentTransfer = null;

// 配置常量
const PING_CHART_MAX_POINTS = 50;
const SPEED_CHART_MAX_POINTS = 30;
const SMOOTHING_WINDOW = 5;

// ==================== Tab切换 ====================
// 确保切换选项卡时重新初始化
function showTab(id, element) {
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav li').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    if (element) element.classList.add('active');

    if (id === 'info') loadInterfaces();
    if (id === 'scan') loadScanInterfaces();
    if (id === 'throughput') initThroughputTab();
    if (id === 'transfer') {
        console.log('切换到文件传输选项卡');
        // 延迟一点确保DOM已更新
        setTimeout(() => {
            initTransferTab();
            toggleUdtConfig();
        }, 50);
    }
}

// ==================== 1. 网络信息 ====================
async function loadInterfaces() {
    const list = document.getElementById('interface-list');
    list.innerHTML = '<div style="grid-column: 1/-1; text-align: center;"><div class="loading"></div></div>';

    try {
        const interfaces = await window.api.getInterfaces();
        list.innerHTML = interfaces.map(iface => `
            <div class="card">
                <h3>${iface.name}</h3>
                <p><strong>IP:</strong> <span>${iface.ip}</span></p>
                <p><strong>MAC:</strong> <span>${iface.mac}</span></p>
                <p><strong>掩码:</strong> <span>${iface.netmask}</span></p>
            </div>
        `).join('');
    } catch (error) {
        list.innerHTML = '<p style="color: var(--danger);">加载失败: ' + error.message + '</p>';
    }
}

// ==================== 2. Ping测试 ====================
function togglePing() {
    const btn = event.currentTarget;
    const target = document.getElementById('ping-target').value.trim();
    const interval = parseFloat(document.getElementById('ping-interval').value) || 1;
    const size = parseInt(document.getElementById('ping-size').value) || 32;

    if (!target) {
        alert('请输入目标地址!');
        return;
    }

    if (!isPinging) {
        // 重置统计数据
        pingStats = { sent: 0, received: 0, times: [], lastUpdateTime: Date.now() };
        updatePingStats();

        // 重置图表
        pingChart.data.labels = [];
        pingChart.data.datasets[0].data = [];
        pingChart.update('none');

        // 清空输出
        document.getElementById('ping-output').textContent = `开始 Ping ${target}...\n`;

        // 启动Ping
        window.api.startPing({ target, interval, size });
        btn.textContent = '停止 Ping';
        btn.style.background = 'linear-gradient(135deg, var(--danger) 0%, #c0392b 100%)';
        isPinging = true;
    } else {
        window.api.stopPing();
        btn.textContent = '开始 Ping';
        btn.style.background = '';
        isPinging = false;
    }
}

// 处理Ping响应
window.api.onPingReply((text) => {
    const out = document.getElementById('ping-output');
    out.textContent += text;
    out.scrollTop = out.scrollHeight;

    // 更新统计
    const now = Date.now();
    if (now - pingStats.lastUpdateTime < 100) return;
    pingStats.lastUpdateTime = now;

    pingStats.sent++;

    if (text.includes('回复') || text.includes('Reply from')) {
        pingStats.received++;

        // 提取延迟时间
        const timeMatch = text.match(/时间=(\d+)ms|time=(\d+)ms|time<1ms/i);
        if (timeMatch) {
            let time;
            if (text.includes('time<1ms')) {
                time = 0.5;
            } else {
                time = parseInt(timeMatch[1] || timeMatch[2]);
            }

            pingStats.times.push(time);

            // 更新图表
            if (pingChart.data.labels.length >= PING_CHART_MAX_POINTS) {
                pingChart.data.labels.shift();
                pingChart.data.datasets[0].data.shift();
            }

            pingChart.data.labels.push(pingStats.sent);
            pingChart.data.datasets[0].data.push(time);
            pingChart.update('none');
        }
    }

    updatePingStats();
});

// 更新Ping统计卡片
function updatePingStats() {
    document.getElementById('ping-sent').textContent = pingStats.sent;
    document.getElementById('ping-received').textContent = pingStats.received;

    const lossRate = pingStats.sent > 0
        ? ((1 - pingStats.received / pingStats.sent) * 100).toFixed(1)
        : 0;
    document.getElementById('ping-loss').textContent = lossRate + '%';

    const avgTime = pingStats.times.length > 0
        ? (pingStats.times.reduce((a, b) => a + b, 0) / pingStats.times.length).toFixed(1)
        : 0;
    document.getElementById('ping-avg').textContent = avgTime + 'ms';
}

// ==================== 3. ARP表 ====================
async function refreshArp() {
    const out = document.getElementById('arp-output');
    out.textContent = '正在读取 ARP 表...';
    try {
        const result = await window.api.getArp();
        out.textContent = result;
    } catch (error) {
        out.textContent = '读取失败: ' + error.message;
    }
}

// ==================== 4. 网段扫描 ====================
async function loadScanInterfaces() {
    const select = document.getElementById('scan-interface');
    try {
        const interfaces = await window.api.getInterfaces();
        select.innerHTML = interfaces.map(iface =>
            `<option value="${iface.ip}|${iface.netmask}">${iface.name} (${iface.ip})</option>`
        ).join('');
    } catch (error) {
        select.innerHTML = '<option value="">加载失败</option>';
    }
}

function toggleScan() {
    const btn = document.getElementById('btn-scan');
    const select = document.getElementById('scan-interface');

    if (!isScanning) {
        const value = select.value;
        if (!value) {
            alert('请选择网络接口!');
            return;
        }

        const [ip, netmask] = value.split('|');

        // 重置数据
        scanDevices = [];
        updateScanStats(0, 0, 0);

        // 清空设备列表
        const deviceList = document.getElementById('device-list');
        deviceList.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">扫描中...</td></tr>';

        // 显示进度条
        document.getElementById('scan-progress').style.display = 'block';

        // 开始扫描
        window.api.startScan({ ip, netmask });
        btn.textContent = '停止扫描';
        btn.style.background = 'linear-gradient(135deg, var(--danger) 0%, #c0392b 100%)';
        isScanning = true;
    } else {
        window.api.stopScan();
        btn.textContent = '开始扫描';
        btn.style.background = '';
        isScanning = false;
    }
}

window.api.onScanStatus((data) => {
    const { status, message, total, current, found } = data;

    document.getElementById('scan-progress-text').textContent = message || '扫描中...';

    const statusMap = {
        calculating: '计算中',
        scanning: '扫描中',
        completed: '完成',
        stopped: '已停止',
        error: '错误'
    };
    document.getElementById('scan-status-text').textContent = statusMap[status] || '就绪';

    if (total !== undefined && current !== undefined) {
        updateScanStats(total, current, found || 0);

        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        document.getElementById('scan-progress-percent').textContent = percent + '%';
        document.getElementById('scan-progress-bar').style.width = percent + '%';
    }

    if (status === 'completed' || status === 'stopped' || status === 'error') {
        isScanning = false;
        const btn = document.getElementById('btn-scan');
        btn.textContent = '开始扫描';
        btn.style.background = '';

        setTimeout(() => {
            document.getElementById('scan-progress').style.display = 'none';
        }, 3000);

        if (scanDevices.length === 0) {
            const deviceList = document.getElementById('device-list');
            deviceList.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 40px;">未发现在线设备</td></tr>';
        }
    }

    if (status === 'error' && data.error) {
        alert('扫描错误: ' + data.error);
    }
});

window.api.onScanDeviceFound((device) => {
    scanDevices.push(device);
    addDeviceToTable(device, scanDevices.length);
    updateDeviceCount();
});

function addDeviceToTable(device, index) {
    const deviceList = document.getElementById('device-list');

    if (index === 1) {
        deviceList.innerHTML = '';
    }

    const row = document.createElement('tr');
    row.className = 'new-device';
    row.innerHTML = `
        <td class="device-index">${index}</td>
        <td class="device-ip">${device.ip}</td>
        <td class="device-mac">${device.mac}</td>
        <td class="device-vendor">${device.vendor}</td>
        <td class="device-time">${device.time}</td>
        <td>
            <button class="device-action-btn" onclick="pingDevice('${device.ip}')">Ping</button>
        </td>
    `;

    deviceList.appendChild(row);
}

function updateScanStats(total, current, found) {
    document.getElementById('scan-total').textContent = total;
    document.getElementById('scan-current').textContent = current;
    document.getElementById('scan-found').textContent = found;
}

function updateDeviceCount() {
    document.getElementById('device-count').textContent = scanDevices.length;
}

function pingDevice(ip) {
    showTab('ping');
    document.getElementById('ping-target').value = ip;
}

function exportDeviceList() {
    if (scanDevices.length === 0) {
        alert('没有可导出的设备!');
        return;
    }

    const header = 'IP地址,MAC地址,厂商,响应时间\n';
    const rows = scanDevices.map(d =>
        `${d.ip},${d.mac},${d.vendor},${d.time}`
    ).join('\n');

    const csv = header + rows;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `network_scan_${new Date().getTime()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

// ==================== 5. 吞吐量测试 ====================
function initThroughputTab() {
    // 初始化吞吐量选项卡
    const protocolSelect = document.getElementById('tp-client-protocol');
    if (protocolSelect) {
        protocolSelect.innerHTML = `
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="hpr-udp">HPR-UDP (高性能)</option>
        `;
        toggleUdpConfig();
    }
}

function toggleUdpConfig() {
    const protocol = document.getElementById('tp-client-protocol').value;
    const configDiv = document.getElementById('udp-config');
    if (configDiv) {
        configDiv.style.display = protocol === 'udp' ? 'block' : 'none';
    }
}

async function startServer() {
    if (isServerRunning) return;

    const protocol = document.getElementById('tp-server-protocol').value;
    const statusEl = document.getElementById('server-status');
    const indicator = statusEl.querySelector('.status-indicator');

    try {
        const res = await window.api.startServer({ port: 5201, protocol });

        const isSuccess = !res.includes('失败');
        indicator.className = `status-indicator ${isSuccess ? 'active' : 'inactive'}`;
        statusEl.innerHTML = `<span class="status-indicator ${isSuccess ? 'active' : 'inactive'}"></span>${res}`;

        isServerRunning = isSuccess;

        if (isSuccess) {
            speedHistory = [];
            peakSpeed = 0;
            resetThroughputStats();
        }
    } catch (error) {
        indicator.className = 'status-indicator inactive';
        statusEl.innerHTML = `<span class="status-indicator inactive"></span>启动失败: ${error.message}`;
    }
}

function toggleClient() {
    const btn = document.getElementById('btn-tp-client');
    const ip = document.getElementById('tp-ip').value.trim();
    const protocol = document.getElementById('tp-client-protocol').value;

    if (!ip) {
        alert('请输入服务端IP地址!');
        return;
    }

    if (!isClientRunning) {
        // 重置数据
        speedHistory = [];
        peakSpeed = 0;
        testStartTime = Date.now();
        resetThroughputStats();

        // 构建配置
        const config = { ip, port: 5201, protocol };
        if (protocol === 'udp' || protocol === 'hpr-udp') {
            config.bandwidth = parseFloat(document.getElementById('tp-udp-bandwidth').value) || 10;
            config.size = parseInt(document.getElementById('tp-udp-size').value) || 1470;
        }

        window.api.startClient(config);
        btn.textContent = '停止测试';
        btn.style.background = 'linear-gradient(135deg, var(--danger) 0%, #c0392b 100%)';
        isClientRunning = true;

        // 重置图表
        speedChart.data.labels = [];
        speedChart.data.datasets[0].data = [];
        speedChart.update('none');

        // 启动计时器
        updateDuration();
    } else {
        window.api.stopClient();
        btn.textContent = '开始测试';
        btn.style.background = '';
        isClientRunning = false;

        if (durationTimer) {
            clearTimeout(durationTimer);
            durationTimer = null;
        }
    }
}

function updateDuration() {
    if (!isClientRunning) return;

    const duration = Math.floor((Date.now() - testStartTime) / 1000);
    document.getElementById('test-duration').textContent = duration + 's';

    durationTimer = setTimeout(updateDuration, 1000);
}

window.api.onTpData((data) => {
    const speed = parseFloat(data.currentSpeed);

    // 存储原始速度数据
    speedHistory.push(speed);
    if (speedHistory.length > SMOOTHING_WINDOW) {
        speedHistory.shift();
    }

    // 计算滑动平均值
    const sum = speedHistory.reduce((a, b) => a + b, 0);
    const smoothedSpeed = sum / speedHistory.length;

    // 更新峰值
    if (speed > peakSpeed) {
        peakSpeed = speed;
    }

    // 更新统计卡片
    document.getElementById('current-speed').textContent = data.currentSpeed + ' Mbps';
    document.getElementById('avg-speed').textContent = data.avgSpeed + ' Mbps';
    document.getElementById('peak-speed').textContent = data.peakSpeed + ' Mbps';
    document.getElementById('test-duration').textContent = data.duration + 's';

    // 更新图表
    const now = new Date().toLocaleTimeString();
    if (speedChart.data.labels.length >= SPEED_CHART_MAX_POINTS) {
        speedChart.data.labels.shift();
        speedChart.data.datasets[0].data.shift();
    }

    speedChart.data.labels.push(now);
    speedChart.data.datasets[0].data.push(smoothedSpeed.toFixed(2));
    speedChart.update('none');
});

window.api.onTpStats((stats) => {
    const logOutput = document.getElementById('tp-log-output');
    logOutput.textContent += `[HPR状态] RTT: ${stats.rtt}ms, Window: ${stats.window}/${stats.windowSize}, RTO: ${stats.rto}ms\n`;
    logOutput.scrollTop = logOutput.scrollHeight;
});

window.api.onTpLog((msg) => {
    const logOutput = document.getElementById('tp-log-output');
    logOutput.textContent += msg + '\n';
    logOutput.scrollTop = logOutput.scrollHeight;

    if (msg.includes('测试已停止') || msg.includes('错误')) {
        isClientRunning = false;
        isServerRunning = false;

        const clientBtn = document.getElementById('btn-tp-client');
        clientBtn.textContent = '开始测试';
        clientBtn.style.background = '';

        const statusEl = document.getElementById('server-status');
        const indicator = statusEl.querySelector('.status-indicator');
        indicator.className = 'status-indicator inactive';
        statusEl.innerHTML = '<span class="status-indicator inactive"></span>未启动';

        if (durationTimer) {
            clearTimeout(durationTimer);
            durationTimer = null;
        }

        speedHistory = [];
    }
});

function resetThroughputStats() {
    document.getElementById('current-speed').textContent = '0 Mbps';
    document.getElementById('avg-speed').textContent = '0 Mbps';
    document.getElementById('peak-speed').textContent = '0 Mbps';
    document.getElementById('test-duration').textContent = '0s';
}

// ==================== 6. 文件传输功能 ====================
function initTransferTab() {
    const protocolSelect = document.getElementById('transfer-protocol');
    if (!protocolSelect) {
        console.error('找不到 transfer-protocol 元素');
        return;
    }

    // 更新协议选项
    protocolSelect.innerHTML = `
        <option value="tcp">TCP (默认)</option>
        <option value="hpr-udp">HPR-UDP (高性能)</option>
    `;

    // 重新绑定事件
    protocolSelect.onchange = toggleUdtConfig;

    // 初始化显示状态
    toggleUdtConfig();
}

async function selectSavePath() {
    const path = await window.api.selectSavePath();
    if (path) {
        document.getElementById('transfer-save-path').value = path;
    }
}

async function startTransferServer() {
    if (isTransferServerRunning) {
        window.api.stopTransferServer();
        return;
    }

    const savePath = document.getElementById('transfer-save-path').value;
    if (!savePath) {
        alert('请先选择保存路径！');
        return;
    }

    const statusEl = document.getElementById('transfer-server-status');
    const indicator = statusEl.querySelector('.status-indicator');

    try {
        const res = await window.api.startTransferServer({ port: 5202, savePath });

        const isSuccess = !res.includes('失败');
        indicator.className = `status-indicator ${isSuccess ? 'active' : 'inactive'}`;
        statusEl.innerHTML = `<span class="status-indicator ${isSuccess ? 'active' : 'inactive'}"></span>${res}`;

        isTransferServerRunning = isSuccess;

        if (isSuccess) {
            logTransfer('📥 接收服务已启动，等待文件...');
        }
    } catch (error) {
        indicator.className = 'status-indicator inactive';
        statusEl.innerHTML = `<span class="status-indicator inactive"></span>启动失败: ${error.message}`;
        logTransfer('❌ 启动失败: ' + error.message);
    }
}

async function triggerFileSelect() {
    const fileInfo = await window.api.selectSendFile();
    if (fileInfo) {
        selectedFilePath = fileInfo.path;
        document.getElementById('transfer-file-display').value = fileInfo.name;

        const sizeInMB = (fileInfo.size / (1024 * 1024)).toFixed(2);
        document.getElementById('current-file').textContent = fileInfo.name;
        document.getElementById('file-size').textContent = sizeInMB + ' MB';
    }
}

// 更新 toggleUdtConfig 函数
function toggleUdtConfig() {
    console.log('toggleUdtConfig 被调用');

    const protocolSelect = document.getElementById('transfer-protocol');
    if (!protocolSelect) {
        console.error('找不到 transfer-protocol 元素');
        return;
    }

    const protocol = protocolSelect.value;
    console.log('当前协议:', protocol);

    const udtConfig = document.getElementById('udt-config');
    if (!udtConfig) {
        console.error('找不到 udt-config 元素');
        return;
    }

    console.log('udt-config 显示状态:', protocol === 'hpr-udp' ? '显示' : '隐藏');
    udtConfig.style.display = protocol === 'hpr-udp' ? 'block' : 'none';
}

// 更新获取配置的函数
function getHprUdpConfig() {
    return {
        packetSize: parseInt(document.getElementById('udt-packet-size').value) || 8192,
        windowSize: parseInt(document.getElementById('udt-window-size').value) || 32768,
        rto: parseInt(document.getElementById('udt-rto').value) || 100
    };
}


function updateUdtConfigInfo() {
    const config = getHprUdpConfig();
    logTransfer(`HPR-UDP配置: 包大小=${config.packetSize}字节 | 窗口=${config.windowSize} | RTO=${config.rto}ms`);
}


// 发送文件函数更新
function sendFile() {
    const ip = document.getElementById('transfer-target-ip').value.trim();
    if (!ip) {
        alert('请输入目标IP地址！');
        return;
    }

    if (!selectedFilePath) {
        alert('请先选择要发送的文件！');
        return;
    }

    const protocol = document.getElementById('transfer-protocol').value;
    const config = {
        ip: ip,
        port: 5202,
        filePath: selectedFilePath,
        protocol: protocol === 'hpr-udp' ? 'hpr-udp' : 'tcp'
    };

    if (protocol === 'hpr-udp') {
        config.hprUdpConfig = getHprUdpConfig();
        updateUdtConfigInfo();
    }

    window.api.sendFile(config);

    // 显示进度条
    document.getElementById('transfer-progress').style.display = 'block';
    document.getElementById('transfer-progress-text').textContent = '正在发送...';
    document.getElementById('transfer-progress-percent').textContent = '0%';
    document.getElementById('transfer-progress-bar').style.width = '0%';
    document.getElementById('transfer-speed').textContent = '0 MB/s';
    document.getElementById('transfer-bytes').textContent = '0 B';
    document.getElementById('transfer-eta').textContent = '--:--';
}

function logTransfer(msg) {
    const logOutput = document.getElementById('transfer-log-output');
    const timestamp = new Date().toLocaleTimeString();
    logOutput.textContent += `[${timestamp}] ${msg}\n`;
    logOutput.scrollTop = logOutput.scrollHeight;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatETA(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '--:--';

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function addTransferHistory(record) {
    transferHistory.unshift(record);
    updateTransferHistoryTable();
}

function updateTransferHistoryTable() {
    const tbody = document.getElementById('transfer-history');
    document.getElementById('transfer-history-count').textContent = transferHistory.length;

    if (transferHistory.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 40px;">暂无传输记录</td></tr>';
        return;
    }

    tbody.innerHTML = transferHistory.map((record, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${record.type === 'send' ? '📤 发送' : '📥 接收'}</td>
            <td style="word-break: break-all;">${record.fileName}</td>
            <td>${formatFileSize(record.fileSize)}</td>
            <td style="font-family: 'Consolas', monospace;">${record.remoteIP}</td>
            <td><span style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 12px;">${record.protocol || 'TCP'}</span></td>
            <td>${record.duration}s</td>
            <td>
                <span style="color: ${record.success ? 'var(--success)' : 'var(--danger)'};">
                    ${record.success ? '✅ 成功' : '❌ 失败'}
                </span>
            </td>
            <td style="font-size: 12px;">${record.time}</td>
        </tr>
    `).join('');
}

function clearTransferHistory() {
    if (transferHistory.length === 0) return;

    if (confirm('确定要清空所有传输历史吗？')) {
        transferHistory = [];
        updateTransferHistoryTable();
        logTransfer('🗑️ 已清空传输历史');
    }
}

// ==================== 文件传输事件监听 ====================
window.api.onTransferLog((msg) => {
    logTransfer(msg);
});

window.api.onFileTransferStart((data) => {
    currentTransfer = {
        type: 'receive',
        fileName: data.fileName,
        fileSize: data.fileSize,
        sourceMD5: data.sourceMD5,
        startTime: Date.now()
    };

    document.getElementById('transfer-progress').style.display = 'block';
    document.getElementById('current-file').textContent = data.fileName;
    document.getElementById('file-size').textContent = formatFileSize(data.fileSize);
    document.getElementById('source-md5').textContent = data.sourceMD5;
    document.getElementById('received-md5').textContent = '计算中...';
    document.getElementById('md5-result').style.display = 'none';
});

window.api.onFileTransferProgress((data) => {
    const { received, total, progress, speed } = data;

    document.getElementById('transfer-progress-text').textContent = '正在接收...';
    document.getElementById('transfer-progress-percent').textContent = progress + '%';
    document.getElementById('transfer-progress-bar').style.width = progress + '%';
    document.getElementById('transfer-speed').textContent = speed + ' MB/s';
    document.getElementById('transfer-bytes').textContent = formatFileSize(received);
    document.getElementById('transfer-total').textContent = formatFileSize(total);

    const speedBytes = parseFloat(speed) * 1024 * 1024;
    const remainingBytes = total - received;
    const eta = speedBytes > 0 ? remainingBytes / speedBytes : 0;
    document.getElementById('transfer-eta').textContent = formatETA(eta);
});

window.api.onFileTransferComplete((data) => {
    const { fileName, fileSize, sourceMD5, receivedMD5, match, duration, protocol } = data;

    document.getElementById('transfer-progress-percent').textContent = '100%';
    document.getElementById('transfer-progress-bar').style.width = '100%';
    document.getElementById('transfer-progress-text').textContent = match ? '✅ 接收完成' : '⚠️ MD5校验失败';

    document.getElementById('received-md5').textContent = receivedMD5;

    const resultDiv = document.getElementById('md5-result');
    resultDiv.style.display = 'block';

    if (match) {
        resultDiv.style.background = 'linear-gradient(135deg, rgba(0, 242, 195, 0.2) 0%, rgba(0, 234, 255, 0.1) 100%)';
        resultDiv.style.color = 'var(--success)';
        resultDiv.style.border = '2px solid var(--success)';
        resultDiv.textContent = '✅ MD5校验通过 - 文件完整';
    } else {
        resultDiv.style.background = 'linear-gradient(135deg, rgba(255, 68, 68, 0.2) 0%, rgba(255, 107, 138, 0.1) 100%)';
        resultDiv.style.color = 'var(--danger)';
        resultDiv.style.border = '2px solid var(--danger)';
        resultDiv.textContent = '❌ MD5校验失败 - 文件可能损坏';
    }

    addTransferHistory({
        type: 'receive',
        fileName: fileName,
        fileSize: fileSize,
        remoteIP: document.getElementById('transfer-target-ip').value || 'Unknown',
        duration: duration,
        success: match,
        time: new Date().toLocaleString(),
        protocol: protocol
    });

    setTimeout(() => {
        document.getElementById('transfer-progress').style.display = 'none';
    }, 3000);
});

window.api.onFileTransferError((data) => {
    document.getElementById('transfer-progress-text').textContent = '❌ 接收失败';
    document.getElementById('transfer-progress-bar').style.background = 'var(--danger)';

    setTimeout(() => {
        document.getElementById('transfer-progress').style.display = 'none';
        document.getElementById('transfer-progress-bar').style.background = '';
    }, 3000);
});

window.api.onFileSendStart((data) => {
    console.log('onFileSendStart 事件触发:', data);
    currentTransfer = {
        type: 'send',
        fileName: data.fileName,
        fileSize: data.fileSize,
        md5: data.md5,
        startTime: Date.now()
    };

    document.getElementById('current-file').textContent = data.fileName;
    document.getElementById('file-size').textContent = formatFileSize(data.fileSize);
    document.getElementById('source-md5').textContent = data.md5;
    document.getElementById('received-md5').textContent = '--';
    document.getElementById('md5-result').style.display = 'none';
});

window.api.onFileSendProgress((data) => {
    console.log('onFileSendProgress 事件触发:', data);
    const { sent, total, progress, speed } = data;

    document.getElementById('transfer-progress-text').textContent = '正在发送...';
    document.getElementById('transfer-progress-percent').textContent = progress + '%';
    document.getElementById('transfer-progress-bar').style.width = progress + '%';
    document.getElementById('transfer-speed').textContent = speed + ' MB/s';
    document.getElementById('transfer-bytes').textContent = formatFileSize(sent);
    document.getElementById('transfer-total').textContent = formatFileSize(total);

    const speedBytes = parseFloat(speed) * 1024 * 1024;
    const remainingBytes = total - sent;
    const eta = speedBytes > 0 ? remainingBytes / speedBytes : 0;
    document.getElementById('transfer-eta').textContent = formatETA(eta);
});

window.api.onFileSendComplete((data) => {
    console.log('onFileSendComplete 事件触发:', data);
    const { fileName, fileSize, md5, duration, protocol } = data;

    document.getElementById('transfer-progress-percent').textContent = '100%';
    document.getElementById('transfer-progress-bar').style.width = '100%';
    document.getElementById('transfer-progress-text').textContent = '✅ 发送完成';

    const resultDiv = document.getElementById('md5-result');
    resultDiv.style.display = 'block';
    resultDiv.style.background = 'linear-gradient(135deg, rgba(0, 242, 195, 0.2) 0%, rgba(0, 234, 255, 0.1) 100%)';
    resultDiv.style.color = 'var(--success)';
    resultDiv.style.border = '2px solid var(--success)';
    resultDiv.textContent = '✅ 文件发送成功 - 等待接收端校验';

    addTransferHistory({
        type: 'send',
        fileName: fileName,
        fileSize: fileSize,
        remoteIP: document.getElementById('transfer-target-ip').value,
        duration: duration,
        success: true,
        time: new Date().toLocaleString(),
        protocol: protocol
    });

    setTimeout(() => {
        document.getElementById('transfer-progress').style.display = 'none';
    }, 3000);
});

window.api.onFileSendError((data) => {
    document.getElementById('transfer-progress-text').textContent = '❌ 发送失败';
    document.getElementById('transfer-progress-bar').style.background = 'var(--danger)';

    const resultDiv = document.getElementById('md5-result');
    resultDiv.style.display = 'block';
    resultDiv.style.background = 'linear-gradient(135deg, rgba(255, 68, 68, 0.2) 0%, rgba(255, 107, 138, 0.1) 100%)';
    resultDiv.style.color = 'var(--danger)';
    resultDiv.style.border = '2px solid var(--danger)';
    resultDiv.textContent = '❌ 文件发送失败: ' + data.error;

    setTimeout(() => {
        document.getElementById('transfer-progress').style.display = 'none';
        document.getElementById('transfer-progress-bar').style.background = '';
    }, 3000);
});

// ==================== 图表初始化 ====================
function initCharts() {
    // Ping延迟图表
    const pingCtx = document.getElementById('pingChart').getContext('2d');
    pingChart = new Chart(pingCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: '延迟 (ms)',
                data: [],
                borderColor: '#00f2c3',
                backgroundColor: 'rgba(0, 242, 195, 0.1)',
                tension: 0.4,
                fill: true,
                pointRadius: 3,
                pointHoverRadius: 5,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#2a2a3e' },
                    ticks: { color: '#a0a0b0' }
                },
                x: {
                    display: false
                }
            },
            plugins: {
                legend: {
                    labels: {
                        color: '#e9ecef',
                        font: { size: 14, weight: '600' }
                    }
                }
            }
        }
    });

    // 速度图表
    const speedCtx = document.getElementById('speedChart').getContext('2d');
    speedChart = new Chart(speedCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: `带宽 (Mbps) - ${SMOOTHING_WINDOW}秒平均`,
                data: [],
                borderColor: '#e14eca',
                backgroundColor: 'rgba(225, 78, 202, 0.1)',
                tension: 0.4,
                fill: true,
                pointRadius: 3,
                pointHoverRadius: 5,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#2a2a3e' },
                    ticks: { color: '#a0a0b0' }
                },
                x: {
                    display: false
                }
            },
            plugins: {
                legend: {
                    labels: {
                        color: '#e9ecef',
                        font: { size: 14, weight: '600' }
                    }
                }
            }
        }
    });
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM 加载完成');

    loadInterfaces();
    loadScanInterfaces();
    initCharts();
    initThroughputTab();
    initTransferTab();

    // 确保协议选择器有事件监听
    const transferProtocol = document.getElementById('transfer-protocol');
    if (transferProtocol) {
        transferProtocol.addEventListener('change', toggleUdtConfig);
        console.log('已绑定 transfer-protocol change 事件');
    }

    // 测试：手动触发一次以初始化显示状态
    setTimeout(toggleUdtConfig, 100);
});

window.addEventListener('beforeunload', () => {
    if (isPinging) {
        window.api.stopPing();
    }
    if (isScanning) {
        window.api.stopScan();
    }
    if (isClientRunning) {
        window.api.stopClient();
    }
    if (durationTimer) {
        clearTimeout(durationTimer);
    }
});

// 添加键盘快捷键调试
document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+D 显示调试信息
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        console.log('=== 调试信息 ===');
        console.log('当前选项卡:', document.querySelector('.tab-pane.active').id);
        console.log('transfer-protocol:', document.getElementById('transfer-protocol')?.value);
        console.log('udt-config:', document.getElementById('udt-config')?.style.display);

        // 显示所有相关元素
        const elements = ['transfer-protocol', 'udt-config', 'transfer-target-ip'];
        elements.forEach(id => {
            const el = document.getElementById(id);
            console.log(`${id}:`, el ? '存在' : '不存在', el);
        });
    }
});