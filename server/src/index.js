// 应用入口（设计文档 §15.3.10）：
// 加载配置 → 初始化 xplaneManager → Express（静态资源 + REST）→
// http.Server + WebSocketServer(/ws) → 监听 0.0.0.0:PORT → 打印局域网访问地址。
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'
import { loadConfig } from './utils/configStore.js'
import { logger } from './utils/logger.js'
import { getLocalUrls } from './utils/network.js'
import * as trackStore from './utils/trackStore.js'
import { XPlaneManager } from './xplane/xplaneManager.js'
import { attach as attachWsHub } from './broadcast/wsHub.js'
import { registerStatusRoute } from './routes/status.js'
import { registerConfigRoute } from './routes/config.js'
import { registerXplaneModeRoute } from './routes/xplaneMode.js'
import { registerTrackRoute } from './routes/track.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 顶层异常兜底：与外部系统（X-Plane、文件、端口）相关的任何未捕获异常
// 都不允许直接击穿进程（§15.1 错误处理原则）
process.on('uncaughtException', (err) => {
  logger.error({ err }, '未捕获异常（已拦截，服务继续运行）')
})
process.on('unhandledRejection', (err) => {
  logger.error({ err }, '未处理的 Promise 拒绝（已拦截，服务继续运行）')
})

const cfg = await loadConfig()
trackStore.configure({ trackMaxMinutes: cfg.trackMaxMinutes })

const xplaneManager = new XPlaneManager()
// 启动时若 X-Plane 尚未就绪，manager 内部会自动重试，不阻塞服务启动
await xplaneManager.start()

// 数据流（设计文档 §5.3）：position 事件 → 航迹环形缓冲（供 /api/track 与刷新补画）
xplaneManager.on('position', (pos) => {
  trackStore.push({ lat: pos.lat, lon: pos.lon, timestamp: pos.timestamp })
})

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '100kb' }))
app.use(express.static(path.join(rootDir, 'public')))

// —— 可选访问口令（§9）：除 /api/config 外的 REST 接口统一校验 ——
function requireToken(req, res, next) {
  const token = req.get('x-access-token') || req.query.token
  if (!token || token !== cfg.accessToken) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '访问口令缺失或不正确' } })
    return
  }
  next()
}
if (cfg.accessToken) {
  app.use('/api', (req, res, next) =>
    req.path.startsWith('/config') ? next() : requireToken(req, res, next),
  )
}

registerConfigRoute(app, { accessToken: cfg.accessToken })
registerStatusRoute(app, xplaneManager)
registerXplaneModeRoute(app, xplaneManager)
registerTrackRoute(app)

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
const wsHub = attachWsHub(wss, xplaneManager, {
  updateHz: cfg.updateHz,
  accessToken: cfg.accessToken,
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`端口 ${cfg.port} 已被占用。请更换 .env 中的 PORT，或释放该端口后重试。`)
    process.exit(1)
  }
  logger.error({ err }, 'HTTP 服务错误')
})

server.listen(cfg.port, '0.0.0.0', async () => {
  // 启动横幅。注意：不要在控制台输出中使用 emoji（✔✈⚠ 等），
  // 中文 Windows 传统控制台（GBK 代码页）缺字形会显示乱码。
  console.log('[OK] X-Plane Tracker 已启动')
  const lanUrls = await getLocalUrls(cfg.port)
  if (lanUrls.length === 0) {
    console.log(`[!!] 未检测到局域网 IPv4 地址，仅可通过 http://localhost:${cfg.port} 本机访问`)
  } else {
    for (const { iface, url } of lanUrls) {
      console.log(`[OK] 局域网访问地址: ${url}  （网卡: ${iface}）`)
    }
    console.log('[OK] 已生成二维码，可在首页查看')
  }
  logger.info({ port: cfg.port, mode: xplaneManager.activeMode }, '服务启动完成')
})

// —— 优雅关闭：断开 X-Plane、关闭 WS 与 HTTP 服务，不留僵尸进程（§15.3.10 验收标准）——
let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, '收到退出信号，正在优雅关闭…')
  wsHub.close()
  await xplaneManager.stop().catch(() => {})
  wss.close()
  server.close(() => process.exit(0))
  // 兜底：若仍有连接挂着，3 秒后强制退出
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
