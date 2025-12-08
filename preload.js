const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // System / Info
  getInterfaces: () => ipcRenderer.invoke('net:interfaces'),
  
  // Ping
  startPing: (target) => ipcRenderer.send('net:ping-start', target),
  stopPing: () => ipcRenderer.send('net:ping-stop'),
  onPingReply: (callback) => ipcRenderer.on('ping-reply', (_, data) => callback(data)),
  
  // ARP
  getArp: () => ipcRenderer.invoke('net:arp'),
  
  // Throughput
  startServer: (port) => ipcRenderer.invoke('net:tp-server', port),
  startClient: (config) => ipcRenderer.send('net:tp-client-start', config),
  stopClient: () => ipcRenderer.send('net:tp-stop'),
  onTpData: (callback) => ipcRenderer.on('tp-data', (_, speed) => callback(speed)),
  onTpLog: (callback) => ipcRenderer.on('tp-log', (_, msg) => callback(msg))
});