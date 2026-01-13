/**
 * renderer.js - NetTestTool Pro 渲染进程主逻辑 (重构版)
 * 集成 HRUFT、iPerf、增强 Ping 功能
 */

// ==================== 1. 全局状态与配置 ====================
const CONFIG = {
    PING_MAX_POINTS: 50,
    TP_MAX_POINTS: 30,
    CHART_COLORS: {
        primary: '#6c5ce7',
        accent: '#00d9a3',
        danger: '#ff4757',
        warning: '#ffa502'
    }
};

const StateManager = {
    activeTab: 'info',
    isPinging: false,
    isScanning: false,
    tpMode: 'server', // 'server' | 'client'
    tpServerRunning: false,
    tpClientRunning: false,
    transferMode: 'send', // 'send' | 'receive'
    charts: {
        ping: null,
        throughput: null
    },
    pingStats: {
        values: [],
        avg: 0,
        min: Infinity,
        max: 0
    }
};

// ==================== 2. UI 基础控制 ====================
const UIController = {
    showTab(tabId) {
        document.querySelectorAll('.nav-item').forEach(el => {
            el.classList.toggle('active', el.getAttribute('data-tab') === tabId);
        });
        document.querySelectorAll('.module-section').forEach(el => {
            el.classList.toggle('active', el.id === tabId);
        });
        StateManager.activeTab = tabId;
    },

    log(elementId, message, type = 'info') {
        const output = document.getElementById(elementId);
        if (!output) return;

        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        output.appendChild(line);
        output.scrollTop = output.scrollHeight;

        if (output.childNodes.length > 500) output.removeChild(output.firstChild);
    },

    updateProgress(barId, textId, percent, text) {
        const bar = document.getElementById(barId);
        const txt = document.getElementById(textId);
        if (bar) bar.style.width = `${Math.min(100, percent)}%`;
        if (txt) txt.textContent = text || `${Math.round(percent)}%`;
    },

    clearConsole(elementId) {
        const output = document.getElementById(elementId);
        if (output) output.innerHTML = '';
    }
};

// 暴露清空控制台函数
window.clearConsole = UIController.clearConsole;

// ==================== 3. 网络信息模块 ====================
const NetworkInfoModule = {
    async loadInterfaces() {
        const listContainer = document.getElementById('interface-list');
        listContainer.innerHTML = '<div class="loading">🔄 正在获取网络接口...</div>';

        try {
            const ifaces = await window.api.getInterfaces();
            listContainer.innerHTML = '';

            if (ifaces.length === 0) {
                listContainer.innerHTML = '<div class="error">未检测到可用的网络接口</div>';
                return;
            }

            ifaces.forEach(iface => {
                const card = document.createElement('div');
                card.className = 'card info-card';
                card.innerHTML = `
                    <div class="card-header">🌐 ${iface.name}</div>
                    <div class="card-body">
                        <p>IP: <span>${iface.ip}</span></p>
                        <p>Mask: <span>${iface.netmask}</span></p>
                        <p>MAC: <span>${iface.mac}</span></p>
                    </div>
                `;
                listContainer.appendChild(card);
            });

            this.updateScanSelectors(ifaces);
        } catch (e) {
            listContainer.innerHTML = `<div class="error">❌ 获取失败: ${e.message}</div>`;
        }
    },

    updateScanSelectors(ifaces) {
        const select = document.getElementById('scan-interface');
        if (!select) return;
        select.innerHTML = ifaces.map(i =>
            `<option value="${i.ip}">${i.name} (${i.ip})</option>`
        ).join('');
    }
};

// ==================== 4. Ping 测试模块 (支持包大小) ====================
const PingModule = {
    initChart() {
        const ctx = document.getElementById('pingChart').getContext('2d');
        StateManager.charts.ping = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '延迟 (ms)',
                    data: [],
                    borderColor: CONFIG.CHART_COLORS.accent,
                    backgroundColor: 'rgba(0, 217, 163, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3,
                    pointHoverRadius: 5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {color: 'rgba(255,255,255,0.05)'},
                        ticks: {color: '#8b8d98'}
                    },
                    x: {
                        display: false
                    }
                },
                plugins: {
                    legend: {display: false}
                }
            }
        });
    },

    toggle() {
        const btn = document.getElementById('btn-ping');

        if (!StateManager.isPinging) {
            const config = {
                target: document.getElementById('ping-target').value.trim(),
                interval: parseFloat(document.getElementById('ping-interval').value),
                size: parseInt(document.getElementById('ping-size').value) || 32
            };

            if (!config.target) {
                alert('请输入目标地址');
                return;
            }

            window.api.startPing(config);
            StateManager.isPinging = true;
            StateManager.pingStats = { values: [], avg: 0, min: Infinity, max: 0 };
            btn.innerHTML = '<span>⏸</span> 停止测试';
            btn.className = 'btn btn-danger';
        } else {
            window.api.stopPing();
            StateManager.isPinging = false;
            btn.innerHTML = '<span>▶</span> 开始测试';
            btn.className = 'btn btn-success';
        }
    },

    handleReply(data) {
        UIController.log('ping-output', data.trim());

        const timeMatch = data.match(/时间[=<]([\d\.]+)ms/i) || data.match(/time[=<]([\d\.]+)ms/i);
        if (timeMatch) {
            const ms = parseFloat(timeMatch[1]);
            const chart = StateManager.charts.ping;
            const stats = StateManager.pingStats;

            chart.data.labels.push('');
            chart.data.datasets[0].data.push(ms);

            if (chart.data.labels.length > CONFIG.PING_MAX_POINTS) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
            }

            chart.update('none');

            // 更新统计
            stats.values.push(ms);
            stats.min = Math.min(stats.min, ms);
            stats.max = Math.max(stats.max, ms);
            stats.avg = stats.values.reduce((a, b) => a + b, 0) / stats.values.length;

            document.getElementById('ping-avg').textContent = `平均: ${stats.avg.toFixed(1)} ms`;
            document.getElementById('ping-min').textContent = `最小: ${stats.min.toFixed(1)} ms`;
            document.getElementById('ping-max').textContent = `最大: ${stats.max.toFixed(1)} ms`;
        }
    }
};

// ==================== 5. 网段扫描模块 ====================
const NetworkScanModule = {
    deviceCount: 0,

    toggle() {
        const btn = document.getElementById('btn-scan');

        if (!StateManager.isScanning) {
            const config = {
                ip: document.getElementById('scan-interface').value,
                timeout: parseInt(document.getElementById('scan-timeout').value) || 200
            };

            // 重置 UI
            document.getElementById('device-list').innerHTML = '';
            this.deviceCount = 0;
            document.getElementById('device-count').textContent = '0 台';
            document.getElementById('scan-progress').style.display = 'block';

            // 重置进度条
            UIController.updateProgress('scan-progress-bar', 'scan-progress-percent', 0, '0%');
            document.getElementById('scan-progress-text').textContent = '准备扫描...';

            window.api.startScan(config);
            StateManager.isScanning = true;
            btn.innerHTML = '<span>⏸</span> 停止扫描';
            btn.className = 'btn btn-danger';
        } else {
            window.api.stopScan();
            StateManager.isScanning = false;
            btn.innerHTML = '<span>🔎</span> 开始扫描';
            btn.className = 'btn btn-success';
        }
    },

    handleStatus(data) {
        const progressBar = document.getElementById('scan-progress-bar');
        const progressText = document.getElementById('scan-progress-text');
        const progressPercent = document.getElementById('scan-progress-percent');

        if (data.status === 'scanning') {
            // 🔧 修复点: 优先使用后端传来的 percent,否则计算
            let percent = data.percent || ((data.current / data.total) * 100);
            percent = Math.min(100, Math.max(0, percent)); // 限制在 0-100

            // 更新进度条
            if (progressBar) progressBar.style.width = `${percent}%`;
            if (progressPercent) progressPercent.textContent = `${Math.round(percent)}%`;
            if (progressText) progressText.textContent = data.message || `扫描中... ${Math.round(percent)}%`;

        } else if (data.status === 'completed') {
            StateManager.isScanning = false;

            // 🔧 修复点: 强制设置为 100%
            if (progressBar) progressBar.style.width = '100%';
            if (progressPercent) progressPercent.textContent = '100%';
            if (progressText) {
                progressText.textContent = data.message || '扫描完成';
                progressText.style.color = '#00d9a3'; // 成功绿色
            }

            // 恢复按钮状态
            const btn = document.getElementById('btn-scan');
            if (btn) {
                btn.innerHTML = '<span>🔎</span> 开始扫描';
                btn.className = 'btn btn-success';
            }

            // 3秒后隐藏进度条
            setTimeout(() => {
                const progressDiv = document.getElementById('scan-progress');
                if (progressDiv && !StateManager.isScanning) {
                    progressDiv.style.display = 'none';
                }
            }, 3000);

        } else if (data.status === 'stopped') {
            StateManager.isScanning = false;

            if (progressText) {
                progressText.textContent = data.message || '扫描已停止';
                progressText.style.color = '#ffa502'; // 警告黄色
            }

            const btn = document.getElementById('btn-scan');
            if (btn) {
                btn.innerHTML = '<span>🔎</span> 开始扫描';
                btn.className = 'btn btn-success';
            }

        } else if (data.status === 'error') {
            StateManager.isScanning = false;

            if (progressText) {
                progressText.textContent = `错误: ${data.error || data.message}`;
                progressText.style.color = '#ff4757'; // 错误红色
            }

            const btn = document.getElementById('btn-scan');
            if (btn) {
                btn.innerHTML = '<span>🔎</span> 开始扫描';
                btn.className = 'btn btn-success';
            }
        }
    },

    addDevice(device) {
        const tbody = document.getElementById('device-list');
        if (!tbody) return;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${device.ip}</td>
            <td><code>${device.mac}</code></td>
            <td>${device.vendor}</td>
            <td><span class="badge-success">${device.time}</span></td>
            <td><button class="btn-sm" onclick="copyIp('${device.ip}')">📋 复制</button></td>
        `;
        tbody.appendChild(row);

        this.deviceCount++;
        const countBadge = document.getElementById('device-count');
        if (countBadge) {
            countBadge.textContent = `${this.deviceCount} 台`;
        }
    }
};

// ==================== 6. 吞吐量测试模块 (iPerf) ====================
const ThroughputModule = {
    tpValues: [],

    initChart() {
        const ctx = document.getElementById('tpChart').getContext('2d');
        StateManager.charts.throughput = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '吞吐量 (Mbps)',
                    data: [],
                    borderColor: CONFIG.CHART_COLORS.primary,
                    backgroundColor: 'rgba(108, 92, 231, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {color: 'rgba(255,255,255,0.05)'},
                        ticks: {color: '#8b8d98'}
                    },
                    x: {display: false}
                },
                plugins: {legend: {display: false}}
            }
        });
    },

    switchMode(mode) {
        StateManager.tpMode = mode;
        document.getElementById('tp-server-controls').style.display = mode === 'server' ? 'block' : 'none';
        document.getElementById('tp-client-controls').style.display = mode === 'client' ? 'block' : 'none';

        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
        });
    },

    toggleServer() {
        const btn = document.getElementById('btn-tp-server');

        if (!StateManager.tpServerRunning) {
            const config = {
                port: parseInt(document.getElementById('tp-server-port').value),
                protocol: document.getElementById('tp-server-protocol').value,
                version: document.getElementById('tp-server-version').value
            };

            window.api.startServer(config).then(msg => {
                UIController.log('tp-log', msg, 'success');
                StateManager.tpServerRunning = true;
                btn.innerHTML = '<span>⏸</span> 停止服务';
                btn.className = 'btn btn-danger';
            });
        } else {
            window.api.stopServer();
            StateManager.tpServerRunning = false;
            btn.innerHTML = '<span>🎯</span> 启动服务';
            btn.className = 'btn btn-success';
        }
    },

    toggleClient() {
        const btn = document.getElementById('btn-tp-client');

        if (!StateManager.tpClientRunning) {
            const config = {
                ip: document.getElementById('tp-client-ip').value.trim(),
                port: parseInt(document.getElementById('tp-client-port').value),
                protocol: document.getElementById('tp-client-protocol').value,
                duration: parseInt(document.getElementById('tp-client-duration').value),
                bandwidth: parseInt(document.getElementById('tp-client-bandwidth').value),
                version: document.getElementById('tp-client-version').value
            };

            if (!config.ip) {
                alert('请输入目标服务器地址');
                return;
            }

            this.tpValues = [];
            window.api.startClient(config);
            StateManager.tpClientRunning = true;
            btn.innerHTML = '<span>⏸</span> 停止测试';
            btn.className = 'btn btn-danger';
        } else {
            window.api.stopClient();
            StateManager.tpClientRunning = false;
            btn.innerHTML = '<span>🚀</span> 开始测试';
            btn.className = 'btn btn-success';
        }
    },

    handleData(speedStr) {
        const speed = parseFloat(speedStr);
        const chart = StateManager.charts.throughput;

        chart.data.labels.push('');
        chart.data.datasets[0].data.push(speed);

        if (chart.data.labels.length > CONFIG.TP_MAX_POINTS) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }

        chart.update('none');

        this.tpValues.push(speed);
        const avg = this.tpValues.reduce((a, b) => a + b, 0) / this.tpValues.length;

        document.getElementById('tp-current').textContent = `当前: ${speed} Mbps`;
        document.getElementById('tp-avg').textContent = `平均: ${avg.toFixed(2)} Mbps`;
    }
};

// ==================== 7. 文件传输模块 (HRUFT) ====================
const FileTransferModule = {
    selectedFile: null,

    switchMode(mode) {
        StateManager.transferMode = mode;
        document.getElementById('send-controls').style.display = mode === 'send' ? 'block' : 'none';
        document.getElementById('receive-controls').style.display = mode === 'receive' ? 'block' : 'none';

        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
        });
    },

    toggleUdtConfig() {
        const protocol = document.getElementById('transfer-protocol').value;
        document.getElementById('udt-config').style.display = protocol === 'hruft' ? 'block' : 'none';
    },

    async selectFile() {
        const file = await window.api.selectSendFile();
        if (file) {
            this.selectedFile = file;
            const sizeMB = (file.size / 1024 / 1024).toFixed(2);
            document.getElementById('transfer-file-display').value = `${file.name} (${sizeMB} MB)`;
        }
    },

    async sendFile() {
        const ip = document.getElementById('transfer-target-ip').value.trim();
        const port = parseInt(document.getElementById('transfer-target-port').value);

        if (!ip || !this.selectedFile) {
            alert('请检查 IP 和文件选择');
            return;
        }

        const protocol = document.getElementById('transfer-protocol').value;
        const config = {
            ip,
            port,
            filePath: this.selectedFile.path,
            protocol,
            udtConfig: protocol === 'hruft' ? {
                packetSize: parseInt(document.getElementById('udt-packet-size').value),
                windowSize: parseInt(document.getElementById('udt-window-size').value) * 1024 * 1024 // 转为字节
            } : null
        };

        document.getElementById('transfer-progress').style.display = 'block';
        window.api.sendFile(config);
    },

    async selectSavePath() {
        const path = await window.api.selectSavePath();
        if (path) document.getElementById('transfer-save-path').value = path;
    },

    async startServer() {
        const btn = document.getElementById('btn-recv-server');
        const path = document.getElementById('transfer-save-path').value;

        if (!path) {
            alert('请选择保存路径');
            return;
        }

        const res = await window.api.startTransferServer({
            port: parseInt(document.getElementById('transfer-recv-port').value),
            savePath: path,
            protocol: document.getElementById('transfer-recv-protocol').value // 新增协议选择
        });

        UIController.log('transfer-log-output', res, 'success');
        btn.innerHTML = '<span>⏸</span> 停止服务';
        btn.className = 'btn btn-danger';
        btn.onclick = () => {
            window.api.stopTransferServer();
            btn.innerHTML = '<span>🎯</span> 开启接收服务';
            btn.className = 'btn btn-success';
            btn.onclick = () => this.startServer();
        };
    },

    handleProgress(data) {
        UIController.updateProgress('transfer-progress-bar', null, data.progress);

        const isSend = StateManager.transferMode === 'send';
        document.getElementById('transfer-status-text').textContent = isSend ? '正在发送...' : '正在接收...';
        document.getElementById('transfer-speed').textContent = `${(data.speed || 0).toFixed(2)} MB/s`;

        const current = (data.sent || data.received || 0) / 1024 / 1024;
        const total = (data.total || 0) / 1024 / 1024;
        document.getElementById('transfer-bytes').textContent = `${current.toFixed(2)} / ${total.toFixed(2)} MB`;

        // 计算剩余时间
        if (data.speed && data.speed > 0) {
            const remainingMB = total - current;
            const etaSeconds = remainingMB / data.speed;
            const minutes = Math.floor(etaSeconds / 60);
            const seconds = Math.floor(etaSeconds % 60);
            document.getElementById('transfer-eta').textContent = `剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
    },

    handleComplete(data) {
        UIController.log('transfer-log-output', `✅ 传输完成: ${data.fileName}`, 'success');
        document.getElementById('transfer-status-text').textContent = '✅ 传输完成';
        document.getElementById('transfer-progress-bar').style.width = '100%';

        if (data.md5_match !== undefined) {
            const matchText = data.md5_match ? '✅ 校验通过' : '❌ 校验失败';
            UIController.log('transfer-log-output', matchText, data.md5_match ? 'success' : 'error');
        }
    }
};

// ==================== 8. 全局函数暴露与初始化 ====================
window.showTab = (id) => UIController.showTab(id);
window.togglePing = () => PingModule.toggle();
window.toggleScan = () => NetworkScanModule.toggle();
window.switchTpMode = (m) => ThroughputModule.switchMode(m);
window.toggleTpServer = () => ThroughputModule.toggleServer();
window.toggleTpClient = () => ThroughputModule.toggleClient();
window.switchTransferMode = (m) => FileTransferModule.switchMode(m);
window.toggleUdtConfig = () => FileTransferModule.toggleUdtConfig();
window.triggerFileSelect = () => FileTransferModule.selectFile();
window.sendFile = () => FileTransferModule.sendFile();
window.selectSavePath = () => FileTransferModule.selectSavePath();
window.startTransferServer = () => FileTransferModule.startServer();

window.copyIp = (ip) => {
    navigator.clipboard.writeText(ip);
    alert(`✅ IP 已复制: ${ip}`);
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    UIController.showTab('info');
    NetworkInfoModule.loadInterfaces();
    PingModule.initChart();
    ThroughputModule.initChart();

    // 绑定后端事件
    window.api.onPingReply((data) => PingModule.handleReply(data));
    window.api.onScanStatus((data) => NetworkScanModule.handleStatus(data));
    window.api.onScanDeviceFound((device) => NetworkScanModule.addDevice(device));
    window.api.onTpData((speed) => ThroughputModule.handleData(speed));
    window.api.onTpLog((msg) => UIController.log('tp-log', msg));
    window.api.onTransferLog((msg) => UIController.log('transfer-log-output', msg));
    window.api.onFileSendProgress((data) => FileTransferModule.handleProgress(data));
    window.api.onFileTransferProgress((data) => FileTransferModule.handleProgress(data));
    window.api.onFileSendComplete((data) => FileTransferModule.handleComplete(data));
    window.api.onFileTransferComplete((data) => FileTransferModule.handleComplete(data));
});