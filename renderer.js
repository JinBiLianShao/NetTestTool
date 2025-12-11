// renderer.js
// === Tab 切换 ===
function showTab(id) {
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav li').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    event.currentTarget.classList.add('active');

    if(id === 'info') loadInterfaces();
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
    // 获取新增的配置值
    const interval = parseFloat(document.getElementById('ping-interval').value) || 1;
    const size = parseInt(document.getElementById('ping-size').value) || 32;

    if (!isPinging) {
        // 更新输出提示，包含间隔和包大小
        document.getElementById('ping-output').textContent = `开始 Ping ${target} (间隔: ${interval}s, 包大小: ${size} bytes)...\n`;
        // 传递配置对象给后端
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

// 初始化图表
function initChart() {
    const ctx = document.getElementById('speedChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: '实时带宽 (Mbps)',
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
                x: { display: false } // 隐藏X轴标签，像示波器
            },
            plugins: { legend: { labels: { color: 'white' } } }
        }
    });
}

async function startServer() {
    const res = await window.api.startServer(5201);
    document.getElementById('server-status').innerText = res;
    document.getElementById('server-status').style.color = '#00f2c3';
}

function toggleClient() {
    const btn = document.getElementById('btn-tp-client');
    if (!isClientRunning) {
        const ip = document.getElementById('tp-ip').value;
        window.api.startClient({ ip, port: 5201 });
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

window.api.onTpData((speedMbps) => {
    // 更新图表
    const now = new Date().toLocaleTimeString();
    if (chart.data.labels.length > 20) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
    }
    chart.data.labels.push(now);
    chart.data.datasets[0].data.push(speedMbps);
    chart.update();
});

window.api.onTpLog((msg) => {
    document.getElementById('tp-log-output').innerText = msg;
});

// 初始化
loadInterfaces();
initChart();