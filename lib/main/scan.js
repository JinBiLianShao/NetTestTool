'use strict';
const { spawn } = require('child_process');
const core = require('../core');

function createArpModule(ctx) {
    const { decodeOutput } = ctx;
    return {
        getTable: () => new Promise((resolve) => {
            const child = spawn('arp', ['-a'], { windowsHide: true });
            let out = Buffer.alloc(0);
            child.stdout.on('data', d => { out = Buffer.concat([out, d]); });
            child.on('error', e => resolve(`Error: ${e.message}`));
            child.on('close', () => resolve(decodeOutput(out)));
        })
    };
}

function createScanModule(ctx) {
    const { safeSend, decodeOutput, runWithConcurrency } = ctx;
    const state = { inProgress: false, children: new Set() };

    function stop() {
        state.inProgress = false;
        state.children.forEach(c => c.kill());
        state.children.clear();
        safeSend('scan-status', { status: 'stopped', message: '扫描已停止', percent: 0 });
    }

    return {
        async start(config) {
            if (state.inProgress) return;
            const { ip, timeout, netmask } = config || {};
            if (!core.isValidIPv4(ip)) {
                safeSend('scan-status', { status: 'error', error: '无效的 IP 地址', message: '扫描出错: 无效的 IP 地址' });
                return;
            }
            state.inProgress = true;

            let ips;
            try { ips = core.expandSubnet(ip, netmask); }
            catch (e) {
                safeSend('scan-status', { status: 'error', error: e.message, message: `扫描出错: ${e.message}` });
                state.inProgress = false;
                return;
            }

            const totalIps = ips.length;
            let scannedCount = 0;
            let foundCount = 0;
            let lastEmit = 0;

            const emit = (force) => {
                const now = Date.now();
                if (!force && now - lastEmit < 100 && scannedCount !== totalIps) return;
                lastEmit = now;
                const percent = Math.round((scannedCount / totalIps) * 100);
                safeSend('scan-status', {
                    status: 'scanning',
                    message: `扫描中... ${percent}% (${scannedCount}/${totalIps})`,
                    total: totalIps, current: scannedCount, found: foundCount, percent
                });
            };

            safeSend('scan-status', { status: 'scanning', message: `正在扫描 ${totalIps} 个地址...`, total: totalIps, current: 0, found: 0, percent: 0 });

            const scanTask = (targetIp) => new Promise((resolve) => {
                if (!state.inProgress) return resolve();
                let args;
                try { args = core.scanPingArgs(targetIp, timeout, process.platform); } catch (e) { return resolve(); }
                let child;
                try { child = spawn('ping', args, { windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }); }
                catch (e) { scannedCount++; return resolve(); }
                state.children.add(child);
                let out = Buffer.alloc(0);
                const timer = setTimeout(() => child.kill(), core.clampInt(timeout, 50, 10000, 500) + 1000);
                child.stdout.on('data', d => { out = Buffer.concat([out, d]); });
                child.on('error', () => {});
                child.on('close', () => {
                    clearTimeout(timer);
                    state.children.delete(child);
                    if (!state.inProgress) return resolve();
                    scannedCount++;
                    emit(false);
                    const text = decodeOutput(out);
                    if (/ttl=/i.test(text)) {
                        foundCount++;
                        const arp = spawn('arp', ['-a', targetIp], { windowsHide: true });
                        let arpOut = Buffer.alloc(0);
                        arp.stdout.on('data', d => { arpOut = Buffer.concat([arpOut, d]); });
                        arp.on('error', () => {});
                        arp.on('close', () => {
                            const match = decodeOutput(arpOut).match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
                            safeSend('scan-device-found', {
                                ip: targetIp,
                                mac: match ? match[0] : 'Unknown',
                                vendor: 'Unknown',
                                time: `<${core.clampInt(timeout, 50, 10000, 500)}ms`
                            });
                            resolve();
                        });
                    } else {
                        resolve();
                    }
                });
            });

            try {
                await runWithConcurrency(ips.map(t => () => scanTask(t)), 20);
                if (state.inProgress) {
                    scannedCount = totalIps;
                    safeSend('scan-status', {
                        status: 'completed',
                        message: `扫描完成 - 发现 ${foundCount} 台设备`,
                        total: totalIps, current: totalIps, found: foundCount, percent: 100
                    });
                }
            } catch (e) {
                safeSend('scan-status', { status: 'error', error: e.message, message: `扫描出错: ${e.message}` });
            } finally {
                state.inProgress = false;
            }
        },

        stop,
        cleanup: () => stop()
    };
}

module.exports = { createArpModule, createScanModule };
