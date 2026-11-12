# NetTestTool Pro

一站式网络测试工具：网卡信息、Ping、局域网扫描、iPerf 2 吞吐量测试，以及基于 HRUFT 的可靠 UDP 文件传输。基于 Electron + Node.js，界面为深色主题。

> 当前版本：**v1.5.9**。本项目采用 [MIT License](LICENSE)。

## 功能

| 模块 | 说明 |
| --- | --- |
| 网络信息 | 列出本机非回环 IPv4 网卡、掩码、MAC 与系统 ARP 表 |
| Ping | 自定义目标、间隔与包大小，Chart.js 实时绘制延迟曲线并统计最小/平均/最大 |
| 局域网扫描 | 按网卡掩码计算扫描范围（大网段自动收敛到所在 /24，最多 20 并发），显示在线设备 IP/MAC 与进度 |
| 吞吐量测试 | 内置 iPerf 2，支持服务端/客户端、TCP/UDP，实时带宽曲线与丢包提示 |
| 文件传输 | HRUFT（可靠 UDP，BLAKE3 校验，支持 fast-start 弱网加速）与标准 TCP 双模式；支持多文件批量发送、发送前后文件大小一致性校验、校验失败时自动删除损坏的临时文件 |

**关于 iPerf 版本**：界面与打包二进制只提供 **iPerf 2**。上游在 `6bd6ad6` 中移除了不稳定的 iPerf 3 支持，本版本沿用该决定。

## 快速开始

前置要求：Node.js 20+、npm 10+。

```bash
git clone https://github.com/JinBiLianShao/NetTestTool.git
cd NetTestTool
npm install
npm run build:assets   # 从 main.ico 生成 build/ 下的图标资源
npm run setup:binaries # 准备 iPerf 2（Linux/macOS 链接系统命令，Windows 自动下载）
npm start
```

仓库已附带 `bin/linux/hruft`、`bin/windows/hruft.exe` 与 Windows 的 `iperf2.exe`。Linux 的 `bin/linux/iperf2` 由 iperf 2.2.1 源码静态编译产生，随包分发。macOS 的 HRUFT/iPerf 二进制需由对应平台自行提供（见 CI 工作流）。

## 测试

测试文件全部放在项目目录 `tests/` 下：

```bash
npm test              # 43 个用例：纯逻辑 + 真实 TCP socket + 真实 iperf2/HRUFT 二进制
npm run test:coverage # 生成 coverage/ 报告
```

- `tests/core.test.js`：输入白名单（命令注入防御）、参数构造、文件名净化、二进制元数据流解析、单位换算与 iperf/HRUFT 输出解析。
- `tests/integration.test.js`：真实 TCP 传输（256 KB 随机二进制、中文文件名、逐字节分片、含非法 UTF-8 字节载荷）、真实 iPerf 2 本机跑一轮、HRUFT 二进制可执行性。

## 打包

```bash
npm run build:assets          # 生成图标资源（幂等）
npm run prebuild              # 校验当前平台二进制与构建资源
npm run build:linux           # AppImage / deb / rpm
npm run build:win             # NSIS 安装程序 / portable（Linux 上通过 wine + NSIS 交叉构建）
npm run build:publishable     # 一次构建 Windows + Linux，不自动发布
```

产物输出到 `app_file/`。RPM 未列入默认目标，因为部分构建环境缺少 `rpmbuild`（fpm 会因此中止整个构建）；如已安装 rpm 工具链，可运行 `npm run build:rpm` 单独产出 `.rpm`。

| 平台 | 产物 | 构建环境 |
| --- | --- | --- |
| Windows x64 | `.exe` (NSIS)、portable `.exe` | Linux（wine + NSIS）或 Windows |
| Linux x64 | `.AppImage`、`.deb` | Linux |
| macOS | `.dmg`、`.zip` | **必须 macOS**（DMG 依赖 hdiutil，签名/公证需要 Apple 证书） |

Linux 无法产出可验证的 macOS DMG，因此本仓库的 Release 提供 Windows 与 Linux 安装包；macOS 构建由 [`.github/workflows/release.yml`](.github/workflows/release.yml) 在 macOS runner 上完成。

## 项目结构

```text
├── main.js               # Electron 主进程：IPC、子进程、网络与文件传输
├── preload.js            # contextBridge 安全网桥
├── renderer.js           # 渲染进程：UI 与 Chart.js 图表
├── index.html / styles.css
├── lib/core.js           # 与 Electron 无关的纯逻辑（主进程与测试共用）
├── lib/main/             # 主进程模块（runtime/system/ping/scan/throughput/transfer）
├── bin/                  # 各平台 HRUFT 与 iPerf 2 二进制
├── build/                # electron-builder 图标资源（由 build:assets 生成）
├── scripts/              # 构建资源、二进制准备、预检脚本
├── tests/                # 深度测试（项目内）
└── .github/workflows/    # macOS 发版 CI
```

## 安全说明

- 所有外部命令使用 `spawn` + 参数数组，用户输入经白名单校验，不拼接 shell 字符串。
- 接收端对远端提供的文件名做净化，拒绝路径穿越，且只写入用户选定的保存目录。
- 渲染进程隔离（`contextIsolation: true`、`nodeIntegration: false`），网络派生数据写入 DOM 前统一转义。

## v1.5.9 更新（本版）

- **代码结构**：main.js 从 1480 行拆成 lib/main/ 五个模块加一个薄组合层，共享运行时（路径解析、IPC、并发）收敛到 runtime.js。
- **HRUFT 弱网加速**：文件传输面板新增 fast-start 开关，弱网/小文件场景更快。
- **多文件批量发送**：支持一次选择多个文件逐个发送（TCP 与 HRUFT 均可）。
- **发送一致性校验**：发送前记录文件大小，结束后再次核对，传输中被修改会给出告警。
- **校验失败处理**：哈希校验失败时明确提示接收端已删除损坏的 `.part` 临时文件，引导重新传输（与 HRUFT v4.1.0 的实际行为一致）。
- **日志优化**：吞吐量与文件传输日志从逐行刷屏改为「分隔线 + 摘要 + 汇总」的分层格式，关键信息一目了然。
- 自动更新状态机抽成纯函数并纳入测试。

### v1.5.9：修复审查发现的问题（本版）

- **随包 HRUFT 升级到 v4.1.0**：用 /opt 下的 llvm-mingw 重新交叉编译 Windows 二进制、Linux 原生重编，两端实跑确认 --fast-start 真正生效（此前随包是旧版，勾选会报 Unknown option）。Windows 运行时 DLL 一并换成 LLVM 的 libc++.dll / libunwind.dll / libwinpthread-1.dll，移除旧 Cygwin DLL。
- **修正 .part 文案**：HRUFT 校验失败时会删除损坏的 .part，日志与 README 已改为如实提示「请重新传输」。
- 修掉 selectFile() 降级分支弹两次文件选择框、formatIperfError 返回 null 时渲染出「null」日志、release.yml 手动触发时忽略填写的 tag 三处问题。
- **测试闸门**：新增拿随包二进制实跑的集成测试（版本、--fast-start、wine 下跑 Windows exe），CI 的 Windows runner 改为显式 test.skip，不再静默假绿灯。


## 自动更新

Windows 安装版与 Linux 版内置基于 electron-updater 的自动更新，发布渠道为本仓库的 GitHub Releases。应用启动后在后台检查新版本，发现新版本自动下载并在退出时安装（进度以应用内 toast 提示）。便携版（Portable）不参与自动更新。

## 常见问题

**Q: 吞吐量测试提示找不到 iPerf？**  
A: 运行 `npm run setup:binaries`，或按平台安装 `iperf`（Debian/Ubuntu: `sudo apt install iperf`；Arch: `sudo pacman -S iperf2`；macOS: `brew install iperf`）后重跑。

**Q: Linux 上 HRUFT 提示权限不足？**  
A: 运行 `chmod +x bin/linux/hruft`（`npm run prebuild` 会自动修正）。

**Q: 为什么不提供 iPerf 3？**  
A: 上游已移除该支持，界面与打包二进制统一为 iPerf 2。

## 贡献

欢迎 Issue / Pull Request。提交前请确保 `npm test` 通过。

## 许可

[MIT](LICENSE) © 2026 JinBiLianShao
