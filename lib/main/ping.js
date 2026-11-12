'use strict';
const { spawn } = require('child_process');
const core = require('../core');

function createPingModule(ctx) {
    const { safeSend, decodeOutput } = ctx;
    const state = { timer: null, children: new Set() };

    function stop() {
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
        state.children.forEach(c => c.kill());
        state.children.clear();
        safeSend('ping-reply', '\n--- Ping 已停止 ---\n');
    }

    return {
        start(config) {
            stop();
            const { target, interval, size } = config || {};
            const intervalMs = Math.max(100, core.clampInt(interval, 0.1, 3600, 1) * 1000);
            let args;
            try { args = core.pingArgs(target, size, process.platform); }
            catch (e) { safeSend('ping-reply', `❌ ${e.message}\n`); return; }
            safeSend('ping-reply', `开始 Ping ${target}...\n`);

            const tick = () => {
                if (state.children.size > 0) return;
                let child;
                try { child = spawn('ping', args, { windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }); }
                catch (e) { safeSend('ping-reply', `❌ 无法启动 ping: ${e.message}\n`); return; }
                state.children.add(child);
                let out = Buffer.alloc(0);
                const timer = setTimeout(() => child.kill(), 3000);
                child.stdout.on('data', d => { out = Buffer.concat([out, d]); });
                child.on('error', e => safeSend('ping-reply', `❌ ${e.message}\n`));
                child.on('close', () => {
                    clearTimeout(timer);
                    state.children.delete(child);
                    const output = decodeOutput(out);
                    let reply;
                    if (/ttl=/i.test(output)) {
                        const m = output.match(/time[=<]([\d.]+)\s*ms/i);
                        reply = `来自 ${target} 的回复: 字节=${args[3]} ${m ? `时间=${m[1]}ms` : ''}`;
                    } else if (/timed out|超时|100% packet loss/i.test(output)) {
                        reply = '请求超时';
                    } else { reply = output.trim().split('\n')[0] || '无响应'; }
                    safeSend('ping-reply', `${reply}\n`);
                });
            };

            tick();
            state.timer = setInterval(tick, intervalMs);
        },

        stop,
        cleanup: () => stop()
    };
}

module.exports = { createPingModule };
