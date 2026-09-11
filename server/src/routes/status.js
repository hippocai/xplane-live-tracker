// GET /api/status —— 连接状态精简视图（设计文档 §5.4 / §15.3.7）
/**
 * @param {import('express').Express} app
 * @param {import('../xplane/xplaneManager.js').XPlaneManager} xplaneManager
 */
export function registerStatusRoute(app, xplaneManager) {
  app.get('/api/status', (req, res) => {
    const s = xplaneManager.getStatus()
    const lastUpdate = s.activeMode === 'udp' ? s.udp.lastUpdate : s.webapi.lastUpdate
    res.json({
      activeMode: s.activeMode,
      connected: s.connected,
      flightActive: s.flightActive,
      lastUpdate,
    })
  })
}
