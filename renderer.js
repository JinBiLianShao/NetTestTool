// renderer.js
// === Tab 切换 ===
function showTab(id) {
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav li').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    event.currentTarget.classList.add('active');

    if(id === 'info') loadInterfaces();
    if(id === 'throughput') toggleUdpConfig();
}

// === 1. 网络信息 ===
async function loadInterfaces() {
    const list = document.getElementById('interface-list');
    const interfaces = await window.api.getInterfaces();

    list.innerHTML = interfaces.map(iface => `
        <div class="card">
            <h3 style="color: #e14eca">${iface.name}</h3>
            <p><strong>IP:</strong> ${iface.ip}</p>
            <p><strong>MAC:</strong> ${iface.mac}</p>
            <p><strong>Mask:</strong> ${iface.netmask}</p>
        </div>
    `).join('');
}

// === 2. Ping 逻辑 ===
let isPinging = false;
function togglePing() {
    const btn = document.querySelector('#ping .btn-primary');
    const target = document.getElementById('ping-target').value;
    const interval = parseFloat(document.getElementById('ping-interval').value) || 1;
    const size = parseInt(document.getElementById('ping-size').value) || 32;

    if (!isPinging) {
        document.getElementById('ping-output').textContent = `开始 Ping ${target} (间隔: ${interval}s, 包大小: ${size} bytes)...\n`;
        window.api.startPing({ target, interval, size });
        btn.textContent = "停止 Ping";
        btn.style.backgroundColor = "#ff4444";
    } else {
        window.api.stopPing();
        btn.textContent = "开始 Ping";
        btn.style.backgroundColor = "";
    }
    isPinging = !isPinging;
}

window.api.onPingReply((text) => {
    const out = document.getElementById('ping-output');
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
});

// === 3. ARP 逻辑 ===
async function refreshArp() {
    const out = document.getElementById('arp-output');
    out.textContent = "正在读取 ARP 表...";
    const result = await window.api.getArp();
    out.textContent = result;
}

// === 4. 吞吐量测试逻辑 ===
let chart;
let isClientRunning = false;
let isServerRunning = false;

// 【新增】用于平滑处理的速度历史数据
let speedHistory = [];
const smoothingWindow = 5; // 5秒滑动平均窗口

// 切换 UDP 配置的显示/隐藏
function toggleUdpConfig() {
    const protocol = document.getElementById('tp-client-protocol').value;
    const configDiv = document.getElementById('udp-config');
    configDiv.style.display = protocol === 'udp' ? 'block' : 'none';
}

// 初始化图表
function initChart() {
    const ctx = document.getElementById('speedChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: '实时带宽 (Mbps) - 5秒平均', // 标签更新
                data: [],
                borderColor: '#00f2c3',
                tension: 0.4,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, grid: { color: '#444' } },
                x: { display: false }
            },
            plugins: { legend: { labels: { color: 'white' } } }
        }
    });
}

// 启动服务端 (Server)
async function startServer() {
    if (isServerRunning) return;
    const protocol = document.getElementById('tp-server-protocol').value;

    // 重置速度历史
    speedHistory = [];

    const res = await window.api.startServer({ port: 5201, protocol });
    document.getElementById('server-status').innerText = res;
    document.getElementById('server-status').style.color = res.includes('失败') ? '#ff4444' : '#00f2c3';
    isServerRunning = !res.includes('失败');
}

// 启动/停止客户端 (Client)
function toggleClient() {
    const btn = document.getElementById('btn-tp-client');
    const ip = document.getElementById('tp-ip').value;
    const protocol = document.getElementById('tp-client-protocol').value;

    if (!isClientRunning) {
        // 重置速度历史
        speedHistory = [];

        const config = {
            ip: ip,
            port: 5201,
            protocol: protocol
        };

        if (protocol === 'udp') {
            config.bandwidth = parseFloat(document.getElementById('tp-udp-bandwidth').value) || 10;
            config.size = parseInt(document.getElementById('tp-udp-size').value) || 1470;
        }

        window.api.startClient(config);
        btn.textContent = "停止测试";
        btn.style.background = "#ff4444";

        // 重置图表
        chart.data.labels = [];
        chart.data.datasets[0].data = [];
        chart.update();
    } else {
        window.api.stopClient();
        btn.textContent = "开始测试";
        btn.style.background = "";
    }
    isClientRunning = !isClientRunning;
}

window.api.onTpData((rawSpeedMbps) => {
    // 1. 存储原始速度数据（来自 main.js 的 1秒速率）
    const speed = parseFloat(rawSpeedMbps);

    // 保持最新的 N 个原始数据
    speedHistory.push(speed);
    if (speedHistory.length > smoothingWindow) {
        speedHistory.shift();
    }

    // 2. 计算滑动平均值 (平滑后的速度)
    const sum = speedHistory.reduce((a, b) => a + b, 0);
    const smoothedSpeed = sum / speedHistory.length;

    // 3. 更新图表
    const now = new Date().toLocaleTimeString();

    // 保持图表上数据点数量
    if (chart.data.labels.length > 20) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
    }

    chart.data.labels.push(now);
    chart.data.datasets[0].data.push(smoothedSpeed.toFixed(2));
    chart.update();
});

window.api.onTpLog((msg) => {
    document.getElementById('tp-log-output').innerText = msg;
    if (msg.includes('测试已停止') || msg.includes('错误')) {
        isClientRunning = false;
        isServerRunning = false;
        document.getElementById('btn-tp-client').textContent = "开始测试";
        document.getElementById('btn-tp-client').style.background = "";
        document.getElementById('server-status').innerText = '未启动';
        document.getElementById('server-status').style.color = 'var(--text-main)';
        // 停止时也清空历史记录
        speedHistory = [];
    }
});

// 初始化
loadInterfaces();
initChart();
toggleUdpConfig();