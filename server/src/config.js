// 静态配置加载（设计文档 §15.3.1）：
// 读取 .env（通过 dotenv），提供一份只读的默认配置对象，
// 供 configStore.js 在 config.json 不存在时做初始化。
// 注意：.env 缺失某项时用内置默认值兜底，绝不允许抛异常导致启动失败。
import 'dotenv/config'

function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name], 10)
  return Number.isFinite(v) ? v : fallback
}

// 只持久化运行时可变配置（设计文档 §15.2 config.json 示例的 6 个键），
// port / 密钥类配置仅来自 .env，不写入 config.json。
export const PERSISTED_KEYS = [
  'activeMode',
  'webapi',
  'udp',
  'flightStaleTimeoutMs',
  'updateHz',
  'trackMaxMinutes',
]

export const defaultConfig = {
  // —— 服务端 ——
  port: intEnv('PORT', 3000),

  // —— 通讯模式（config.json 持久化）——
  activeMode: process.env.XPLANE_MODE === 'udp' ? 'udp' : 'webapi',
  webapi: {
    host: process.env.XPLANE_WEBAPI_HOST || '127.0.0.1',
    port: intEnv('XPLANE_WEBAPI_PORT', 8086),
  },
  udp: {
    listenPort: intEnv('XPLANE_UDP_LISTEN_PORT', 49005),
  },
  flightStaleTimeoutMs: intEnv('FLIGHT_STALE_TIMEOUT_MS', 5000),
  updateHz: intEnv('UPDATE_HZ', 2),
  trackMaxMinutes: intEnv('TRACK_MAX_MINUTES', 30),

  // —— 地图（仅 .env）——
  mapProvider: process.env.MAP_PROVIDER === 'google' ? 'google' : 'osm',
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null,

  // —— 鉴权（仅 .env，空字符串视为未启用）——
  accessToken: process.env.ACCESS_TOKEN || null,
}
