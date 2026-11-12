'use strict';
const path = require('path');
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const core = require('../core');

function createTransferModule(ctx) {
    const { safeSend, decodeOutput, getHruftPath, isWin } = ctx;
    const state = { hruftProcesses: new Map(), tcpServer: null, currentProtocol: 'hruft' };

    function spawnOptions(hruftPath) {
        const opts = { cwd: path.dirname(hruftPath) };
        if (isWin) opts.env = { ...process.env, CHCP: '65001' };
        return opts;
    }

    function lineSplit(buffer, chunk) {
        buffer.value += decodeOutput(chunk);
        const lines = buffer.value.split(/\r\n|\n|\r/);
        buffer.value = lines.pop() || '';
        return lines;
    }

    function stopServer() {
        state.hruftProcesses.forEach((p) => {
            try {
                p.kill('SIGTERM');
                setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); }, 2000);
            } catch (e) { console.warn('[FileTransfer] 停止进程失败:', e.message); }
        });
        state.hruftProcesses.clear();
        if (state.tcpServer) { try { state.tcpServer.close(); } catch (e) {} state.tcpServer = null; }
        safeSend('transfer-log', '所有传输服务已停止');
    }

    return {
        get hruftProcesses() { return state.hruftProcesses; },
        get tcpServer() { return state.tcpServer; },

        async selectSavePath(dialog, mainWindowRef) {
            const { filePaths } = await dialog.showOpenDialog(mainWindowRef.current, { properties: ['openDirectory'] });
            return filePaths[0] || null;
        },

        async selectSendFile(dialog, mainWindowRef, multi) {
            const opts = multi ? { properties: ['openFile', 'multiSelections'] } : { properties: ['openFile'] };
            const { filePaths } = await dialog.showOpenDialog(mainWindowRef.current, opts);
            if (!filePaths.length) return multi ? [] : null;
            const map = (p) => { const s = fs.statSync(p); return { path: p, name: path.basename(p), size: s.size }; };
            return multi ? filePaths.map(map) : map(filePaths[0]);
        },

        /** 发送前记录文件大小，传输结束后再次校验，防止传输中被修改。 */
        snapshotFile(filePath) {
            try { return fs.statSync(filePath); }
            catch (e) { safeSend('file-send-error', { error: `无法读取文件: ${e.message}` }); return null; }
        },

        send(config) {
            const { ip, port, filePath, files, protocol, udtConfig, fastStart } = config;
            const list = files && files.length ? files : (filePath ? [{ path: filePath }] : []);
            if (!list.length) { safeSend('file-send-error', { error: '未选择文件' }); return; }
            if (protocol === 'tcp') {
                list.forEach((f, i) => setTimeout(() => this.sendTcp(ip, port, f.path), i * 100));
                return;
            }
            list.forEach((f, i) => setTimeout(() => this.sendHruft(ip, port, f.path, udtConfig, fastStart), i * 100));
        },

        sendHruft(ip, port, filePath, udtConfig, fastStart) {
            const hruft = getHruftPath();
            if (!hruft.path) {
                safeSend('transfer-log', '❌ HRUFT 可执行文件未找到');
                safeSend('file-send-error', { error: 'HRUFT executable not found' });
                return;
            }
            const before = this.snapshotFile(filePath);
            if (!before) return;
            const fileName = path.basename(filePath);
            const transferId = `send-${Date.now()}`;
            const absoluteFilePath = path.resolve(filePath);

            let args;
            try { args = core.hruftSendArgs(ip, port, absoluteFilePath, udtConfig, fastStart); }
            catch (e) { safeSend('transfer-log', `❌ ${e.message}`); safeSend('file-send-error', { error: e.message }); return; }

            safeSend('transfer-log', `📤 [HRUFT] 发送 ${fileName} (${core.formatFileSize(before.size)}) → ${ip}:${port}${fastStart ? ' · fast-start' : ''}`);
            safeSend('file-send-start', { fileName, fileSize: before.size, hash: '计算中(BLAKE3)...' });

            const child = spawn(hruft.path, args, spawnOptions(hruft.path));
            state.hruftProcesses.set(transferId, child);
            const stdout = { value: '' };
            const stderr = { value: '' };

            child.stdout.on('data', (data) => {
                lineSplit(stdout, data).forEach(line => {
                    const t = line.trim();
                    if (t) this.parseHruftOutput(t, { mode: 'send', fileName, filePath: absoluteFilePath, startTime: Date.now() });
                });
            });
            child.stderr.on('data', (data) => {
                lineSplit(stderr, data).forEach(line => { if (line.trim()) safeSend('transfer-log', `[HRUFT 错误] ${line.trim()}`); });
            });
            child.on('close', (code) => {
                state.hruftProcesses.delete(transferId);
                if (code === 0) {
                    safeSend('transfer-log', `✅ 发送完成: ${fileName}`);
                    const after = this.snapshotFile(filePath);
                    if (after && after.size !== before.size) {
                        safeSend('transfer-log', `⚠️ 发送期间文件大小变化 (${before.size} → ${after.size} B)，接收端可能不完整`);
                    }
                } else {
                    safeSend('transfer-log', `⚠️ HRUFT 进程退出码: ${code}`);
                    safeSend('file-send-error', { error: `进程退出码: ${code}` });
                }
            });
            child.on('error', (err) => {
                state.hruftProcesses.delete(transferId);
                safeSend('transfer-log', `❌ HRUFT 启动失败: ${err.message}`);
                safeSend('file-send-error', { error: err.message });
            });
        },

        startServer(config) {
            return new Promise((resolve) => {
                const { port, savePath, protocol } = config;
                state.currentProtocol = protocol;
                const absoluteSavePath = path.resolve(savePath);
                if (protocol === 'hruft') {
                    const hruft = getHruftPath();
                    if (!hruft.path) return resolve('❌ HRUFT 可执行文件未找到');
                    let args;
                    try { args = core.hruftRecvArgs(port, absoluteSavePath); }
                    catch (e) { return resolve(`❌ ${e.message}`); }

                    const child = spawn(hruft.path, args, spawnOptions(hruft.path));
                    state.hruftProcesses.set(`recv-${port}`, child);
                    const receiveContext = { mode: 'receive', fileName: '等待文件...', savePath: absoluteSavePath, startTime: Date.now() };
                    const stdout = { value: '' };
                    const stderr = { value: '' };

                    child.stdout.on('data', data => {
                        lineSplit(stdout, data).forEach(line => { const t = line.trim(); if (t) this.parseHruftOutput(t, receiveContext); });
                    });
                    child.stderr.on('data', data => {
                        lineSplit(stderr, data).forEach(line => { if (line.trim()) safeSend('transfer-log', `[HRUFT] ${line.trim()}`); });
                    });
                    child.on('close', code => {
                        state.hruftProcesses.delete(`recv-${port}`);
                        if (code === 0) safeSend('transfer-log', '✅ HRUFT 接收完成');
                        else safeSend('transfer-log', `⚠️ HRUFT 服务已停止 (code: ${code})`);
                    });
                    child.on('error', err => {
                        state.hruftProcesses.delete(`recv-${port}`);
                        safeSend('transfer-log', `❌ HRUFT 启动失败: ${err.message}`);
                        safeSend('file-transfer-error', { error: err.message });
                    });
                    resolve(`HRUFT Pro (BLAKE3) 接收服务已启动 · 端口 ${port} · 保存到 ${absoluteSavePath}`);
                } else {
                    this.startTcpServer(port, savePath);
                    resolve(`TCP 接收服务已启动 · 端口 ${port} · 保存到 ${savePath}`);
                }
            });
        },

        stopServer,

        parseHruftOutput(line, context) {
            line = line.trim();
            if (!line) return;
            if (line.startsWith('{') && line.endsWith('}')) {
                try { this.handleHruftJson(JSON.parse(line), context); return; } catch (e) {}
            }
            if (line.includes('Receiving file:') || line.includes('Sending file:')) {
                const m = line.match(/(?:Receiving|Sending) file:\s*(.+?)\s*\(([\d.]+)\s*([KMG]?B)\)/i);
                if (m) {
                    const name = m[1].trim();
                    const size = core.toBytes(m[2], m[3]);
                    context.fileName = name; context.totalBytes = size;
                    if (context.mode === 'receive') safeSend('file-transfer-start', { fileName: name, fileSize: size });
                    safeSend('transfer-log', `📁 ${context.mode === 'send' ? '发送' : '接收'} ${name} (${m[2]} ${m[3].toUpperCase()})`);
                    return;
                }
            }
            if (line.startsWith('[Progress]') || line.startsWith('Progress')) {
                const p = core.parseProgressLine(line);
                if (p) {
                    if (p.totalBytes > 0) context.totalBytes = p.totalBytes;
                    if (!context.totalBytes) return;
                    const payload = {
                        progress: p.percent,
                        received: context.mode === 'receive' ? p.currentBytes : 0,
                        sent: context.mode === 'send' ? p.currentBytes : 0,
                        total: context.totalBytes,
                        speed: p.speedMbps > 0 ? p.speedMbps / 8 : 0,
                        remainingBytes: Math.max(0, context.totalBytes - p.currentBytes),
                        elapsedSeconds: (Date.now() - (context.startTime || Date.now())) / 1000
                    };
                    safeSend(context.mode === 'receive' ? 'file-transfer-progress' : 'file-send-progress', payload);
                    return;
                }
            }
            if (line.includes('Connecting to') || line.includes('Listening on')) { safeSend('transfer-log', `🔗 ${line}`); return; }
            if (line.includes('[INFO]')) { safeSend('transfer-log', `ℹ️ ${line.replace(/\[INFO\]\s*/, '').trim()}`); return; }
            if (line.includes('[ERROR]')) { safeSend('transfer-log', `❌ ${line.replace(/\[ERROR\]\s*/, '').trim()}`); return; }
            if (line.includes('[WARNING]')) { safeSend('transfer-log', `⚠️ ${line.replace(/\[WARNING\]\s*/, '').trim()}`); return; }
            safeSend('transfer-log', `📝 ${line}`);
        },

        handleHruftJson(json, context) {
            const isSend = context.mode === 'send';
            if (json.meta) {
                const meta = json.meta;
                const hashOk = meta.hash_match !== undefined ? meta.hash_match : true;
                const completeData = {
                    fileName: meta.filename || context.fileName || '未知文件',
                    fileSize: meta.filesize || 0,
                    sourceMD5: meta.remote_hash || 'N/A',
                    receivedMD5: meta.local_hash || 'N/A',
                    match: hashOk,
                    duration: meta.duration_sec || 0,
                    protocol: 'HRUFT',
                    stats: json,
                    averageSpeed: meta.avg_speed_mbps || 0,
                    maxSpeed: json.max_speed_mbps || 0,
                    networkQuality: json.network_health || 'unknown'
                };
                safeSend(isSend ? 'file-send-complete' : 'file-transfer-complete', completeData);
                const l = [
                    `✅ 传输完成: ${completeData.fileName} · ${core.formatFileSize(completeData.fileSize)} · ${meta.duration_sec || 0}s · 平均 ${meta.avg_speed_mbps || 0} Mbps`
                ];
                l.push(hashOk ? '✅ 哈希校验通过 (BLAKE3)' : '❌ 哈希校验失败 — 接收端已保留 .part 文件，可重传');
                if (json.analysis) {
                    l.push(`🌐 网络健康度: ${json.analysis.network_health || 'unknown'}`);
                    if (json.analysis.advice && json.analysis.advice.length) l.push(`💡 建议: ${json.analysis.advice.join('；')}`);
                }
                l.forEach(x => safeSend('transfer-log', x));
                return;
            }
            if (json.type === 'progress') {
                safeSend(isSend ? 'file-send-progress' : 'file-transfer-progress', {
                    progress: json.percent || 0,
                    sent: isSend ? (json.current || 0) : 0,
                    received: !isSend ? (json.current || 0) : 0,
                    total: json.total || 1,
                    speed: (json.speed_mbps || 0) / 8,
                    remainingBytes: json.remaining_bytes || 0,
                    elapsedSeconds: json.elapsed_seconds || 0
                });
                return;
            }
            safeSend('transfer-log', `[JSON] ${JSON.stringify(json)}`);
        },

        startTcpServer(port, savePath) {
            const server = net.createServer(socket => {
                const parser = core.createMetadataParser();
                let fileName = `recv_${Date.now()}.bin`, fileSize = 0, received = 0, writeStream = null, finished = false;
                const startTime = Date.now();
                let lastProgressTime = startTime, lastBytes = 0;
                const emitProgress = (force) => {
                    if (fileSize <= 0) return;
                    const now = Date.now();
                    if (!force && now - lastProgressTime < 100) return;
                    const elapsed = (now - startTime) / 1000;
                    const speed = elapsed > 0 ? ((received - lastBytes) / ((now - lastProgressTime) / 1000)) / (1024 * 1024) : 0;
                    safeSend('file-transfer-progress', { progress: Math.min(100, received / fileSize * 100), received, total: fileSize, speed: Math.max(0, speed), remainingBytes: Math.max(0, fileSize - received), elapsedSeconds: elapsed });
                    lastProgressTime = now; lastBytes = received;
                };
                const complete = () => {
                    if (finished) return; finished = true;
                    const elapsed = (Date.now() - startTime) / 1000;
                    const avg = elapsed > 0 ? (received / elapsed) / (1024 * 1024) : 0;
                    if (writeStream) writeStream.end();
                    safeSend('file-transfer-progress', { progress: 100, received, total: fileSize || received, speed: 0, remainingBytes: 0, elapsedSeconds: elapsed });
                    safeSend('file-transfer-complete', { fileName, fileSize: received, sourceMD5: 'N/A', receivedMD5: 'N/A', match: true, duration: elapsed, protocol: 'TCP', stats: { transfer: { bytes: received, time: elapsed } }, averageSpeed: avg * 8, maxSpeed: avg * 8, networkQuality: 'unknown' });
                    safeSend('transfer-log', `✅ TCP 接收完成: ${fileName} (${core.formatFileSize(received)}) · ${elapsed.toFixed(1)}s`);
                };
                socket.on('data', chunk => {
                    let payload = chunk;
                    if (!parser.done) {
                        try { payload = parser.push(chunk); }
                        catch (e) { safeSend('transfer-log', `❌ TCP 元数据解析失败: ${e.message}`); safeSend('file-transfer-error', { error: e.message }); socket.destroy(); return; }
                        if (!parser.done) return;
                        fileName = parser.meta.fileName; fileSize = parser.meta.fileSize;
                        writeStream = fs.createWriteStream(path.join(savePath, core.safeFileName(fileName, `recv_${Date.now()}.bin`)));
                        writeStream.on('error', e => { safeSend('transfer-log', `❌ 写入文件失败: ${e.message}`); socket.destroy(); });
                        safeSend('file-transfer-start', { fileName, fileSize });
                        safeSend('transfer-log', `📁 接收 ${fileName} (${core.formatFileSize(fileSize)})`);
                    }
                    if (payload.length && writeStream) { writeStream.write(payload); received += payload.length; emitProgress(false); if (fileSize > 0 && received >= fileSize) complete(); }
                });
                socket.on('end', complete);
                socket.on('error', err => { safeSend('transfer-log', `❌ TCP 接收错误: ${err.message}`); safeSend('file-transfer-error', { error: err.message }); if (writeStream) writeStream.destroy(); });
            });
            server.on('error', err => { safeSend('transfer-log', `❌ TCP 服务器错误: ${err.message}`); safeSend('file-transfer-error', { error: err.message }); });
            server.listen(core.clampInt(port, 1, 65535, 5201), () => {
                state.tcpServer = server;
                safeSend('transfer-log', `✅ TCP 服务端监听端口: ${port}`);
            });
        },

        sendTcp(ip, port, filePath) {
            const before = this.snapshotFile(filePath);
            if (!before) return;
            const fileName = path.basename(filePath);
            const socket = new net.Socket();
            let sent = 0, startTime = Date.now(), lastProgressTime = startTime, lastBytes = 0, stream = null, finished = false;
            const emitProgress = () => {
                if (before.size <= 0) return;
                const now = Date.now();
                if (now - lastProgressTime < 100) return;
                const elapsed = (now - startTime) / 1000;
                const speed = elapsed > 0 ? ((sent - lastBytes) / ((now - lastProgressTime) / 1000)) / (1024 * 1024) : 0;
                safeSend('file-send-progress', { sent, total: before.size, progress: Math.min(100, sent / before.size * 100), speed: Math.max(0, speed), remainingBytes: Math.max(0, before.size - sent), elapsedSeconds: elapsed });
                lastProgressTime = now; lastBytes = sent;
            };
            socket.connect(core.clampInt(port, 1, 65535, 5201), ip, () => {
                safeSend('file-send-start', { fileName, fileSize: before.size, hash: 'N/A (TCP)' });
                safeSend('transfer-log', `📤 [TCP] 发送 ${fileName} (${core.formatFileSize(before.size)}) → ${ip}:${port}`);
                socket.write(core.createMetadata(fileName, before.size));
                stream = fs.createReadStream(filePath);
                stream.on('data', chunk => { if (!socket.write(chunk)) stream.pause(); sent += chunk.length; emitProgress(); });
                socket.on('drain', () => stream && stream.resume());
                stream.on('end', () => socket.end());
                stream.on('error', err => { socket.destroy(); safeSend('file-send-error', { error: `文件读取错误: ${err.message}` }); });
            });
            socket.on('end', () => {
                if (finished) return; finished = true;
                const elapsed = (Date.now() - startTime) / 1000;
                const avg = elapsed > 0 ? (sent / elapsed) / (1024 * 1024) : 0;
                safeSend('file-send-complete', { fileName, fileSize: before.size, sourceMD5: 'N/A', receivedMD5: 'N/A', match: true, duration: elapsed, protocol: 'TCP', stats: { transfer: { bytes: sent, time: elapsed } }, averageSpeed: avg * 8, maxSpeed: avg * 8, networkQuality: 'unknown' });
                safeSend('transfer-log', `✅ TCP 发送完成: ${fileName} · ${elapsed.toFixed(1)}s`);
                const after = this.snapshotFile(filePath);
                if (after && after.size !== before.size) safeSend('transfer-log', `⚠️ 发送期间文件大小变化 (${before.size} → ${after.size} B)`);
            });
            socket.on('error', err => { safeSend('file-send-error', { error: `TCP连接错误: ${err.message}` }); safeSend('transfer-log', `❌ TCP 发送错误: ${err.message}`); });
            socket.setTimeout(30000, () => { socket.destroy(); safeSend('file-send-error', { error: '连接超时' }); });
        },

        cancelHruft(id) {
            const p = state.hruftProcesses.get(id);
            if (p) { p.kill('SIGTERM'); state.hruftProcesses.delete(id); safeSend('transfer-log', `传输已取消: ${id}`); }
        },

        cleanup() { stopServer(); },
        formatFileSize: (bytes) => core.formatFileSize(bytes)
    };
}

module.exports = { createTransferModule };
