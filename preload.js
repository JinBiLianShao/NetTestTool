const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ==================== 网络信息 ====================
  getInterfaces: () => ipcRenderer.invoke('net:interfaces'),

  // ==================== Ping测试 ====================
  startPing: (config) => ipcRenderer.send('net:ping-start', config),
  stopPing: () => ipcRenderer.send('net:ping-stop'),
  onPingReply: (callback) => ipcRenderer.on('ping-reply', (_, data) => callback(data)),

  // ==================== ARP表 ====================
  getArp: () => ipcRenderer.invoke('net:arp'),

  // ==================== 网段扫描 ====================
  startScan: (config) => ipcRenderer.send('net:scan-start', config),
  stopScan: () => ipcRenderer.send('net:scan-stop'),
  onScanStatus: (callback) => ipcRenderer.on('scan-status', (_, data) => callback(data)),
  onScanDeviceFound: (callback) => ipcRenderer.on('scan-device-found', (_, device) => callback(device)),

  // ==================== 吞吐量测试 ====================
  startServer: (config) => ipcRenderer.invoke('net:tp-server', config),
  startClient: (config) => ipcRenderer.send('net:tp-client-start', config),
  stopClient: () => ipcRenderer.send('net:tp-stop'),
  stopServer: () => ipcRenderer.send('net:tp-server-stop'), // 新增：单独停止服务端
  onTpData: (callback) => ipcRenderer.on('tp-data', (_, speed) => callback(speed)),
  onTpLog: (callback) => ipcRenderer.on('tp-log', (_, msg) => callback(msg)),

  // ==================== 文件传输 (HRUFT集成) ====================
  selectSavePath: () => ipcRenderer.invoke('file:select-save-path'),
  startTransferServer: (config) => ipcRenderer.invoke('file:start-server', config),
  stopTransferServer: () => ipcRenderer.send('file:stop-server'),

  // 新增：HRUFT特定功能
  getHruftVersion: () => ipcRenderer.invoke('file:hruft-version'),
  getHruftStats: () => ipcRenderer.invoke('file:hruft-stats'),
  cancelTransfer: (transferId) => ipcRenderer.send('file:cancel-transfer', transferId),
  pauseTransfer: (transferId) => ipcRenderer.send('file:pause-transfer', transferId),
  resumeTransfer: (transferId) => ipcRenderer.send('file:resume-transfer', transferId),

  sendFile: (config) => ipcRenderer.send('file:send', config),

  // 传输事件监听
  onTransferLog: (callback) => ipcRenderer.on('transfer-log', (_, msg) => callback(msg)),
  onFileTransferStart: (callback) => ipcRenderer.on('file-transfer-start', (_, data) => callback(data)),
  onFileTransferProgress: (callback) => ipcRenderer.on('file-transfer-progress', (_, data) => callback(data)),
  onFileTransferComplete: (callback) => ipcRenderer.on('file-transfer-complete', (_, data) => callback(data)),
  onFileTransferError: (callback) => ipcRenderer.on('file-transfer-error', (_, data) => callback(data)),

  onFileSendStart: (callback) => ipcRenderer.on('file-send-start', (_, data) => callback(data)),
  onFileSendProgress: (callback) => ipcRenderer.on('file-send-progress', (_, data) => callback(data)),
  onFileSendComplete: (callback) => ipcRenderer.on('file-send-complete', (_, data) => callback(data)),
  onFileSendError: (callback) => ipcRenderer.on('file-send-error', (_, data) => callback(data)),

  // 新增：HRUFT统计事件
  onHruftStatsUpdate: (callback) => ipcRenderer.on('hruft-stats-update', (_, stats) => callback(stats)),
  onHruftStatusChange: (callback) => ipcRenderer.on('hruft-status-change', (_, status) => callback(status)),

  // 文件选择
  selectSendFile: () => ipcRenderer.invoke('file:select-send-file'),

  // ==================== 系统功能 ====================
  clearArpCache: () => ipcRenderer.invoke('sys:clear-arp'),
  getSystemInfo: () => ipcRenderer.invoke('sys:info'),
  exportData: (data, filename) => ipcRenderer.invoke('sys:export-data', { data, filename }),

  // ==================== 应用控制 ====================
  restartApp: () => ipcRenderer.send('app:restart'),
  quitApp: () => ipcRenderer.send('app:quit'),
  showDevTools: () => ipcRenderer.send('app:devtools'),

  // ==================== 日志功能 ====================
  getLogs: () => ipcRenderer.invoke('log:get'),
  clearLogs: () => ipcRenderer.invoke('log:clear'),
  exportLogs: () => ipcRenderer.invoke('log:export'),

  // ==================== 更新检查 ====================
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.send('update:download'),
  installUpdate: () => ipcRenderer.send('update:install')
});