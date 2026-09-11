// 方案 B：传统 UDP DATA 广播客户端（设计文档 §4.2 / §15.3.4）。
// 监听本地 UDP 端口，解析 X-Plane 的 DATA 帧，组装为与 WebApiClient 相同的
// AircraftPosition 结构（接口完全一致，供 xplaneManager 无差别调度）。
// UDP 无"连接"概念：connect() 只做 bind，是否"已连接"以收到首帧有效数据为准。
import { EventEmitter } from 'node:events'
import dgram from 'node:dgram'
import { logger } from '../utils/logger.js'

const MS_TO_KT = 1.94384 // m/s → 节
const FT_PER_M = 3.28084 // 米 → 英尺

/**
 * DATA 帧行映射表（设计文档 §4.2/§15.3.4 要求按 X-Plane 官方 Data Output 的
 * "row index" 对照表映射）。每个包由若干组 [int32 行号, 8×float32] 组成，
 * 此处只声明我们关心的行与列索引。
 *
 * 需要在 X-Plane Settings → Data Output 中启用以下数据行并广播到本机监听端口：
 *   - 第 18 行（Lat, Lon, Altitude）→ 经纬度 / 海拔 MSL / AGL
 *   - 第 20 行（Pitch, Roll, Headings）→ 俯仰 / 横滚 / 真航向
 *   - 第 21 行（Speeds）→ 指示空速（列 1）
 *   - 第 3 行（Velocities，本机坐标系 m/s）→ 地速与垂直速度由 vx/vz、vy 计算
 *
 * 若你的 X-Plane 版本行号定义有出入，只需调整此表即可（行为集中在一处）。
 */
export const DATA_ROW_MAP = {
  18: { lat: 0, lon: 1, altMsl: 2, altAgl: 3 },
  20: { pitch: 0, roll: 1, heading: 2 },
  21: { iasKt: 1 },
  3: { vx: 0, vy: 1, vz: 2 },
}

/**
 * 解析一个 UDP DATA 包（纯函数，便于单元测试）。
 * X-Plane DATA 包格式：4 字节 ASCII 头 "DATA"，之后若干组
 * [4 字节行号(int32) + 8 个 4 字节 float]（每组 36 字节）。
 *
 * 字节序：不同版本/资料对字节序说法不一，因此先按小端解析并用
 * 经纬度合理范围做校验，不合理则按大端重试——两种都能兼容。
 *
 * @param {Buffer} buffer 原始 UDP 载荷
 * @returns {Object|null} 解析出的原始行数据 { rows: {rowIndex: float[8]} }，无效包返回 null
 */
export function parseDataPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null
  if (buffer.toString('ascii', 0, 4) !== 'DATA') return null

  // 先试小端，行号/经纬度不合理时再试大端；两种都无效才判定为脏包
  for (const littleEndian of [true, false]) {
    const rows = {}
    let valid = true
    for (let offset = 4; offset + 36 <= buffer.length; offset += 36) {
      const rowIndex = littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset)
      if (rowIndex < 0 || rowIndex > 10000) {
        valid = false
        break
      }
      const floats = []
      for (let i = 0; i < 8; i++) {
        const p = offset + 4 + i * 4
        floats.push(littleEndian ? buffer.readFloatLE(p) : buffer.readFloatBE(p))
      }
      rows[rowIndex] = floats
    }
    // 本字节序解析无效：换另一种重试（不要在此返回 null）
    if (!valid || Object.keys(rows).length === 0) continue
    // 用第 18 行的经纬度合理性判定字节序是否正确
    const row18 = rows[18]
    if (row18) {
      const [lat, lon] = row18
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      ) {
        continue // 换另一种字节序重试
      }
    }
    return { rows }
  }
  return null
}

/**
 * 把解析出的行数据组装为 AircraftPosition（纯函数，便于单元测试）。
 * 经纬度缺失时返回 null（同 WebApiClient 的约定：没有位置就没有有效帧）。
 * @param {{rows: Object<string, number[]>}} parsed parseDataPacket 的返回值
 * @param {number} timestamp
 */
export function buildPositionFromRows(parsed, timestamp) {
  if (!parsed) return null
  const rows = parsed.rows
  const row = (n) => rows[n] || null
  const pick = (r, idx) => {
    const v = r?.[idx]
    return Number.isFinite(v) ? v : null
  }

  const r18 = row(18)
  const lat = pick(r18, 0)
  const lon = pick(r18, 1)
  if (lat == null || lon == null) return null

  const r20 = row(20)
  const r21 = row(21)
  const r3 = row(3)
  const vx = pick(r3, 0)
  const vy = pick(r3, 1)
  const vz = pick(r3, 2)

  // 地速 = 水平面速度分量合成（本机坐标系：X 向东、Y 向上、Z 向南），
  // 垂直速度 = vy（m/s → ft/min，即 ×3.28084×60）。不依赖 Speeds 行中地速列的版本差异。
  const groundSpeedKt = vx != null && vz != null ? Math.sqrt(vx * vx + vz * vz) * MS_TO_KT : null
  const verticalSpeedFpm = vy != null ? vy * FT_PER_M * 60 : null

  return {
    lat,
    lon,
    altMsl: pick(r18, 2),
    altAgl: pick(r18, 3),
    heading: pick(r20, 2),
    groundSpeedKt,
    iasKt: pick(r21, 1),
    verticalSpeedFpm,
    pitch: pick(r20, 0),
    roll: pick(r20, 1),
    tailNumber: null, // UDP DATA 广播不含注册号
    timestamp,
  }
}

export class UdpClient extends EventEmitter {
  /**
   * @param {{listenPort: number}} opts
   */
  constructor(opts) {
    super()
    this.listenPort = opts.listenPort
    this.socket = null
    this.gotFirstFrame = false
  }

  /**
   * 绑定监听端口；成功后开始 emit('position', ...)。
   * UDP 无连接概念，"已连接"以收到首帧有效数据为准（§15.3.4 实现要点 4）。
   * @returns {Promise<void>} bind 成功即 resolve；端口占用 reject({code:'PORT_IN_USE'})
   */
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4')
      const onError = (err) => {
        cleanup()
        try {
          this.socket.close()
        } catch {
          /* 未 bind 成功的 socket close 会抛异常 */
        }
        this.socket = null
        const code = err?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'UDP_BIND_FAILED'
        const message =
          code === 'PORT_IN_USE'
            ? `UDP 监听端口 ${this.listenPort} 已被占用，请更换端口或检查是否已有实例在运行`
            : `UDP 端口绑定失败：${err?.message}`
        this.#emitError(code, message)
        reject({ code, message })
      }
      const cleanup = () => this.socket?.removeListener('error', onError)

      this.socket.on('error', onError)
      this.socket.on('message', (buf) => this.#onPacket(buf))
      this.socket.bind(this.listenPort, () => {
        cleanup()
        this.gotFirstFrame = false
        resolve()
      })
    })
  }

  /** 主动断开，关闭 socket 并停止一切事件 */
  async disconnect() {
    if (this.socket) {
      try {
        this.socket.removeAllListeners()
        this.socket.close()
      } catch {
        /* 已关闭 */
      }
      this.socket = null
    }
    this.gotFirstFrame = false
  }

  #onPacket(buf) {
    // 格式不符的包（非 X-Plane 广播、脏数据）静默丢弃并记 debug 日志，不抛异常
    let parsed
    try {
      parsed = parseDataPacket(buf)
    } catch (err) {
      logger.debug({ err: err.message }, 'UDP 包解析异常，已丢弃')
      return
    }
    if (!parsed) {
      logger.debug('收到非 DATA 格式的 UDP 包，已丢弃')
      return
    }
    const position = buildPositionFromRows(parsed, Date.now())
    if (!position) return
    if (!this.gotFirstFrame) {
      this.gotFirstFrame = true
      logger.info({ port: this.listenPort }, '收到首帧 UDP 数据，视为已连接')
      this.emit('connected')
    }
    this.emit('position', position)
  }

  #emitError(code, message) {
    logger.error({ code, message }, 'UdpClient 错误')
    this.emit('error', { code, message })
  }
}
