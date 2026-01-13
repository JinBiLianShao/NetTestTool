// ================================================================
//                     NetTestTool Pro - Renderer
// ================================================================
// 模块化重构版本 - 集成HRUFT可靠UDP传输
// ================================================================

// ==================== 全局配置和常量 ====================
const CONFIG = {
    PING_CHART_MAX_POINTS: 50,      // Ping图表最多显示50个点
    SPEED_CHART_MAX_POINTS: 30,     // 速度图表最多显示30个点
    SMOOTHING_WINDOW: 5,            // 5秒滑动平均窗口
    DEFAULT_HRUFT_PORT: 5202,       // HRUFT默认端口
    DEFAULT_TCP_PORT: 5203          // TCP文件传输默认端口
};

// ==================== 全局状态管理器 ====================
const StateManager = {
    // 图表实例
    charts: {
        ping: null,
        speed: null
    },

    // 功能状态
    status: {
        pinging: false,
        scanning: false,
        clientRunning: false,
        serverRunning: false,
        transferServerRunning: false
    },

    // 统计数据
    stats: {
        ping: {
            sent: 0,
            received: 0,
            times: [],
            lastUpdateTime: Date.now()
        },
        scan: {
            devices: [],
            current: 0,
            total: 0,
            found: 0
        },
        throughput: {
            history: [],
            peakSpeed: 0,
            startTime: null
        },
        transfer: {
            history: [],
            current: null,
            selectedFile: null
        }
    },

    // 重置所有状态
    resetAll() {
        this.stats.ping = { sent: 0, received: 0, times: [], lastUpdateTime: Date.now() };
        this.stats.scan = { devices: [], current: 0, total: 0, found: 0 };
        this.stats.throughput = { history: [], peakSpeed: 0, startTime: null };
        this.status = {
            pinging: false,
            scanning: false,
            clientRunning: false,
            serverRunning: false,
            transferServerRunning: false
        };
    },

    // 重置特定模块状态
    resetModule(moduleName) {
        if (moduleName === 'ping') {
            this.stats.ping = { sent: 0, received: 0, times: [], lastUpdateTime: Date.now() };
        } else if (moduleName === 'scan') {
            this.stats.scan = { devices: [], current: 0, total: 0, found: 0 };
        } else if (moduleName === 'throughput') {
            this.stats.throughput = { history: [], peakSpeed: 0, startTime: null };
        }
    }
};

// ==================== 工具函数模块 ====================
const Utils = {
    // 格式化文件大小
    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    },

    // 格式化剩余时间
    formatETA(seconds) {
        if (!isFinite(seconds) || seconds <= 0) return '--:--';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    },

    // 计算传输速度
    calculateSpeed(bytes, durationMs) {
        if (durationMs <= 0) return 0;
        const speedMBps = (bytes / (1024 * 1024)) / (durationMs / 1000);
        return speedMBps.toFixed(2);
    },

    // 生成设备导出CSV
    generateDeviceCSV(devices) {
        const header = '序号,IP地址,MAC地址,厂商,响应时间\n';
        const rows = devices.map((device, index) =>
            `${index + 1},${device.ip},${device.mac},${device.vendor},${device.time}`
        ).join('\n');
        return header + rows;
    },

    // 创建下载链接
    createDownloadLink(content, filename, type = 'text/csv') {
        const blob = new Blob([content], { type: `${type};charset=utf-8;` });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        return { link, url };
    }
};

// ==================== UI控制模块 ====================
const UIController = {
    // Tab切换
    showTab(tabId) {
        // 隐藏所有tab内容
        document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));

        // 移除所有导航项的活动状态
        document.querySelectorAll('.nav li').forEach(el => el.classList.remove('active'));

        // 显示选中的tab
        const tabElement = document.getElementById(tabId);
        if (tabElement) {
            tabElement.classList.add('active');

            // 根据tab加载特定数据
            if (tabId === 'info') {
                NetworkInfoModule.loadInterfaces();
            } else if (tabId === 'scan') {
                NetworkScanModule.loadScanInterfaces();
            } else if (tabId === 'transfer') {
                FileTransferModule.toggleUdtConfig();
            }
        }

        // 设置导航项为活动状态
        if (event && event.currentTarget) {
            event.currentTarget.classList.add('active');
        }
    },

    // 更新进度条
    updateProgress(progressId, percent, text) {
        const progressBar = document.getElementById(`${progressId}-progress-bar`);
        const progressText = document.getElementById(`${progressId}-progress-text`);
        const progressPercent = document.getElementById(`${progressId}-progress-percent`);

        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressText) progressText.textContent = text;
        if (progressPercent) progressPercent.textContent = `${percent.toFixed(1)}%`;
    },

    // 显示/隐藏元素
    toggleElement(elementId, show) {
        const element = document.getElementById(elementId);
        if (element) {
            element.style.display = show ? 'block' : 'none';
        }
    },

    // 更新状态指示灯
    updateStatusIndicator(elementId, isActive, message) {
        const element = document.getElementById(elementId);
        if (element) {
            const indicator = element.querySelector('.status-indicator');
            if (indicator) {
                indicator.className = `status-indicator ${isActive ? 'active' : 'inactive'}`;
            }
            if (message) {
                element.innerHTML = `<span class="status-indicator ${isActive ? 'active' : 'inactive'}"></span>${message}`;
            }
        }
    },

    // 更新统计卡片
    updateStatCard(elementId, value, label = '') {
        const element = document.getElementById(elementId);
        if (element) {
            if (label) {
                const labelElement = element.querySelector('.stat-label');
                if (labelElement) labelElement.textContent = label;
            }

            const valueElement = element.querySelector('.stat-value');
            if (valueElement) valueElement.textContent = value;
        }
    },

    // 清空表格
    clearTable(tableBodyId) {
        const tbody = document.getElementById(tableBodyId);
        if (tbody) {
            tbody.innerHTML = '';
        }
    },

    // 添加表格行
    addTableRow(tableBodyId, rowData) {
        const tbody = document.getElementById(tableBodyId);
        if (!tbody) return;

        const row = document.createElement('tr');
        row.className = rowData.className || '';
        row.innerHTML = rowData.html;

        if (rowData.animation) {
            row.style.animation = 'slideIn 0.4s ease';
        }

        tbody.appendChild(row);
        return row;
    },

    // 显示消息
    showMessage(type, message, duration = 3000) {
        // 创建消息元素
        const messageEl = document.createElement('div');
        messageEl.className = `message-${type}`;
        messageEl.textContent = message;
        messageEl.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 8px;
            color: white;
            z-index: 1000;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            animation: slideInRight 0.3s ease;
        `;

        // 设置颜色
        if (type === 'success') {
            messageEl.style.background = 'linear-gradient(135deg, #00f2c3 0%, #00b894 100%)';
        } else if (type === 'error') {
            messageEl.style.background = 'linear-gradient(135deg, #ff4444 0%, #c0392b 100%)';
        } else if (type === 'warning') {
            messageEl.style.background = 'linear-gradient(135deg, #ffa500 0%, #f39c12 100%)';
        } else {
            messageEl.style.background = 'linear-gradient(135deg, #3498db 0%, #2980b9 100%)';
        }

        // 添加到页面
        document.body.appendChild(messageEl);

        // 自动移除
        setTimeout(() => {
            messageEl.style.animation = 'fadeOut 0.3s ease';
            setTimeout(() => {
                if (messageEl.parentNode) {
                    messageEl.parentNode.removeChild(messageEl);
                }
            }, 300);
        }, duration);
    },

    // 添加CSS动画
    addAnimations() {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideInRight {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes fadeOut {
                from { opacity: 1; }
                to { opacity: 0; }
            }
            @keyframes slideIn {
                from { transform: translateX(-20px); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            .message-success, .message-error, .message-warning, .message-info {
                animation: slideInRight 0.3s ease;
            }
        `;
        document.head.appendChild(style);
    }
};

// ==================== 网络信息模块 ====================
const NetworkInfoModule = {
    async loadInterfaces() {
        const list = document.getElementById('interface-list');
        if (!list) return;

        list.innerHTML = '<div style="grid-column: 1/-1; text-align: center;"><div class="loading"></div></div>';

        try {
            const interfaces = await window.api.getInterfaces();

            if (interfaces.length === 0) {
                list.innerHTML = '<p style="color: var(--text-muted); grid-column: 1/-1; text-align: center;">未发现网络接口</p>';
                return;
            }

            list.innerHTML = interfaces.map(iface => `
                <div class="card">
                    <h3>${iface.name}</h3>
                    <p><strong>IP地址:</strong> <span style="font-family: monospace;">${iface.ip}</span></p>
                    <p><strong>MAC地址:</strong> <span style="font-family: monospace;">${iface.mac}</span></p>
                    <p><strong>子网掩码:</strong> <span style="font-family: monospace;">${iface.netmask}</span></p>
                </div>
            `).join('');

        } catch (error) {
            list.innerHTML = '<p style="color: var(--danger); grid-column: 1/-1; text-align: center;">加载失败: ' + error.message + '</p>';
        }
    }
};

// ==================== Ping测试模块 ====================
const PingTestModule = {
    // 开始/停止Ping测试
    togglePing() {
        const target = document.getElementById('ping-target').value.trim();
        const interval = parseFloat(document.getElementById('ping-interval').value) || 1;
        const size = parseInt(document.getElementById('ping-size').value) || 32;

        if (!target) {
            UIController.showMessage('warning', '请输入目标地址（IP或域名）');
            return;
        }

        if (!StateManager.status.pinging) {
            this.startPing(target, interval, size);
        } else {
            this.stopPing();
        }
    },

    // 开始Ping
    startPing(target, interval, size) {
        // 重置统计数据
        StateManager.resetModule('ping');
        this.updatePingStats();

        // 重置图表
        if (StateManager.charts.ping) {
            StateManager.charts.ping.data.labels = [];
            StateManager.charts.ping.data.datasets[0].data = [];
            StateManager.charts.ping.update('none');
        }

        // 清空输出
        const output = document.getElementById('ping-output');
        if (output) {
            output.textContent = `开始 Ping ${target}...\n`;
        }

        // 启动Ping
        window.api.startPing({ target, interval, size });

        // 更新UI
        const btn = document.querySelector('#ping button');
        if (btn) {
            btn.textContent = '停止 Ping';
            btn.style.background = 'linear-gradient(135deg, var(--danger) 0%, #c0392b 100%)';
        }

        StateManager.status.pinging = true;
    },

    // 停止Ping
    stopPing() {
        window.api.stopPing();

        // 更新UI
        const btn = document.querySelector('#ping button');
        if (btn) {
            btn.textContent = '开始 Ping';
            btn.style.background = '';
        }

        StateManager.status.pinging = false;
    },

    // 处理Ping响应
    handlePingReply(text) {
        const output = document.getElementById('ping-output');
        if (output) {
            output.textContent += text;
            output.scrollTop = output.scrollHeight;
        }

        // 更新统计
        const now = Date.now();
        if (now - StateManager.stats.ping.lastUpdateTime < 100) return;

        StateManager.stats.ping.lastUpdateTime = now;
        StateManager.stats.ping.sent++;

        if (text.includes('回复') || text.includes('Reply from')) {
            StateManager.stats.ping.received++;

            // 提取延迟时间
            const timeMatch = text.match(/时间=(\d+)ms|time=(\d+)ms|time<1ms/i);
            if (timeMatch) {
                let time;
                if (text.includes('time<1ms')) {
                    time = 0.5;
                } else {
                    time = parseInt(timeMatch[1] || timeMatch[2]);
                }

                StateManager.stats.ping.times.push(time);
                this.updatePingChart(time);
            }
        }

        this.updatePingStats();
    },

    // 更新Ping统计显示
    updatePingStats() {
        const stats = StateManager.stats.ping;

        UIController.updateStatCard('ping-sent', stats.sent);
        UIController.updateStatCard('ping-received', stats.received);

        // 计算丢包率
        const lossRate = stats.sent > 0 ? ((1 - stats.received / stats.sent) * 100).toFixed(1) : 0;
        UIController.updateStatCard('ping-loss', lossRate + '%');

        // 计算平均延迟
        const avgTime = stats.times.length > 0 ?
            (stats.times.reduce((a, b) => a + b, 0) / stats.times.length).toFixed(1) : 0;
        UIController.updateStatCard('ping-avg', avgTime + 'ms');
    },

    // 更新Ping图表
    updatePingChart(time) {
        const chart = StateManager.charts.ping;
        if (!chart) return;

        // 限制数据点数量
        if (chart.data.labels.length >= CONFIG.PING_CHART_MAX_POINTS) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }

        chart.data.labels.push(StateManager.stats.ping.sent);
        chart.data.datasets[0].data.push(time);
        chart.update('none');
    }
};

// ==================== 网段扫描模块 ====================
const NetworkScanModule = {
    // 加载网络接口下拉列表
    async loadScanInterfaces() {
        const select = document.getElementById('scan-interface');
        if (!select) return;

        try {
            const interfaces = await window.api.getInterfaces();

            if (interfaces.length === 0) {
                select.innerHTML = '<option value="">无可用网络接口</option>';
                return;
            }

            select.innerHTML = interfaces.map(iface =>
                `<option value="${iface.ip}|${iface.netmask}">${iface.name} (${iface.ip})</option>`
            ).join('');

        } catch (error) {
            select.innerHTML = '<option value="">加载失败</option>';
        }
    },

    // 开始/停止扫描
    toggleScan() {
        const select = document.getElementById('scan-interface');
        if (!select || !select.value) {
            UIController.showMessage('warning', '请选择网络接口');
            return;
        }

        if (!StateManager.status.scanning) {
            this.startScan();
        } else {
            this.stopScan();
        }
    },

    // 开始扫描
    startScan() {
        const select = document.getElementById('scan-interface');
        const [ip, netmask] = select.value.split('|');

        // 重置数据
        StateManager.resetModule('scan');

        // 清空设备列表
        UIController.clearTable('device-list');
        UIController.addTableRow('device-list', {
            html: '<td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">扫描中...</td>'
        });

        // 显示进度条
        UIController.toggleElement('scan-progress', true);

        // 开始扫描
        window.api.startScan({ ip, netmask });

        // 更新UI
        const btn = document.getElementById('btn-scan');
        if (btn) {
            btn.textContent = '停止扫描';
            btn.style.background = 'linear-gradient(135deg, var(--danger) 0%, #c0392b 100%)';
        }

        StateManager.status.scanning = true;
    },

    // 停止扫描
    stopScan() {
        window.api.stopScan();

        // 更新UI
        const btn = document.getElementById('btn-scan');
        if (btn) {
            btn.textContent = '开始扫描';
            btn.style.background = '';
        }

        StateManager.status.scanning = false;

        // 3秒后隐藏进度条
        setTimeout(() => {
            UIController.toggleElement('scan-progress', false);
        }, 3000);
    },

    // 处理扫描状态更新
    handleScanStatus(data) {
        const { status, message, total, current, found } = data;

        // 更新进度文本
        const progressText = document.getElementById('scan-progress-text');
        if (progressText) progressText.textContent = message || '扫描中...';

        // 更新状态文本
        const statusMap = {
            calculating: '计算中',
            scanning: '扫描中',
            completed: '完成',
            stopped: '已停止',
            error: '错误'
        };

        UIController.updateStatCard('scan-status-text', statusMap[status] || '就绪');

        // 更新统计
        if (total !== undefined && current !== undefined) {
            StateManager.stats.scan.total = total;
            StateManager.stats.scan.current = current;
            StateManager.stats.scan.found = found || 0;

            this.updateScanStats();

            // 更新进度条
            const percent = total > 0 ? Math.round((current / total) * 100) : 0;
            const progressPercent = document.getElementById('scan-progress-percent');
            if (progressPercent) progressPercent.textContent = percent + '%';

            UIController.updateProgress('scan', percent, message || '扫描中...');
        }

        // 扫描完成或停止
        if (status === 'completed' || status === 'stopped' || status === 'error') {
            StateManager.status.scanning = false;

            const btn = document.getElementById('btn-scan');
            if (btn) {
                btn.textContent = '开始扫描';
                btn.style.background = '';
            }

            // 如果没有发现设备
            if (StateManager.stats.scan.devices.length === 0) {
                UIController.clearTable('device-list');
                UIController.addTableRow('device-list', {
                    html: '<td colspan="6" style="text-align: center; color: var(--text-muted); padding: 40px;">未发现在线设备</td>'
                });
            }

            // 3秒后隐藏进度条
            setTimeout(() => {
                UIController.toggleElement('scan-progress', false);
            }, 3000);
        }

        // 错误处理
        if (status === 'error' && data.error) {
            UIController.showMessage('error', '扫描错误: ' + data.error);
        }
    },

    // 处理发现新设备
    handleDeviceFound(device) {
        StateManager.stats.scan.devices.push(device);
        this.addDeviceToTable(device, StateManager.stats.scan.devices.length);
        this.updateDeviceCount();
    },

    // 添加设备到表格
    addDeviceToTable(device, index) {
        const deviceList = document.getElementById('device-list');

        // 如果是第一个设备，清空提示信息
        if (index === 1) {
            UIController.clearTable('device-list');
        }

        UIController.addTableRow('device-list', {
            html: `
                <td class="device-index">${index}</td>
                <td class="device-ip">${device.ip}</td>
                <td class="device-mac">${device.mac}</td>
                <td class="device-vendor">${device.vendor}</td>
                <td class="device-time">${device.time}</td>
                <td>
                    <button class="device-action-btn" onclick="pingDevice('${device.ip}')">Ping</button>
                </td>
            `,
            animation: true
        });
    },

    // 更新扫描统计
    updateScanStats() {
        const stats = StateManager.stats.scan;

        UIController.updateStatCard('scan-total', stats.total);
        UIController.updateStatCard('scan-current', stats.current);
        UIController.updateStatCard('scan-found', stats.found);
    },

    // 更新设备计数
    updateDeviceCount() {
        const count = StateManager.stats.scan.devices.length;
        const countElement = document.getElementById('device-count');
        if (countElement) {
            countElement.textContent = count;
        }
    },

    // Ping单个设备
    pingDevice(ip) {
        UIController.showTab('ping');
        const targetInput = document.getElementById('ping-target');
        if (targetInput) {
            targetInput.value = ip;
        }
    },

    // 导出设备列表
    exportDeviceList() {
        if (StateManager.stats.scan.devices.length === 0) {
            UIController.showMessage('warning', '没有可导出的设备');
            return;
        }

        const csv = Utils.generateDeviceCSV(StateManager.stats.scan.devices);
        const { link, url } = Utils.createDownloadLink(
            csv,
            `network_scan_${new Date().getTime()}.csv`
        );

        link.click();
        URL.revokeObjectURL(url);
    }
};

// ==================== ARP表模块 ====================
const ArpTableModule = {
    async refreshArp() {
        const output = document.getElementById('arp-output');
        if (!output) return;

        output.textContent = '正在读取 ARP 表...';

        try {
            const result = await window.api.getArp();
            output.textContent = result;
        } catch (error) {
            output.textContent = '读取失败: ' + error.message;
        }
    }
};

// ==================== 吞吐量测试模块 ====================
const ThroughputTestModule = {
    // 切换UDP配置显示
    toggleUdpConfig() {
        const protocol = document.getElementById('tp-client-protocol').value;
        const configDiv = document.getElementById('udp-config');
        if (configDiv) {
            configDiv.style.display = protocol === 'udp' ? 'block' : 'none';
        }
    },

    // 启动服务端
    async startServer() {
        if (StateManager.status.serverRunning) return;

        const protocol = document.getElementById('tp-server-protocol').value;

        try {
            const res = await window.api.startServer({ port: 5201, protocol });

            // 更新状态显示
            const isSuccess = !res.includes('失败');
            UIController.updateStatusIndicator('server-status', isSuccess, res);

            StateManager.status.serverRunning = isSuccess;

            // 重置统计数据
            if (isSuccess) {
                StateManager.resetModule('throughput');
                this.resetThroughputStats();
            }
        } catch (error) {
            UIController.updateStatusIndicator('server-status', false, '启动失败: ' + error.message);
        }
    },

    // 启动/停止客户端
    toggleClient() {
        const ip = document.getElementById('tp-ip').value.trim();
        const protocol = document.getElementById('tp-client-protocol').value;

        if (!ip) {
            UIController.showMessage('warning', '请输入服务端IP地址');
            return;
        }

        if (!StateManager.status.clientRunning) {
            this.startClient(ip, protocol);
        } else {
            this.stopClient();
        }
    },

    // 启动客户端
    startClient(ip, protocol) {
        // 重置数据
        StateManager.resetModule('throughput');
        StateManager.stats.throughput.startTime = Date.now();
        this.resetThroughputStats();

        // 构建配置
        const config = { ip, port: 5201, protocol };
        if (protocol === 'udp') {
            config.bandwidth = parseFloat(document.getElementById('tp-udp-bandwidth').value) || 10;
            config.size = parseInt(document.getElementById('tp-udp-size').value) || 1470;
        }

        window.api.startClient(config);

        // 更新UI
        const btn = document.getElementById('btn-tp-client');
        if (btn) {
            btn.textContent = '停止测试';
            btn.style.background = 'linear-gradient(135deg, var(--danger) 0%, #c0392b 100%)';
        }

        StateManager.status.clientRunning = true;

        // 重置图表
        if (StateManager.charts.speed) {
            StateManager.charts.speed.data.labels = [];
            StateManager.charts.speed.data.datasets[0].data = [];
            StateManager.charts.speed.update('none');
        }

        // 启动计时器
        this.updateDuration();
    },

    // 停止客户端
    stopClient() {
        window.api.stopClient();

        // 更新UI
        const btn = document.getElementById('btn-tp-client');
        if (btn) {
            btn.textContent = '开始测试';
            btn.style.background = '';
        }

        StateManager.status.clientRunning = false;
        StateManager.status.serverRunning = false;

        // 停止计时器
        if (durationTimer) {
            clearTimeout(durationTimer);
            durationTimer = null;
        }

        // 更新服务端状态
        UIController.updateStatusIndicator('server-status', false, '未启动');
    },

    // 更新测试时长
    updateDuration() {
        if (!StateManager.status.clientRunning) return;

        const startTime = StateManager.stats.throughput.startTime;
        const duration = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;

        UIController.updateStatCard('test-duration', duration + 's');

        durationTimer = setTimeout(() => this.updateDuration(), 1000);
    },

    // 处理吞吐量数据
    handleTpData(rawSpeedMbps) {
        const speed = parseFloat(rawSpeedMbps);

        // 存储原始速度数据
        StateManager.stats.throughput.history.push(speed);
        if (StateManager.stats.throughput.history.length > CONFIG.SMOOTHING_WINDOW) {
            StateManager.stats.throughput.history.shift();
        }

        // 计算滑动平均值
        const sum = StateManager.stats.throughput.history.reduce((a, b) => a + b, 0);
        const smoothedSpeed = sum / StateManager.stats.throughput.history.length;

        // 更新峰值
        if (speed > StateManager.stats.throughput.peakSpeed) {
            StateManager.stats.throughput.peakSpeed = speed;
        }

        // 计算平均速度
        const chartData = StateManager.charts.speed ? StateManager.charts.speed.data.datasets[0].data : [];
        const avgSpeed = chartData.length > 0 ?
            chartData.reduce((a, b) => a + parseFloat(b), 0) / chartData.length : 0;

        // 更新统计卡片
        UIController.updateStatCard('current-speed', speed.toFixed(2) + ' Mbps');
        UIController.updateStatCard('avg-speed', avgSpeed.toFixed(2) + ' Mbps');
        UIController.updateStatCard('peak-speed', StateManager.stats.throughput.peakSpeed.toFixed(2) + ' Mbps');

        // 更新图表
        this.updateSpeedChart(smoothedSpeed);
    },

    // 更新速度图表
    updateSpeedChart(smoothedSpeed) {
        const chart = StateManager.charts.speed;
        if (!chart) return;

        // 限制数据点数量
        if (chart.data.labels.length >= CONFIG.SPEED_CHART_MAX_POINTS) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }

        const now = new Date().toLocaleTimeString();
        chart.data.labels.push(now);
        chart.data.datasets[0].data.push(smoothedSpeed.toFixed(2));
        chart.update('none');
    },

    // 处理吞吐量日志
    handleTpLog(msg) {
        const logOutput = document.getElementById('tp-log-output');
        if (logOutput) {
            logOutput.textContent = msg;
        }

        // 处理停止消息
        if (msg.includes('测试已停止') || msg.includes('错误')) {
            this.stopClient();
        }
    },

    // 重置吞吐量统计
    resetThroughputStats() {
        UIController.updateStatCard('current-speed', '0 Mbps');
        UIController.updateStatCard('avg-speed', '0 Mbps');
        UIController.updateStatCard('peak-speed', '0 Mbps');
        UIController.updateStatCard('test-duration', '0s');
    }
};

// ==================== 文件传输模块 ====================
const FileTransferModule = {
    // 选择保存路径
    async selectSavePath() {
        const path = await window.api.selectSavePath();
        const pathInput = document.getElementById('transfer-save-path');
        if (path && pathInput) {
            pathInput.value = path;
        }
    },

    // 选择发送文件
    async triggerFileSelect() {
        const fileInfo = await window.api.selectSendFile();
        if (fileInfo) {
            StateManager.stats.transfer.selectedFile = fileInfo;

            const displayInput = document.getElementById('transfer-file-display');
            if (displayInput) {
                displayInput.value = fileInfo.name;
            }

            // 更新界面显示
            const sizeInMB = (fileInfo.size / (1024 * 1024)).toFixed(2);
            UIController.updateStatCard('current-file', fileInfo.name);
            UIController.updateStatCard('file-size', sizeInMB + ' MB');
        }
    },

    // 切换UDT配置显示
    toggleUdtConfig() {
        const protocol = document.getElementById('transfer-protocol').value;
        const udtConfig = document.getElementById('udt-config');
        if (udtConfig) {
            udtConfig.style.display = protocol === 'udt' ? 'block' : 'none';
        }
    },

    // 获取HRUFT配置参数
    getUdtConfig() {
        return {
            // HRUFT参数
            packetSize: parseInt(document.getElementById('udt-packet-size').value) || 1400,
            windowSize: parseInt(document.getElementById('udt-window-size').value) || 64,
            bandwidth: parseInt(document.getElementById('udt-bandwidth').value) || 0,
            bufferSize: parseInt(document.getElementById('udt-buffer').value) || 16,

            // 向后兼容的默认参数
            rto: 1000,
            maxRetransmit: 5,
            sendInterval: 10,
            fastRetransmit: true,
            congestionControl: true
        };
    },

    // 更新UDT配置说明
    updateUdtConfigInfo() {
        const config = this.getUdtConfig();
        const windowBytes = config.windowSize * config.packetSize;
        const windowMB = (windowBytes / (1024 * 1024)).toFixed(2);

        this.logTransfer(`HRUFT配置: MSS=${config.packetSize}字节 | 窗口=${config.windowSize}包 (${windowMB}MB)`);
        if (config.bandwidth > 0) {
            this.logTransfer(`目标带宽: ${config.bandwidth} Mbps`);
        }
    },

    // 发送文件
    async sendFile() {
        const ip = document.getElementById('transfer-target-ip').value.trim();
        if (!ip) {
            UIController.showMessage('warning', '请输入目标IP地址');
            return;
        }

        if (!StateManager.stats.transfer.selectedFile) {
            UIController.showMessage('warning', '请先选择要发送的文件');
            return;
        }

        const protocol = document.getElementById('transfer-protocol').value;
        const config = {
            ip: ip,
            port: CONFIG.DEFAULT_HRUFT_PORT,
            filePath: StateManager.stats.transfer.selectedFile.path,
            protocol: protocol
        };

        // 如果是UDT协议，添加HRUFT配置参数
        if (protocol === 'udt') {
            config.udtConfig = this.getUdtConfig();
            this.updateUdtConfigInfo();
        }

        window.api.sendFile(config);

        // 显示进度条
        UIController.toggleElement('transfer-progress', true);
        UIController.updateProgress('transfer', 0, '正在准备...');
    },

    // 启动接收服务器
    async startTransferServer() {
        if (StateManager.status.transferServerRunning) {
            window.api.stopTransferServer();
            return;
        }

        const savePath = document.getElementById('transfer-save-path').value;
        if (!savePath) {
            UIController.showMessage('warning', '请先选择保存路径');
            return;
        }

        try {
            const res = await window.api.startTransferServer({
                port: CONFIG.DEFAULT_HRUFT_PORT,
                savePath
            });

            const isSuccess = !res.includes('失败');
            UIController.updateStatusIndicator('transfer-server-status', isSuccess, res);
            StateManager.status.transferServerRunning = isSuccess;

            if (isSuccess) {
                this.logTransfer('📥 接收服务已启动，等待文件...');
            }
        } catch (error) {
            UIController.updateStatusIndicator('transfer-server-status', false, '启动失败: ' + error.message);
            this.logTransfer('❌ 启动失败: ' + error.message);
        }
    },

    // 日志输出
    logTransfer(msg) {
        const logOutput = document.getElementById('transfer-log-output');
        if (!logOutput) return;

        const timestamp = new Date().toLocaleTimeString();
        logOutput.textContent += `[${timestamp}] ${msg}\n`;
        logOutput.scrollTop = logOutput.scrollHeight;

        // 检测HRUFT特有的日志格式
        if (msg.includes('HRUFT') || msg.includes('Mbps') || msg.includes('丢包率')) {
            logOutput.textContent += `[${timestamp}] ⚡ ${msg}\n`;
        }
    },

    // 添加传输历史记录
    addTransferHistory(record) {
        StateManager.stats.transfer.history.unshift(record);
        this.updateTransferHistoryTable();
    },

    // 更新传输历史表格
    updateTransferHistoryTable() {
        const tbody = document.getElementById('transfer-history');
        const countElement = document.getElementById('transfer-history-count');

        if (countElement) {
            countElement.textContent = StateManager.stats.transfer.history.length;
        }

        if (StateManager.stats.transfer.history.length === 0) {
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 40px;">暂无传输记录</td></tr>';
            }
            return;
        }

        if (!tbody) return;

        tbody.innerHTML = StateManager.stats.transfer.history.map((record, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${record.type === 'send' ? '📤 发送' : '📥 接收'}</td>
                <td style="word-break: break-all;">${record.fileName}</td>
                <td>${Utils.formatFileSize(record.fileSize)}</td>
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
    },

    // 清空传输历史
    clearTransferHistory() {
        if (StateManager.stats.transfer.history.length === 0) return;

        if (confirm('确定要清空所有传输历史吗？')) {
            StateManager.stats.transfer.history = [];
            this.updateTransferHistoryTable();
            this.logTransfer('🗑️ 已清空传输历史');
        }
    },

    // 处理文件传输日志
    handleTransferLog(msg) {
        this.logTransfer(msg);
    },

    // 接收端 - 文件开始接收
    handleFileTransferStart(data) {
        StateManager.stats.transfer.current = {
            type: 'receive',
            fileName: data.fileName,
            fileSize: data.fileSize,
            sourceMD5: data.sourceMD5,
            startTime: Date.now()
        };

        UIController.toggleElement('transfer-progress', true);
        UIController.updateStatCard('current-file', data.fileName);
        UIController.updateStatCard('file-size', Utils.formatFileSize(data.fileSize));
        UIController.updateStatCard('source-md5', data.sourceMD5);
        UIController.updateStatCard('received-md5', '计算中...');
        UIController.toggleElement('md5-result', false);
    },

    // 接收端 - 进度更新
    handleFileTransferProgress(data) {
        const { received, total, progress, speed } = data;

        UIController.updateProgress('transfer', progress, '正在接收...');

        // 更新传输信息
        const speedElement = document.getElementById('transfer-speed');
        const bytesElement = document.getElementById('transfer-bytes');
        const totalElement = document.getElementById('transfer-total');
        const etaElement = document.getElementById('transfer-eta');

        if (speedElement) speedElement.textContent = speed + ' MB/s';
        if (bytesElement) bytesElement.textContent = Utils.formatFileSize(received);
        if (totalElement) totalElement.textContent = Utils.formatFileSize(total);

        // 计算预计剩余时间
        const speedBytes = parseFloat(speed) * 1024 * 1024;
        const remainingBytes = total - received;
        const eta = speedBytes > 0 ? remainingBytes / speedBytes : 0;
        if (etaElement) etaElement.textContent = Utils.formatETA(eta);
    },

    // 接收端 - 接收完成
    handleFileTransferComplete(data) {
        const { fileName, fileSize, sourceMD5, receivedMD5, match, duration, protocol } = data;

        // 更新进度为100%
        UIController.updateProgress('transfer', 100, match ? '✅ 接收完成' : '⚠️ MD5校验失败');

        // 显示MD5值
        UIController.updateStatCard('received-md5', receivedMD5);

        // 显示MD5校验结果
        const resultDiv = document.getElementById('md5-result');
        if (resultDiv) {
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
        }

        // 添加到历史记录
        this.addTransferHistory({
            type: 'receive',
            fileName: fileName,
            fileSize: fileSize,
            remoteIP: document.getElementById('transfer-target-ip')?.value || 'Unknown',
            duration: duration,
            success: match,
            time: new Date().toLocaleString(),
            protocol: protocol
        });

        // 3秒后隐藏进度条
        setTimeout(() => {
            UIController.toggleElement('transfer-progress', false);
        }, 3000);
    },

    // 发送端 - 开始发送
    handleFileSendStart(data) {
        StateManager.stats.transfer.current = {
            type: 'send',
            fileName: data.fileName,
            fileSize: data.fileSize,
            md5: data.md5,
            startTime: Date.now()
        };

        UIController.updateStatCard('current-file', data.fileName);
        UIController.updateStatCard('file-size', Utils.formatFileSize(data.fileSize));
        UIController.updateStatCard('source-md5', data.md5);
        UIController.updateStatCard('received-md5', '--');
        UIController.toggleElement('md5-result', false);
    },

    // 发送端 - 进度更新
    handleFileSendProgress(data) {
        const { sent, total, progress, speed } = data;

        UIController.updateProgress('transfer', progress, '正在发送...');

        // 更新传输信息
        const speedElement = document.getElementById('transfer-speed');
        const bytesElement = document.getElementById('transfer-bytes');
        const totalElement = document.getElementById('transfer-total');
        const etaElement = document.getElementById('transfer-eta');

        if (speedElement) speedElement.textContent = speed + ' MB/s';
        if (bytesElement) bytesElement.textContent = Utils.formatFileSize(sent);
        if (totalElement) totalElement.textContent = Utils.formatFileSize(total);

        // 计算预计剩余时间
        const speedBytes = parseFloat(speed) * 1024 * 1024;
        const remainingBytes = total - sent;
        const eta = speedBytes > 0 ? remainingBytes / speedBytes : 0;
        if (etaElement) etaElement.textContent = Utils.formatETA(eta);
    },

    // 发送端 - 发送完成
    handleFileSendComplete(data) {
        const { fileName, fileSize, md5, duration, protocol } = data;

        UIController.updateProgress('transfer', 100, '✅ 发送完成');

        // 显示成功消息
        const resultDiv = document.getElementById('md5-result');
        if (resultDiv) {
            resultDiv.style.display = 'block';
            resultDiv.style.background = 'linear-gradient(135deg, rgba(0, 242, 195, 0.2) 0%, rgba(0, 234, 255, 0.1) 100%)';
            resultDiv.style.color = 'var(--success)';
            resultDiv.style.border = '2px solid var(--success)';
            resultDiv.textContent = '✅ 文件发送成功 - 等待接收端校验';
        }

        // 显示HRUFT统计信息
        if (data.stats && protocol === 'UDT') {
            this.logTransfer(`📊 HRUFT传输统计:`);
            this.logTransfer(`  - 平均速度: ${data.stats.average_speed_mbps || 0} Mbps`);
            this.logTransfer(`  - 最高速度: ${data.stats.max_speed_mbps || 0} Mbps`);
            this.logTransfer(`  - 丢包率: ${data.stats.packet_loss_rate || 0}%`);
            this.logTransfer(`  - 网络质量: ${data.stats.network_quality || 'N/A'}`);
            this.logTransfer(`  - 传输效率: ${data.stats.transfer_efficiency || 0}%`);
        }

        // 添加到历史记录
        this.addTransferHistory({
            type: 'send',
            fileName: fileName,
            fileSize: fileSize,
            remoteIP: document.getElementById('transfer-target-ip')?.value,
            duration: duration,
            success: true,
            time: new Date().toLocaleString(),
            protocol: protocol
        });

        // 3秒后隐藏进度条
        setTimeout(() => {
            UIController.toggleElement('transfer-progress', false);
        }, 3000);
    },

    // 发送端 - 错误
    handleFileSendError(data) {
        UIController.updateProgress('transfer', 0, '❌ 发送失败');

        const progressBar = document.getElementById('transfer-progress-bar');
        if (progressBar) {
            progressBar.style.background = 'var(--danger)';
        }

        // 显示错误消息
        const resultDiv = document.getElementById('md5-result');
        if (resultDiv) {
            resultDiv.style.display = 'block';
            resultDiv.style.background = 'linear-gradient(135deg, rgba(255, 68, 68, 0.2) 0%, rgba(255, 107, 138, 0.1) 100%)';
            resultDiv.style.color = 'var(--danger)';
            resultDiv.style.border = '2px solid var(--danger)';
            resultDiv.textContent = '❌ 文件发送失败: ' + (data.error || '未知错误');
        }

        setTimeout(() => {
            UIController.toggleElement('transfer-progress', false);
            if (progressBar) {
                progressBar.style.background = '';
            }
        }, 3000);
    }
};

// ==================== 图表初始化模块 ====================
const ChartModule = {
    // 初始化所有图表
    initCharts() {
        this.initPingChart();
        this.initSpeedChart();
    },

    // 初始化Ping图表
    initPingChart() {
        const pingCtx = document.getElementById('pingChart');
        if (!pingCtx) return;

        StateManager.charts.ping = new Chart(pingCtx.getContext('2d'), {
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
                    x: { display: false }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: '#e9ecef',
                            font: { size: 14, weight: '600' }
                        }
                    },
                    tooltip: { mode: 'index', intersect: false }
                },
                interaction: { mode: 'nearest', axis: 'x', intersect: false }
            }
        });
    },

    // 初始化速度图表
    initSpeedChart() {
        const speedCtx = document.getElementById('speedChart');
        if (!speedCtx) return;

        StateManager.charts.speed = new Chart(speedCtx.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: `带宽 (Mbps) - ${CONFIG.SMOOTHING_WINDOW}秒平均`,
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
                    x: { display: false }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: '#e9ecef',
                            font: { size: 14, weight: '600' }
                        }
                    },
                    tooltip: { mode: 'index', intersect: false }
                },
                interaction: { mode: 'nearest', axis: 'x', intersect: false }
            }
        });
    }
};

// ==================== IPC事件监听模块 ====================
const IPCEventHandler = {
    // 初始化所有事件监听
    init() {
        this.setupPingEvents();
        this.setupScanEvents();
        this.setupThroughputEvents();
        this.setupTransferEvents();
    },

    // Ping测试事件
    setupPingEvents() {
        window.api.onPingReply((text) => {
            PingTestModule.handlePingReply(text);
        });
    },

    // 网段扫描事件
    setupScanEvents() {
        window.api.onScanStatus((data) => {
            NetworkScanModule.handleScanStatus(data);
        });

        window.api.onScanDeviceFound((device) => {
            NetworkScanModule.handleDeviceFound(device);
        });
    },

    // 吞吐量测试事件
    setupThroughputEvents() {
        window.api.onTpData((speed) => {
            ThroughputTestModule.handleTpData(speed);
        });

        window.api.onTpLog((msg) => {
            ThroughputTestModule.handleTpLog(msg);
        });
    },

    // 文件传输事件
    setupTransferEvents() {
        window.api.onTransferLog((msg) => {
            FileTransferModule.handleTransferLog(msg);
        });

        window.api.onFileTransferStart((data) => {
            FileTransferModule.handleFileTransferStart(data);
        });

        window.api.onFileTransferProgress((data) => {
            FileTransferModule.handleFileTransferProgress(data);
        });

        window.api.onFileTransferComplete((data) => {
            FileTransferModule.handleFileTransferComplete(data);
        });

        window.api.onFileSendStart((data) => {
            FileTransferModule.handleFileSendStart(data);
        });

        window.api.onFileSendProgress((data) => {
            FileTransferModule.handleFileSendProgress(data);
        });

        window.api.onFileSendComplete((data) => {
            FileTransferModule.handleFileSendComplete(data);
        });

        window.api.onFileSendError((data) => {
            FileTransferModule.handleFileSendError(data);
        });
    }
};

// ==================== 全局函数导出 ====================
// 导出到全局作用域的函数
window.showTab = (id) => UIController.showTab(id);
window.togglePing = () => PingTestModule.togglePing();
window.refreshArp = () => ArpTableModule.refreshArp();
window.toggleScan = () => NetworkScanModule.toggleScan();
window.exportDeviceList = () => NetworkScanModule.exportDeviceList();
window.pingDevice = (ip) => NetworkScanModule.pingDevice(ip);
window.startServer = () => ThroughputTestModule.startServer();
window.toggleClient = () => ThroughputTestModule.toggleClient();
window.toggleUdpConfig = () => ThroughputTestModule.toggleUdpConfig();
window.selectSavePath = () => FileTransferModule.selectSavePath();
window.startTransferServer = () => FileTransferModule.startTransferServer();
window.triggerFileSelect = () => FileTransferModule.triggerFileSelect();
window.sendFile = () => FileTransferModule.sendFile();
window.toggleUdtConfig = () => FileTransferModule.toggleUdtConfig();
window.updateUdtConfigInfo = () => FileTransferModule.updateUdtConfigInfo();
window.clearTransferHistory = () => FileTransferModule.clearTransferHistory();

// ==================== 主初始化函数 ====================
function initializeApp() {
    // 添加CSS动画
    UIController.addAnimations();

    // 初始化图表
    ChartModule.initCharts();

    // 设置IPC事件监听
    IPCEventHandler.init();

    // 加载初始数据
    NetworkInfoModule.loadInterfaces();
    NetworkScanModule.loadScanInterfaces();
    FileTransferModule.toggleUdtConfig();

    // 设置HRUFT默认配置
    document.getElementById('udt-packet-size').value = 1400;
    document.getElementById('udt-window-size').value = 64;
    document.getElementById('udt-bandwidth').value = 0;
    document.getElementById('udt-buffer').value = 16;

    UIController.showMessage('success', 'NetTestTool Pro 已就绪', 2000);
}

// DOM加载完成后初始化
document.addEventListener('DOMContentLoaded', initializeApp);

// 页面卸载时清理资源
window.addEventListener('beforeunload', () => {
    if (StateManager.status.pinging) {
        window.api.stopPing();
    }
    if (StateManager.status.scanning) {
        window.api.stopScan();
    }
    if (StateManager.status.clientRunning) {
        window.api.stopClient();
    }
    if (durationTimer) {
        clearTimeout(durationTimer);
    }
});