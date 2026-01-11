const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // System / Info
  getInterfaces: () => ipcRenderer.invoke('net:interfaces'),

  // Ping
  startPing: (config) => ipcRenderer.send('net:ping-start', config),
  stopPing: () => ipcRenderer.send('net:ping-stop'),
  onPingReply: (callback) => ipcRenderer.on('ping-reply', (_, data) => callback(data)),

  // ARP
  getArp: () => ipcRenderer.invoke('net:arp'),

  // Network Scan
  startScan: (config) => ipcRenderer.send('net:scan-start', config),
  stopScan: () => ipcRenderer.send('net:scan-stop'),
  onScanStatus: (callback) => ipcRenderer.on('scan-status', (_, data) => callback(data)),
  onScanDeviceFound: (callback) => ipcRenderer.on('scan-device-found', (_, device) => callback(device)),

  // Throughput (更新HPR-UDP支持)
  startServer: (config) => ipcRenderer.invoke('net:tp-server', config),
  startClient: (config) => ipcRenderer.send('net:tp-client-start', config),
  stopClient: () => ipcRenderer.send('net:tp-stop'),
  onTpData: (callback) => ipcRenderer.on('tp-data', (_, data) => callback(data)),
  onTpStats: (callback) => ipcRenderer.on('tp-stats', (_, stats) => callback(stats)),
  onTpLog: (callback) => ipcRenderer.on('tp-log', (_, msg) => callback(msg)),

  // File Transfer
  selectSavePath: () => ipcRenderer.invoke('file:select-save-path'),
  startTransferServer: (config) => ipcRenderer.invoke('file:start-server', config),
  stopTransferServer: () => ipcRenderer.send('file:stop-server'),
  sendFile: (config) => ipcRenderer.send('file:send', config),
  selectSendFile: () => ipcRenderer.invoke('file:select-send-file'),

  // File Transfer Events
  onTransferLog: (callback) => ipcRenderer.on('transfer-log', (_, msg) => callback(msg)),
  onFileTransferStart: (callback) => ipcRenderer.on('file-transfer-start', (_, data) => callback(data)),
  onFileTransferProgress: (callback) => ipcRenderer.on('file-transfer-progress', (_, data) => callback(data)),
  onFileTransferComplete: (callback) => ipcRenderer.on('file-transfer-complete', (_, data) => callback(data)),
  onFileTransferError: (callback) => ipcRenderer.on('file-transfer-error', (_, data) => callback(data)),

  onFileSendStart: (callback) => ipcRenderer.on('file-send-start', (_, data) => callback(data)),
  onFileSendProgress: (callback) => ipcRenderer.on('file-send-progress', (_, data) => callback(data)),
  onFileSendComplete: (callback) => ipcRenderer.on('file-send-complete', (_, data) => callback(data)),
  onFileSendError: (callback) => ipcRenderer.on('file-send-error', (_, data) => callback(data))
});