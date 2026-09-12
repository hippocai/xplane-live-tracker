// 导航数据接口（图层功能）：
//   GET  /api/navpoints?lat=&lon=&radiusKm=&types=airport,navaid,fix —— 中心+半径查询
//   GET  /api/nav-config  —— 加载状态与统计
//   POST /api/nav-config  —— 设置 X-Plane 安装路径并重新加载（空 = 自动探测）
import { getNavStatus, initNavData, queryNavPoints, reloadNavData } from '../utils/navDataStore.js'
import { saveConfig } from '../utils/configStore.js'
import { logger } from '../utils/logger.js'

export function registerNavRoutes(app) {
  app.get('/api/navpoints', (req, res) => {
    const lat = Number(req.query.lat)
    const lon = Number(req.query.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'lat/lon 必填' } })
      return
    }
    const types = typeof req.query.types === 'string' ? req.query.types.split(',') : undefined
    const { points, truncated } = queryNavPoints({
      lat,
      lon,
      radiusKm: Number(req.query.radiusKm) || 200,
      types,
    })
    res.json({ ...getNavStatus(), radiusCappedHint: truncated || undefined, points })
  })

  app.get('/api/nav-config', (req, res) => {
    res.json(getNavStatus())
  })

  app.post('/api/nav-config', async (req, res) => {
    const raw = typeof req.body?.xplanePath === 'string' ? req.body.xplanePath.trim() : ''
    try {
      // 空路径 = 自动探测常见安装位置；非空 = 按指定目录加载
      const status = raw ? await reloadNavData(raw) : await initNavData('')
      if (status.error) {
        res.status(400).json({ error: { code: 'NAV_DATA_UNAVAILABLE', message: status.error } })
        return
      }
      await saveConfig({ xplanePath: raw })
      logger.info({ xplanePath: raw }, '导航数据库路径已更新')
      res.json(status)
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } })
    }
  })
}
