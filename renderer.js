// renderer.js - 完整版本 (支持 UDT)

// ==================== 全局变量 ====================
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
const PING_CHART_MAX_POINTS = 50;  // Ping图表最多显示50个点
const SPEED_CHART_MAX_POINTS = 30; // 速度图表最多显示30个点
const SMOOTHING_WINDOW = 5;        // 5秒滑动平均窗口

// ==================== Tab切换 ====================
function showTab(id) {
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav li').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    event.currentTarget.classList.add('active');

    if (id === 'info') loadInterfaces();
    if (id === 'scan') loadScanInterfaces();
    if (id === 'throughput') toggleUdpConfig();
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

    // 更新统计 - 节流处理,避免频繁更新DOM
    const now = Date.now();
    if (now - pingStats.lastUpdateTime < 100) return; // 100ms内只更新一次
    pingStats.lastUpdateTime = now;

    // 解析Ping结果
    pingStats.sent++;

    if (text.includes('回复') || text.includes('Reply from')) {
        pingStats.received++;

        // 提取延迟时间
        const timeMatch = text.match(/时间=(\d+)ms|time=(\d+)ms|time<1ms/i);
        if (timeMatch) {
            let time;
            if (text.includes('time<1ms')) {
                time = 0.5; // 小于1ms的用0.5表示
            } else {
                time = parseInt(timeMatch[1] || timeMatch[2]);
            }

            pingStats.times.push(time);

            // 更新图表 - 限制数据点数量
            if (pingChart.data.labels.length >= PING_CHART_MAX_POINTS) {
                pingChart.data.labels.shift();
                pingChart.data.datasets[0].data.shift();
            }

            pingChart.data.labels.push(pingStats.sent);
            pingChart.data.datasets[0].data.push(time);
            pingChart.update('none'); // 禁用动画提升性能
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

// 加载网络接口到下拉列表
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

// 开始/停止扫描
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

// 处理扫描状态更新
window.api.onScanStatus((data) => {
    const { status, message, total, current, found } = data;

    // 更新进度文本
    document.getElementById('scan-progress-text').textContent = message || '扫描中...';

    // 更新状态文本
    const statusMap = {
        calculating: '计算中',
        scanning: '扫描中',
        completed: '完成',
        stopped: '已停止',
        error: '错误'
    };
    document.getElementById('scan-status-text').textContent = statusMap[status] || '就绪';

    // 更新统计
    if (total !== undefined && current !== undefined) {
        updateScanStats(total, current, found || 0);

        // 更新进度条
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        document.getElementById('scan-progress-percent').textContent = percent + '%';
        document.getElementById('scan-progress-bar').style.width = percent + '%';
    }

    // 扫描完成或停止
    if (status === 'completed' || status === 'stopped' || status === 'error') {
        isScanning = false;
        const btn = document.getElementById('btn-scan');
        btn.textContent = '开始扫描';
        btn.style.background = '';

        // 3秒后隐藏进度条
        setTimeout(() => {
            document.getElementById('scan-progress').style.display = 'none';
        }, 3000);

        // 如果没有发现设备
        if (scanDevices.length === 0) {
            const deviceList = document.getElementById('device-list');
            deviceList.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 40px;">未发现在线设备</td></tr>';
        }
    }

    // 错误处理
    if (status === 'error' && data.error) {
        alert('扫描错误: ' + data.error);
    }
});

// 处理发现新设备
window.api.onScanDeviceFound((device) => {
    scanDevices.push(device);
    addDeviceToTable(device, scanDevices.length);
    updateDeviceCount();
});

// 添加设备到表格
function addDeviceToTable(device, index) {
    const deviceList = document.getElementById('device-list');

    // 如果是第一个设备，清空提示信息
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

// 更新扫描统计
function updateScanStats(total, current, found) {
    document.getElementById('scan-total').textContent = total;
    document.getElementById('scan-current').textContent = current;
    document.getElementById('scan-found').textContent = found;
}

// 更新设备计数
function updateDeviceCount() {
    document.getElementById('device-count').textContent = scanDevices.length;
}

// Ping单个设备
function pingDevice(ip) {
    showTab('ping');
    document.getElementById('ping-target').value = ip;
    // 不自动开始，让用户点击
}

// 导出设备列表
function exportDeviceList() {
    if (scanDevices.length === 0) {
        alert('没有可导出的设备!');
        return;
    }

    // 生成CSV内容
    const header = 'IP地址,MAC地址,厂商,响应时间\n';
    const rows = scanDevices.map(d =>
        `${d.ip},${d.mac},${d.vendor},${d.time}`
    ).join('\n');

    const csv = header + rows;

    // 创建下载链接
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `network_scan_${new Date().getTime()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

// ==================== 5. 吞吐量测试 ====================

// 切换UDP配置显示
function toggleUdpConfig() {
    const protocol = document.getElementById('tp-client-protocol').value;
    const configDiv = document.getElementById('udp-config');
    configDiv.style.display = protocol === 'udp' ? 'block' : 'none';
}

// 启动服务端
async function startServer() {
    if (isServerRunning) return;

    const protocol = document.getElementById('tp-server-protocol').value;
    const statusEl = document.getElementById('server-status');
    const indicator = statusEl.querySelector('.status-indicator');

    try {
        const res = await window.api.startServer({ port: 5201, protocol });

        // 更新状态显示
        const isSuccess = !res.includes('失败');
        indicator.className = `status-indicator ${isSuccess ? 'active' : 'inactive'}`;
        statusEl.innerHTML = `<span class="status-indicator ${isSuccess ? 'active' : 'inactive'}"></span>${res}`;

        isServerRunning = isSuccess;

        // 重置统计数据
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

// 启动/停止客户端
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
        if (protocol === 'udp') {
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

        // 停止计时器
        if (durationTimer) {
            clearTimeout(durationTimer);
            durationTimer = null;
        }
    }
}

// 更新测试时长
function updateDuration() {
    if (!isClientRunning) return;

    const duration = Math.floor((Date.now() - testStartTime) / 1000);
    document.getElementById('test-duration').textContent = duration + 's';

    durationTimer = setTimeout(updateDuration, 1000);
}

// 处理吞吐量数据
window.api.onTpData((rawSpeedMbps) => {
    const speed = parseFloat(rawSpeedMbps);

    // 存储原始速度数据
    speedHistory.push(speed);
    if (speedHistory.length > SMOOTHING_WINDOW) {
        speedHistory.shift();
    }

    // 计算滑动平均值(平滑后的速度)
    const sum = speedHistory.reduce((a, b) => a + b, 0);
    const smoothedSpeed = sum / speedHistory.length;

    // 更新峰值
    if (speed > peakSpeed) {
        peakSpeed = speed;
    }

    // 计算平均速度(所有历史数据)
    const totalHistory = speedChart.data.datasets[0].data;
    const avgSpeed = totalHistory.length > 0
        ? totalHistory.reduce((a, b) => a + parseFloat(b), 0) / totalHistory.length
        : 0;

    // 更新统计卡片
    document.getElementById('current-speed').textContent = speed.toFixed(2) + ' Mbps';
    document.getElementById('avg-speed').textContent = avgSpeed.toFixed(2) + ' Mbps';
    document.getElementById('peak-speed').textContent = peakSpeed.toFixed(2) + ' Mbps';

    // 更新图表 - 限制数据点数量
    const now = new Date().toLocaleTimeString();
    if (speedChart.data.labels.length >= SPEED_CHART_MAX_POINTS) {
        speedChart.data.labels.shift();
        speedChart.data.datasets[0].data.shift();
    }

    speedChart.data.labels.push(now);
    speedChart.data.datasets[0].data.push(smoothedSpeed.toFixed(2));
    speedChart.update('none'); // 禁用动画提升性能
});

// 处理日志消息
window.api.onTpLog((msg) => {
    const logOutput = document.getElementById('tp-log-output');
    logOutput.textContent = msg;

    // 处理停止消息
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

        // 停止计时器
        if (durationTimer) {
            clearTimeout(durationTimer);
            durationTimer = null;
        }

        // 清空历史记录
        speedHistory = [];
    }
});

// 重置吞吐量统计
function resetThroughputStats() {
    document.getElementById('current-speed').textContent = '0 Mbps';
    document.getElementById('avg-speed').textContent = '0 Mbps';
    document.getElementById('peak-speed').textContent = '0 Mbps';
    document.getElementById('test-duration').textContent = '0s';
}

// ==================== 6. 文件传输功能 ====================

// 选择保存路径
async function selectSavePath() {
    const path = await window.api.selectSavePath();
    if (path) {
        document.getElementById('transfer-save-path').value = path;
    }
}

// 处理文件选择
function handleFileSelect() {
    const fileInput = document.getElementById('transfer-file');
    const file = fileInput.files[0];

    if (file) {
        selectedFilePath = file.path;
        document.getElementById('transfer-file-display').value = file.name;

        // 更新统计信息
        const sizeInMB = (file.size / (1024 * 1024)).toFixed(2);
        document.getElementById('current-file').textContent = file.name;
        document.getElementById('file-size').textContent = sizeInMB + ' MB';
    }
}

// 启动接收服务器
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

// 发送文件
// 1. 定义新的选择函数
async function triggerFileSelect() {
    const fileInfo = await window.api.selectSendFile();
    if (fileInfo) {
        selectedFilePath = fileInfo.path;
        document.getElementById('transfer-file-display').value = fileInfo.name;

        // 更新界面显示
        const sizeInMB = (fileInfo.size / (1024 * 1024)).toFixed(2);
        document.getElementById('current-file').textContent = fileInfo.name;
        document.getElementById('file-size').textContent = sizeInMB + ' MB';
    }
}

// 2. 确保 sendFile 函数使用的是正确的变量

// ==================== UDT配置相关函数 ====================

// 切换UDT配置显示
function toggleUdtConfig() {
    const protocol = document.getElementById('transfer-protocol').value;
    const udtConfig = document.getElementById('udt-config');
    udtConfig.style.display = protocol === 'udt' ? 'block' : 'none';
}

// 获取UDT配置参数
function getUdtConfig() {
    return {
        windowSize: parseInt(document.getElementById('udt-window-size').value) || 32,
        packetSize: parseInt(document.getElementById('udt-packet-size').value) || 1400,
        rto: parseInt(document.getElementById('udt-rto').value) || 1000,
        maxRetransmit: parseInt(document.getElementById('udt-max-retrans').value) || 5,
        sendInterval: parseInt(document.getElementById('udt-send-interval').value) || 10,
        bandwidth: parseInt(document.getElementById('udt-bandwidth').value) || 100,
        fastRetransmit: document.getElementById('udt-fast-retransmit').checked,
        congestionControl: document.getElementById('udt-congestion-control').checked
    };
}

// 更新UDT配置说明
function updateUdtConfigInfo() {
    const config = getUdtConfig();
    logTransfer(`UDT配置: 窗口=${config.windowSize} | 包大小=${config.packetSize}字节 | RTO=${config.rto}ms | 最大重传=${config.maxRetransmit}`);
}
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
        protocol: protocol
    };

    // 如果是UDT协议，添加配置参数
    if (protocol === 'udt') {
        config.udtConfig = getUdtConfig();
        updateUdtConfigInfo();
    }

    window.api.sendFile(config);

    document.getElementById('transfer-progress').style.display = 'block';
    document.getElementById('transfer-progress-text').textContent = '正在发送...';
}

// 在初始化函数中添加


// 日志输出
function logTransfer(msg) {
    const logOutput = document.getElementById('transfer-log-output');
    const timestamp = new Date().toLocaleTimeString();
    logOutput.textContent += `[${timestamp}] ${msg}\n`;
    logOutput.scrollTop = logOutput.scrollHeight;
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// 格式化剩余时间
function formatETA(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '--:--';

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// 添加传输历史记录
function addTransferHistory(record) {
    transferHistory.unshift(record);
    updateTransferHistoryTable();
}

// 更新传输历史表格
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

// 清空传输历史
function clearTransferHistory() {
    if (transferHistory.length === 0) return;

    if (confirm('确定要清空所有传输历史吗？')) {
        transferHistory = [];
        updateTransferHistoryTable();
        logTransfer('🗑️ 已清空传输历史');
    }
}

// ==================== 文件传输事件监听 ====================

// 监听日志消息
window.api.onTransferLog((msg) => {
    logTransfer(msg);
});

// 接收端 - 文件开始接收
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

// 接收端 - 进度更新
window.api.onFileTransferProgress((data) => {
    const { received, total, progress, speed } = data;

    document.getElementById('transfer-progress-text').textContent = '正在接收...';
    document.getElementById('transfer-progress-percent').textContent = progress + '%';
    document.getElementById('transfer-progress-bar').style.width = progress + '%';
    document.getElementById('transfer-speed').textContent = speed + ' MB/s';
    document.getElementById('transfer-bytes').textContent = formatFileSize(received);
    document.getElementById('transfer-total').textContent = formatFileSize(total);

    // 计算预计剩余时间
    const speedBytes = parseFloat(speed) * 1024 * 1024;
    const remainingBytes = total - received;
    const eta = speedBytes > 0 ? remainingBytes / speedBytes : 0;
    document.getElementById('transfer-eta').textContent = formatETA(eta);
});

// 接收端 - 接收完成
window.api.onFileTransferComplete((data) => {
    const { fileName, fileSize, sourceMD5, receivedMD5, match, duration, protocol } = data;

    // 更新进度为100%
    document.getElementById('transfer-progress-percent').textContent = '100%';
    document.getElementById('transfer-progress-bar').style.width = '100%';
    document.getElementById('transfer-progress-text').textContent = match ? '✅ 接收完成' : '⚠️ MD5校验失败';

    // 显示MD5值
    document.getElementById('received-md5').textContent = receivedMD5;

    // 显示MD5校验结果
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

    // 添加到历史记录
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

    // 3秒后隐藏进度条
    setTimeout(() => {
        document.getElementById('transfer-progress').style.display = 'none';
    }, 3000);
});

// 接收端 - 错误
window.api.onFileTransferError((data) => {
    document.getElementById('transfer-progress-text').textContent = '❌ 接收失败';
    document.getElementById('transfer-progress-bar').style.background = 'var(--danger)';

    setTimeout(() => {
        document.getElementById('transfer-progress').style.display = 'none';
        document.getElementById('transfer-progress-bar').style.background = '';
    }, 3000);
});

// 发送端 - 开始发送
window.api.onFileSendStart((data) => {
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

// 发送端 - 进度更新
window.api.onFileSendProgress((data) => {
    const { sent, total, progress, speed } = data;

    document.getElementById('transfer-progress-text').textContent = '正在发送...';
    document.getElementById('transfer-progress-percent').textContent = progress + '%';
    document.getElementById('transfer-progress-bar').style.width = progress + '%';
    document.getElementById('transfer-speed').textContent = speed + ' MB/s';
    document.getElementById('transfer-bytes').textContent = formatFileSize(sent);
    document.getElementById('transfer-total').textContent = formatFileSize(total);

    // 计算预计剩余时间
    const speedBytes = parseFloat(speed) * 1024 * 1024;
    const remainingBytes = total - sent;
    const eta = speedBytes > 0 ? remainingBytes / speedBytes : 0;
    document.getElementById('transfer-eta').textContent = formatETA(eta);
});

// 发送端 - 发送完成
window.api.onFileSendComplete((data) => {
    const { fileName, fileSize, md5, duration, protocol } = data;

    document.getElementById('transfer-progress-percent').textContent = '100%';
    document.getElementById('transfer-progress-bar').style.width = '100%';
    document.getElementById('transfer-progress-text').textContent = '✅ 发送完成';

    // 显示成功消息
    const resultDiv = document.getElementById('md5-result');
    resultDiv.style.display = 'block';
    resultDiv.style.background = 'linear-gradient(135deg, rgba(0, 242, 195, 0.2) 0%, rgba(0, 234, 255, 0.1) 100%)';
    resultDiv.style.color = 'var(--success)';
    resultDiv.style.border = '2px solid var(--success)';
    resultDiv.textContent = '✅ 文件发送成功 - 等待接收端校验';

    // 添加到历史记录
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

    // 3秒后隐藏进度条
    setTimeout(() => {
        document.getElementById('transfer-progress').style.display = 'none';
    }, 3000);
});

// 发送端 - 错误
window.api.onFileSendError((data) => {
    document.getElementById('transfer-progress-text').textContent = '❌ 发送失败';
    document.getElementById('transfer-progress-bar').style.background = 'var(--danger)';

    // 显示错误消息
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
            animation: false, // 禁用动画提升性能
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
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
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
            animation: false, // 禁用动画提升性能
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
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    loadInterfaces();
    loadScanInterfaces();
    initCharts();
    toggleUdtConfig(); // 添加这一行

    // 监听UDT配置变化
    document.getElementById('udt-window-size').addEventListener('change', updateUdtConfigInfo);
    document.getElementById('udt-packet-size').addEventListener('change', updateUdtConfigInfo);
    document.getElementById('udt-rto').addEventListener('change', updateUdtConfigInfo);
});

// 页面卸载时清理资源
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