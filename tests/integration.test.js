'use strict';
/** 端到端集成测试：不依赖 Electron，直接跑真实的二进制与真实的 TCP 传输。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const {spawn} = require('child_process');
const c = require('../lib/core');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ntt-test-'));

function listenServer(port) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const server = net.createServer(socket => {
      const parser = c.createMetadataParser();
      let name = null, size = 0, got = 0;
      socket.on('data', chunk => {
        let payload = chunk;
        if (!parser.done) {
          try { payload = parser.push(chunk); } catch (e) { socket.destroy(); reject(e); return; }
          if (!parser.done) return;
          name = parser.meta.fileName;
          size = parser.meta.fileSize;
        }
        got += payload.length;
        if (payload.length) chunks.push(payload);
        if (parser.done && size > 0 && got >= size) {
          socket.end();
          server.close();
          resolve({name, size, data: Buffer.concat(chunks)});
        }
      });
      socket.on('error', reject);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

afterAll(() => {
  try { fs.rmSync(tmp, {recursive: true, force: true}); } catch (_) {}
});

describe('TCP 文件传输（真实 socket，二进制完整性）', () => {
  test('256KB 随机二进制 + 中文名，元数据标记跨 chunk 拆分后字节完全一致', async () => {
    const payload = crypto.randomBytes(256 * 1024);
    const fileName = '测试 文件 №1.bin';
    const port = 45201;
    const pending = listenServer(port);
    await new Promise(r => setTimeout(r, 30));
    const meta = c.createMetadata(fileName, payload.length);
    const full = Buffer.concat([meta, payload]);
    const socket = net.connect(port, '127.0.0.1', () => {
      const cut = meta.length - 5;
      socket.write(full.subarray(0, cut));
      setTimeout(() => socket.write(full.subarray(cut, cut + 13)), 5);
      setTimeout(() => socket.write(full.subarray(cut + 13)), 10);
    });
    const result = await pending;
    expect(result.name).toBe(fileName);
    expect(result.size).toBe(payload.length);
    expect(result.data.equals(payload)).toBe(true);
    socket.destroy();
  }, 15000);

  test('逐字节喂入也不损坏含非法 UTF-8 字节的载荷', async () => {
    const payload = Buffer.concat([Buffer.from([0xc3, 0x28, 0xff, 0x00, 0x80, 0xfe]), crypto.randomBytes(4096)]);
    const port = 45204;
    const pending = listenServer(port);
    await new Promise(r => setTimeout(r, 30));
    const full = Buffer.concat([c.createMetadata('bin.dat', payload.length), payload]);
    const socket = net.connect(port, '127.0.0.1');
    let i = 0;
    const sendNext = () => {
      if (i >= full.length) return;
      socket.write(full.subarray(i, i + 1)); i++; setImmediate(sendNext);
    };
    socket.on('connect', sendNext);
    const result = await pending;
    expect(result.data.equals(payload)).toBe(true);
    socket.destroy();
  }, 20000);

  test('恶意文件名经端到端链路仍被限制在安全文件名内', async () => {
    const payload = Buffer.from([1, 2, 3]);
    const raw = Buffer.concat([
      Buffer.from(JSON.stringify({fileName: '../../../etc/evil.sh', fileSize: 3}) + '\n'),
      c.MARKER, Buffer.from('\n'), payload
    ]);
    const port = 45202;
    const pending = listenServer(port);
    await new Promise(r => setTimeout(r, 30));
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
    const result = await pending;
    expect(result.name).not.toContain('/');
    expect(result.name).not.toContain('..');
    expect(result.data.equals(payload)).toBe(true);
    socket.destroy();
  }, 15000);
});

describe('随包二进制可用性', () => {
  test('Linux HRUFT 二进制可执行并打印用法', done => {
    const bin = path.join(root, 'bin', 'linux', 'hruft');
    if (!fs.existsSync(bin)) return done();
    fs.chmodSync(bin, 0o755);
    const child = spawn(bin, [], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    child.on('close', () => {
      expect(out).toMatch(/hruft send/);
      expect(out).toMatch(/hruft recv/);
      done();
    });
    child.on('error', done);
  }, 10000);

  test('Linux iPerf2 二进制可执行并报告版本', done => {
    const bin = path.join(root, 'bin', 'linux', 'iperf2');
    if (!fs.existsSync(bin)) return done();
    fs.chmodSync(bin, 0o755);
    const child = spawn(bin, ['--version'], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    child.on('close', () => { expect(out).toMatch(/iperf version 2/); done(); });
    child.on('error', done);
  }, 10000);

  test('iPerf2 本机服务端/客户端真实跑一轮并解析出速率', done => {
    const bin = path.join(root, 'bin', 'linux', 'iperf2');
    if (!fs.existsSync(bin)) return done();
    const port = 45203;
    const server = spawn(bin, c.iperfServerArgs(port, 'tcp', 'iperf2'), {stdio: 'ignore'});
    server.unref();
    let clientOut = '';
    setTimeout(() => {
      const client = spawn(bin, c.iperfClientArgs({
        ip: '127.0.0.1', port, protocol: 'tcp', duration: 1, version: 'iperf2'
      }), {stdio: ['ignore', 'pipe', 'pipe']});
      client.stdout.on('data', d => clientOut += d);
      client.stderr.on('data', d => clientOut += d);
      client.on('close', () => {
        server.kill('SIGKILL');
        const speeds = clientOut.split('\n').map(l => c.parseIperfLine(l).speed).filter(v => v !== null);
        expect(speeds.length).toBeGreaterThan(0);
        expect(speeds.some(v => v > 0)).toBe(true);
        done();
      });
      client.on('error', e => { server.kill('SIGKILL'); done(e); });
    }, 300);
    server.on('error', done);
  }, 20000);
});
