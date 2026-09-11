// 面向前端的 WebSocket 广播中心（设计文档 §5.4 / §15.3.6）。
// - position：按 updateHz 固定节拍从"最新缓存的一条"取值广播（比节流更平滑，§15.3.6 推荐做法）
// - status：任意状态字段变化立即广播，不节流
// - 客户端 hello：校验可选访问口令后，立即回发最新 position + 当前 xplane_status，
//   避免新连接的设备等到下一个广播周期才看到画面
// - 心跳：依赖 ws 库的 ping/pong 帧（30s 周期，超时终止连接）
import { logger } from '../utils/logger.js'

const HEARTBEAT_INTERVAL_MS = 30000

/**
 * @param {import('ws').WebSocketServer} wss
 * @param {import('../xplane/xplaneManager.js').XPlaneManager} xplaneManager
 * @param {{updateHz: number, accessToken: string|null}} opts
 */
export function attach(wss, xplaneManager, { updateHz, accessToken }) {
  let latestPosition = null
  let latestStatusJson = JSON.stringify({ type: 'xplane_status', data: xplaneManager.getStatus() })

  // —— 上行数据接入 ——
  xplaneManager.on('position', (pos) => {
    latestPosition = pos
  })

  xplaneManager.on('status', (status) => {
    latestStatusJson = JSON.stringify({ type: 'xplane_status', data: status })
    broadcastText(latestStatusJson)
  })

  // 固定节拍广播位置（1000/updateHz 毫秒）
  const tick = setInterval(
    () => {
      if (!latestPosition) return
      // 多个前端连接复用同一份序列化 JSON 字符串，避免重复 stringify 开销（§5.5）
      const payload = JSON.stringify({ type: 'position', data: latestPosition })
      broadcastText(payload)
    },
    Math.max(100, Math.round(1000 / Math.max(0.1, updateHz))),
  )
  tick.unref?.()

  function broadcastText(text) {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(text, (err) => {
          if (err) logger.debug({ err: err.message }, '向客户端写入失败（可能刚断开）')
        })
      }
    }
  }

  // —— 客户端连接生命周期 ——
  wss.on('connection', (socket) => {
    socket.isAlive = true
    socket.on('pong', () => {
      socket.isAlive = true
    })
    // 客户端异常断开必须有兜底，避免向失效 socket 写入时抛未捕获异常（§15.3.6 边界情况）
    socket.on('error', (err) => {
      logger.debug({ err: err.message }, '前端 WebSocket 连接错误')
    })

    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return // 非 JSON 消息直接忽略
      }
      if (msg?.type === 'hello') {
        // 可选访问口令校验（§9）：不通过则断开连接
        if (accessToken && msg.token !== accessToken) {
          socket.send(
            JSON.stringify({ type: 'auth_required', data: { reason: 'token 无效或缺失' } }),
          )
          socket.close(4001, 'unauthorized')
          return
        }
        // 握手：立即回发当前最新位置（如有）与当前状态
        if (latestPosition) {
          socket.send(JSON.stringify({ type: 'position', data: latestPosition }))
        }
        socket.send(latestStatusJson)
      } else if (msg?.type === 'ping') {
        // 应用层心跳保活（与 ws 协议层 ping/pong 互不冲突）
        socket.send(JSON.stringify({ type: 'pong' }))
      }
    })
  })

  // —— 协议层心跳：30s 一轮，两轮无 pong 视为死连接并终止 ——
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate()
        continue
      }
      client.isAlive = false
      client.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()

  return {
    /** 优雅关闭时调用 */
    close() {
      clearInterval(tick)
      clearInterval(heartbeat)
    },
  }
}
