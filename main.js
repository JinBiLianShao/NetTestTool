'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { createRuntime } = require('./lib/main/runtime');
const { createSystemModule } = require('./lib/main/system');
const { createPingModule } = require('./lib/main/ping');
const { createArpModule, createScanModule } = require('./lib/main/scan');
const { createThroughputModule } = require('./lib/main/throughput');
const { createTransferModule } = require('./lib/main/transfer');

const mainWindowRef = { current: null };
const isDev = !app.isPackaged;

const rt = createRuntime({ app, mainWindowRef });
const SystemInfoModule = createSystemModule(rt);
const PingModule = createPingModule(rt);
const ArpModule = createArpModule(rt);
const ScanModule = createScanModule(rt);
const ThroughputModule = createThroughputModule(rt);
const FileTransferModule = createTransferModule(rt);

function createWindow() {
    const win = new BrowserWindow({
        width: 1280, height: 850, minWidth: 1000, minHeight: 700,
        backgroundColor: '#0f0f1e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true
        }
    });
    mainWindowRef.current = win;
    win.loadFile('index.html');
    if (isDev) win.webContents.openDevTools();
    win.on('closed', () => { if (mainWindowRef.current === win) mainWindowRef.current = null; });
    console.log('[启动信息]', { isDev, platform: process.platform, binPath: rt.getBinPath() });
}

function setupIpcHandlers() {
    ipcMain.on('app:devtools', () => {
        if (mainWindowRef.current && !mainWindowRef.current.isDestroyed() && isDev) mainWindowRef.current.webContents.openDevTools();
    });
    ipcMain.handle('net:interfaces', SystemInfoModule.getInterfaces);
    ipcMain.on('net:ping-start', (e, c) => PingModule.start(c));
    ipcMain.on('net:ping-stop', () => PingModule.stop());
    ipcMain.handle('net:arp', ArpModule.getTable);
    ipcMain.on('net:scan-start', (e, c) => ScanModule.start(c));
    ipcMain.on('net:scan-stop', () => ScanModule.stop());
    ipcMain.handle('net:tp-server', (e, c) => ThroughputModule.startServer(c));
    ipcMain.on('net:tp-server-stop', () => ThroughputModule.stopServer());
    ipcMain.on('net:tp-client-start', (e, c) => ThroughputModule.startClient(c));
    ipcMain.on('net:tp-stop', () => ThroughputModule.stopClient());
    ipcMain.handle('file:select-save-path', () => FileTransferModule.selectSavePath(dialog, mainWindowRef));
    ipcMain.handle('file:select-send-file', () => FileTransferModule.selectSendFile(dialog, mainWindowRef, false));
    ipcMain.handle('file:select-send-files', () => FileTransferModule.selectSendFile(dialog, mainWindowRef, true));
    ipcMain.handle('file:start-server', (e, c) => FileTransferModule.startServer(c));
    ipcMain.on('file:stop-server', () => FileTransferModule.stopServer());
    ipcMain.on('file:send', (e, c) => FileTransferModule.send(c));
    ipcMain.on('file:cancel-transfer', (e, id) => FileTransferModule.cancelHruft(id));
}

function setupAutoUpdater() {
    if (isDev) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', info => rt.safeSend('updater-status', require('./lib/core').updaterMessage('downloaded', info && info.version)));
    autoUpdater.on('update-available', info => rt.safeSend('updater-status', require('./lib/core').updaterMessage('available', info && info.version)));
    autoUpdater.on('update-not-available', () => rt.safeSend('updater-status', require('./lib/core').updaterMessage('up-to-date')));
    autoUpdater.on('error', err => { console.warn('[Updater] 检查更新失败:', err && err.message); rt.safeSend('updater-status', require('./lib/core').updaterMessage('error', err && err.message)); });
    autoUpdater.checkForUpdates().catch(err => console.warn('[Updater] 初始化失败:', err && err.message));
}

function cleanupAll() {
    for (const mod of [FileTransferModule, ScanModule, PingModule, ThroughputModule]) {
        try { mod.cleanup(); } catch (e) { console.warn('[Cleanup] 清理失败:', e.message); }
    }
}

app.whenReady().then(() => { createWindow(); setupIpcHandlers(); setupAutoUpdater(); });
app.on('window-all-closed', () => { cleanupAll(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', cleanupAll);
