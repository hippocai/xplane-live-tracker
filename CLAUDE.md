# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态（务必先读）

- **v1 已实现**（对应设计文档里程碑 M1–M7，外加 §9 的 ACCESS_TOKEN 可选鉴权）。代码位于 `server/src/`（后端）与 `public/`（前端）。
- **`design_specs.md`（v1.3）是权威实现规范**。README 中引用的《XPlane12-飞机位置追踪工具-设计文档.md》即指此文件。改动任何模块前，先读 `design_specs.md` 第 15 节对应小节——那里有每个文件的职责、函数签名、边界情况处理要求与验收标准。实现允许微调签名，但对外 REST/WS 协议（第 4.3.2、7 节）必须保持不变。
- **未实现的项**：M8 可选项中的 Google Maps 底图切换（`mapController.js` 目前无论 provider 一律用 OSM 瓦片兜底，参数与 `/api/config` 字段已预留）。
- **UDP 行映射**：X-Plane DATA 广播的行号映射集中在 `server/src/xplane/udpClient.js` 顶部的 `DATA_ROW_MAP`（含"需要在 X-Plane Data Output 中启用哪些行"的说明）。若某版本行号定义有出入，只调该表即可。UDP 解析做了小端/大端自适应探测。

## 命令

```bash
npm install      # postinstall 会把 Leaflet 复制到 public/vendor/（勿提交 vendor）
npm start        # node server/src/index.js
npm run dev      # node --watch server/src/index.js
npm run lint     # eslint .
npm run format   # prettier --write .
npm test         # node --test server/test/*.test.js（Node 内置测试器，不引入 jest/vitest）
```

测试覆盖三层（改前端 JS 或后端协议后都应跑 `npm test`）：
- 后端单元：trackStore / configStore / UDP 解析 / WebAPI 数值映射 / geo 坐标转换（proj4 oracle）
- 前端模块（node 直接 import public/js，用极简 DOM/Leaflet/WebSocket/fetch 替身，见 `server/test/frontendHelpers.js`）：api / ui / wsClient / mapController（含底图切换与迟滞）/ settingsPanel / baiduCrs / frontendShape（防命名空间误用回归）
- 服务端集成 `serverIntegration.test.js`：spawn 真实服务进程，覆盖全部 REST 接口与 WS hello/ping 协议
- 注意：前端模块测试若断言失败，务必保证 connect() 建立的定时器被清理（用例用 `t.after` 兜底），否则泄漏的 setInterval 会让测试进程永不退出（已踩过）

- 运行单个测试文件：`node --test server/test/trackStore.test.js`
- 协议模拟器：`npm run simulate`（`scripts/xplane-simulator.js`，同时模拟 Web API 与 UDP DATA 广播，支持场景/倍速/暂停/传送/断连，详见 README"本地联调"）。联调后端时先 `npm start` 再 `npm run simulate`，后端会自动连上。
- 冒烟验证：`npm start` 后 `curl http://127.0.0.1:3000/api/status`，无 X-Plane 环境应返回 `connected:false, flightActive:false` 且进程不退出（T1）。

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
- **百度底图区域自动切换**：`public/js/geo.js` 为坐标纯函数层（WGS84⇄GCJ02⇄BD09 纠偏、BD09→百度墨卡托/Krassovsky 椭球闭式投影、大陆判定 = bbox − 港澳台），`baiduCrs.js` 将其注入 Leaflet 自定义 CRS——调用方全程使用 WGS84 数值。切换逻辑在 `mapController.updatePosition`（进入用精确边界、离开用外扩 0.3° 迟滞防抖），通过销毁重建地图恢复视图/航迹/图标。**投影正确性由 `server/test/geoConvert.test.js` 以 proj4 为 oracle 保证（<0.01m），改动投影公式必须跑该测试**。百度瓦片免 AK URL 若失效，只需改 `baiduCrs.js` 的 `BAIDU_TILE_URL`。

## 代码规范（§15.1）

- 现代 JavaScript（ES2020+，ESM）；文件名小驼峰、类名大驼峰、常量全大写下划线。
- 复杂状态机/协议解析逻辑用**中文注释**说明"为什么"；核心模块公开函数写简要 JSDoc。
- 所有外部交互（连接、文件 IO、端口监听）必须 `try/catch`，禁止未捕获异常导致进程崩溃；REST 错误统一 `{ "error": { "code", "message" } }` 格式（400/404/409/500）。
- 日志用 `pino`：高频 dataref 原始值用 `debug`（默认关闭），连接/切换/启动用 `info`，重连与"无飞行"判定用 `warn`。生产默认 `info`。
- Git 提交遵循 Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`），按里程碑 M1–M8（§13）推进。

## 验收

- 每个模块小节末尾有独立验收标准；总体 DoD 清单在 §15.6。
- 手动测试用例 T1–T10（§15.5）覆盖：无 X-Plane 启动不崩溃、置灰/恢复、双设备一致性、teleport 断线、切换竞态、重启后配置保留、端口占用报错等。实现完一个模块应对照其验收标准自测。
