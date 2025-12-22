// renderer.js - 优化版本

// ==================== 全局变量 ====================
let pingChart, speedChart;
let isPinging = false;
let isScanning = false;
let isClientRunning = false;
let isServerRunning = false;

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
    toggleUdpConfig();
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