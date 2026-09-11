// GET/POST /api/xplane-mode —— 查询/切换通讯模式（设计文档 §4.3.2 / §15.3.7）
// POST 成功返回最新状态；失败按错误码映射 HTTP 状态：
//   INVALID_PARAMS → 400，PORT_IN_USE → 409，上游不可达/拒绝 → 502，其余 → 500
// 统一错误格式：{ "error": { "code": "...", "message": "..." } }（§15.1）
import { logger } from '../utils/logger.js'

const HTTP_STATUS_BY_CODE = {
  INVALID_PARAMS: 400,
  PORT_IN_USE: 409,
  WEBAPI_UNREACHABLE: 502,
  FORBIDDEN: 502,
  DATAREF_RESOLVE_FAILED: 502,
  UDP_BIND_FAILED: 500,
}

/**
 * @param {import('express').Express} app
 * @param {import('../xplane/xplaneManager.js').XPlaneManager} xplaneManager
 */
export function registerXplaneModeRoute(app, xplaneManager) {
  app.get('/api/xplane-mode', (req, res) => {
    res.json(xplaneManager.getStatus())
  })

  app.post('/api/xplane-mode', async (req, res) => {
    const { activeMode, webapi, udp } = req.body || {}
    try {
      const status = await xplaneManager.switchMode(activeMode, { webapi, udp })
      res.json(status)
    } catch (err) {
      const code = err?.code || 'SWITCH_FAILED'
      const message = err?.message || '切换通讯模式失败'
      logger.warn({ code, message }, '模式切换请求失败')
      res.status(HTTP_STATUS_BY_CODE[code] || 500).json({ error: { code, message } })
    }
  })
}
