// GET /api/track?minutes=N —— 最近 N 分钟航迹点（设计文档 §5.4 / §15.3.7）
// N 非法或超出 trackMaxMinutes 时截断到合法范围而非报错。
import { getConfig } from '../utils/configStore.js'
import * as trackStore from '../utils/trackStore.js'

export function registerTrackRoute(app) {
  app.get('/api/track', (req, res) => {
    const max = getConfig().trackMaxMinutes
    let minutes = Number(req.query.minutes)
    if (!Number.isFinite(minutes) || minutes < 1) minutes = max
    if (minutes > max) minutes = max
    res.json({
      minutes,
      points: trackStore.getRecent(minutes),
    })
  })
}
