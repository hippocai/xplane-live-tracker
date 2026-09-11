# xplane-live-tracker

X-Plane 12 实时飞机位置追踪工具。在局域网内实时查看 X-Plane 12 正在模拟飞行的飞机位置。后端（Node.js）读取 X-Plane 数据并通过 WebSocket 推送，任意设备（iPad、手机、电脑）打开浏览器输入后端 IP 即可在地图上实时查看飞机位置和航迹。

详细设计见 [`design_specs.md`](./design_specs.md)，本 README 仅作快速上手指南。

## 功能特性

- 支持两种与 X-Plane 通讯的方式，并可在前端设置面板中随时切换：
  - **X-Plane 12 内置 Web API**（推荐，需 X-Plane 12.1.1+）
  - **传统 UDP 数据广播**（兼容旧版本）
- 地图默认使用 OpenStreetMap（免费无需 Key），可选切换 Google Maps
- 飞机图标随航向实时旋转，支持飞行航迹绘制
- 支持多设备同时查看
- 当前没有飞机在飞行时，地图自动以灰色禁用样式提示

## 环境要求

- Node.js ≥ 20
- X-Plane 12（Web API 模式需 12.1.1 及以上版本）
- 运行 X-Plane 与本工具的电脑，和查看地图的设备（iPad/手机等）需处于同一局域网

## 快速开始

```bash
# 0. 克隆项目
git clone <repo-url>/xplane-live-tracker.git
cd xplane-live-tracker

# 1. 安装依赖
npm install

# 2. 复制环境变量配置文件并按需修改
cp .env.example .env

# 3. 在 X-Plane 12 的 Settings → Network 中勾选"允许接受传入连接"（Accept incoming connections）

# 4. 启动服务
npm start
```

启动后终端会打印局域网访问地址，例如：

```
✔ X-Plane Tracker 已启动
✔ 局域网访问地址: http://192.168.1.50:3000
✔ 已生成二维码，可在首页查看
```

在 X-Plane 中开始飞行后，用同一 WiFi 下的 iPad/手机浏览器打开上述地址（或扫描首页二维码）即可实时查看飞机位置。

如需使用 UDP 通讯模式，还需在 X-Plane 的 `Settings → Data Output → Data Set` 中勾选相应数据行，并将广播目标设置为本机 IP + `.env` 中配置的 `XPLANE_UDP_LISTEN_PORT` 端口；也可以直接在网页右上角的"设置"面板中切换并配置该模式，无需重启服务。

## 常用配置项（.env）

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 前端设备访问的端口 | `3000` |
| `XPLANE_MODE` | 初始通讯模式 `webapi` \| `udp` | `webapi` |
| `XPLANE_WEBAPI_HOST` / `XPLANE_WEBAPI_PORT` | X-Plane Web API 地址 | `127.0.0.1` / `8086` |
| `XPLANE_UDP_LISTEN_PORT` | UDP 模式监听端口 | `49005` |
| `UPDATE_HZ` | 推送给前端的更新频率 | `2` |
| `FLIGHT_STALE_TIMEOUT_MS` | 判定"无飞行"的静默超时（毫秒） | `5000` |
| `MAP_PROVIDER` | 默认地图 `osm` \| `google` | `osm` |
| `GOOGLE_MAPS_API_KEY` | 如使用 Google Map 需填 | 空 |
| `ACCESS_TOKEN` | 可选访问口令 | 空（不启用）|

首次启动后，上述部分配置会写入 `config.json` 并作为后续运行的实际生效值（通过网页设置面板修改后也会写回该文件），`.env` 仅作为首次初始化的默认值。

## 目录结构

```
xplane-live-tracker/
├── server/           # Node.js 后端
├── public/            # 前端静态页面
├── config.json          # 运行时配置（自动生成）
├── .env.example
└── package.json
```

## 常见问题

- **前端一直显示"未连接到 X-Plane"**：确认 X-Plane 已启动、`Settings → Network` 中已允许接受传入连接，并确认设置面板中的通讯模式和端口配置正确。
- **地图显示灰色、提示"当前没有飞机在飞行"**：说明已连接 X-Plane 但暂无有效飞行数据（如停在主菜单、模拟暂停），在 X-Plane 中加载飞机并开始飞行后会自动恢复。
- **iPad/手机打不开页面**：确认设备与运行本工具的电脑处于同一局域网，且电脑防火墙已放行对应端口。

## 开发说明

给 Claude Code / 开发者的完整模块设计、函数签名、验收标准请参阅设计文档第 15 节《模块详细设计与开发任务清单》。
