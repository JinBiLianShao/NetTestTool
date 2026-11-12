'use strict';
const { spawn } = require('child_process');
const core = require('../core');

/**
 * 吞吐量测试模块（iPerf）。
 * 日志采用「分隔线 + 表头 + 数据行 + 汇总」的分层格式，原始数据行压缩成一条可读摘要，
 * 避免把 iperf 的逐行原始输出全部刷进界面。
 */
function createThroughputModule(ctx) {
    const { safeSend, decodeOutput, getIperfPath } = ctx;
    const state = { serverProcess: null, clientProcess: null, currentSession: null };

    function stopServer() {
        if (state.serverProcess) {
            try { state.serverProcess.kill(); } catch (e) { console.warn('[Throughput] 停止服务端失败:', e.message); }
            state.serverProcess = null;
            safeSend('tp-log', '🛑 服务端已手动停止');
        }
    }

    function stopClient() {
        if (state.clientProcess) {
            try { state.clientProcess.kill(); } catch (e) { console.warn('[Throughput] 停止客户端失败:', e.message); }
            state.clientProcess = null;
            safeSend('tp-log', '🛑 测试已手动停止');
        }
    }

    function formatServerOutput(line) {
        const parsed = core.parseIperfLine(line);
        if (parsed.message === null) return null;
        const text = parsed.message;
        if (text.includes('Server listening')) {
            const m = text.match(/listening on (\d+)/);
            return `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 服务器监听中 | 端口: ${m ? m[1] : 'unknown'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        }
        if (text.includes('Accepted connection')) {
            const m = text.match(/from ([0-9.]+), port (\d+)/);
            if (m) return `\n📥 客户端已连接\n   来源: ${m[1]}:${m[2]}\n   时间: ${new Date().toLocaleTimeString()}`;
        }
        if (parsed.speed !== null) safeSend('tp-data', parsed.speed.toFixed(2));
        return text;
    }

    function formatClientStart(config) {
        const { ip, port, protocol, duration, bandwidth, version } = config;
        const lines = [
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '🚀 开始吞吐量测试',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `   目标: ${ip}:${port}` + (version === 'iperf3' ? ' (iPerf3)' : ' (iPerf2)'),
            `   协议: ${protocol.toUpperCase()}` + (protocol === 'udp' ? ` | 目标带宽 ${bandwidth} Mbps` : ''),
            `   时长: ${duration} 秒 | 开始: ${new Date().toLocaleTimeString()}`
        ];
        return lines.join('\n');
    }

    function formatClientOutput(line) {
        const parsed = core.parseIperfLine(line);
        if (parsed.message === null) return { message: null, speed: null };
        const text = parsed.message;
        if (text.includes('Connecting to host')) {
            const m = text.match(/Connecting to host ([^,]+), port (\d+)/);
            if (m) return { message: `🔗 正在连接 ${m[1]}:${m[2]}…`, speed: null };
        }
        if (/sender|receiver/.test(text) && /\[\s*\d+\]/.test(text)) {
            const m = text.match(/\[\s*\d+\]\s+([\d.]+)-([\d.]+)\s+sec\s+([\d.]+\s+\w+Bytes)\s+([\d.]+\s+\w+bits\/sec)\s+(sender|receiver)/);
            if (m) {
                const role = m[5];
                return {
                    message: `\n${'━'.repeat(60)}\n${role === 'sender' ? '📤 发送端' : '📥 接收端'}汇总 (${m[1]}-${m[2]}s)\n   总传输: ${m[3]}  平均: ${m[4]}\n${'━'.repeat(60)}`,
                    speed: null
                };
            }
        }
        const lossMatch = text.match(/([\d.]+)\s*\/\s*([\d.]+)\s*\(([\d.]+)%\)\s*$/);
        if (lossMatch && /datagrams|Jitter|Lost|ms/i.test(text)) {
            const loss = parseFloat(lossMatch[3]);
            const emoji = loss < 1 ? '✅' : loss < 5 ? '⚠️' : '❌';
            return { message: `${emoji} UDP 丢包率: ${loss}% (${lossMatch[1]}/${lossMatch[2]})`, speed: null };
        }
        if (parsed.speed !== null && state.currentSession) {
            state.currentSession.intervals.push({ speed: parsed.speed });
        }
        return { message: text, speed: parsed.speed !== null ? parsed.speed.toFixed(2) : null };
    }

    function formatClientClose(code) {
        const session = state.currentSession;
        if (!session) return code === 0 ? '✅ 测试完成' : `⚠️ 测试异常退出 (代码: ${code})`;
        const duration = Math.floor((Date.now() - session.startTime) / 1000);
        const speeds = (session.intervals || []).map(i => i.speed).filter(s => s !== null && s > 0);
        const lines = ['━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '📊 测试完成'];
        if (speeds.length) {
            const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
            lines.push(`   总时长: ${duration}s  平均: ${avg.toFixed(2)} Mbps  峰值: ${Math.max(...speeds).toFixed(2)} Mbps`);
        } else {
            lines.push(`   总时长: ${duration}s  无有效速率数据`);
        }
        lines.push(`   状态: ${code === 0 ? '✅ 正常完成' : `⚠️ 异常退出 (代码: ${code})`}  结束: ${new Date().toLocaleTimeString()}`);
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return lines.join('\n');
    }

    function formatServerClose(code, duration) {
        return [
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '🛑 服务端已停止',
            `   运行时长: ${duration}s  状态: ${code === 0 ? '✅ 正常关闭' : `⚠️ 异常退出 (代码: ${code})`}  结束: ${new Date().toLocaleTimeString()}`
        ].join('\n');
    }

    return {
        startServer(config) {
            return new Promise((resolve) => {
                stopServer();
                const { port, protocol, version } = config;
                const iperfPath = getIperfPath(version);
                if (!iperfPath) return resolve(`错误: ${version} 未找到`);
                let args;
                try { args = core.iperfServerArgs(port, protocol, version); }
                catch (e) { return resolve(`错误: ${e.message}`); }

                const child = spawn(iperfPath, args, { windowsHide: true });
                state.serverProcess = child;
                state.currentSession = { role: 'server', startTime: Date.now(), version };

                let outputBuffer = '';
                child.stdout.on('data', data => {
                    const text = decodeOutput(data);
                    outputBuffer += text;
                    const lines = outputBuffer.split('\n');
                    outputBuffer = lines.pop() || '';
                    lines.forEach(line => { const f = formatServerOutput(line); if (f) safeSend('tp-log', f); });
                });
                child.stderr.on('data', data => { const msg = core.formatIperfError(decodeOutput(data)); if (msg) safeSend('tp-log', msg); });
                child.on('error', e => safeSend('tp-log', `❌ 无法启动 ${version}: ${e.message}`));
                child.on('close', code => {
                    const session = state.currentSession;
                    const duration = session ? Math.floor((Date.now() - session.startTime) / 1000) : 0;
                    safeSend('tp-log', formatServerClose(code, duration));
                    state.serverProcess = null;
                    state.currentSession = null;
                });

                resolve(`✅ ${version === 'iperf3' ? 'iPerf3' : 'iPerf2'} 服务端已启动 · 端口 ${port} · ${protocol.toUpperCase()} · 等待客户端…`);
            });
        },

        stopServer,

        startClient(config) {
            stopClient();
            const { ip, port, protocol, duration, version } = config;
            const iperfPath = getIperfPath(version);
            if (!iperfPath) { safeSend('tp-log', `❌ 错误: ${version} 未找到`); return; }

            state.currentSession = { role: 'client', protocol: protocol.toUpperCase(), version, target: `${ip}:${port}`, duration, startTime: Date.now(), intervals: [] };

            let args;
            try { args = core.iperfClientArgs(config); }
            catch (e) { safeSend('tp-log', `❌ 错误: ${e.message}`); return; }

            const child = spawn(iperfPath, args, { windowsHide: true });
            state.clientProcess = child;
            safeSend('tp-log', formatClientStart(config));

            let outputBuffer = '';
            child.stdout.on('data', data => {
                const text = decodeOutput(data);
                outputBuffer += text;
                const lines = outputBuffer.split('\n');
                outputBuffer = lines.pop() || '';
                lines.forEach(line => {
                    const f = formatClientOutput(line);
                    if (f.message) safeSend('tp-log', f.message);
                    if (f.speed !== null) safeSend('tp-data', f.speed);
                });
            });
            child.stderr.on('data', data => { const msg = core.formatIperfError(decodeOutput(data)); if (msg) safeSend('tp-log', msg); });
            child.on('error', e => safeSend('tp-log', `❌ 无法启动 ${version}: ${e.message}`));
            child.on('close', code => {
                safeSend('tp-log', formatClientClose(code));
                state.clientProcess = null;
                state.currentSession = null;
            });
        },

        stopClient,
        cleanup() { stopClient(); stopServer(); }
    };
}

module.exports = { createThroughputModule };
