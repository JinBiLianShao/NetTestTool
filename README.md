
# 🚀 NetTestTool Pro

**NetTestTool Pro** 是一款基于 Electron 开发的一站式专业网络测试工具。它集成了常规的网络诊断功能与高性能的自定义传输协议，旨在为开发者和网络工程师提供一个可视化、易用且功能强大的调试环境。

---

## ✨ 核心特性

* **📊 网络信息可视化**：实时查看本机网卡接口、IP 地址、MAC 地址及系统 ARP 表。
* **⚡ 增强型 Ping 测试**：支持自定义频率与数据包大小，并结合 **Chart.js** 实现延迟波动的实时可视化呈现。
* **🔍 局域网扫描**：快速扫描子网活跃设备，支持基础端口扫描功能。
* **🚀 HRUFT 传输协议**：集成 **High-Reliability UDP File Transfer (HRUFT)** 协议，在恶劣网络环境下提供比传统 TCP 更高效、可靠的文件传输能力。
* **📈 吞吐量测试 (iPerf)**：无缝集成 iPerf2 与 iPerf3，支持服务端/客户端模式，实时绘制带宽曲线。
* **📂 双模式文件传输**：支持标准 TCP 传输与高性能 HRUFT 传输，内置传输进度、速度计算及剩余时间预测。
* **🌙 现代深色主题**：精心设计的 UI 界面，兼顾专业感与长时间使用的舒适度。

---

## 🛠️ 技术栈

* **Frontend**: HTML5, CSS3 (CSS Variables), JavaScript (ES6+)
* **Runtime**: [Electron](https://www.electronjs.org/)
* **Visualization**: [Chart.js](https://www.chartjs.org/)
* **Backend Support**: Node.js `child_process`, `net`, `dgram`
* **Third-party Binaries**: iPerf2, iPerf3, HRUFT Core

---

## 🚀 快速开始

### 前置要求

* [Node.js](https://nodejs.org/) (建议 v16.x 或更高)
* npm 或 yarn

### 安装步骤

1. **克隆仓库**
```bash
git clone https://github.com/JinBiLianShao/NetTestTool.git
cd NetTestTool

```


2. **安装依赖**
```bash
npm install
或
cnpm install

```


3. **配置二进制环境**
   项目依赖于特定平台的二进制文件（HRUFT, iPerf）。运行以下脚本进行初始化：
```bash
npm run setup:binaries
或
npm run setup:hruft

```


4. **启动开发模式**
```bash
npm start

```



---

## 📦 打包与构建

项目使用 `electron-builder` 进行跨平台打包。在执行构建前，脚本会自动运行 `pre-build-check.js` 确保所有平台的二进制文件就绪。

* **Windows**: `npm run build:win`
* **macOS**: `npm run build:mac`
* **Linux**: `npm run build:linux`
* **全平台**: `npm run build:all`

---

## 📂 项目结构

```text
├── bin/                # 核心二进制文件 (hruft, iperf)
├── scripts/            # 构建与环境部署脚本
├── main.js             # Electron 主进程逻辑 (系统交互, IPC 响应)
├── preload.js          # 预加载脚本 (安全网桥)
├── renderer.js         # 前端渲染层逻辑 (UI 控制, 图表渲染)
├── index.html          # 主界面结构
├── styles.css          # 现代深色主题样式
└── package.json        # 项目配置与脚本定义

```

---

## ⚙️ 常见问题

**Q: 为什么 HRUFT 无法启动？**
A: 请确保 `bin/` 目录下对应操作系统的 `hruft` 可执行文件具有执行权限。在 Linux/macOS 上可运行 `chmod +x bin/xxx/hruft`。

**Q: 支持测试哪些协议的吞吐量？**
A: 目前深度集成了 iPerf2 和 iPerf3，可以测试 TCP 和 UDP 的带宽、抖动及丢包率。

---

## 🤝 贡献指南

欢迎提交 Issue 或 Pull Request 来完善此项目！

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

---

## 📄 开源协议

本项目采用 **MIT License**。详情请参阅 [LICENSE](https://www.google.com/search?q=LICENSE) 文件。

---

**如果您觉得这个工具有帮助，请给一个 ⭐️ Star！**