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
            StateManager.pingStats = {values: [], avg: 0, min: Infinity, max: 0};
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
    lastProgressUpdate: 0, // 上次进度更新时间戳
    progressUpdateInterval: 100, // 进度更新间隔 (ms)

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

        // 重置进度
        this.lastProgressUpdate = 0;
        document.getElementById('transfer-progress').style.display = 'block';
        UIController.updateProgress('transfer-progress-bar', null, 0);
        document.getElementById('transfer-status-text').textContent = '准备发送...';

        window.api.sendFile(config);
    },

    async selectSavePath() {
        const path = await window.api.selectSavePath();
        if (path) document.getElementById('transfer-save-path').value = path;
    },

    async startServer() {
        const btn = document.getElementById('btn-recv-server');
        const path = document.getElementById('transfer-save-path').value;
        const port = document.getElementById('transfer-recv-port').value;

        if (!path) {
            alert('请选择保存路径');
            return;
        }

        // 调用后端 API
        const res = await window.api.startTransferServer({
            port: parseInt(port),
            savePath: path,
            protocol: document.getElementById('transfer-recv-protocol').value
        });

        UIController.log('transfer-log-output', res, 'success');

        // [新增] 1. 初始化进度条区域为 "等待中" 状态
        const progressDiv = document.getElementById('transfer-progress');
        progressDiv.style.display = 'block'; // 显示进度卡片

        UIController.updateProgress('transfer-progress-bar', null, 0); // 重置进度条为 0

        // 更新状态文本
        document.getElementById('transfer-status-text').textContent = '⏳ 等待连接...';
        document.getElementById('transfer-speed').textContent = '0.00 MB/s';
        document.getElementById('transfer-bytes').textContent = '等待发送端启动';
        document.getElementById('transfer-eta').textContent = '--';

        // 进度条颜色设置为 "等待" 状态 (可选：通过CSS控制，这里保持默认)
        const barFill = document.getElementById('transfer-progress-bar');
        if (barFill) barFill.style.width = '0%';

        // 按钮状态切换
        btn.innerHTML = '<span>⏸</span> 停止服务';
        btn.className = 'btn btn-danger';

        btn.onclick = () => {
            window.api.stopTransferServer();
            // [新增] 2. 停止时隐藏或重置进度条
            document.getElementById('transfer-status-text').textContent = '🛑 服务已停止';
            document.getElementById('transfer-speed').textContent = '';

            btn.innerHTML = '<span>🎯</span> 开启接收服务';
            btn.className = 'btn btn-success';
            btn.onclick = () => this.startServer();
        };
    },

    handleProgress: (data) => {
        console.log('[Renderer] 收到进度数据:', data);

        // 确保数据有效
        if (!data || typeof data.progress !== 'number') {
            console.error('[Renderer] 无效的进度数据:', data);
            return;
        }

        const now = Date.now();
        if (now - this.lastProgressUpdate < this.progressUpdateInterval && data.progress < 99) {
            console.log('[Renderer] 跳过频繁更新');
            return; // 跳过中间更新
        }
        this.lastProgressUpdate = now;

        const isSend = StateManager.transferMode === 'send';
        console.log(`[Renderer] 模式: ${StateManager.transferMode}, 是发送模式: ${isSend}`);

        // 🔧 修复点 1: 确保进度条容器显示
        const progressDiv = document.getElementById('transfer-progress');
        if (progressDiv && progressDiv.style.display === 'none') {
            console.log('[Renderer] 显示进度条容器');
            progressDiv.style.display = 'block';
        }

        let progress = parseFloat(data.progress) || 0;
        progress = Math.min(100, Math.max(0, progress)); // 限制在 0-100

        const currentBytes = isSend ? data.sent : data.received || 0;
        const totalBytes = data.total || 1;

        // 🔧 修复点 2: 确保进度条平滑更新
        console.log(`[Renderer] 更新进度: ${progress}%, 字节: ${currentBytes}/${totalBytes}`);

        // 更新进度条
        const progressBar = document.getElementById('transfer-progress-bar');
        if (progressBar) {
            progressBar.style.width = `${progress}%`;

            // 根据进度改变颜色
            if (progress < 30) {
                progressBar.style.background = 'linear-gradient(90deg, #ff4757, #ff6b81)';
            } else if (progress < 70) {
                progressBar.style.background = 'linear-gradient(90deg, #ffa502, #ffbe76)';
            } else {
                progressBar.style.background = 'linear-gradient(90deg, #00d9a3, #2ecc71)';
            }
        }

        // 🔧 修复点 3: 更新状态文本
        const statusText = document.getElementById('transfer-status-text');
        if (statusText) {
            if (progress >= 100) {
                statusText.textContent = '✅ 传输完成';
                statusText.style.color = '#00d9a3';
            } else if (progress > 0) {
                statusText.textContent = isSend ? '🚀 正在发送...' : '📥 正在接收...';
                statusText.style.color = '#e9ecef';
            } else {
                statusText.textContent = isSend ? '准备发送...' : '等待数据...';
                statusText.style.color = '#8b8d98';
            }
        }

        // 🔧 修复点 4: 更新速度显示
        const speedText = document.getElementById('transfer-speed');
        if (speedText) {
            const speed = data.speed || 0;
            speedText.textContent = `${speed.toFixed(2)} MB/s`;

            // 根据速度显示不同颜色
            if (speed > 10) {
                speedText.style.color = '#00d9a3'; // 绿色
            } else if (speed > 1) {
                speedText.style.color = '#ffa502'; // 橙色
            } else {
                speedText.style.color = '#ff4757'; // 红色
            }
        }

        // 🔧 修复点 5: 更新字节显示
        const bytesText = document.getElementById('transfer-bytes');
        if (bytesText) {
            const currentMB = currentBytes / 1024 / 1024;
            const totalMB = totalBytes / 1024 / 1024;

            if (totalMB > 0) {
                bytesText.textContent = `${currentMB.toFixed(2)} / ${totalMB.toFixed(2)} MB`;
            } else {
                bytesText.textContent = `${currentMB.toFixed(2)} MB`;
            }
        }

        // 🔧 修复点 6: 更新剩余时间
        const etaText = document.getElementById('transfer-eta');
        if (etaText && data.speed && data.speed > 0 && data.remainingBytes > 0) {
            const remainingMB = data.remainingBytes / 1024 / 1024;
            const etaSeconds = remainingMB / data.speed;

            if (etaSeconds < 60) {
                etaText.textContent = `剩余: ${Math.ceil(etaSeconds)}秒`;
            } else {
                const minutes = Math.floor(etaSeconds / 60);
                const seconds = Math.ceil(etaSeconds % 60);
                etaText.textContent = `剩余: ${minutes}:${seconds.toString().padStart(2, '0')}`;
            }
            etaText.style.color = '#8b8d98';
        } else if (etaText) {
            etaText.textContent = progress >= 100 ? '已完成' : '计算中...';
        }

        // 🔧 修复点 7: 特殊处理接近完成的情况
        if (progress > 95 && progress < 100) {
            const statusText = document.getElementById('transfer-status-text');
            if (statusText) {
                statusText.textContent = '即将完成...';
                statusText.style.color = '#ffa502';
            }
        }

        // 🔧 修复点 8: 强制重绘进度条
        if (progressBar) {
            progressBar.style.display = 'none';
            progressBar.offsetHeight; // 触发重排
            progressBar.style.display = 'block';
        }

        console.log('[Renderer] 进度更新完成');
    },

    handleComplete(data) {
        // 🔧 优化点 7: 完成时强制设置为 100%
        const progressBar = document.getElementById('transfer-progress-bar');
        const statusText = document.getElementById('transfer-status-text');

        if (progressBar) {
            progressBar.style.width = '100%';
        }

        if (statusText) {
            statusText.textContent = '✅ 传输完成';
            statusText.style.color = '#00d9a3';
        }

        // 更新字节显示为最终值
        const bytesText = document.getElementById('transfer-bytes');
        if (bytesText && data.fileSize) {
            const sizeMB = (data.fileSize / 1024 / 1024).toFixed(2);
            bytesText.textContent = `${sizeMB} / ${sizeMB} MB`;
        }

        // 清空剩余时间
        const etaText = document.getElementById('transfer-eta');
        if (etaText) {
            etaText.textContent = '剩余时间: 完成';
            etaText.style.color = '#00d9a3';
        }

        // 日志记录
        UIController.log('transfer-log-output', `✅ 传输完成: ${data.fileName}`, 'success');

        // 🔧 优化点 8: 显示详细统计信息
        if (data.stats) {
            const stats = data.stats;

            // 显示速度统计
            if (stats.average_speed_mbps) {
                UIController.log('transfer-log-output',
                    `📊 平均速度: ${stats.average_speed_mbps.toFixed(2)} Mbps`, 'info');
            }
            if (stats.max_speed_mbps) {
                UIController.log('transfer-log-output',
                    `⚡ 峰值速度: ${stats.max_speed_mbps.toFixed(2)} Mbps`, 'info');
            }

            // 显示传输时长
            if (stats.total_time_seconds) {
                const minutes = Math.floor(stats.total_time_seconds / 60);
                const seconds = Math.floor(stats.total_time_seconds % 60);
                UIController.log('transfer-log-output',
                    `⏱️ 传输时长: ${minutes}:${seconds.toString().padStart(2, '0')}`, 'info');
            }

            // 显示网络质量
            if (stats.network_quality_assessment) {
                const qa = stats.network_quality_assessment;
                const qualityMap = {
                    'excellent': '优秀 ⭐⭐⭐⭐⭐',
                    'good': '良好 ⭐⭐⭐⭐',
                    'fair': '一般 ⭐⭐⭐',
                    'poor': '较差 ⭐⭐'
                };
                UIController.log('transfer-log-output',
                    `🌐 网络质量: ${qualityMap[qa.quality_level] || qa.quality_level}`, 'info');

                if (qa.recommendations) {
                    UIController.log('transfer-log-output',
                        `💡 建议: ${qa.recommendations}`, 'warning');
                }
            }

            // 显示网络分析
            if (stats.network_analysis) {
                const na = stats.network_analysis;
                if (na.data_packet_loss_rate !== undefined) {
                    UIController.log('transfer-log-output',
                        `📉 丢包率: ${na.data_packet_loss_rate.toFixed(2)}%`, 'info');
                }
                if (na.network_transmission_efficiency !== undefined) {
                    UIController.log('transfer-log-output',
                        `📈 传输效率: ${na.network_transmission_efficiency.toFixed(2)}%`, 'info');
                }
            }
        }

        // 🔧 修改哈希校验显示（从 MD5 改为哈希）
        if (data.match !== undefined) {
            const matchText = data.match ? '✅ 哈希校验通过' : '❌ 哈希校验失败';
            const matchType = data.match ? 'success' : 'error';
            UIController.log('transfer-log-output', matchText, matchType);

            // 🔧 修改字段名从 MD5 改为 hash
            if (!data.match && data.sourceHash && data.receivedHash) {
                UIController.log('transfer-log-output',
                    `期望: ${data.sourceHash}`, 'info');
                UIController.log('transfer-log-output',
                    `实际: ${data.receivedHash}`, 'info');
            } else if (!data.match && data.sourceMD5 && data.receivedMD5) {
                // 保持向后兼容
                UIController.log('transfer-log-output',
                    `期望: ${data.sourceMD5}`, 'info');
                UIController.log('transfer-log-output',
                    `实际: ${data.receivedMD5}`, 'info');
            }
        }

        // 🔧 优化点 9: 3秒后自动隐藏进度条（可选）
        setTimeout(() => {
            const progressDiv = document.getElementById('transfer-progress');
            if (progressDiv) {
                // progressDiv.style.display = 'none'; // 如果想保留，注释这行
            }
        }, 3000);
    },

    handleError(data) {
        const statusText = document.getElementById('transfer-status-text');
        if (statusText) {
            statusText.textContent = '❌ 传输失败';
            statusText.style.color = '#ff4757';
        }

        UIController.log('transfer-log-output',
            `❌ 错误: ${data.error || '未知错误'}`, 'error');
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
// 在 renderer.js 的 DOMContentLoaded 事件中，确保正确绑定事件：

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

    // 🔧 修复点: 正确绑定进度事件
    console.log('[Renderer] 绑定文件传输事件监听器');

    // 发送进度事件
    window.api.onFileSendProgress((data) => {
        console.log('[Renderer] 收到 file-send-progress 事件');
        StateManager.transferMode = 'send';
        FileTransferModule.handleProgress(data);
    });

    // 接收进度事件
    window.api.onFileTransferProgress((data) => {
        console.log('[Renderer] 收到 file-transfer-progress 事件');
        StateManager.transferMode = 'receive';
        FileTransferModule.handleProgress(data);
    });

    // 完成事件
    window.api.onFileSendComplete((data) => {
        console.log('[Renderer] 收到 file-send-complete 事件');
        StateManager.transferMode = 'send';
        FileTransferModule.handleComplete(data);
    });

    window.api.onFileTransferComplete((data) => {
        console.log('[Renderer] 收到 file-transfer-complete 事件');
        StateManager.transferMode = 'receive';
        FileTransferModule.handleComplete(data);
    });

    // 错误事件
    window.api.onFileSendError((data) => {
        console.log('[Renderer] 收到 file-send-error 事件');
        FileTransferModule.handleError(data);
    });

    window.api.onFileTransferError((data) => {
        console.log('[Renderer] 收到 file-transfer-error 事件');
        FileTransferModule.handleError(data);
    });

    // 开始事件（如果支持）
    window.api.onFileSendStart && window.api.onFileSendStart((data) => {
        console.log('[Renderer] 收到 file-send-start 事件');
        UIController.log('transfer-log-output',
            `🚀 开始发送: ${data.fileName} (${(data.fileSize / 1024 / 1024).toFixed(2)} MB)`,
            'info');

        // 显示进度区域
        const progressDiv = document.getElementById('transfer-progress');
        if (progressDiv) {
            progressDiv.style.display = 'block';
        }

        // 重置进度条
        UIController.updateProgress('transfer-progress-bar', null, 0);
        const statusText = document.getElementById('transfer-status-text');
        if (statusText) {
            statusText.textContent = '正在发送...';
            statusText.style.color = '#e9ecef';
        }
    });

    console.log('✅ NetTestTool Pro 已初始化，事件监听器已绑定');
});