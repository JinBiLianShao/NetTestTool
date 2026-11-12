'use strict';
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');

/**
 * 模块共享运行时：窗口句柄、平台判断、资源路径与公共工具。
 * 各功能模块通过 createRuntime() 拿到注入的上下文，不互相引用。
 */
function createRuntime(deps) {
    const { app, mainWindowRef } = deps;
    const isWin = process.platform === 'win32';
    const isDev = !app.isPackaged;

    function getResourcesPath() {
        return isDev ? __dirname : process.resourcesPath;
    }

    function getBinPath() {
        const resourcesPath = getResourcesPath();
        if (!isDev) return path.join(resourcesPath, 'bin');
        const folder = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
        return path.join(resourcesPath, 'bin', folder);
    }

    function getExecPath(execName) {
        const p = path.join(getBinPath(), execName);
        if (!fs.existsSync(p)) {
            console.warn(`[bin] 可执行文件不存在: ${p}`);
            return null;
        }
        if (process.platform !== 'win32') {
            try { fs.chmodSync(p, 0o755); } catch (e) { console.warn('[bin] 设置权限失败:', e.message); }
        }
        return p;
    }

    function getHruftPath() {
        const name = process.platform === 'win32' ? 'hruft.exe' : 'hruft';
        return { path: getExecPath(name), command: name };
    }

    function getIperfPath(version) {
        const name = process.platform === 'win32' ? `${version}.exe` : version;
        return getExecPath(name);
    }

    function safeSend(channel, data) {
        const win = mainWindowRef.current;
        if (win && !win.isDestroyed()) {
            try { win.webContents.send(channel, data); }
            catch (e) { console.warn(`[IPC] 发送失败 (${channel}):`, e.message); }
        }
    }

    async function runWithConcurrency(tasks, limit) {
        const results = [];
        const executing = [];
        for (const task of tasks) {
            const p = task().then(result => { executing.splice(executing.indexOf(p), 1); return result; });
            results.push(p);
            executing.push(p);
            if (executing.length >= limit) await Promise.race(executing);
        }
        return Promise.all(results);
    }

    function decodeOutput(data) {
        return isWin ? iconv.decode(data, 'cp936') : data.toString();
    }

    return { isWin, isDev, getResourcesPath, getBinPath, getHruftPath, getIperfPath, safeSend, runWithConcurrency, decodeOutput };
}

module.exports = { createRuntime };
