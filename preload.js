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

  // Network Scan (新增)
  startScan: (config) => ipcRenderer.send('net:scan-start', config),
  stopScan: () => ipcRenderer.send('net:scan-stop'),
  onScanStatus: (callback) => ipcRenderer.on('scan-status', (_, data) => callback(data)),
  onScanDeviceFound: (callback) => ipcRenderer.on('scan-device-found', (_, device) => callback(device)),

  // Throughput
  startServer: (config) => ipcRenderer.invoke('net:tp-server', config),
  startClient: (config) => ipcRenderer.send('net:tp-client-start', config),
  stopClient: () => ipcRenderer.send('net:tp-stop'),
  onTpData: (callback) => ipcRenderer.on('tp-data', (_, speed) => callback(speed)),
  onTpLog: (callback) => ipcRenderer.on('tp-log', (_, msg) => callback(msg))
});