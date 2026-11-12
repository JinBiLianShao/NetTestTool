'use strict';
/**
 * 与 Electron 无关的纯逻辑：命令构造、参数校验、输出解析、单位换算。
 * 主进程与 Jest 测试共用同一份实现。
 */

const MARKER = Buffer.from('###END_METADATA###');
const MAX_META_BYTES = 64 * 1024;

function isValidIPv4(value) {
    if (typeof value !== 'string') return false;
    const parts = value.split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isValidHost(value) {
    return typeof value === 'string' && value.length <= 253 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) && !value.includes('..');
}

function isValidTarget(value) {
    return isValidIPv4(value) || isValidHost(value);
}

function isValidPort(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function clampInt(value, min, max, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function pingArgs(target, size, platform) {
    if (!isValidTarget(target)) throw new Error('无效的 Ping 目标地址');
    const bytes = clampInt(size, 1, 65500, 32);
    return platform === 'win32'
        ? ['-n', '1', '-l', String(bytes), target]
        : ['-c', '1', '-s', String(bytes), '-W', '2', target];
}

function scanPingArgs(ip, timeoutMs, platform) {
    if (!isValidIPv4(ip)) throw new Error('无效的扫描 IP 地址');
    const ms = clampInt(timeoutMs, 50, 10000, 500);
    return platform === 'win32'
        ? ['-n', '1', '-w', String(ms), ip]
        : ['-c', '1', '-W', String(Math.max(1, Math.ceil(ms / 1000))), '-s', '16', ip];
}

function iperfServerArgs(port, protocol, version) {
    if (!isValidPort(port)) throw new Error('无效的端口');
    if (protocol !== 'tcp' && protocol !== 'udp') throw new Error('无效的协议');
    if (version !== 'iperf2' && version !== 'iperf3') throw new Error('不支持的 iPerf 版本');
    const args = ['-s', '-p', String(port), '-i', '1'];
    if (version === 'iperf2' && protocol === 'udp') args.push('-u');
    return args;
}

function iperfClientArgs(config) {
    const { ip, port, protocol, duration, bandwidth, version } = config;
    if (!isValidTarget(ip)) throw new Error('无效的服务器地址');
    if (!isValidPort(port)) throw new Error('无效的端口');
    if (protocol !== 'tcp' && protocol !== 'udp') throw new Error('无效的协议');
    if (version !== 'iperf2' && version !== 'iperf3') throw new Error('不支持的 iPerf 版本');
    const args = ['-c', ip, '-p', String(port), '-t', String(clampInt(duration, 1, 3600, 10)), '-i', '1'];
    if (protocol === 'udp') args.push('-u', '-b', clampInt(bandwidth, 1, 100000, 10) + 'M');
    return args;
}

function hruftSendArgs(ip, port, filePath, udtConfig, fastStart) {
    if (!isValidTarget(ip)) throw new Error('无效的目标地址');
    if (!isValidPort(port)) throw new Error('无效的端口');
    if (typeof filePath !== 'string' || !filePath) throw new Error('无效的文件路径');
    const args = ['send', ip, String(port), filePath];
    if (udtConfig) {
        const mss = clampInt(udtConfig.packetSize, 64, 65535, null);
        const win = clampInt(udtConfig.windowSize, 1024, 1024 * 1024 * 1024, null);
        if (mss) args.push('--mss', String(mss));
        if (win) args.push('--window', String(win));
    }
    if (fastStart) args.push('--fast-start');
    args.push('--detailed');
    return args;
}

function hruftRecvArgs(port, savePath) {
    if (!isValidPort(port)) throw new Error('无效的端口');
    if (typeof savePath !== 'string' || !savePath) throw new Error('无效的保存路径');
    return ['recv', String(port), savePath, '--detailed'];
}

function safeFileName(name, fallback) {
    fallback = fallback || 'received.bin';
    if (typeof name !== 'string') return fallback;
    let base = name.slice(0, 255).replace(/[/\\]/g, '_').replace(/\0/g, '');
    base = base.replace(/^\.+/, '').replace(/\.{2,}/g, '_').trim();
    if (!base || base === '.' || base === '..' ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(base)) return fallback;
    return base;
}

const MAX_SCAN_ADDRESSES = 4096;

/**
 * 按 netmask 展开网段为待扫描地址列表。
 * 主机数 <= 256 的网段列出全部可用主机地址（去掉网络地址与广播地址）；
 * 更大的网段只扫描 IP 所在 /24 的 254 个地址（避免上万地址的盲目扫描）。
 * 掩码支持点分十进制与 /CIDR 两种写法；非法掩码或非连续掩码退化为 /24。
 */
function expandSubnet(ip, netmask) {
    const toInt = (str) => {
        const p = String(str).split('.').map(Number);
        if (p.length !== 4 || p.some(x => !(x >= 0 && x <= 255))) return null;
        return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
    };
    const toStr = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    const ipInt = toInt(ip);
    if (ipInt === null) throw new Error('无效的 IP 地址');

    let maskInt = 0xFFFFFF00; // 默认 /24
    if (netmask) {
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(netmask)) {
            const parsed = toInt(netmask);
            if (parsed === null) throw new Error('无效的子网掩码');
            const inv = (~parsed) >>> 0;
            // 仅接受连续掩码（inv+1 是 2 的幂）
            if (inv !== 0 && ((inv + 1) & inv) === 0) maskInt = parsed >>> 0;
        } else if (/^\/(\d{1,2})$/.test(netmask)) {
            const bits = Number(netmask.slice(1));
            if (!(bits >= 0 && bits <= 32)) throw new Error('无效的前缀长度');
            maskInt = bits === 0 ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0);
        }
    }

    const invMask = (~maskInt) >>> 0;
    const hostCount = invMask + 1;
    if (hostCount <= 256) {
        const network = (ipInt & maskInt) >>> 0;
        const start = hostCount > 2 ? network + 1 : network;
        const end = hostCount > 2 ? network + hostCount - 2 : network + hostCount - 1;
        const list = [];
        for (let n = start; n <= end; n++) list.push(toStr(n));
        return list;
    }
    // 大网段：只扫 IP 所在 /24 的 254 个地址
    const slash24 = (ipInt & 0xFFFFFF00) >>> 0;
    const list = [];
    for (let i = 1; i <= 254; i++) list.push(toStr(slash24 + i));
    return list;
}

function createMetadata(fileName, fileSize) {
    const meta = { fileName: safeFileName(fileName), fileSize: fileSize };
    return Buffer.concat([Buffer.from(JSON.stringify(meta) + '\n', 'utf8'), MARKER]);
}

function createMetadataParser() {
    let buffer = Buffer.alloc(0);
    let done = false;
    let meta = null;
    let remainder = Buffer.alloc(0);
    let failed = false;
    return {
        get done() { return done; },
        get meta() { return meta; },
        get remainder() { return remainder; },
        get failed() { return failed; },
        push(chunk) {
            if (done) return chunk;
            buffer = Buffer.concat([buffer, chunk]);
            const idx = buffer.indexOf(MARKER);
            if (idx < 0) {
                if (buffer.length > MAX_META_BYTES + MARKER.length) {
                    failed = true; done = true;
                    throw new Error('元数据过长');
                }
                return Buffer.alloc(0);
            }
            try {
                const head = buffer.subarray(0, idx).toString('utf8').trim();
                meta = JSON.parse(head);
                if (!Number.isFinite(meta.fileSize) || meta.fileSize < 0) throw new Error('无效文件大小');
                meta.fileName = safeFileName(meta.fileName, 'recv_' + Date.now() + '.bin');
                remainder = buffer.subarray(idx + MARKER.length);
                if (remainder.length && remainder[0] === 0x0a) remainder = remainder.subarray(1);
            } catch (e) {
                failed = true; done = true;
                throw new Error('元数据解析失败: ' + e.message);
            }
            buffer = Buffer.alloc(0);
            done = true;
            return remainder;
        }
    };
}

const UNIT_MULTIPLIERS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

function toBytes(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n * (UNIT_MULTIPLIERS[String(unit).toUpperCase()] || 1);
}

function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / (1024 ** i)).toFixed(2) + ' ' + units[i];
}

function bandwidthToMbps(text) {
    if (typeof text !== 'string') return null;
    const m = text.match(/([\d.]+)\s*([KMGT]?)bits?\/sec/i);
    if (!m) return null;
    const value = parseFloat(m[1]);
    if (!Number.isFinite(value)) return null;
    const scale = { '': 1 / 1e6, K: 1 / 1000, M: 1, G: 1000, T: 1e6 }[m[2].toUpperCase()] || 1;
    return value * scale;
}

function parseIperfLine(line) {
    if (typeof line !== 'string' || !line.trim()) return { message: line, speed: null };
    const trimmed = line.trim();
    if (/^-+$/.test(trimmed)) return { message: null, speed: null };
    if (/Interval/.test(trimmed) && /Bandwidth/.test(trimmed)) return { message: trimmed, speed: null };
    const dataMatch = trimmed.match(/\[\s*\d+\]\s+([\d.]+)-([\d.]+)\s+sec\s+([\d.]+\s+\w+Bytes)\s+([\d.]+\s+\w+bits\/sec)/);
    if (dataMatch) return { message: trimmed, speed: bandwidthToMbps(dataMatch[4]) };
    return { message: trimmed, speed: null };
}

function parseProgressLine(line) {
    if (typeof line !== 'string') return null;
    const full = line.match(/\[Progress\]\s*([\d.]+)%\s*\|\s*([\d.]+)\s*([KMGT]?B)\s*\/\s*([\d.]+)\s*([KMGT]?B)(?:\s*\|\s*Rate:\s*([\d.]+)\s*Mbps)?/i);
    if (full) {
        const speedMbps = full[6] !== undefined ? parseFloat(full[6]) : 0;
        return {
            percent: parseFloat(full[1]) || 0,
            currentBytes: toBytes(full[2], full[3]),
            totalBytes: toBytes(full[4], full[5]),
            speedMbps: Number.isFinite(speedMbps) ? speedMbps : 0
        };
    }
    const simple = line.match(/\[Progress\]\s*([\d.]+)%/);
    if (simple) return { percent: parseFloat(simple[1]) || 0, currentBytes: 0, totalBytes: 0, speedMbps: 0 };
    return null;
}

/**
 * 自动更新状态 → 面向用户的一行提示。纯函数，供主进程与测试共用。
 */
function updaterMessage(state, version) {
    switch (state) {
        case 'downloaded':
            return { state, version, message: `新版本 ${version || ''} 已就绪，退出应用时将自动安装` };
        case 'available':
            return { state, version, message: '发现新版本，正在后台下载…' };
        case 'up-to-date':
            return { state, version, message: '已是最新版本' };
        case 'error':
            return { state, version, message: `检查更新失败: ${version || '未知错误'}` };
        default:
            return { state: state || 'unknown', version, message: '' };
    }
}

function formatIperfError(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const t = text.trim();
    const hints = [
        ['Connection refused', '❌ 连接被拒绝 - 请检查服务端是否已启动'],
        ['No route to host', '❌ 无法到达主机 - 请检查网络连接和IP地址'],
        ['Address already in use', '❌ 端口已被占用 - 请更换端口或关闭占用该端口的程序'],
        ['Permission denied', '❌ 权限不足 - 某些端口可能需要管理员权限']
    ];
    for (const pair of hints) if (t.includes(pair[0])) return pair[1];
    return '⚠️ ' + t;
}

module.exports = {
    MARKER, MAX_META_BYTES,
    isValidIPv4, isValidHost, isValidTarget, isValidPort, clampInt,
    pingArgs, scanPingArgs, iperfServerArgs, iperfClientArgs,
    hruftSendArgs, hruftRecvArgs,
    safeFileName, createMetadata, createMetadataParser,
    toBytes, formatFileSize, bandwidthToMbps, parseIperfLine, parseProgressLine,
    expandSubnet, MAX_SCAN_ADDRESSES,
    updaterMessage,
    formatIperfError
};
