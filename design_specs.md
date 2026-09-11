# X-Plane 12 实时飞机位置追踪工具 —— 详细设计文档

项目代号 / Repo 名：`xplane-live-tracker`

版本：v1.3（新增：确定项目 Repo 名为 `xplane-live-tracker`，并同步更新文档中的目录结构命名）
日期：2026-09-11

---

## 1. 项目背景与目标

X-Plane 12 是一款高保真飞行模拟器。本项目旨在开发一个配套工具，实时读取正在模拟飞行的飞机位置数据（经纬度、高度、航向、速度等），并通过局域网将这些数据推送到地图上（OpenStreetMap / Google Map），供同一局域网内的其他设备（如 iPad、手机、平板浏览器）实时查看飞机在地图上的位置和航迹。

### 1.1 核心目标

- 后端（Node.js）实时从 X-Plane 12 读取飞机位置数据。
- 后端将数据通过 WebSocket 实时推送给所有连接的前端客户端。
- 前端是一个网页地图应用，任意设备在浏览器中输入 `http://<后端IP>:<端口>` 即可打开，无需安装 App。
- 地图上实时显示飞机图标位置、航向、并可选绘制飞行航迹。
- 部署简单：只需在运行 X-Plane 的电脑上启动 Node.js 服务，其它设备连接同一 WiFi/局域网即可访问。

### 1.2 非目标（本期不做）

- 不做多人联飞、多机同屏（可作为二期扩展）。
- 不做云端/公网访问（本期仅限局域网，公网访问涉及内网穿透，作为扩展项说明）。
- 不做账号系统和复杂权限管理（局域网工具，弱鉴权即可）。

---

## 2. 需求分析

### 2.1 功能性需求

| 编号 | 需求描述 |
|---|---|
| F1 | 后端与 X-Plane 12 建立连接，实时获取飞机经度、纬度、海拔高度、航向、地速、俯仰/横滚角 |
| F2 | 后端将采集到的数据通过 WebSocket 广播给所有已连接的前端客户端 |
| F3 | 前端页面加载地图（OpenStreetMap 优先，可切换 Google Map），显示飞机图标 |
| F4 | 飞机图标随航向（Heading）实时旋转 |
| F5 | 地图自动/手动跟随飞机位置（可切换"自动居中"开关）|
| F6 | 显示当前飞行基本数据面板：高度、速度、航向、经纬度 |
| F7 | 可选：绘制最近 N 分钟的飞行航迹（轨迹线）|
| F8 | 支持多个设备同时连接查看（如 iPad + 手机同时打开）|
| F9 | 后端提供一个"连接状态"接口，显示是否已连接 X-Plane |
| F10 | 首页显示后端所在局域网 IP 和二维码，方便其它设备扫码打开 |
| F11 | 当前若没有飞机在飞行（未连接、无有效数据、或数据长时间未更新），地图以灰色禁用（disabled）样式呈现，并用醒目文字提示当前状态 |

### 2.2 非功能性需求

| 编号 | 需求描述 |
|---|---|
| N1 | 数据更新频率：1～5 Hz 可配置（默认 2 Hz，兼顾流畅度与网络开销）|
| N2 | 低延迟：从飞机移动到地图刷新，延迟应控制在 500ms 以内 |
| N3 | 断线重连：X-Plane 未启动/中途关闭时，后端自动重试连接；前端 WebSocket 断线自动重连 |
| N4 | 跨平台：后端可在 Windows / macOS 运行（X-Plane 支持的平台）；前端为标准网页，兼容 iPad Safari、Android Chrome、桌面浏览器 |
| N5 | 部署简单：`npm install && npm start` 即可运行，无需数据库（默认内存存储，历史航迹可选持久化）|
| N6 | 局域网安全：默认仅监听局域网，避免误暴露到公网 |

---

## 3. 总体架构

```
┌──────────────────────────┐        WebSocket / REST(局域网)         ┌──────────────────────────┐
│   运行 X-Plane 12 的电脑   │                                        │   iPad / 手机 / 笔记本      │
│                          │                                        │   （浏览器打开网页）         │
│  ┌────────────────────┐  │                                        │  ┌────────────────────┐  │
│  │     X-Plane 12       │  │                                        │  │  前端 Web 页面        │  │
│  │  内置 Web API         │◄─┼── WebSocket/REST（本机 8086 端口）──────┤  │  Leaflet + OSM/GMap  │  │
│  │  (127.0.0.1:8086)     │  │                                        │  │  飞机图标 + 航迹       │  │
│  └─────────▲──────────┘  │                                        │  └──────────▲─────────┘  │
│            │ 订阅datarefs  │                                        │             │ WebSocket   │
│  ┌─────────┴──────────┐  │                                        │             │ 实时推送     │
│  │   Node.js 后端服务    │  │                                        └─────────────┼───────────┘
│  │  - XPlaneClient      │  │                                                      │
│  │  - 数据广播 WSServer   │──┼──────────────────────────────────────────────────────┘
│  │  - HTTP静态资源/REST   │  │           （局域网内任意设备访问 http://电脑IP:端口）
│  └───────────────────┘  │
└──────────────────────────┘
```

### 3.1 数据流概览

1. Node.js 后端作为 **客户端**，通过 WebSocket 连接 X-Plane 12 内置的本机 Web API（`ws://127.0.0.1:8086/api/v2/ws`），订阅所需的 dataref（经纬度、高度、航向等）。
2. X-Plane 按设定频率推送 dataref 数值变化给 Node.js 后端。
3. Node.js 后端整理成统一的 JSON 结构，通过自己开的 **WebSocket 服务端**（例如端口 `3000`）广播给所有已连接的前端设备。
4. 前端网页（Leaflet 地图）收到数据后更新飞机图标位置、航向、信息面板。
5. 同时 Node.js 通过 Express 提供静态网页（HTML/JS/CSS）和若干 REST 接口（状态查询、历史航迹导出等）。

---

## 4. 与 X-Plane 12 的通讯方案

X-Plane 12 提供两种可选的数据获取方式。**本设计要求两种方式均完整实现，并由用户在前端设置面板中手动选择/切换当前使用哪一种**（不是简单的"主 + 自动降级兜底"），具体切换机制见 4.3。

### 4.1 方案 A（推荐）：X-Plane 12 内置 Web API（REST + WebSocket）

自 X-Plane 12.1.1 起，模拟器内置了本机 Web 服务器，默认监听 `8086` 端口，提供：

- **REST API**：查询/写入单个 dataref、执行 command、查询可用飞机等（`http://127.0.0.1:8086/api/v2/...`）。
- **WebSocket API**：按 ID 订阅一组 dataref，模拟器会在数值变化（或按设定频率）时主动推送，非常适合本项目"持续流式获取位置"的需求（`ws://127.0.0.1:8086/api/v2/ws`）。

**优点**：官方原生支持、无需第三方插件、协议为标准 JSON、可读性好、支持按需订阅节省带宽。

**需要的设置**：
- 在 X-Plane 内 `Settings → Network` 中勾选"允许接受传入连接"（Accept incoming connections），否则会返回 403。
- 确认 Web API 端口（默认 8086），如与其它程序冲突可通过启动参数 `--web_server_port=XXXX` 修改。
- 由于本方案中 Node.js 后端与 X-Plane 运行在**同一台电脑**上，直接用 `127.0.0.1:8086` 连接即可，无需额外开放防火墙端口（局域网设备访问的是 Node.js 自己的端口，见第 5 节）。

**需要订阅的关键 dataref（示例）：**

| Dataref | 含义 | 单位 |
|---|---|---|
| `sim/flightmodel/position/latitude` | 纬度 | 度 |
| `sim/flightmodel/position/longitude` | 经度 | 度 |
| `sim/flightmodel/position/elevation` | 海拔高度（海平面） | 米 |
| `sim/flightmodel/position/y_agl` | 离地高度 AGL | 米 |
| `sim/flightmodel/position/psi` | 真航向 Heading | 度 |
| `sim/flightmodel/position/groundspeed` | 地速 | m/s |
| `sim/flightmodel/position/indicated_airspeed` | 指示空速 IAS | kt |
| `sim/flightmodel/position/phi` | 横滚角 Roll | 度 |
| `sim/flightmodel/position/theta` | 俯仰角 Pitch | 度 |
| `sim/flightmodel/position/vh_ind_fpm` | 垂直速度 | ft/min |
| `sim/aircraft/view/acf_tailnum` | 飞机注册号（可选，用于标识）| 字符串 |

后端在启动 WebSocket 连接后，先通过 REST 接口 `GET /api/v2/datarefs?filter[name]=...` 查询上述 dataref 对应的数值 ID，再通过 WebSocket 发送订阅请求（`request_id`、`type: "dataref_subscribe_values"`），设定期望的推送频率（如 `20` 表示约 20Hz，本项目可设置较低频率 2～5Hz 以降低网络与渲染压力）。

### 4.2 方案 B（兼容/兜底）：传统 UDP DATA 输出

适用于运行较旧版本 X-Plane 12（低于 12.1.1，尚无 Web API）的情况：

- 在 X-Plane `Settings → Data Output → Data Set` 中勾选需要的数据行（如 "Latitude, longitude, altitude"、"Speeds"、"Pitch, roll, headings" 等），并设置目标 IP（Node.js 所在机器 IP）和端口（如 `49005`），勾选按一定频率 `send every N frames` 广播。
- Node.js 后端用 `dgram` 模块监听该 UDP 端口，解析 X-Plane 私有二进制协议（`DATA*` 帧头 + 4字节 index + 8 个 float，每个 dataset 一帧）。
- 缺点：协议为二进制、需要按 X-Plane 文档中的 "row index" 手册解析字段含义，可维护性不如 Web API；仅支持广播固定的数据集合，不能像 dataref 订阅那样灵活。

### 4.3 两种方案均需实现，且由前端页面可配置切换

不同于早期版本"自动探测、失败才降级"的思路，**本设计要求方案 A（Web API）和方案 B（UDP）都完整实现**，运行时由用户在前端页面上**手动选择**当前使用哪种方式，并可分别配置各自参数（IP、端口等）。原因：

- 有些用户的 X-Plane 版本低于 12.1.1，只能用 UDP；
- 有些用户即使装了新版本，也可能出于个人习惯/已有的 UDP 转发链路（如同时给其它插件用）而倾向继续用 UDP；
- 排障时切换方案本身就是一种诊断手段（比如怀疑 Web API 有问题，切到 UDP 试一下）。

因此后端需要把"当前通讯模式"设计成一个**可在运行时热切换的状态**，而不是启动时一次性决定。

#### 4.3.1 后端设计要点

- `xplaneManager.js` 内部持有两个独立的客户端实例：`webApiClient` 和 `udpClient`，二者实现同一套接口（`connect() / disconnect() / on('position', cb) / on('status', cb)`），`xplaneManager` 只是按当前选中的模式启用其中一个，另一个保持停用状态（不会两个同时抢占/混合推流，避免前端收到两套频率不一致的数据）。
- 切换模式时：先 `disconnect()` 当前客户端，清空/标记"未连接"状态广播给前端，再 `connect()` 新客户端，成功后恢复数据推流。
- 每种模式各自的参数（Web API 的 `host/port`；UDP 的 `listenPort`，以及可选的 `xplaneBroadcastHost`/端口用于文档提示用户在 X-Plane 端如何配置）都可通过前端表单修改，改动后调用后端接口保存并立即生效。
- 配置持久化到本地 `config.json`（而不仅是内存），这样重启 Node.js 服务后仍记得用户上次选择的模式和参数。
- 当前选中的模式、连接状态、最近数据时间戳，通过 REST `/api/xplane-mode`（GET/POST）和 WebSocket 的 `xplane_status` 消息实时暴露给前端（见 4.3.2、第 5.4、第 7 节）。

#### 4.3.2 后端 REST 接口新增

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/xplane-mode` | 返回当前模式（`webapi`/`udp`）及各自配置、连接状态 |
| POST | `/api/xplane-mode` | 前端提交新的模式和参数，后端执行热切换 |

**GET `/api/xplane-mode` 响应示例：**

```json
{
  "activeMode": "webapi",
  "webapi": {
    "host": "127.0.0.1",
    "port": 8086,
    "connected": true,
    "lastUpdate": 1757590000123
  },
  "udp": {
    "listenPort": 49005,
    "connected": false,
    "lastUpdate": null
  }
}
```

**POST `/api/xplane-mode` 请求示例（切换到 UDP，并修改监听端口）：**

```json
{
  "activeMode": "udp",
  "udp": {
    "listenPort": 49006
  }
}
```

后端收到后：校验参数合法性 → 断开旧模式客户端 → 保存新配置到 `config.json` → 启动新模式客户端 → 通过 WebSocket 广播最新的 `xplane_status`，前端据此更新界面。若切换/连接失败（如端口被占用、Web API 拒绝连接），接口返回明确错误信息（`{"error": "..."}`），前端弹出提示并保持在原模式。

### 4.4 连接与容错设计（通用，两种模式均适用）

- 后端维护一个 `XPlaneClient` 状态机：`DISCONNECTED → CONNECTING → SUBSCRIBED → STREAMING`（UDP 模式下 `SUBSCRIBED` 可理解为"已确认收到有效数据帧"）。
- X-Plane 未启动、飞行暂停、切换飞机等情况都应被妥善处理，不能导致后端崩溃。
- 采用指数退避重连（1s → 2s → 5s → 10s，最大间隔封顶），并将连接状态通过 WebSocket/REST 暴露给前端，前端显示"等待连接 X-Plane…"等提示。
- 两种模式互斥运行，但配置和状态各自独立保留，切换后可以随时切回，不丢失已保存的参数。

### 4.5 "是否有飞机在飞行"状态判定（flightActive）

这是一个独立于"是否连接 X-Plane"的**更细粒度的状态**，专门用于驱动前端 F11 需求（无飞行时地图置灰）。两者的区别：

- `xplaneConnected`：Node.js 后端与 X-Plane（Web API 或 UDP）之间的**连接本身**是否建立成功。
- `flightActive`：在连接成功的基础上，**是否正在收到有效、持续更新的飞机位置数据**，代表"当前有一场正在进行的飞行/模拟会话"。

一次连接成功但长期收不到新位置（比如 X-Plane 停在主菜单、或者用户尚未加载任何飞机、或者模拟被暂停），应当被判定为 `flightActive = false`，即使 `xplaneConnected = true`。

#### 4.5.1 判定规则（默认实现，V1）

```
flightActive =
    xplaneConnected === true
    AND (当前时间 - 最近一次收到有效 position 数据的时间) <= STALE_TIMEOUT_MS
```

- `STALE_TIMEOUT_MS` 默认 **5000ms**（5秒无新数据即判定为"当前无飞行"），可在 `config.json` 中配置（`flightStaleTimeoutMs`）。
- "有效 position 数据"指：Web API/UDP 成功解析出一组完整的经纬度、高度等字段（数值非 `NaN`/非空）。
- 后端用一个定时器（如每 1 秒检查一次）比较 `lastPositionTimestamp` 与当前时间，一旦跨越阈值就把 `flightActive` 置为 `false` 并广播状态变化；一旦重新收到数据则立即置回 `true` 并广播。

#### 4.5.2 判定规则（可选增强，V2，非本期必做）

如果 V1 的"仅看数据是否新鲜"不够精确（例如用户把模拟暂停但连接和数据推送仍在，导致长时间显示同一坐标却仍判定为"有效"），可选叠加：

- 读取 dataref `sim/time/paused`（模拟是否暂停），暂停时强制 `flightActive = false`；
- 读取 dataref `sim/operation/prefs/startup_running` 或类似"是否已加载飞机/进入自由飞行"的 dataref，用于区分"停在主菜单"与"已加载飞行但静止在停机坪"；
- 这一部分 dataref 的具体路径可能随 X-Plane 版本变化，V1 阶段先不依赖，作为后续增强项，接口设计上预留 `flightActive` 的判定逻辑放在 `xplaneManager` 内单一函数中，方便后续替换判定算法而不影响其它模块。

#### 4.5.3 状态广播

`flightActive` 作为字段合并进现有的 `xplane_status` WebSocket 消息（见 7.2 节更新），不单独开新的消息类型，前端只需监听同一条消息即可同时拿到"是否连接"和"是否有飞行"两个维度的状态。

---

## 5. 后端设计（Node.js）

### 5.1 技术栈

| 组件 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 20 LTS | |
| Web 框架 | Express | 提供静态页面、REST 接口 |
| 实时通讯（面向前端） | `ws`（WebSocket） | 后端 → 前端广播飞机数据 |
| 实时通讯（面向 X-Plane） | `ws`（WebSocket 客户端）/ `axios`（REST） | 后端 → X-Plane 拉取/订阅数据 |
| UDP 兜底方案 | Node.js 内置 `dgram` | 解析 X-Plane DATA UDP 广播 |
| 配置管理 | `dotenv` + JSON 配置文件 | 端口、订阅频率、X-Plane 地址等 |
| 日志 | `pino` 或 `winston` | 便于排查连接问题 |
| 局域网 IP 展示 | `qrcode`（生成二维码）+ Node 内置 `os.networkInterfaces()` | 首页展示可扫码访问的地址 |

### 5.2 模块划分

```
server/
├── src/
│   ├── index.js                 # 应用入口：启动 Express + WS Server
│   ├── config.js                # 读取 .env / config.json 配置
│   ├── xplane/
│   │   ├── webApiClient.js      # 方案A：X-Plane 12 Web API 客户端
│   │   ├── udpClient.js         # 方案B：UDP DATA 解析客户端
│   │   └── xplaneManager.js     # 统一调度，自动选择A/B并对外暴露标准事件
│   ├── broadcast/
│   │   └── wsHub.js             # 面向前端的 WebSocket 广播中心（连接池管理）
│   ├── routes/
│   │   ├── status.js            # GET /api/status  连接状态
│   │   ├── track.js             # GET /api/track   历史航迹（可选）
│   │   ├── config.js            # GET /api/config  返回地图/更新频率等前端配置
│   │   └── xplaneMode.js        # GET/POST /api/xplane-mode  查询/切换通讯模式（见4.3.2）
│   └── utils/
│       ├── network.js           # 获取本机局域网IP、生成二维码
│       ├── trackStore.js        # 内存环形缓冲区，存最近N分钟航迹点
│       └── configStore.js       # 读写 config.json，持久化用户选择的通讯模式与参数
├── public/                      # 前端静态资源（见第6节）
├── config.json                  # 运行时可变配置（活动模式、各模式参数），首次运行自动生成默认值
├── package.json
└── .env.example
```

### 5.3 核心数据流（后端内部）

```
XPlaneManager (监听 X-Plane 数据变化)
        │  emits 'position' 事件, payload: { lat, lon, alt, agl, heading,
        │                                     ias, gs, vs, pitch, roll, ts }
        ▼
 trackStore.push(payload)        wsHub.broadcast(payload)
   (保留最近N分钟航迹)                 (推送给所有前端WS连接)
```

### 5.4 关键接口设计

**面向前端设备的 WebSocket（后端作为服务端）**

- 地址：`ws://<后端IP>:3000/ws`
- 服务端 → 客户端 消息格式（见第 7 节协议定义）
- 客户端 → 服务端 可发送简单指令，如：
  - `{"type":"hello"}`：握手，服务端立即回一条当前最新位置（避免新连接等待下一帧）
  - `{"type":"ping"}`：心跳保活

**REST 接口**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 返回 X-Plane 连接状态、当前数据源（WebAPI/UDP）、最近一次收到数据的时间戳 |
| GET | `/api/config` | 返回前端所需配置：地图类型、Google Maps Key（若配置）、更新频率、是否显示航迹 |
| GET | `/api/xplane-mode` | 返回当前通讯模式（webapi/udp）及各自参数、连接状态（详见4.3.2）|
| POST | `/api/xplane-mode` | 前端提交并切换通讯模式/参数，后端热切换生效（详见4.3.2）|
| GET | `/api/track?minutes=10` | 返回最近 N 分钟的航迹点数组（用于刷新页面后补画历史航迹）|
| GET | `/` | 返回前端主页面（含局域网访问地址与二维码）|

### 5.5 性能与节流

- X-Plane 一侧订阅频率建议设置为 5～10Hz（原始数据），后端做**节流/采样**后再以 1～2Hz 广播给前端，避免大量设备连接时网络拥塞。
- 航迹存储使用固定长度环形缓冲区（如最多保留 3600 个点，约 30 分钟 @2Hz），防止内存无限增长。
- 广播时对多个前端连接使用同一份序列化后的 JSON 字符串，避免重复 `JSON.stringify` 开销。

---

## 6. 前端设计

### 6.1 地图选型

| 方案 | 优点 | 缺点 | 建议 |
|---|---|---|---|
| **OpenStreetMap + Leaflet.js** | 完全免费、无需 API Key、无需联网账号注册、开源、轻量 | 卫星图层需第三方源、样式相对朴素 | **默认/推荐方案**，局域网/无外网环境也可配合本地瓦片缓存 |
| **Google Maps JavaScript API** | 影像清晰、路网/地标丰富、体验好 | 需申请 API Key、有免费额度限制、需要联网 | 作为**可选切换**方案，通过配置项开启 |

建议前端做成**可切换底图**：默认 Leaflet + OSM 瓦片，若在 `/api/config` 中检测到用户配置了 `GOOGLE_MAPS_API_KEY`，界面右上角出现"切换到 Google Map"按钮。

### 6.2 页面结构

```
public/
├── index.html          # 主页面：地图容器 + 信息面板 + 连接状态
├── css/
│   └── style.css
├── js/
│   ├── app.js           # 入口：初始化地图、建立WS连接、事件绑定
│   ├── mapController.js # 封装 Leaflet/Google Map 的统一接口（图标更新/航迹绘制/居中）
│   ├── wsClient.js       # 前端WebSocket客户端（自动重连、心跳）
│   ├── ui.js             # 信息面板（高度/速度/航向）渲染、状态提示
│   └── settingsPanel.js   # 通讯模式设置面板：读取/提交 /api/xplane-mode（见6.4）
└── assets/
    └── plane-icon.svg    # 飞机图标（支持CSS旋转）
```

### 6.3 关键交互设计

- **飞机图标**：使用可旋转的 SVG/PNG 图标，根据 `heading` 字段用 CSS `transform: rotate()` 或 Leaflet 的 `marker rotation` 插件实时旋转朝向。
- **自动居中**：默认开启"跟随飞机"，用户手动拖动地图后自动关闭跟随，提供一个"回到飞机位置"悬浮按钮重新开启跟随。
- **信息面板**：悬浮卡片显示 高度(ft/m) / 速度(kt) / 航向(°) / 经纬度 / 数据更新延迟（用于判断是否卡顿）。
- **航迹绘制**：使用 Leaflet `Polyline`，随着新坐标点到达不断 `addLatLng()`，超过设定长度后从队首移除，避免线段无限增长。
- **首屏引导 / 无飞行状态提示**：地图状态与 `flightActive` 绑定，具体样式规范见新增的 6.6 节。
- **多设备访问引导**：首页顶部展示"在其它设备浏览器打开：`http://192.168.x.x:3000`"文字及二维码，方便 iPad 直接扫码。

### 6.4 通讯模式设置面板（新增）

页面提供一个"设置 / Settings"入口（图标按钮，如齿轮），点开为一个弹层/侧边抽屉，内容包括：

| 区块 | 控件 | 说明 |
|---|---|---|
| **通讯模式选择** | 单选按钮：`○ X-Plane Web API（推荐）` / `○ UDP 广播` | 对应后端 `activeMode` |
| **Web API 参数**（仅选中该模式时可编辑） | 输入框：Host（默认 `127.0.0.1`）、Port（默认 `8086`） | 一般无需修改，特殊情况下（如 X-Plane 与后端不在同一台机器，或自定义了端口）可手动调整 |
| **UDP 参数**（仅选中该模式时可编辑） | 输入框：监听端口 Listen Port（默认 `49005`） | 并附文字提示："请确认已在 X-Plane 的 Data Output 设置中将该数据发送到本机此端口" |
| **连接状态** | 只读文字/指示灯：🟢已连接 / 🟡连接中 / 🔴未连接，及"最近数据时间" | 实时通过 `xplane_status` WS消息刷新 |
| **操作按钮** | `保存并切换` / `取消` | 点击"保存并切换"调用 `POST /api/xplane-mode`，成功后弹层显示"切换成功"，失败显示具体错误（如端口被占用） |

**交互流程：**

1. 面板打开时，先调用 `GET /api/xplane-mode` 拉取当前模式与参数，回填表单。
2. 用户切换单选按钮时，仅高亮/启用对应模式的参数输入框，另一组置灰。
3. 点击"保存并切换"后按钮进入 loading 状态，等待后端响应；成功则更新页面顶部状态指示，失败则在按钮下方展示错误提示且不关闭面板，方便用户重试。
4. 切换过程中飞机图标/信息面板保留最后一次已知位置（不清空），仅顶部状态提示切换为"连接中…"，避免用户误以为数据丢失。
5. 所有设备打开的页面共享同一份后端配置：任一设备切换模式后，其它已连接设备会通过 `xplane_status` 广播同步看到新的模式状态（但设置面板本身是本地打开/关闭，不强制同步弹出）。

### 6.5 响应式适配

- 采用简单的 Flex/Grid 布局，保证在 iPad（横屏/竖屏）、手机浏览器下均可正常显示地图与信息面板（面板在窄屏下可收起为底部抽屉）。

### 6.6 无飞行状态的地图呈现（F11，新增）

当后端广播的 `xplane_status.flightActive === false` 时（含"尚未连接"和"连接但无有效飞行数据"两种子情况），前端需要用**明显区别于正常状态**的视觉样式呈现，避免用户误以为飞机就静止在最后位置。

#### 6.6.1 视觉规范

| 元素 | 正常状态（flightActive=true） | 无飞行状态（flightActive=false） |
|---|---|---|
| 地图瓦片 | 正常彩色显示 | 叠加一层半透明灰色遮罩（CSS `filter: grayscale(100%)` + 一层 `rgba(0,0,0,0.35)` overlay），瓦片本身仍在但视觉上明显"变灰变暗" |
| 飞机图标 | 正常显示、随数据更新移动 | 隐藏，或以半透明(`opacity:0.3`)+不再旋转的方式显示"最后已知位置"（二选一，见6.6.3实现建议，默认选"隐藏"更清晰） |
| 航迹线 | 正常显示 | 保留但降低透明度（如 `opacity:0.3`），不再新增线段 |
| 信息面板 | 显示实时数值 | 数值区域整体置灰（`color:#999`），或替换为"--" 占位符 |
| 提示文字 | 无 | 屏幕中央/顶部出现**醒目的**提示条，见6.6.2 |
| 地图交互 | 可拖动/缩放/点击 | 建议**仍允许**拖动缩放（方便用户查看最后位置周边），但不强制禁用交互；核心是视觉上的"disabled"感，而非真正锁死操作 |

#### 6.6.2 提示文案设计

提示条固定在地图上方或中央，样式要求：底色醒目（如橙色/琥珀色 `#f59e0b` 或半透明深色卡片）、图标 + 文字组合，区分两种子状态给出不同文案：

| 子状态 | 判定条件 | 文案（中文） |
|---|---|---|
| 未连接 X-Plane | `xplaneConnected === false` | ⚠️ **未连接到 X-Plane** — 请确认 X-Plane 12 已启动，且通讯模式配置正确（点击右上角"设置"检查） |
| 已连接但无飞行数据 | `xplaneConnected === true && flightActive === false` | ✈️ **当前没有飞机在飞行** — 请在 X-Plane 中加载飞机并开始飞行，地图将自动恢复显示 |

文案文本建议做成可配置项（`public/js/ui.js` 中的常量或 `/api/config` 下发的字符串），方便后续多语言扩展。

#### 6.6.3 实现建议

- `mapController.js` 暴露 `setFlightActive(active: boolean)` 方法：
  - `active = true`：移除灰色遮罩 class、恢复飞机图标显示、隐藏提示条。
  - `active = false`：给地图容器加一个 `.map-disabled` CSS class（负责灰度+遮罩效果）、隐藏或淡化飞机图标、显示提示条并根据 `xplaneConnected` 决定具体文案。
- `wsClient.js` 收到 `xplane_status` 消息后，调用 `mapController.setFlightActive(data.flightActive)` 和 `ui.updateStatusBanner(data)`，两者解耦，互不影响地图本身的缩放/拖动状态。
- 页面**首次加载**、WS 尚未建立连接时，默认视为 `flightActive=false`（未连接文案），避免出现"假的正常状态"闪烁。
- 从"无飞行"恢复到"有飞行"时，遮罩和提示条应有一个简单的淡入淡出过渡（CSS `transition: opacity 0.3s`），避免生硬跳变。
- CSS 建议实现（供参考，非强制）：
  ```css
  #map.map-disabled {
    filter: grayscale(100%) brightness(0.85);
    pointer-events: auto; /* 保持可拖动缩放 */
  }
  #status-banner {
    display: none;
  }
  #status-banner.visible {
    display: flex;
    background: #f59e0b;
    color: #1a1a1a;
    font-weight: 600;
  }
  ```

---

## 7. 通讯协议设计（后端 ↔ 前端 WebSocket JSON 格式）

### 7.1 服务端 → 客户端：位置更新消息

```json
{
  "type": "position",
  "data": {
    "lat": 34.6937,
    "lon": 135.5023,
    "altMsl": 1520.4,
    "altAgl": 305.2,
    "heading": 273.5,
    "groundSpeedKt": 118.3,
    "verticalSpeedFpm": -320,
    "pitch": -1.2,
    "roll": 4.5,
    "tailNumber": "N12345",
    "timestamp": 1757590000123
  }
}
```

### 7.2 服务端 → 客户端：连接状态消息

```json
{
  "type": "xplane_status",
  "data": {
    "activeMode": "webapi",     // "webapi" | "udp"，当前生效的通讯模式
    "connected": true,           // xplaneConnected：是否成功连接 X-Plane
    "flightActive": true,         // 是否正在收到有效、持续更新的飞行数据（见4.5节）
    "lastUpdate": 1757590000123,
    "webapi": { "host": "127.0.0.1", "port": 8086 },
    "udp": { "listenPort": 49005 }
  }
}
```

> `flightActive` 的判定逻辑见 4.5 节。前端仅需监听本消息即可驱动 6.6 节所述的"无飞行灰色禁用样式"。

> 该消息在两种场景下推送：① 常规状态心跳（如每5秒）；② 用户通过设置面板触发模式切换后（见6.4、4.3.2），切换过程中的每个阶段（断开旧连接 / 连接中 / 已连接 / 失败）都会各推送一次，便于前端实时展示切换进度。

### 7.3 客户端 → 服务端：握手/心跳

```json
{ "type": "hello" }
{ "type": "ping" }
```

### 7.4 REST `/api/config` 响应示例

```json
{
  "mapProvider": "osm",
  "googleMapsApiKey": null,
  "updateHz": 2,
  "trackEnabled": true,
  "trackMaxMinutes": 30
}
```

---

## 8. 网络与部署方案

### 8.1 典型部署场景

```
家庭/机构局域网（同一路由器 WiFi）
 ├── 电脑 A：运行 X-Plane 12 + Node.js 后端（IP: 192.168.1.50，端口 3000）
 ├── iPad：Safari 打开 http://192.168.1.50:3000
 └── 手机：Chrome 打开 http://192.168.1.50:3000
```

### 8.2 部署步骤

1. 在运行 X-Plane 12 的电脑上安装 Node.js 20+。
2. 克隆项目（`git clone <repo-url>/xplane-live-tracker.git`）或解压项目包，进入目录后执行 `npm install`。
3. 复制 `.env.example` 为 `.env`，按需修改：
   ```
   PORT=3000
   XPLANE_HOST=127.0.0.1
   XPLANE_WEBAPI_PORT=8086
   UPDATE_HZ=2
   MAP_PROVIDER=osm
   GOOGLE_MAPS_API_KEY=
   ```
4. 在 X-Plane 12 的 `Settings → Network` 中确认已勾选"允许接受传入连接"。
5. 执行 `npm start` 启动服务，终端会打印局域网访问地址，例如：
   ```
   ✔ X-Plane Tracker 已启动
   ✔ 局域网访问地址: http://192.168.1.50:3000
   ✔ 已生成二维码，可在首页查看
   ```
6. 启动 X-Plane 12 并开始飞行。
7. iPad/手机连接同一 WiFi，浏览器打开上述地址即可查看实时位置。

### 8.3 防火墙与网络注意事项

- Windows 首次运行需在"允许应用通过防火墙"中放行 Node.js（或该端口）。
- 后端应监听 `0.0.0.0`（而非仅 `127.0.0.1`），才能被局域网其它设备访问；X-Plane 侧的 Web API 仍然只需监听本机 `127.0.0.1`，无需暴露。
- 若希望跨公网访问（如不同地点的朋友远程查看），可选方案：
  - 使用内网穿透工具（如 frp、ngrok、Cloudflare Tunnel）将 3000 端口映射到公网域名；
  - 此时**强烈建议**为 WebSocket/REST 增加简单的访问口令（见第 9 节安全性），避免任意人扫描到该端口。

---

## 9. 安全性考虑

本工具默认定位为**局域网内部工具**，因此不做复杂的账号体系，但建议至少具备：

- **访问口令（可选开启）**：`.env` 中配置 `ACCESS_TOKEN`，前端首次打开需输入口令（存入 `localStorage`），WebSocket 握手 `hello` 消息携带 token，服务端校验不通过则断开连接。
- **只读原则**：本工具只读取 X-Plane 数据、不写入/不下发控制指令，避免误操作影响飞行模拟（即便未来扩展写操作，也应显式加二次确认）。
- **默认不监听公网网卡**：文档/README 中明确提示，如需公网访问必须自行加鉴权和 HTTPS。
- **限流**：REST 接口和 WebSocket 连接数做基本限流，防止误用或恶意连接耗尽资源。

---

## 10. 数据结构定义（TypeScript 风格，供实现参考）

```ts
// 飞机实时位置
interface AircraftPosition {
  lat: number;              // 纬度
  lon: number;               // 经度
  altMsl: number;             // 海拔高度（米）
  altAgl: number;              // 离地高度（米）
  heading: number;              // 真航向（0-360度）
  groundSpeedKt: number;         // 地速（节）
  verticalSpeedFpm: number;       // 垂直速度（ft/min）
  pitch: number;                   // 俯仰角（度）
  roll: number;                     // 横滚角（度）
  tailNumber?: string;               // 飞机注册号（可选）
  timestamp: number;                  // 数据时间戳（ms）
}

// X-Plane 连接状态（含当前通讯模式与各模式参数，供设置面板回填）
interface XPlaneModeConfig {
  activeMode: "webapi" | "udp";
  connected: boolean;              // xplaneConnected
  flightActive: boolean;            // 是否有有效飞行数据在持续更新（见4.5节）
  flightStaleTimeoutMs: number;      // 判定“无飞行”的静默超时阈值，默认5000
  webapi: {
    host: string;                 // 默认 "127.0.0.1"
    port: number;                  // 默认 8086
    connected: boolean;
    lastUpdate: number | null;
  };
  udp: {
    listenPort: number;             // 默认 49005，Node.js 监听该端口接收 X-Plane 广播
    connected: boolean;
    lastUpdate: number | null;
  };
}

// 前端配置
interface FrontendConfig {
  mapProvider: "osm" | "google";
  googleMapsApiKey: string | null;
  updateHz: number;
  trackEnabled: boolean;
  trackMaxMinutes: number;
}
```

---

## 11. 关键技术难点与应对

| 难点 | 说明 | 应对方案 |
|---|---|---|
| X-Plane Web API 版本差异 | 12.1.1 以下无内置 Web API | 前端设置面板中明确提示"低版本请选择UDP模式"，两种模式均完整实现、可随时手动切换（见4.3）|
| 运行时切换模式的状态一致性 | 切换过程中新旧客户端交替、多设备同时在线 | 后端以单一状态源（`xplaneManager`当前模式）为准，切换步骤严格串行（先断后连），并通过 `xplane_status` 广播让所有前端保持同步（见4.3.1、7.2）|
| 多设备同时访问的带宽/性能 | 多个 iPad/手机同时连 WebSocket | 后端统一广播同一份序列化数据；限制广播频率（1-2Hz足够地图平滑移动）|
| 坐标更新的平滑显示 | 2Hz 更新在地图上可能显得"跳跃" | 前端可选做简单的线性插值/CSS `transition` 动画，让图标在两次数据点之间平滑移动 |
| 飞机切换/传送(teleport) | 用户在 X-Plane 中手动传送飞机位置，导致航迹连线跨越地图 | 检测相邻两点距离超过阈值（如 5 公里/秒）时，判定为"跳变"，航迹线在此处断开，不连线 |
| iPad Safari 兼容性 | Safari 对 WebSocket、CSS transform 支持需要测试 | 前端使用标准 WebSocket API + 成熟的 Leaflet 库，避免使用过新的实验性 CSS/JS 特性 |
| 局域网 IP 会变化 | 电脑重启/DHCP 重新分配后 IP 变化 | 首页显示当前检测到的 IP 二维码；亦可提示用户在路由器中为该电脑绑定静态 IP/DHCP 保留 |
| "无飞行"状态的误判 | 用户只是短暂暂停/停在停机坪长时间静止，可能被误判为"无飞行" | V1 用固定阈值（默认5秒无新数据）判定，可在设置中调整阈值；如需更精确区分"暂停"与"静止但仍在飞行"，走4.5.2的可选增强方案（读取 `sim/time/paused` 等dataref）|

---

## 12. 目录结构与技术栈总览

```
xplane-live-tracker/
├── server/                # Node.js 后端（见第5节）
├── public/                 # 前端静态资源（见第6节）
├── .env.example
├── package.json
└── README.md
```

**技术栈汇总**

- 后端：Node.js + Express + ws + axios + dgram（备用）
- 前端：原生 HTML/CSS/JS + Leaflet.js（默认）/ Google Maps JS API（可选）
- 数据源：X-Plane 12 内置 Web API（WebSocket，主）/ UDP DATA 输出（备）
- 部署：本机运行，局域网内任意设备浏览器访问，无需安装 App

---

## 13. 开发里程碑建议

| 阶段 | 内容 | 产出 |
|---|---|---|
| M1（1-2天） | 打通 X-Plane Web API 连接，命令行打印实时经纬度/高度 | `webApiClient` 可运行 |
| M2（1天） | 实现 UDP 客户端，解析 X-Plane DATA 广播 | `udpClient` 可运行，与 webApiClient 接口一致 |
| M3（1天） | 搭建 Express + WS 服务端，`xplaneManager` 统一调度两种模式并支持运行时切换 + `config.json` 持久化 | 后端可通过 `/api/xplane-mode` 查询/切换模式 |
| M4（2天） | 完成前端 Leaflet 地图 + 飞机图标实时更新 | 桌面浏览器可看到飞机移动 |
| M5（1天） | 完成前端"设置面板"：模式选择、参数编辑、状态指示（见6.4） | 可在页面上完成 Web API / UDP 切换并生效 |
| M6（1天） | iPad/手机联调，适配响应式布局，完成局域网IP/二维码展示 | 多设备联调通过 |
| M7（1天） | 加入航迹绘制、信息面板、断线重连、跳变检测 | 功能完整版 |
| M8（可选） | 访问口令、内网穿透公网访问方案、Google Maps 切换 | 增强版/发布版 |

---

## 14. 后续可扩展方向

- 多机联飞：显示同一局域网内多台电脑各自模拟的飞机（需要为每架飞机加唯一ID，广播消息带 `aircraftId`）。
- 历史飞行回放：将航迹落盘（SQLite/JSON文件），支持事后按时间轴回放整趟飞行。
- 天气/风向图层叠加（结合 X-Plane 天气 dataref）。
- 起降检测与统计（离地/触地事件识别，自动记录航班起止时间、里程）。
## 15. 模块详细设计与开发任务清单（供 Claude Code 实施参考）

> 本节是面向具体编码实现的详细拆解，目的是让 Claude Code（或任何开发者）无需再向产品方反复确认设计意图即可直接开始编码。每个模块给出：文件路径、职责、依赖、关键函数/接口签名（伪代码级）、边界情况处理要求、验收标准（Definition of Done）。实现时若发现签名需要微调，以保持行为不变（尤其是对外 REST/WS 协议）为前提，允许合理调整。

### 15.1 通用开发规范

- **语言/风格**：后端与前端统一使用现代 JavaScript（ES2020+，Node.js 20 原生支持 ESM，建议 `package.json` 设置 `"type": "module"`）。如实现者更熟悉 TypeScript，可自行加 TS + 编译步骤，但需保证 `npm run build && npm start` 或等价命令可用；本文档中的 `interface` 定义可直接作为 TS 类型或作为 JSDoc 注释参考。
- **代码风格**：使用 ESLint（推荐 `eslint:recommended` + `airbnb-base` 或 `standard`）+ Prettier，统一缩进 2 空格，字符串优先单引号，行尾无分号与否均可但需全项目统一。提供 `npm run lint`、`npm run format` 脚本。
- **命名规范**：文件名小驼峰（`webApiClient.js`）；类名大驼峰（`XPlaneManager`）；常量全大写下划线（`STALE_TIMEOUT_MS`）；事件名使用小写短横线或小驼峰但需在同一模块内保持一致。
- **注释**：核心模块的公开函数需有简要 JSDoc（说明参数、返回值、副作用）；复杂的状态机/协议解析逻辑需有中文注释说明"为什么"而不仅是"是什么"。
- **错误处理**：
  - 所有与外部系统的交互（X-Plane 连接、文件读写、端口监听）必须 `try/catch` 或 Promise `.catch`，禁止让未捕获异常导致进程崩溃。
  - 网络/IO 类错误统一通过模块的 `on('error', cb)` 或返回 `{ ok: false, error: { code, message } }` 形式暴露，不直接 `throw` 到调用方无法处理的位置。
  - REST 接口出错时返回合理的 HTTP 状态码（400 参数错误、404 未找到、409 冲突如端口占用、500 未知错误）及统一格式 `{ "error": { "code": "PORT_IN_USE", "message": "..." } }`。
- **日志**：使用 `pino`（推荐，性能好、体积小）。日志级别：`debug`（原始 dataref 数值等高频信息，默认关闭）、`info`（连接建立/断开、模式切换、服务启动）、`warn`（重连、数据陈旧判定为无飞行）、`error`（连接失败、解析异常）。生产环境默认 `info` 级别。
- **Git 提交规范**：建议 Conventional Commits（`feat: `, `fix: `, `refactor: `, `docs: `, `chore: `），每个里程碑（见13节 M1-M8）对应至少一个功能完整的提交/PR。
- **目录规范**：严格遵循第 5.2 节（后端）与第 6.2 节（前端）给出的目录结构，新增文件需归类到对应子目录（`xplane/`、`broadcast/`、`routes/`、`utils/`）。

### 15.2 项目初始化清单

**`package.json` 关键依赖（后端）：**

```json
{
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.x",
    "ws": "^8.x",
    "axios": "^1.x",
    "dotenv": "^16.x",
    "pino": "^9.x",
    "qrcode": "^1.x"
  }
}
```

> 说明：`dgram` 为 Node.js 内置模块，无需安装。测试框架优先使用 Node.js 20 内置的 `node --test`（无需额外依赖），如实现者更熟悉 `jest`/`vitest` 亦可替换，需同步更新本节脚本。

**`.env.example`（完整版，含本轮新增项）：**

```
# 服务端口（前端设备访问的端口）
PORT=3000

# 通讯模式初始默认值（首次启动、config.json 不存在时使用）：webapi | udp
XPLANE_MODE=webapi

# Web API 模式参数
XPLANE_WEBAPI_HOST=127.0.0.1
XPLANE_WEBAPI_PORT=8086

# UDP 模式参数（Node.js 监听端口，需与 X-Plane Data Output 设置一致）
XPLANE_UDP_LISTEN_PORT=49005

# 广播到前端的更新频率（Hz）
UPDATE_HZ=2

# 判定“无飞行”的静默超时（毫秒）
FLIGHT_STALE_TIMEOUT_MS=5000

# 地图
MAP_PROVIDER=osm
GOOGLE_MAPS_API_KEY=

# 航迹保留时长（分钟）
TRACK_MAX_MINUTES=30

# 可选访问口令（留空表示不启用鉴权）
ACCESS_TOKEN=
```

**`config.json`（运行时可变配置，首次启动自动生成，结构见 4.3.1 / 10 节 `XPlaneModeConfig`，此处为完整示例）：**

```json
{
  "activeMode": "webapi",
  "webapi": { "host": "127.0.0.1", "port": 8086 },
  "udp": { "listenPort": 49005 },
  "flightStaleTimeoutMs": 5000,
  "updateHz": 2,
  "trackMaxMinutes": 30
}
```

`.env` 中的值仅作为 **首次启动、`config.json` 不存在时的默认值**；一旦 `config.json` 生成，后续以 `config.json` 为准（通过设置面板修改的内容写回 `config.json`，不回写 `.env`）。

### 15.3 后端模块详细设计

#### 15.3.1 `src/config.js` —— 静态配置加载

- **职责**：读取 `.env`（通过 `dotenv`），提供一份只读的默认配置对象，供 `configStore.js` 在 `config.json` 不存在时做初始化。
- **导出**：`export const defaultConfig = { ... }`（结构对应 15.2 节 `.env.example` 各项，转换为正确类型：端口转数字、`ACCESS_TOKEN` 空字符串转 `null`）。
- **边界情况**：`.env` 缺失某项时使用文档中给出的默认值兜底，不允许抛异常导致启动失败。
- **验收标准**：不存在 `.env` 文件时，`npm start` 仍可正常启动并使用内置默认值。

#### 15.3.2 `src/utils/configStore.js` —— 运行时配置持久化

- **职责**：管理 `config.json` 的读、写、合并更新；是 `activeMode` 等运行时状态的**唯一真源（single source of truth）**。
- **关键函数签名**：
  ```js
  async function loadConfig(): Promise<RuntimeConfig>       // 不存在则用 defaultConfig 创建文件并返回
  async function saveConfig(partial: Partial<RuntimeConfig>): Promise<RuntimeConfig>  // 合并写入并持久化，返回合并后的完整配置
  function getConfig(): RuntimeConfig                          // 同步读取内存中的当前配置（供高频调用场景，避免每次都读文件）
  ```
- **边界情况**：
  - 写文件采用"先写临时文件再 rename"的方式，避免进程中途崩溃导致 `config.json` 损坏。
  - 读取时若 JSON 解析失败（文件被手动改坏），记录 `error` 日志并回退到 `defaultConfig`，同时备份坏文件为 `config.json.bak`。
- **验收标准**：连续调用 `saveConfig({ activeMode: 'udp' })` 后重启进程，`loadConfig()` 返回的 `activeMode` 仍为 `'udp'`。

#### 15.3.3 `src/xplane/webApiClient.js` —— 方案A客户端

- **职责**：连接 X-Plane 12 内置 Web API（REST 查 dataref ID + WebSocket 订阅推送），解析为统一的 `AircraftPosition` 结构。
- **接口约定（与 `udpClient.js` 保持一致，供 `xplaneManager` 无差别调用）**：
  ```js
  class WebApiClient extends EventEmitter {
    constructor(opts: { host: string, port: number })
    async connect(): Promise<void>     // 建立REST探测+WS订阅，成功后开始emit('position', ...)
    async disconnect(): Promise<void>   // 主动断开，停止一切定时器/重连
    // events: 'connected', 'disconnected', 'position' (payload: AircraftPosition,不含flightActive),
    //         'error' (payload: { code, message })
  }
  ```
- **实现要点**：
  1. `connect()` 先 `GET http://{host}:{port}/api/v2/capabilities` 探测服务是否可用（超时建议 3s），失败则 emit `error`（code: `WEBAPI_UNREACHABLE`）并不再继续。
  2. 通过 `GET /api/v2/datarefs?filter[name]=...` 批量查询 4.1 节表格中各 dataref 的数值 ID（**只需在每次 `connect()` 时查一次，缓存 ID**，避免每帧都查）。
  3. 建立 `ws://{host}:{port}/api/v2/ws`，发送订阅请求（`dataref_subscribe_values`），设置推送频率（建议 5～10Hz，由 `updateHz` 的上游节流值决定，或直接固定为一个较低值如 5Hz 减少X-Plane侧负担）。
  4. 收到 WS 消息后按 dataref ID 映射回字段名，组装成 `AircraftPosition` 对象，`emit('position', payload)`。
  5. WS 断开时触发指数退避重连（见4.4节），最大重试间隔 10s，重连期间 `emit('disconnected')`。
- **边界情况**：
  - X-Plane 返回 403（未勾选"允许接受传入连接"）→ emit `error`，`code: 'FORBIDDEN'`，供前端设置面板展示具体原因。
  - 部分 dataref 查询不到 ID（不同飞机/版本可能路径略有差异）→ 记录 warn 日志，跳过该字段（对应 `AircraftPosition` 字段置 `null`），不阻塞其余字段的正常推送。
- **验收标准**：X-Plane 正常运行并允许连接时，`connect()` 后 2 秒内应至少收到一次 `position` 事件；手动关闭 X-Plane 后，10 秒内应观察到自动重连尝试（日志可见）。

#### 15.3.4 `src/xplane/udpClient.js` —— 方案B客户端

- **职责**：监听本地 UDP 端口，解析 X-Plane 的 `DATA*` 广播帧，组装为同样的 `AircraftPosition` 结构。
- **接口约定**：与 `WebApiClient` 完全一致（`connect/disconnect/on('position'|'connected'|'disconnected'|'error')`），`connect(opts: { listenPort })`。
- **实现要点**：
  1. 使用 `dgram.createSocket('udp4')`，`bind(listenPort)`。
  2. 每个 UDP 包结构：4字节 ASCII 头（`DATA` + 数据集索引，具体以 X-Plane 官方 Data Output 文档的 row index 对照表为准）+ 后续若干组 `[index(4字节int), 8个float(每个4字节)]`。需要实现者对照 X-Plane 官方文档中的 "row index" 列表，映射出经纬度、高度、航向、速度等所在的 row。
  3. 解析出的字段同样组装为 `AircraftPosition`，`emit('position', payload)`。
  4. 由于 UDP 无"连接"概念，`connect()` 只做 `bind`；是否"已连接"以**是否收到过至少一帧有效数据**为准（首次收到数据时 emit `connected`）。
- **边界情况**：
  - `listenPort` 被占用（`EADDRINUSE`）→ emit `error`，`code: 'PORT_IN_USE'`，供前端设置面板提示"该端口已被占用，请更换端口或检查是否已有实例在运行"。
  - 收到格式不符的包（非 X-Plane 广播、脏数据）→ 静默丢弃并记录 `debug` 日志，不抛异常。
- **验收标准**：正确配置 X-Plane Data Output 广播到该端口后，`connect()` 后应能在数据实际发送的频率下持续收到 `position` 事件；错误端口配置下不应导致进程崩溃，且能通过 REST 查到明确的错误原因。

#### 15.3.5 `src/xplane/xplaneManager.js` —— 统一调度与状态机（核心模块）

- **职责**：
  1. 按 `configStore` 中的 `activeMode` 决定启用 `webApiClient` 还是 `udpClient`；
  2. 统一维护 `xplaneConnected`、`flightActive`、`lastUpdate` 等状态（4.5节判定逻辑在此实现）；
  3. 对外提供**唯一的**事件源，供 `wsHub`/REST routes 消费，屏蔽底层是哪种客户端的细节；
  4. 提供 `switchMode()` 方法供 `POST /api/xplane-mode` 调用，执行"先断后连"的热切换（4.3.1节）。
- **关键函数/事件签名**：
  ```js
  class XPlaneManager extends EventEmitter {
    async start(): Promise<void>              // 应用启动时调用，根据当前config启用对应客户端
    async switchMode(newMode: 'webapi' | 'udp', params?: object): Promise<void> // 热切换，失败则抛出可读错误并保持原状态
    getStatus(): XPlaneModeConfig              // 同步获取当前完整状态（见10节接口）
    // events: 'position' (payload: AircraftPosition), 'status' (payload: XPlaneModeConfig，任意状态字段变化时触发)
  }
  ```
  - `flightActive` 判定：内部维护 `lastPositionTimestamp`，每次收到底层客户端的 `position` 事件时更新该时间戳并将 `flightActive` 置 `true`（若之前为 `false`，触发一次 `status` 事件）；再启动一个 `setInterval`（建议每 1000ms 检查一次）比较 `Date.now() - lastPositionTimestamp` 是否超过 `flightStaleTimeoutMs`，超过则置 `false` 并触发 `status` 事件（若之前为 `true`，避免重复触发）。
  - `switchMode()` 步骤：① 校验新参数合法性（端口范围等，非法直接 reject）；② 若新模式与当前相同且参数未变，直接返回（幂等）；③ 停用当前客户端并 `await disconnect()`；④ 重置 `flightActive=false`、`connected=false` 并广播一次状态（体现"切换中"）；⑤ 用新参数实例化并 `connect()` 新客户端；⑥ 连接结果（成功/失败）更新状态并广播；⑦ 调用 `configStore.saveConfig()` 持久化。
- **边界情况**：
  - `switchMode()` 过程中如果又收到一次新的切换请求（用户手速很快连点两次），应对前一次操作做取消/忽略处理，避免竞态（可用一个 `switching` 标志位或简单的操作队列）。
  - 底层客户端连续报错（如 UDP 端口一直占用）不应导致 `xplaneManager` 本身崩溃，错误需转换为 `status` 事件中的可读信息，而不是抛到顶层未捕获。
- **验收标准**：
  - 启动后默认按 `config.json.activeMode` 正确启用对应客户端；
  - 调用 `switchMode('udp', { listenPort: 49006 })` 后，`getStatus().activeMode === 'udp'` 且原 Web API 客户端已断开（无残留的定时器/连接，可通过日志或 `process._getActiveHandles()` 排查）；
  - 断开 X-Plane 5 秒以上后，`getStatus().flightActive === false`；恢复数据后 1 个心跳周期内变回 `true`。

#### 15.3.6 `src/broadcast/wsHub.js` —— 面向前端的广播中心

- **职责**：管理所有前端 WebSocket 连接的生命周期，将 `xplaneManager` 的 `position`/`status` 事件节流后广播给所有客户端；处理客户端的 `hello`/`ping` 消息。
- **关键函数签名**：
  ```js
  function attach(wss: WebSocketServer, xplaneManager: XPlaneManager): void
  // 内部逻辑：
  //  - xplaneManager.on('position', throttledBroadcastPosition)  节流到 updateHz
  //  - xplaneManager.on('status', broadcastStatus)                 状态变化立即广播，不节流
  //  - wss.on('connection', socket => { socket.on('message', handleClientMessage) })
  ```
- **实现要点**：
  - 节流实现：维护一个"距上次广播时间"判断，或用 `setInterval(1000/updateHz)` 固定节拍从最新收到的一条 position 缓存中取值广播（后者更平滑，推荐）。
  - 新客户端连接（`hello` 消息）时，立即回发一条当前最新的 `position`（如有）和当前 `xplane_status`，避免新连接的设备要等到下一个广播周期才看到画面。
  - `ping` 消息仅用于保活，服务端可选择性回 `pong`，或依赖 `ws` 库自带的心跳机制（`ws.isAlive` + 定时 `ping/pong` 帧，30s 周期，超时则终止连接）。
- **边界情况**：客户端异常断开（未正常关闭）需要被检测并从连接池移除，避免向已失效的 socket 写入抛出未捕获异常（用 `socket.on('error', ...)` 兜底）。
- **验收标准**：多个浏览器标签同时连接，均能收到一致的广播内容；一个客户端断开不影响其它客户端继续接收数据。

#### 15.3.7 `src/routes/*.js` —— REST 路由

| 文件 | 路由 | 实现要点 |
|---|---|---|
| `status.js` | `GET /api/status` | 直接返回 `xplaneManager.getStatus()` 的精简视图（`connected`, `flightActive`, `activeMode`, `lastUpdate`）|
| `config.js` | `GET /api/config` | 返回 `FrontendConfig`（10节），从 `configStore.getConfig()` + `.env` 中的 `GOOGLE_MAPS_API_KEY` 组装 |
| `xplaneMode.js` | `GET/POST /api/xplane-mode` | GET 返回 `xplaneManager.getStatus()` 全量；POST 校验 body 后调用 `xplaneManager.switchMode()`，成功返回最新状态，失败返回 `4xx` + 错误详情（见4.3.2示例）|
| `track.js` | `GET /api/track?minutes=N` | 从 `trackStore` 中按时间窗口过滤返回坐标点数组，`N` 非法（非数字/超过`trackMaxMinutes`）时截断到合法范围而非报错 |

**统一要求**：所有路由需注册在 `src/index.js` 的 Express app 上，路径前缀统一 `/api`；如启用了 `ACCESS_TOKEN`（见9节），需在一个公共中间件中校验（WebSocket 的校验逻辑见 `wsHub.js` 的 `hello` 处理）。

#### 15.3.8 `src/utils/trackStore.js` —— 航迹环形缓冲

- **职责**：内存中保存最近 `trackMaxMinutes` 分钟的坐标点，供航迹绘制与 `/api/track` 使用。
- **关键函数签名**：
  ```js
  function push(point: { lat, lon, timestamp }): void   // 追加一个点，自动淘汰过期点
  function getRecent(minutes: number): Array<{lat, lon, timestamp}>
  function clear(): void                                    // 供“切换模式/重新开始飞行”等场景手动清空（可选功能）
  ```
- **边界情况**：与 4.5 节"跳变检测"配合——若相邻两点距离超过合理阈值（见11节表格，建议阈值可配置，默认 5km/更新周期），仍然存入 `trackStore`，但标记 `breakBefore: true`，供前端据此决定航迹线在此处断开而不连线。
- **验收标准**：长时间运行（30分钟以上）内存占用稳定，不随时间无限增长。

#### 15.3.9 `src/utils/network.js` —— 局域网 IP 与二维码

- **职责**：枚举本机网卡（`os.networkInterfaces()`），过滤出局域网 IPv4 地址（排除 `127.0.0.1`、虚拟网卡），生成访问 URL 和对应二维码（`qrcode` 库生成 base64 PNG 或 SVG data URL），供首页渲染。
- **关键函数签名**：`function getLocalUrls(port: number): Array<{ iface: string, url: string, qrDataUrl: string }>`
- **边界情况**：多网卡（如同时有 WiFi 和有线）时全部列出，由用户自行判断使用哪一个；无可用局域网 IP（如仅回环）时给出明确提示文案而非空白。

#### 15.3.10 `src/index.js` —— 应用入口

- **职责**：加载配置 → 初始化 `configStore` → 实例化 `xplaneManager` 并 `start()` → 创建 Express app（挂载静态资源 `public/` 与各路由）→ 创建 `http.Server` + `WebSocketServer`（挂载 `wsHub`）→ 监听 `PORT`（`0.0.0.0`）→ 打印局域网访问地址与提示信息（对应8.2节部署步骤中的终端输出示例）。
- **边界情况**：端口被占用时给出清晰的错误提示（而非裸抛 `EADDRINUSE` 堆栈），并以非零码退出。
- **验收标准**：`npm start` 后终端按 8.2 节示例格式打印访问地址；`Ctrl+C` 能优雅关闭（断开 X-Plane 连接、关闭 WS 服务、关闭 HTTP 服务）不留僵尸进程。

### 15.4 前端模块详细设计

#### 15.4.1 `public/index.html`

- 页面骨架：顶部状态条（连接/无飞行提示，6.6节）+ 地图容器（`#map`）+ 悬浮信息面板 + 悬浮设置入口按钮 + 悬浮"回到飞机位置"按钮 + 首次访问的局域网地址/二维码展示区（可折叠）。
- 通过 `<script>` 引入 Leaflet（CDN 或本地 vendor 文件均可，考虑到部分部署场景可能无外网，建议**优先把 Leaflet 静态资源打包进 `public/vendor/`**，而非强依赖 CDN）。

#### 15.4.2 `public/js/wsClient.js`

- **职责**：封装与后端的 WebSocket 连接（`ws://<当前页面host>:<同端口>/ws`，无需硬编码 IP，用 `location.host` 动态拼），自动重连（断线后 1s/2s/5s 递增重试），心跳保活。
- **关键接口**：
  ```js
  function connect({ onPosition, onStatus, onOpen, onClose }): { send(obj), close() }
  ```
- **边界情况**：页面首次加载、WS 尚未 `open` 之前，`onStatus` 应先手动触发一次"未连接"的默认状态（对应6.6.3节要求），避免闪烁出正常画面。

#### 15.4.3 `public/js/mapController.js`

- **职责**：封装 Leaflet（及可选 Google Maps）的初始化、飞机图标更新、航迹绘制、"无飞行"灰色样式切换（6.6节）。
- **关键接口**：
  ```js
  function initMap(container, provider): MapController
  MapController.updatePosition(pos: AircraftPosition): void   // 更新飞机图标位置/朝向，若trackEnabled则追加航迹点
  MapController.setFlightActive(active: boolean): void          // 6.6.3节的灰色遮罩切换
  MapController.setFollowMode(follow: boolean): void              // 自动居中开关
  MapController.recenter(): void                                    // “回到飞机位置”按钮触发
  ```
- **边界情况**：`updatePosition` 在 `flightActive === false` 期间不应被调用（由 `app.js` 统一控制调用时机），避免出现"灰色遮罩下飞机图标却仍在跳动"的矛盾体验。

#### 15.4.4 `public/js/ui.js`

- **职责**：信息面板数值渲染、顶部状态条文案渲染（6.6.2节两种文案）、简单的中文文案常量集中管理。
- **关键接口**：
  ```js
  function updateInfoPanel(pos: AircraftPosition | null): void
  function updateStatusBanner(status: { connected, flightActive }): void
  ```

#### 15.4.5 `public/js/settingsPanel.js`

- **职责**：实现 6.4 节所述的设置面板交互（拉取/提交 `/api/xplane-mode`）。
- **关键接口**：`function initSettingsPanel(container): void`（内部自行处理表单状态、loading、错误提示）。

#### 15.4.6 `public/js/app.js`

- **职责**：入口，按顺序：`initMap` → `connect`(wsClient) → 绑定 `onPosition`→`mapController.updatePosition` + `ui.updateInfoPanel`；`onStatus` → `mapController.setFlightActive` + `ui.updateStatusBanner`；初始化 `settingsPanel`；拉取 `/api/config` 决定地图底图/是否显示航迹开关。

#### 15.4.7 `public/css/style.css`

- 覆盖：地图容器全屏布局、6.6.1节的灰色禁用样式（`.map-disabled`）、状态条样式、信息面板卡片样式、设置面板弹层样式、响应式断点（建议以 `768px` 为平板/手机分界）。

### 15.5 测试计划与验收用例（建议）

| 用例编号 | 场景 | 预期结果 |
|---|---|---|
| T1 | X-Plane 未启动时直接 `npm start` 后端 | 服务正常启动不崩溃，`/api/status` 返回 `connected:false, flightActive:false` |
| T2 | 启动 X-Plane 并允许连接，模式为 webapi | 5秒内前端地图恢复彩色、飞机图标出现 |
| T3 | 飞行中途暂停/切到主菜单 | `flightStaleTimeoutMs` 超时后前端自动置灰并显示"当前没有飞机在飞行" |
| T4 | 通过设置面板从 webapi 切到 udp（未在X-Plane配置UDP广播）| 面板显示"connected:false"，地图保持灰色，不崩溃 |
| T5 | 在 X-Plane 中正确配置 UDP 广播后 | udp 模式下前端恢复正常显示 |
| T6 | 两台设备（如笔记本+手机模拟器）同时打开页面 | 两端数据一致，互不影响，其中一端关闭不影响另一端 |
| T7 | 飞机在 X-Plane 中被手动传送（teleport）到很远的位置 | 航迹线在跳变处断开，不出现跨半个地球的直线 |
| T8 | 连续快速两次点击设置面板切换模式 | 不出现竞态错误，最终状态与最后一次点击一致 |
| T9 | 重启 Node.js 服务 | 记住上次选择的通讯模式和参数（读取 `config.json`）|
| T10 | 端口被占用（UDP监听端口冲突）| 设置面板给出清晰错误提示，不影响原模式继续运行 |

### 15.6 总体验收（Definition of Done）清单

- [ ] F1–F11（第2.1节）全部功能点均可在真实 X-Plane 12 环境下手动验证通过。
- [ ] N1–N6（第2.2节）非功能性要求均满足（更新频率可配、延迟可接受、断线自动重连、iPad Safari 实测通过、无数据库依赖、默认仅监听局域网）。
- [ ] 两种通讯模式（Web API / UDP）均可独立完整工作，并可在前端设置面板中无需重启服务完成切换（第4.3节）。
- [ ] "无飞行"灰色禁用样式（F11 / 6.6节）在"未连接"与"已连接但无数据"两种子状态下均有正确且不同的文案提示。
- [ ] 15.5 节列出的 T1–T10 用例均已手动或自动化验证通过。
- [ ] README 中包含完整的部署步骤（对应第8节）和 `.env.example`/`config.json` 说明。

---

**文档结束**
