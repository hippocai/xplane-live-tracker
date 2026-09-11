// 航迹环形缓冲（设计文档 §15.3.8）：
// 内存中保存最近 trackMaxMinutes 分钟的坐标点，供航迹绘制与 /api/track 使用。
// 长时间运行内存占用必须稳定，不随时间无限增长（验收标准）。

// —— 配置 ——
let maxMs = 30 * 60 * 1000
// 硬上限兜底：即使 trackMaxMinutes 配得很大 / 推送频率很高，也不会内存爆炸。
// 按 10Hz × 60min ≈ 36000 点估算。
const MAX_POINTS = 36000

// —— 状态 ——
const points = []

// 跳变检测阈值：相邻两点隐含速度超过该值（km/h）判定为 teleport，
// 仍然存入 trackStore 但标记 breakBefore: true，前端据此断开航迹线（设计文档 §11 / §15.3.8）。
// 真实飞机不可能超过该速度，而"5km/更新周期"在不同推送频率下不好统一换算，
// 因此实现上用"隐含速度"表达同一意图。
export const JUMP_SPEED_KMH = 3600 // = 1 km/s

/** 按运行时配置调整保留窗口（应用启动时调用一次） */
export function configure({ trackMaxMinutes } = {}) {
  if (Number.isFinite(trackMaxMinutes) && trackMaxMinutes > 0) {
    maxMs = trackMaxMinutes * 60 * 1000
  }
}

/** 追加一个点，自动淘汰过期点；相邻两点超速时标记 breakBefore */
export function push(point) {
  const entry = { ...point }
  const prev = points[points.length - 1]
  if (prev && prev.timestamp != null && entry.timestamp != null) {
    const dtSec = (entry.timestamp - prev.timestamp) / 1000
    if (dtSec > 0) {
      const dKm = haversineKm(prev, entry)
      if ((dKm / dtSec) * 3600 > JUMP_SPEED_KMH) {
        entry.breakBefore = true
      }
    }
  }
  points.push(entry)
  prune()
}

/** 返回最近 minutes 分钟内的点（非法/越界窗口由调用方截断，这里只做下限保护） */
export function getRecent(minutes) {
  const windowMs = Math.max(1, minutes) * 60 * 1000
  const cutoff = Date.now() - windowMs
  const out = []
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].timestamp < cutoff) break
    out.unshift(points[i])
  }
  return out
}

/** 供"切换模式/重新开始飞行"等场景手动清空 */
export function clear() {
  points.length = 0
}

function prune() {
  const cutoff = Date.now() - maxMs
  // 找到第一个未过期点，一次性截掉前面的过期段
  let firstValid = 0
  while (firstValid < points.length && points[firstValid].timestamp < cutoff) {
    firstValid++
  }
  if (firstValid > 0) points.splice(0, firstValid)
  if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS)
}

// 两点间大圆距离（km）。haversine 公式，精度对航迹跳变检测足够。
function haversineKm(a, b) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}
