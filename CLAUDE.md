# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态（务必先读）

- 本仓库目前**只有设计文档，尚无任何代码**：仅有 `README.md` 与 `design_specs.md` 两个文件，也未初始化 git。
- **`design_specs.md`（v1.3）是权威实现规范**。README 中引用的《XPlane12-飞机位置追踪工具-设计文档.md》即指此文件。动手实现任何模块前，必须先阅读 `design_specs.md` 第 15 节对应小节——那里给出了每个文件的路径、职责、函数签名、边界情况处理要求与验收标准（Definition of Done）。实现时允许微调签名，但对外 REST/WS 协议（第 4.3.2、7 节）必须保持不变。
- README 中的目录结构、`.env` 变量表、快速开始步骤均描述的是**目标状态**，不是现状。

## 命令

代码尚未存在。首次创建 `package.json` 时，脚本必须与设计规范 §15.2 一致（ESM：`"type": "module"`，Node ≥ 20）：

```bash
npm install
npm start        # node src/index.js
npm run dev      # node --watch src/index.js
npm run lint     # eslint .
npm run format   # prettier --write .
npm test         # node --test （Node 20 内置测试器，不引入 jest/vitest）
```

- 运行单个测试文件：`node --test path/to/test.test.js`
- 启动后终端应按 §8.2 示例打印局域网访问地址与二维码提示。

## 架构（大图景）

数据流：**X-Plane 12 →（Web API WS 订阅 或 UDP DATA 广播）→ Node 后端 → 节流 → WS 广播 → 浏览器 Leaflet 地图**。无数据库，航迹为内存环形缓冲。

后端（`server/src/`）四个关键层次：

1. **X-Plane 客户端层**：`xplane/webApiClient.js`（方案 A：REST 查 dataref ID + WS 订阅，需 X-Plane 12.1.1+）与 `xplane/udpClient.js`（方案 B：`dgram` 解析二进制 `DATA*` 帧）实现**完全相同的接口**（`connect/disconnect` + `position/connected/disconnected/error` 事件），由 `xplane/xplaneManager.js` 统一调度。
2. **xplaneManager（核心）**：对外唯一事件源（`position` / `status`），内部维护状态机（DISCONNECTED→CONNECTING→SUBSCRIBED→STREAMING）、指数退避重连（1s→2s→5s→10s 封顶）、`flightActive` 判定（§4.5：每 1s 检查 `lastPositionTimestamp` 是否超过 `flightStaleTimeoutMs`，默认 5000ms）。
3. **广播层** `broadcast/wsHub.js`：将 `position` 按固定节拍（`updateHz`，默认 2Hz）节流广播，`status` 变化立即广播不节流；处理客户端 `hello`（回发最新 position + status）/`ping` 消息。
4. **REST 路由** `routes/`：`/api/status`、`/api/config`、`/api/xplane-mode`（GET/POST，模式热切换）、`/api/track?minutes=N`。

前端（`public/`）为无框架原生 JS：`app.js` 入口 → `wsClient.js`（自动重连）→ `mapController.js`（Leaflet 封装，含 `setFlightActive` 置灰切换）+ `ui.js`（信息面板/状态条）+ `settingsPanel.js`（通讯模式设置面板）。Leaflet 优先打包进 `public/vendor/` 本地引用，不强依赖 CDN。

## 关键设计决策（易踩坑）

- **双模式互斥 + 运行时热切换**：Web API 与 UDP 两种模式都必须完整实现，由用户在前端设置面板手动切换（不是自动降级）。`switchMode()` 严格"先断后连"串行执行，需防连点竞态；切换失败保持原模式并返回 `{ error: { code, message } }`。
- **`xplaneConnected` ≠ `flightActive`**：前者是连接是否建立，后者是"是否正在收到有效且新鲜的位置数据"。连接成功但 X-Plane 停在主菜单时 `flightActive=false`，前端地图据此置灰（§6.6，`.map-disabled` CSS class + 两种不同文案的状态条）。这两个维度都走同一条 `xplane_status` WS 消息（§7.2），不开新消息类型。
- **配置优先级**：`.env` 仅在首次启动、`config.json` 不存在时作为默认值；一旦 `config.json` 生成即为唯一真源（设置面板修改写回 `config.json`，不回写 `.env`）。`configStore.js` 写文件须"先写临时文件再 rename"，解析失败时备份为 `config.json.bak` 并回退默认值。
- **节流策略**：向 X-Plane 订阅 5–10Hz，后端缓存最新一条 position、按 `updateHz` 固定节拍广播给前端；多客户端复用同一份序列化 JSON 字符串。
- **只读原则**：本工具只读 X-Plane 数据，绝不写入 dataref / 下发 command。
- **航迹跳变检测**：相邻两点距离超阈值（默认 5km/更新周期，可配）时照常存入 `trackStore` 但标记 `breakBefore: true`，前端在此断开航迹线（teleport 场景）。
- **后端监听 `0.0.0.0`**（供局域网设备访问），X-Plane Web API 只走本机 `127.0.0.1`。

## 代码规范（§15.1）

- 现代 JavaScript（ES2020+，ESM）；文件名小驼峰、类名大驼峰、常量全大写下划线。
- 复杂状态机/协议解析逻辑用**中文注释**说明"为什么"；核心模块公开函数写简要 JSDoc。
- 所有外部交互（连接、文件 IO、端口监听）必须 `try/catch`，禁止未捕获异常导致进程崩溃；REST 错误统一 `{ "error": { "code", "message" } }` 格式（400/404/409/500）。
- 日志用 `pino`：高频 dataref 原始值用 `debug`（默认关闭），连接/切换/启动用 `info`，重连与"无飞行"判定用 `warn`。生产默认 `info`。
- Git 提交遵循 Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`），按里程碑 M1–M8（§13）推进。

## 验收

- 每个模块小节末尾有独立验收标准；总体 DoD 清单在 §15.6。
- 手动测试用例 T1–T10（§15.5）覆盖：无 X-Plane 启动不崩溃、置灰/恢复、双设备一致性、teleport 断线、切换竞态、重启后配置保留、端口占用报错等。实现完一个模块应对照其验收标准自测。
