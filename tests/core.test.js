'use strict';
const c = require('../lib/core');

describe('参数校验与输入白名单', () => {
  test('IPv4 合法/非法边界', () => {
    expect(c.isValidIPv4('192.168.1.1')).toBe(true);
    expect(c.isValidIPv4('0.0.0.0')).toBe(true);
    expect(c.isValidIPv4('255.255.255.255')).toBe(true);
    expect(c.isValidIPv4('256.1.1.1')).toBe(false);
    expect(c.isValidIPv4('01.1.1.1')).toBe(false);
    expect(c.isValidIPv4('1.1.1')).toBe(false);
    expect(c.isValidIPv4('1.1.1.1; rm -rf /')).toBe(false);
  });

  test('主机名拒绝 shell 元字符与超长输入', () => {
    expect(c.isValidHost('example.com')).toBe(true);
    expect(c.isValidHost('localhost')).toBe(true);
    expect(c.isValidHost('a'.repeat(254))).toBe(false);
    for (const bad of ['a;id', '$(id)', '`id`', 'a b', 'a|b', 'a&&b', '../x', 'a..b', '-rf']) {
      expect(c.isValidHost(bad)).toBe(false);
      expect(c.isValidTarget(bad)).toBe(false);
    }
  });

  test('端口范围', () => {
    expect(c.isValidPort(1)).toBe(true);
    expect(c.isValidPort(65535)).toBe(true);
    for (const bad of [0, -1, 65536, 1.5, NaN, 'abc', '', null, undefined, '80;id']) {
      expect(c.isValidPort(bad)).toBe(false);
    }
  });

  test('clampInt 把越界/非法值收敛到边界或默认值', () => {
    expect(c.clampInt(5, 1, 10, 3)).toBe(5);
    expect(c.clampInt(-99, 1, 10, 3)).toBe(1);
    expect(c.clampInt(999, 1, 10, 3)).toBe(10);
    expect(c.clampInt(undefined, 1, 10, 3)).toBe(3);
    expect(c.clampInt('abc', 1, 10, 3)).toBe(3);
    expect(c.clampInt(3.9, 1, 10, 3)).toBe(3);
  });
});

describe('命令参数构造（全部为数组，无 shell 拼接）', () => {
  test('Linux/Windows ping 参数', () => {
    expect(c.pingArgs('8.8.8.8', 64, 'linux')).toEqual(['-c', '1', '-s', '64', '-W', '2', '8.8.8.8']);
    expect(c.pingArgs('example.com', 32, 'win32')).toEqual(['-n', '1', '-l', '32', 'example.com']);
    expect(c.pingArgs('8.8.8.8', 999999, 'linux')[3]).toBe('65500');
  });

  test('注入尝试直接抛错，绝不进入命令数组', () => {
    for (const bad of ['8.8.8.8; rm -rf /', '$(curl evil)', 'a && b', 'host`id`']) {
      expect(() => c.pingArgs(bad, 32, 'linux')).toThrow(/无效/);
      expect(() => c.iperfClientArgs({ip: bad, port: 5201, protocol: 'tcp', duration: 5, version: 'iperf2'})).toThrow(/无效/);
      expect(() => c.hruftSendArgs(bad, 5202, '/tmp/f')).toThrow(/无效/);
    }
  });

  test('扫描 ping 参数把超时收敛为整数秒', () => {
    expect(c.scanPingArgs('192.168.1.1', 200, 'linux')).toEqual(['-c', '1', '-W', '1', '-s', '16', '192.168.1.1']);
    expect(c.scanPingArgs('192.168.1.1', 500, 'win32')).toEqual(['-n', '1', '-w', '500', '192.168.1.1']);
    expect(() => c.scanPingArgs('not-an-ip', 500, 'linux')).toThrow(/无效/);
  });

  test('iPerf 服务端/客户端参数', () => {
    expect(c.iperfServerArgs(5201, 'tcp', 'iperf2')).toEqual(['-s', '-p', '5201', '-i', '1']);
    expect(c.iperfServerArgs(5201, 'udp', 'iperf2')).toContain('-u');
    expect(c.iperfServerArgs(5201, 'udp', 'iperf3')).not.toContain('-u');
    expect(c.iperfClientArgs({ip: '10.0.0.1', port: 5201, protocol: 'udp', duration: 10, bandwidth: 50, version: 'iperf2'}))
      .toEqual(['-c', '10.0.0.1', '-p', '5201', '-t', '10', '-i', '1', '-u', '-b', '50M']);
    expect(() => c.iperfClientArgs({ip: '10.0.0.1', port: 0, protocol: 'tcp', duration: 1, version: 'iperf2'})).toThrow(/无效/);
    expect(() => c.iperfServerArgs(5201, 'sctp', 'iperf2')).toThrow(/无效/);
  });

  test('HRUFT 参数与可选配置', () => {
    expect(c.hruftSendArgs('127.0.0.1', 5202, '/tmp/a.bin')).toEqual(['send', '127.0.0.1', '5202', '/tmp/a.bin', '--detailed']);
    expect(c.hruftSendArgs('127.0.0.1', 5202, '/tmp/a.bin', {packetSize: 1400, windowSize: 1048576}))
      .toEqual(['send', '127.0.0.1', '5202', '/tmp/a.bin', '--mss', '1400', '--window', '1048576', '--detailed']);
    expect(c.hruftRecvArgs(5202, '/tmp/out')).toEqual(['recv', '5202', '/tmp/out', '--detailed']);
    expect(() => c.hruftRecvArgs(70000, '/tmp/out')).toThrow(/无效/);
  });
});

describe('文件名安全与 TCP 元数据（路径穿越防御）', () => {
  test('safeFileName 阻断各种穿越与 Windows 保留名', () => {
    expect(c.safeFileName('a.txt')).toBe('a.txt');
    expect(c.safeFileName('../../etc/passwd')).not.toContain('/');
    expect(c.safeFileName('..\\..\\windows\\system32')).not.toContain('\\');
    expect(c.safeFileName('...')).toBe('received.bin');
    expect(c.safeFileName('.hidden')).toBe('hidden');
    expect(c.safeFileName('CON')).toBe('received.bin');
    expect(c.safeFileName('a'.repeat(300))).toHaveLength(255);
    expect(c.safeFileName(null, 'fallback.bin')).toBe('fallback.bin');
  });

  test('createMetadata 生成可被解析的二进制头', () => {
    const buf = c.createMetadata('测试 文件.bin', 1234);
    expect(buf.indexOf(c.MARKER)).toBeGreaterThan(0);
    const parser = c.createMetadataParser();
    const rest = parser.push(buf);
    expect(parser.done).toBe(true);
    expect(parser.meta.fileName).toBe('测试 文件.bin');
    expect(parser.meta.fileSize).toBe(1234);
    expect(rest.length).toBe(0);
  });

  test('标记跨越多个 TCP chunk 时仍能正确拆分', () => {
    const meta = c.createMetadata('split.bin', 10);
    const payload = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x42, 0x00, 0xfe]);
    const stream = Buffer.concat([meta, payload]);
    const parser = c.createMetadataParser();
    let out = Buffer.alloc(0);
    for (let i = 0; i < stream.length; i++) out = Buffer.concat([out, parser.push(stream.subarray(i, i + 1))]);
    expect(parser.done).toBe(true);
    expect(out.equals(payload)).toBe(true);
  });

  test('二进制文件内容含 UTF-8 非法字节时不损坏', () => {
    const payload = Buffer.from([0xc3, 0x28, 0xff, 0x00, 0x80, 0xfe, 0x41]);
    const parser = c.createMetadataParser();
    parser.push(c.createMetadata('bin.dat', payload.length));
    const out = parser.push(payload);
    expect(out.equals(payload)).toBe(true);
  });

  test('恶意文件名在解析阶段即被净化', () => {
    const raw = Buffer.concat([Buffer.from(JSON.stringify({fileName: '../../evil.sh', fileSize: 1}) + '\n'), c.MARKER]);
    const parser = c.createMetadataParser();
    parser.push(raw);
    expect(parser.meta.fileName).not.toContain('/');
    expect(parser.meta.fileName).not.toContain('..');
  });

  test('畸形/过长元数据被拒绝', () => {
    const bad = Buffer.concat([Buffer.from('not-json'), c.MARKER]);
    expect(() => c.createMetadataParser().push(bad)).toThrow(/解析失败/);
    const huge = Buffer.alloc(c.MAX_META_BYTES + c.MARKER.length + 1, 0x41);
    expect(() => c.createMetadataParser().push(huge)).toThrow(/过长/);
    const neg = Buffer.concat([Buffer.from(JSON.stringify({fileName: 'a', fileSize: -1}) + '\n'), c.MARKER]);
    expect(() => c.createMetadataParser().push(neg)).toThrow(/解析失败/);
  });
});

describe('单位换算与输出解析', () => {
  test('toBytes 覆盖 B..TB', () => {
    expect(c.toBytes(1, 'B')).toBe(1);
    expect(c.toBytes(1, 'KB')).toBe(1024);
    expect(c.toBytes(1.5, 'MB')).toBe(1572864);
    expect(c.toBytes(2, 'GB')).toBe(2147483648);
    expect(c.toBytes(1, 'TB')).toBe(1099511627776);
    expect(c.toBytes(-1, 'MB')).toBe(0);
    expect(c.toBytes('x', 'MB')).toBe(0);
  });

  test('formatFileSize 边界', () => {
    expect(c.formatFileSize(0)).toBe('0 B');
    expect(c.formatFileSize(1024)).toBe('1.00 KB');
    expect(c.formatFileSize(1536)).toBe('1.50 KB');
    expect(c.formatFileSize(1048576)).toBe('1.00 MB');
    expect(c.formatFileSize(NaN)).toBe('0 B');
  });

  test('bandwidthToMbps 统一换算 K/M/G/T', () => {
    expect(c.bandwidthToMbps('94.5 Mbits/sec')).toBeCloseTo(94.5);
    expect(c.bandwidthToMbps('1.25 Gbits/sec')).toBeCloseTo(1250);
    expect(c.bandwidthToMbps('950 Kbits/sec')).toBeCloseTo(0.95);
    expect(c.bandwidthToMbps('2 Tbits/sec')).toBeCloseTo(2000000);
    expect(c.bandwidthToMbps('1000000 bits/sec')).toBeCloseTo(1);
    expect(c.bandwidthToMbps('n/a')).toBeNull();
  });

  test('parseIperfLine 从 iperf2/iperf3 数据行提取 Mbps', () => {
    expect(c.parseIperfLine('[  1] 0.00-1.00 sec  11.3 MBytes  94.5 Mbits/sec').speed).toBeCloseTo(94.5);
    expect(c.parseIperfLine('[  5] 1.00-2.00 sec  1.25 GBytes  10.7 Gbits/sec').speed).toBeCloseTo(10700);
    expect(c.parseIperfLine('[  1] 0.00-1.00 sec   128 KBytes  1.05 Mbits/sec  0.012 ms  0/89 (0%)').speed).toBeCloseTo(1.05);
    expect(c.parseIperfLine('-------------------------------------------------').message).toBeNull();
    expect(c.parseIperfLine('Interval       Transfer     Bandwidth').speed).toBeNull();
    expect(c.parseIperfLine('').speed).toBeNull();
    expect(c.parseIperfLine(null).speed).toBeNull();
  });

  test('parseProgressLine 支持 B..TB 与可选速率', () => {
    expect(c.parseProgressLine('[Progress] 42.5% | 4.00 MB / 10.00 MB | Rate: 101.5 Mbps'))
      .toMatchObject({percent: 42.5, currentBytes: 4194304, totalBytes: 10485760, speedMbps: 101.5});
    const tb = c.parseProgressLine('[Progress] 1.0% | 1.00 TB / 2.00 TB');
    expect(tb.totalBytes).toBe(2 * 1024 ** 4);
    expect(tb.speedMbps).toBe(0);
    expect(c.parseProgressLine('[Progress] 7%').percent).toBe(7);
    expect(c.parseProgressLine('no progress')).toBeNull();
    expect(c.parseProgressLine(null)).toBeNull();
  });

  test('formatIperfError 给出友好提示', () => {
    expect(c.formatIperfError('connect: Connection refused')).toContain('连接被拒绝');
    expect(c.formatIperfError('bind: Address already in use')).toContain('端口已被占用');
    expect(c.formatIperfError('  ')).toBeNull();
    expect(c.formatIperfError('some unknown error')).toContain('⚠️');
  });
});
