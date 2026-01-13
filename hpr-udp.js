'use strict';

const dgram = require('dgram');
const {Writable, Readable} = require('stream');
const EventEmitter = require('events');

/* ===================== CONSTANTS ===================== */

const CONSTANTS = {
    HEADER_SIZE: 16,
    TYPE_DATA: 1,
    TYPE_ACK: 2,
    TYPE_NACK: 3,
    TYPE_FIN: 4,
    TYPE_SYN: 5,
    TYPE_SYN_ACK: 6,
    TYPE_FIN_ACK: 7,
    TYPE_KEEPALIVE: 8,

    DEFAULT_MSS: 8192,
    LOCALHOST_MSS: 16384,

    DEFAULT_WINDOW: 32768,
    LOCALHOST_WINDOW: 131072,

    MIN_RTO: 1,
    MAX_RTO: 2000,
    CONNECT_TIMEOUT: 5000,
    KEEPALIVE_INTERVAL: 30000,
    NACK_DELAY_MS: 20,
    MAX_NACK_RETRIES: 3
};

/* ===================== PROTOCOL ===================== */

const Protocol = {
    writeHeader(buf, seq, ack, type, len, ts) {
        buf.writeUInt32BE(seq >>> 0, 0);
        buf.writeUInt32BE(ack >>> 0, 4);
        buf.writeUInt32BE(ts >>> 0, 8);
        buf.writeUInt16BE(type, 12);
        buf.writeUInt16BE(len, 14);
    },
    parseHeader(buf) {
        return {
            seq: buf.readUInt32BE(0),
            ack: buf.readUInt32BE(4),
            ts: buf.readUInt32BE(8),
            type: buf.readUInt16BE(12),
            len: buf.readUInt16BE(14)
        };
    }
};

/* ===================== LOGGER ===================== */

class Logger {
    constructor(enable = true, prefix = '') {
        this.enable = enable;
        this.prefix = prefix;
        this.lastStat = Date.now();
        this.txBytes = 0;
        this.rxBytes = 0;
    }

    log(...args) {
        if (this.enable) {
            console.log(new Date().toISOString(), this.prefix, ...args);
        }
    }

    countTx(bytes) {
        this.txBytes += bytes;
        const now = Date.now();
        if (now - this.lastStat >= 1000) {
            const mbps = (this.txBytes * 8 / (1024 * 1024)).toFixed(2);
            this.log('[STAT] TX:', mbps, 'Mbps');
            this.txBytes = 0;
            this.lastStat = now;
        }
    }

    countRx(bytes) {
        this.rxBytes += bytes;
    }

    getStats() {
        return {
            txBytes: this.txBytes,
            rxBytes: this.rxBytes
        };
    }
}

/* ===================== SENDER STREAM ===================== */

class UdpSenderStream extends Writable {
    constructor(targetPort, targetAddress, options = {}) {
        // Fix constructor parameter names to match original
        super({highWaterMark: 64 * 1024 * 1024});

        this.targetPort = targetPort;
        this.targetAddress = targetAddress;
        this.isLocal = targetAddress === '127.0.0.1' ||
            targetAddress === 'localhost' ||
            targetAddress === '::1';

        this.mss = this.isLocal ? CONSTANTS.LOCALHOST_MSS : CONSTANTS.DEFAULT_MSS;
        this.windowSize = this.isLocal ? CONSTANTS.LOCALHOST_WINDOW : CONSTANTS.DEFAULT_WINDOW;

        this.seq = 1;
        this.ackedUntil = 0; // FIX #1: Track highest consecutively acked seq
        this.inflight = new Map();

        this.srtt = 50;
        this.rttvar = 20;
        this.rto = options.rto || 100;
        this.statsSeq = 0; // 添加统计序列号

        // Connection state
        this.state = 'CLOSED'; // CLOSED, CONNECTING, ESTABLISHED, FIN_WAIT, CLOSING
        this.connectionTimer = null;
        this.keepaliveTimer = null;

        this.socket = options.socket || dgram.createSocket('udp4');
        this.ownSocket = !options.socket;

        this.logger = new Logger(options.log !== false, '[SENDER]');

        // 添加统计计数器
        this.lastSeqForStats = 0;

        this.emitter = new EventEmitter();

        // Bind emitter methods
        this.on = this.emitter.on.bind(this.emitter);
        this.emit = this.emitter.emit.bind(this.emitter);
        this.once = this.emitter.once.bind(this.emitter);

        this.socket.on('message', msg => this._onMessage(msg));
        this.socket.on('error', err => {
            this.logger.log('[ERROR] Socket error:', err.message);
            this.emit('error', err);
        });

        this._startTimer();
    }

    // Public connect method
    connect() {
        if (this.state !== 'CLOSED') {
            return;
        }

        this.state = 'CONNECTING';
        this.logger.log('[CONN] Connecting...');

        // Send SYN
        const syn = Buffer.allocUnsafe(CONSTANTS.HEADER_SIZE);
        Protocol.writeHeader(syn, 0, 0, CONSTANTS.TYPE_SYN, 0, Date.now() >>> 0);
        this.socket.send(syn, this.targetPort, this.targetAddress);

        // Set connection timeout
        this.connectionTimer = setTimeout(() => {
            if (this.state === 'CONNECTING') {
                this.logger.log('[CONN] Connection timeout');
                this._closeConnection();
                this.emit('error', new Error('Connection timeout'));
            }
        }, CONSTANTS.CONNECT_TIMEOUT);
    }

    _write(chunk, encoding, callback) {
        // 添加调试日志
        console.log(`[UdpSenderStream] _write 被调用, chunk长度: ${chunk.length}, 当前状态: ${this.state}`);

        // Only allow writing in ESTABLISHED state
        if (this.state !== 'ESTABLISHED') {
            console.log(`[UdpSenderStream] 连接状态不正确: ${this.state}, 无法写入`);
            callback(new Error('Connection not established'));
            return;
        }

        let offset = 0;

        const sendLoop = () => {
            // Flow control
            if (this.inflight.size >= this.windowSize) {
                this.logger.log('[FLOW] Window full, waiting...');
                this.once('drainWindow', sendLoop);
                return;
            }

            while (offset < chunk.length && this.inflight.size < this.windowSize) {
                const size = Math.min(this.mss, chunk.length - offset);
                const payload = chunk.subarray(offset, offset + size);
                this._sendPacket(payload, this.seq++, false);
                offset += size;
                this.logger.countTx(size);

                // Emit stats periodically (减少频率)
                this.statsSeq++;
                if (this.statsSeq % 500 === 0) {
                    this.emit('stats', {
                        seq: this.seq,
                        rtt: Math.round(this.srtt),
                        window: this.inflight.size,
                        windowSize: this.windowSize,
                        rto: Math.round(this.rto)
                    });
                }
            }

            if (offset >= chunk.length) {
                console.log(`[UdpSenderStream] 写入完成, 总计: ${offset} bytes`);
                callback();
            } else {
                this.logger.log('[FLOW] Window限制, 等待...');
                this.once('drainWindow', sendLoop);
            }
        };

        sendLoop();
    }

    _sendPacket(payload, seq, isRetrans = false) {
        if (this.inflight.size >= this.windowSize) {
            this.logger.log('[WARN] Window full, dropping packet seq=', seq);
            return;
        }

        const header = Buffer.allocUnsafe(CONSTANTS.HEADER_SIZE);
        const now = Date.now();
        Protocol.writeHeader(header, seq, 0, CONSTANTS.TYPE_DATA, payload.length, now >>> 0);

        // Zero-copy send
        this.socket.send([header, payload], this.targetPort, this.targetAddress);

        if (!isRetrans) {
            this.inflight.set(seq, {
                header: header,
                payload: payload,
                sent: now,
                lastSend: now,
                fastResend: false,
                retransCount: 0
            });
        }

        this.logger.log(isRetrans ? '[RETX]' : '[SEND]', 'seq=', seq,
            'size=', payload.length, 'inflight=', this.inflight.size);
    }

    _onMessage(msg) {
        try {
            const h = Protocol.parseHeader(msg);

            // Handle connection control messages
            switch (h.type) {
                case CONSTANTS.TYPE_SYN_ACK:
                    this._handleSynAck();
                    break;
                case CONSTANTS.TYPE_ACK:
                    this._handleAck(h.ack);
                    break;
                case CONSTANTS.TYPE_NACK:
                    this._handleNack(h.ack);
                    break;
                case CONSTANTS.TYPE_FIN_ACK:
                    this._handleFinAck();
                    break;
                case CONSTANTS.TYPE_KEEPALIVE:
                    // Just ignore, connection is alive
                    break;
            }
        } catch (err) {
            this.logger.log('[ERROR] Failed to parse message:', err.message);
        }
    }

    _handleSynAck() {
        if (this.state === 'CONNECTING') {
            clearTimeout(this.connectionTimer);
            this.state = 'ESTABLISHED';
            this.logger.log('[CONN] Connection established');

            // Start keepalive
            this._startKeepalive();

            this.emit('connect');
        }
    }

    // FIX #1: Correct ACK handling with ackedUntil
    _handleAck(ackSeq) {
        if (ackSeq <= this.ackedUntil) {
            return; // Old ACK, ignore
        }

        let freed = false;
        let totalFreed = 0;

        // ACK all packets from ackedUntil+1 to ackSeq
        for (let seq = this.ackedUntil + 1; seq <= ackSeq; seq++) {
            const item = this.inflight.get(seq);
            if (item) {
                const rtt = Date.now() - item.sent;
                this._updateRtt(rtt);
                this.inflight.delete(seq);
                freed = true;
                totalFreed++;
            }
        }

        // Update ackedUntil
        this.ackedUntil = Math.max(this.ackedUntil, ackSeq);

        if (freed) {
            this.emit('drainWindow');
        }

        this.logger.log('[ACK]', 'ack=', ackSeq,
            'freed=', totalFreed,
            'inflight=', this.inflight.size,
            'ackedUntil=', this.ackedUntil);
    }

    _handleNack(seq) {
        const item = this.inflight.get(seq);
        if (!item || item.fastResend) {
            return;
        }

        item.fastResend = true;
        item.retransCount++;

        // Fast retransmit
        this._sendPacket(item.payload, seq, true);

        this.logger.log('[NACK]', 'Fast retransmit seq=', seq);
    }

    _handleFinAck() {
        if (this.state === 'FIN_WAIT') {
            clearTimeout(this.connectionTimer);
            this._closeConnection();
        }
    }

    _updateRtt(sample) {
        if (sample <= 0 || sample > 60000) {
            return;
        }

        // Jacobson/Karels algorithm
        this.srtt = 0.875 * this.srtt + 0.125 * sample;
        this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - sample);
        this.rto = Math.min(
            Math.max(this.srtt + 4 * this.rttvar, CONSTANTS.MIN_RTO),
            CONSTANTS.MAX_RTO
        );

        this.logger.log('[RTT]', 'sample=', sample,
            'srtt=', this.srtt.toFixed(1),
            'rto=', this.rto.toFixed(1));
    }

    _startTimer() {
        // Timer for retransmissions
        setInterval(() => {
            // Only check the oldest unacked packet (O(1) check)
            const oldestSeq = this.ackedUntil + 1;
            const item = this.inflight.get(oldestSeq);

            if (!item) {
                return;
            }

            const now = Date.now();
            if (now - item.lastSend >= this.rto) {
                // Timeout retransmission
                this._sendPacket(item.payload, oldestSeq, true);
                item.lastSend = now;
                item.retransCount++;

                // Exponential backoff for timeout retransmissions
                if (item.retransCount > 1) {
                    this.rto = Math.min(this.rto * 1.5, CONSTANTS.MAX_RTO);
                }
            }
        }, this.isLocal ? 1 : 10);
    }

    _startKeepalive() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
        }

        this.keepaliveTimer = setInterval(() => {
            if (this.state === 'ESTABLISHED') {
                const keepalive = Buffer.allocUnsafe(CONSTANTS.HEADER_SIZE);
                Protocol.writeHeader(keepalive, 0, 0, CONSTANTS.TYPE_KEEPALIVE, 0, Date.now() >>> 0);
                this.socket.send(keepalive, this.targetPort, this.targetAddress);
            }
        }, CONSTANTS.KEEPALIVE_INTERVAL);
    }

    _closeConnection() {
        this.state = 'CLOSED';

        if (this.connectionTimer) {
            clearTimeout(this.connectionTimer);
        }
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
        }

        if (this.ownSocket && this.socket) {
            this.socket.close();
        }

        this.logger.log('[CONN] Connection closed');
        this.emit('close');
    }

    // Public end method
    end(callback) {
        console.log(`[UdpSenderStream] end() 被调用, 当前状态: ${this.state}`);

        if (this.state !== 'ESTABLISHED') {
            console.log(`[UdpSenderStream] 状态不正确: ${this.state}, 直接关闭`);
            if (callback) callback();
            return;
        }

        this.state = 'FIN_WAIT';
        this.logger.log('[CONN] Sending FIN, waiting for close');

        // Send FIN
        const fin = Buffer.allocUnsafe(CONSTANTS.HEADER_SIZE);
        Protocol.writeHeader(fin, this.seq, 0, CONSTANTS.TYPE_FIN, 0, Date.now() >>> 0);
        this.socket.send(fin, this.targetPort, this.targetAddress);

        console.log('[UdpSenderStream] FIN包已发送');

        // Wait for FIN-ACK
        this.connectionTimer = setTimeout(() => {
            console.log('[UdpSenderStream] FIN-ACK超时，强制关闭连接');
            this._closeConnection();
            if (callback) callback();
        }, 2000);
    }

    // Cleanup
    destroy() {
        this._closeConnection();
        super.destroy();
    }
}

/* ===================== RECEIVER STREAM ===================== */

class UdpReceiverStream extends Readable {
    constructor(port, options = {}) {
        super({highWaterMark: 64 * 1024 * 1024});

        this.expectedSeq = 1;
        this.buffer = new Map();
        this.remoteInfo = null;

        // FIX #2: NACK management
        this.nackTimers = new Map();
        this.nackCounts = new Map();
        this.pendingNacks = new Set();

        // Connection state
        this.state = 'LISTENING'; // LISTENING, ESTABLISHED, CLOSING, CLOSED
        this.connected = false;

        this.socket = dgram.createSocket('udp4');
        this.port = port;

        this.logger = new Logger(options.log !== false, '[RECEIVER]');

        this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
        this.socket.on('error', err => {
            this.logger.log('[ERROR] Socket error:', err.message);
        });

        this.socket.bind(port);
        this.logger.log('[INIT] Listening on port:', port);
    }

    _onMessage(msg, rinfo) {
        this.remoteInfo = rinfo;

        try {
            const h = Protocol.parseHeader(msg);

            // Handle connection control messages
            switch (h.type) {
                case CONSTANTS.TYPE_SYN:
                    this._handleSyn(rinfo);
                    break;
                case CONSTANTS.TYPE_DATA:
                    this._handleData(h, msg.subarray(CONSTANTS.HEADER_SIZE), rinfo);
                    break;
                case CONSTANTS.TYPE_FIN:
                    this._handleFin(rinfo);
                    break;
                case CONSTANTS.TYPE_KEEPALIVE:
                    // Connection is alive, no action needed
                    break;
            }
        } catch (err) {
            this.logger.log('[ERROR] Failed to parse message:', err.message);
        }
    }

    _handleSyn(rinfo) {
        if (this.state === 'LISTENING') {
            this.state = 'ESTABLISHED';
            this.connected = true;
            this.logger.log('[CONN] Connection established from:', rinfo.address);

            // Send SYN-ACK
            const synAck = Buffer.allocUnsafe(CONSTANTS.HEADER_SIZE);
            Protocol.writeHeader(synAck, 0, 0, CONSTANTS.TYPE_SYN_ACK, 0, Date.now() >>> 0);
            this.socket.send(synAck, rinfo.port, rinfo.address);
        }
    }

    // FIX #2: Improved NACK handling with delay and suppression
    _handleData(h, payload, rinfo) {
        if (this.state !== 'ESTABLISHED') {
            return;
        }

        this.logger.countRx(payload.length);

        if (h.seq === this.expectedSeq) {
            // In-order delivery
            this.push(payload);
            this.expectedSeq++;

            // Deliver any buffered packets
            while (this.buffer.has(this.expectedSeq)) {
                const buffered = this.buffer.get(this.expectedSeq);
                this.push(buffered);
                this.buffer.delete(this.expectedSeq);
                this.expectedSeq++;

                // Clean up NACK state for this sequence
                this._cleanupNackState(this.expectedSeq - 1);
            }

            // Send ACK for the highest in-order packet
            this._sendAck(this.expectedSeq - 1, rinfo);
        } else if (h.seq > this.expectedSeq) {
            // Out-of-order delivery
            if (!this.buffer.has(h.seq)) {
                this.buffer.set(h.seq, payload);
                this.logger.log('[BUFFER]', 'Buffered out-of-order seq=', h.seq,
                    'expected=', this.expectedSeq);

                // Schedule delayed NACK for missing packet
                this._scheduleNack(this.expectedSeq, rinfo);
            }

            // Always ACK the highest consecutive packet we've received
            this._sendAck(this.expectedSeq - 1, rinfo);
        }
        // h.seq < this.expectedSeq: duplicate packet, ignore but still ACK
        else {
            this._sendAck(this.expectedSeq - 1, rinfo);
        }
    }

    _handleFin(rinfo) {
        if (this.state === 'ESTABLISHED') {
            this.state = 'CLOSING';
            this.logger.log('[CONN] Received FIN, closing connection');

            // Send FIN-ACK
            const finAck = Buffer.allocUnsafe(CONSTANTS.HEADER_SIZE);
            Protocol.writeHeader(finAck, 0, 0, CONSTANTS.TYPE_FIN_ACK, 0, Date.now() >>> 0);
            this.socket.send(finAck, rinfo.port, rinfo.address);

            // Push EOF to stream
            this.push(null);

            // Close after a short delay
            setTimeout(() => {
                this.close();
            }, 100);
        }
    }

    _sendAck(ackSeq, rinfo) {
        const ack = Buffer.allocUnsafe(CONSTANTS.HEADER_SIZE);
        Protocol.writeHeader(ack, 0, ackSeq, CONSTANTS.TYPE_ACK, 0, Date.now() >>> 0);
        this.socket.send(ack, rinfo.port, rinfo.address);
    }

    // FIX #2: Scheduled NACK with retry limit
    _scheduleNack(missingSeq, rinfo) {
        // Check if we already have a pending NACK for this sequence
        if (this.pendingNacks.has(missingSeq)) {
            return;
        }

        // Check retry count
        const nackCount = this.nackCounts.get(missingSeq) || 0;
        if (nackCount >= CONSTANTS.MAX_NACK_RETRIES) {
            this.logger.log('[NACK]', 'Max retries reached for seq=', missingSeq);
            return;
        }

        // Schedule delayed NACK
        const timer = setTimeout(() => {
            this._sendNack(missingSeq, rinfo);
            this.pendingNacks.delete(missingSeq);
            this.nackCounts.set(missingSeq, nackCount + 1);

            // Schedule another NACK if still missing
            if (nackCount + 1 < CONSTANTS.MAX_NACK_RETRIES) {
                this._scheduleNack(missingSeq, rinfo);
            }
        }, CONSTANTS.NACK_DELAY_MS);

        this.nackTimers.set(missingSeq, timer);
        this.pendingNacks.add(missingSeq);
    }

    _sendNack(seq, rinfo) {
        const nack = Buffer.allocUnsafe(CONSTANTS.HEADER_SIZE);
        Protocol.writeHeader(nack, 0, seq, CONSTANTS.TYPE_NACK, 0, Date.now() >>> 0);
        this.socket.send(nack, rinfo.port, rinfo.address);

        this.logger.log('[NACK]', 'Requesting missing seq=', seq);
    }

    _cleanupNackState(seq) {
        if (this.nackTimers.has(seq)) {
            clearTimeout(this.nackTimers.get(seq));
            this.nackTimers.delete(seq);
        }
        this.nackCounts.delete(seq);
        this.pendingNacks.delete(seq);
    }

    _read() {
        // Nothing to do here, data is pushed asynchronously
    }

    close() {
        this.state = 'CLOSED';

        // Cleanup all NACK timers
        for (const timer of this.nackTimers.values()) {
            clearTimeout(timer);
        }
        this.nackTimers.clear();
        this.nackCounts.clear();
        this.pendingNacks.clear();

        if (this.socket) {
            this.socket.close();
        }

        this.logger.log('[CONN] Receiver closed');
    }
}

/* ===================== EXPORT ===================== */

module.exports = {
    UdpSenderStream,
    UdpReceiverStream,
    Protocol,
    CONSTANTS
};