// 前端 WebSocket 客户端（设计文档 §15.4.2）：
// - 地址按 location.host 动态拼接，不硬编码 IP
// - 断线自动重连：1s / 2s / 5s 递增（封顶 10s）
// - 连接建立后发 hello 握手（携带可选口令），每 25s 发一次应用层 ping 保活
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000]
const PING_INTERVAL_MS = 25000

/**
 * @param {{onPosition: Function, onStatus: Function, onOpen?: Function,
 *          onClose?: Function, onAuthRequired?: Function, getToken?: Function}} handlers
 * @returns {{send: Function, close: Function}}
 */
export function connect({ onPosition, onStatus, onOpen, onClose, onAuthRequired, getToken }) {
  let ws = null
  let attempts = 0
  let closedByUser = false
  let pingTimer = null
  let reconnectTimer = null

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onopen = () => {
      attempts = 0
      ws.send(JSON.stringify({ type: 'hello', token: getToken?.() || undefined }))
      clearInterval(pingTimer)
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, PING_INTERVAL_MS)
      onOpen?.()
    }

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'position') onPosition?.(msg.data)
      else if (msg.type === 'xplane_status') onStatus?.(msg.data)
      else if (msg.type === 'auth_required') {
        onAuthRequired?.(msg.data)
        close() // 服务端也会断开，这里主动清理并停止重连，等用户输入口令后再连
      }
    }

    ws.onclose = () => {
      clearInterval(pingTimer)
      if (closedByUser) return
      onClose?.()
      scheduleReconnect()
    }
    // onerror 后必然触发 onclose，此处无需额外处理
  }

  function scheduleReconnect() {
    const delay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)]
    attempts++
    reconnectTimer = setTimeout(open, delay)
  }

  open()

  return {
    send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
    },
    close() {
      closedByUser = true
      clearInterval(pingTimer)
      clearTimeout(reconnectTimer)
      if (ws) ws.close()
    },
    /** 重置"用户主动关闭"标记并立即重连（口令输入正确后调用） */
    reopen() {
      closedByUser = false
      attempts = 0
      open()
    },
  }
}
