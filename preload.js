/**
 * preload.js - NetTestTool Pro 预加载脚本
 * * 作用：作为渲染进程(前端)与主进程(后端)之间的安全桥梁。
 * 通过 contextBridge.exposeInMainWorld 将安全的 API 暴露给 window.api 对象。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ========================================================================
  //                          1. 系统与网络信息模块
  // ========================================================================
  /**
   * 获取本机网络接口列表
   * @returns {Promise<Array>} 包含 name, ip, netmask, mac 的对象数组
   */
  getInterfaces: () => ipcRenderer.invoke('net:interfaces'),

  /**
   * 获取系统 ARP 表
   * @returns {Promise<string>} 原始 ARP 命令输出文本
   */
  getArp: () => ipcRenderer.invoke('net:arp'),


  // ========================================================================
  //                          2. Ping 测试模块
  // ========================================================================
  /**
   * 开始 Ping 测试
   * @param {Object} config - { target: string, interval: number, size: number }
   */
  startPing: (config) => ipcRenderer.send('net:ping-start', config),

  /**
   * 停止 Ping 测试
   */
  stopPing: () => ipcRenderer.send('net:ping-stop'),

  /**
   * 监听 Ping 回复日志
   * @param {Function} callback - (text) => void
   */
  onPingReply: (callback) => {
    // 先移除旧的监听器以防重复注册
    ipcRenderer.removeAllListeners('ping-reply');
    ipcRenderer.on('ping-reply', (_, text) => callback(text));
  },


  // ========================================================================
  //                          3. 网段扫描模块
  // ========================================================================
  /**
   * 开始网段扫描
   * @param {Object} config - { ip: string, timeout: number }
   */
  startScan: (config) => ipcRenderer.send('net:scan-start', config),

  /**
   * 停止网段扫描
   */
  stopScan: () => ipcRenderer.send('net:scan-stop'),

  /**
   * 监听扫描总体状态更新 (进度、完成、错误)
   * @param {Function} callback - (statusObj) => void
   */
  onScanStatus: (callback) => {
    ipcRenderer.removeAllListeners('scan-status');
    ipcRenderer.on('scan-status', (_, data) => callback(data));
  },

  /**
   * 监听发现新设备事件 (单个设备信息)
   * @param {Function} callback - (deviceObj) => void
   */
  onScanDeviceFound: (callback) => {
    ipcRenderer.removeAllListeners('scan-device-found');
    ipcRenderer.on('scan-device-found', (_, device) => callback(device));
  },


  // ========================================================================
  //                          4. 吞吐量测试模块 (TCP/UDP)
  // ========================================================================
  /**
   * 启动吞吐量测试服务端
   * @param {Object} config - { port: number, protocol: 'tcp'|'udp' }
   * @returns {Promise<string>} 启动结果消息
   */
  startServer: (config) => ipcRenderer.invoke('net:tp-server', config),

  /**
   * 停止服务端
   */
  stopServer: () => ipcRenderer.send('net:tp-server-stop'),

  /**
   * 启动吞吐量测试客户端
   * @param {Object} config - { ip, port, protocol, bandwidth, size }
   */
  startClient: (config) => ipcRenderer.send('net:tp-client-start', config),

  /**
   * 停止客户端测试
   */
  stopClient: () => ipcRenderer.send('net:tp-stop'),

  /**
   * 监听实时速度数据 (Mbps)
   * @param {Function} callback - (speedStr) => void
   */
  onTpData: (callback) => {
    ipcRenderer.removeAllListeners('tp-data');
    ipcRenderer.on('tp-data', (_, speed) => callback(speed));
  },

  /**
   * 监听吞吐量测试日志
   * @param {Function} callback - (msg) => void
   */
  onTpLog: (callback) => {
    ipcRenderer.removeAllListeners('tp-log');
    ipcRenderer.on('tp-log', (_, msg) => callback(msg));
  },


  // ========================================================================
  //                          5. 文件传输模块 (集成 HRUFT)
  // ========================================================================

  // --- 通用/配置 ---

  /**
   * 打开系统对话框选择保存目录
   * @returns {Promise<string|null>} 选中的路径
   */
  selectSavePath: () => ipcRenderer.invoke('file:select-save-path'),

  /**
   * 打开系统对话框选择要发送的文件
   * @returns {Promise<Object|null>} { path, name, size }
   */
  selectSendFile: () => ipcRenderer.invoke('file:select-send-file'),

  /**
   * 启动文件接收服务 (HRUFT Server)
   * @param {Object} config - { port, savePath }
   * @returns {Promise<string>} 启动结果
   */
  startTransferServer: (config) => ipcRenderer.invoke('file:start-server', config),

  /**
   * 停止文件接收服务
   */
  stopTransferServer: () => ipcRenderer.send('file:stop-server'),

  /**
   * 发送文件 (客户端)
   * @param {Object} config - { ip, port, filePath, protocol, udtConfig }
   */
  sendFile: (config) => ipcRenderer.send('file:send', config),

  /**
   * 取消特定的 HRUFT 传输 (预留接口)
   * @param {string} transferId
   */
  cancelTransfer: (transferId) => ipcRenderer.send('file:cancel-transfer', transferId),

  // --- 事件监听 (日志与状态) ---

  /**
   * 监听通用传输日志 (命令行输出、系统消息)
   */
  onTransferLog: (callback) => {
    ipcRenderer.removeAllListeners('transfer-log');
    ipcRenderer.on('transfer-log', (_, msg) => callback(msg));
  },

  // --- 发送端事件 (Client) ---

  onFileSendStart: (callback) => {
    ipcRenderer.removeAllListeners('file-send-start');
    ipcRenderer.on('file-send-start', (_, data) => callback(data));
  },

  // --- 接收端事件 (Server) ---

  onFileTransferStart: (callback) => { // 注意：当前主进程逻辑可能未触发此事件，视具体实现而定
    ipcRenderer.removeAllListeners('file-transfer-start');
    ipcRenderer.on('file-transfer-start', (_, data) => callback(data));
  },

  // 在 preload.js 中，确保进度事件监听器正确设置：

// --- 发送端事件 (Client) ---
  onFileSendProgress: (callback) => {
    console.log('[Preload] 注册 file-send-progress 监听器');
    ipcRenderer.removeAllListeners('file-send-progress');
    ipcRenderer.on('file-send-progress', (_, data) => {
      console.log('[Preload] 收到 file-send-progress 事件:', data);
      callback(data);
    });
  },
  onFileSendComplete: (callback) => {
    console.log('[Preload] 注册 file-send-complete 监听器');
    ipcRenderer.removeAllListeners('file-send-complete');
    ipcRenderer.on('file-send-complete', (_, data) => {
      console.log('[Preload] 收到 file-send-complete 事件:', data);
      callback(data);
    });
  },
  onFileSendError: (callback) => {
    console.log('[Preload] 注册 file-send-error 监听器');
    ipcRenderer.removeAllListeners('file-send-error');
    ipcRenderer.on('file-send-error', (_, data) => {
      console.log('[Preload] 收到 file-send-error 事件:', data);
      callback(data);
    });
  },

// --- 接收端事件 (Server) ---
  onFileTransferProgress: (callback) => {
    console.log('[Preload] 注册 file-transfer-progress 监听器');
    ipcRenderer.removeAllListeners('file-transfer-progress');
    ipcRenderer.on('file-transfer-progress', (_, data) => {
      console.log('[Preload] 收到 file-transfer-progress 事件:', data);
      callback(data);
    });
  },
  onFileTransferComplete: (callback) => {
    console.log('[Preload] 注册 file-transfer-complete 监听器');
    ipcRenderer.removeAllListeners('file-transfer-complete');
    ipcRenderer.on('file-transfer-complete', (_, data) => {
      console.log('[Preload] 收到 file-transfer-complete 事件:', data);
      callback(data);
    });
  },
  onFileTransferError: (callback) => {
    console.log('[Preload] 注册 file-transfer-error 监听器');
    ipcRenderer.removeAllListeners('file-transfer-error');
    ipcRenderer.on('file-transfer-error', (_, data) => {
      console.log('[Preload] 收到 file-transfer-error 事件:', data);
      callback(data);
    });
  },


  // ========================================================================
  //                          6. 应用级控制 (可选)
  // ========================================================================
  /**
   * 打开开发者工具 (调试用)
   */
  openDevTools: () => ipcRenderer.send('app:devtools'), // 需要在 main.js 对应监听

  /**
   * 清理所有监听器 (页面卸载时调用)
   */
  removeAllListeners: () => {
    const channels = [
      'ping-reply', 'scan-status', 'scan-device-found',
      'tp-data', 'tp-log', 'transfer-log',
      'file-send-progress', 'file-send-complete', 'file-send-error',
      'file-transfer-progress', 'file-transfer-complete', 'file-transfer-error'
    ];
    channels.forEach(ch => ipcRenderer.removeAllListeners(ch));
  }
});