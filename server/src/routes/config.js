// GET /api/config —— 前端所需配置（设计文档 §7.4 / §15.3.7）
// 扩展说明：在 §7.4 字段基础上追加 lanUrls（局域网地址 + 二维码，F10）与
// authRequired（是否启用了访问口令，§9）。两者均为向后兼容的新增字段。
// 注意：本路由不做鉴权——前端需要在登录前拿到"是否需要口令"这一信息。
import { getConfig } from '../utils/configStore.js'
import { getLocalUrls } from '../utils/network.js'

/**
 * @param {import('express').Express} app
 * @param {{accessToken: string|null}} opts
 */
export function registerConfigRoute(app, { accessToken }) {
  app.get('/api/config', async (req, res) => {
    try {
      const cfg = getConfig()
      const lanUrls = await getLocalUrls(cfg.port)
      res.json({
        mapProvider: cfg.mapProvider,
        googleMapsApiKey: cfg.googleMapsApiKey,
        updateHz: cfg.updateHz,
        trackEnabled: true,
        trackMaxMinutes: cfg.trackMaxMinutes,
        authRequired: Boolean(accessToken),
        lanUrls,
      })
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } })
    }
  })
}
