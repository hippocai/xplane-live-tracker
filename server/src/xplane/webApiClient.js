// 方案 A：X-Plane 12 内置 Web API 客户端（设计文档 §4.1 / §15.3.3）。
// 流程：REST 探测 capabilities → 查询 dataref 数值 ID（每次 connect 查一次并缓存）→
// WebSocket 订阅 dataref_subscribe_values（固定 5Hz，降低 X-Plane 侧负担）→
// 把推送值组装为统一的 AircraftPosition 并 emit('position')。
// 断线时按 1s → 2s → 5s → 10s（封顶）指数退避自动重连（§4.4）。
import { EventEmitter } from 'node:events'
import axios from 'axios'
import WebSocket from 'ws'
import { logger } from '../utils/logger.js'

const MS_TO_KT = 1.94384 // 地速 m/s → 节

// 需要订阅的 dataref（§4.1 表格）。field 为 AircraftPosition 字段名；
// convert 为可选的单位换算；optional 为 true 时查询不到不视为致命错误。
export const DATAREF_SPECS = [
  { name: 'sim/flightmodel/position/latitude', field: 'lat' },
  { name: 'sim/flightmodel/position/longitude', field: 'lon' },
  { name: 'sim/flightmodel/position/elevation', field: 'altMsl' },
  { name: 'sim/flightmodel/position/y_agl', field: 'altAgl' },
  { name: 'sim/flightmodel/position/psi', field: 'heading' },
  {
    name: 'sim/flightmodel/position/groundspeed',
    field: 'groundSpeedKt',
    convert: (v) => v * MS_TO_KT,
  },
  { name: 'sim/flightmodel/position/indicated_airspeed', field: 'iasKt', optional: true },
  { name: 'sim/flightmodel/position/phi', field: 'roll' },
  { name: 'sim/flightmodel/position/theta', field: 'pitch' },
  { name: 'sim/flightmodel/position/vh_ind_fpm', field: 'verticalSpeedFpm', optional: true },
  { name: 'sim/aircraft/view/acf_tailnum', field: 'tailNumber', optional: true },
]

// 订阅推送频率（Hz）。上游设计建议 5～10Hz，固定取 5：广播侧还会按 updateHz 节流（§15.3.3）。
const SUBSCRIBE_HZ = 5
// 指数退避序列（毫秒），超出后封顶在最后一个值
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000]

export class WebApiClient extends EventEmitter {
  /**
   * @param {{host: string, port: number}} opts
   */
  constructor(opts) {
    super()
    this.host = opts.host
    this.port = opts.port
    this.ws = null
    this.reconnectTimer = null
    this.attempts = 0
    this.intentionalClose = false
    // dataref 数值 ID → 字段名 的映射（每次 connect 重新解析，避免版本变化后失效）
    this.idToField = new Map()
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`
  }

  /**
   * 建立 REST 探测 + WS 订阅，成功后开始 emit('position', ...)
   * @returns {Promise<void>} 订阅建立成功即 resolve；探测/连接失败 reject({code, message})
   */
  async connect() {
    this.intentionalClose = false
    // 1. 探测服务可用性（3s 超时，§15.3.3 实现要点 1）
    try {
      await axios.get(`${this.baseUrl}/api/v2/capabilities`, { timeout: 3000 })
    } catch (err) {
      const code = err?.response?.status === 403 ? 'FORBIDDEN' : 'WEBAPI_UNREACHABLE'
      const message =
        code === 'FORBIDDEN'
          ? `X-Plane Web API 拒绝访问（403）：请在 Settings → Network 中勾选"允许接受传入连接"`
          : `无法连接 X-Plane Web API（${this.host}:${this.port}）：${err.message}`
      this.#emitError(code, message)
      throw { code, message } // eslint-disable-line no-throw-literal
    }
    // 2. 解析 dataref ID（只查一次并缓存）
    await this.#resolveDatarefIds()
    // 3. 建立 WS 并订阅（重连路径也走这里）
    await this.#openSocket()
  }

  /** 主动断开，停止一切定时器/重连 */
  async disconnect() {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.attempts = 0
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close()
      } catch {
        /* 已关闭的 socket 上 close 可能抛异常，忽略 */
      }
      this.ws = null
    }
  }

  async #resolveDatarefIds() {
    this.idToField.clear()
    for (const spec of DATAREF_SPECS) {
      try {
        // filter[name] 查询该 dataref 的数值 ID
        const res = await axios.get(`${this.baseUrl}/api/v2/datarefs`, {
          params: { 'filter[name]': spec.name },
          timeout: 3000,
        })
        const list = Array.isArray(res.data?.data) ? res.data.data : []
        // 取 name 完全匹配的第一条（不同版本返回的元数据字段可能有差异）
        const hit = list.find((d) => d?.name === spec.name)
        if (hit && hit.id != null) {
          this.idToField.set(hit.id, spec)
        } else if (!spec.optional) {
          logger.warn({ dataref: spec.name }, 'dataref 查询不到 ID，该字段将始终为 null')
        }
      } catch (err) {
        logger.warn({ dataref: spec.name, err: err.message }, 'dataref ID 查询失败，跳过该字段')
      }
    }
    if (this.idToField.size === 0) {
      const message = '所有 dataref 均查询失败，无法订阅位置数据'
      this.#emitError('DATAREF_RESOLVE_FAILED', message)
      throw { code: 'DATAREF_RESOLVE_FAILED', message } // eslint-disable-line no-throw-literal
    }
  }

  #openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${this.port}/api/v2/ws`)
      this.ws = ws
      let settled = false

      ws.on('open', () => {
        // 订阅请求：request_id + dataref_subscribe_values（§4.1）
        const ids = [...this.idToField.keys()]
        ws.send(
          JSON.stringify({
            type: 'dataref_subscribe_values',
            request_id: 1,
            data: { ids, frequency: SUBSCRIBE_HZ },
          }),
        )
        settled = true
        this.attempts = 0
        this.emit('connected')
        resolve()
      })

      ws.on('message', (raw) => {
        try {
          this.#handleMessage(JSON.parse(raw.toString()))
        } catch (err) {
          // 单条消息解析失败只记日志，绝不影响连接
          logger.debug({ err: err.message }, 'Web API 消息解析失败')
        }
      })

      ws.on('error', (err) => {
        if (!settled) {
          settled = true
          reject({ code: 'WEBAPI_UNREACHABLE', message: `WebSocket 连接失败：${err.message}` })
        }
      })

      ws.on('close', () => {
        if (this.intentionalClose) return
        this.emit('disconnected')
        if (!settled) {
          settled = true
          reject({ code: 'WEBAPI_UNREACHABLE', message: 'WebSocket 在订阅建立前关闭' })
          return
        }
        this.#scheduleReconnect()
      })
    })
  }

  #scheduleReconnect() {
    if (this.intentionalClose || this.reconnectTimer) return
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)]
    this.attempts++
    logger.warn({ delay, attempt: this.attempts }, 'Web API 连接断开，稍后自动重连')
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.intentionalClose) return
      try {
        // 重连时重新探测 + 重新解析 dataref ID（X-Plane 重启后 ID 可能变化）
        await axios.get(`${this.baseUrl}/api/v2/capabilities`, { timeout: 3000 })
        await this.#resolveDatarefIds()
        await this.#openSocket()
      } catch (err) {
        this.#emitError(err?.code || 'WEBAPI_UNREACHABLE', err?.message || '重连失败')
        this.#scheduleReconnect()
      }
    }, delay)
    this.reconnectTimer.unref?.()
  }

  #handleMessage(msg) {
    // 服务端错误消息：记录并继续（订阅本身失败不改变连接状态）
    if (msg?.type === 'error') {
      logger.warn({ msg }, 'X-Plane Web API 返回错误')
      return
    }
    // 数值推送：{ type: 'dataref_values', data: { values: [{id, value}, ...] } }
    // 对消息结构做防御性解析：兼容 values 数组或以 id 为键的对象映射两种形态
    const values = msg?.data?.values
    if (!values) return
    const position = buildPositionFromValues(this.idToField, values, Date.now())
    if (position) this.emit('position', position)
  }

  #emitError(code, message) {
    logger.error({ code, message }, 'WebApiClient 错误')
    this.emit('error', { code, message })
  }
}

/**
 * 把一帧 dataref 数值组装为 AircraftPosition（纯函数，便于单元测试）。
 * 缺失的字段置 null；经纬度缺失或非法时返回 null（没有位置就没有有效帧）。
 * @param {Map<number, {field: string, convert?: Function}>} idToField
 * @param {Array<{id: number|string, value: any}>|Object<string, any>} values
 * @param {number} timestamp
 * @returns {Object|null}
 */
export function buildPositionFromValues(idToField, values, timestamp) {
  const pairs = Array.isArray(values)
    ? values.map((v) => [v?.id, v?.value])
    : Object.entries(values || {}).map(([id, value]) => [Number(id), value])

  const raw = {}
  for (const [id, value] of pairs) {
    const spec = idToField.get(id)
    if (!spec) continue
    // 字符串型 dataref（如注册号）可能以 char 数组形式下发
    let v = value
    if (spec.field === 'tailNumber') {
      v =
        typeof value === 'string'
          ? value
          : Array.isArray(value)
            ? String.fromCharCode(...value.filter((c) => c > 0))
            : null
      raw[spec.field] = v || null
      continue
    }
    const n = Number(value)
    raw[spec.field] = Number.isFinite(n) ? (spec.convert ? spec.convert(n) : n) : null
  }

  if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null

  return {
    lat: raw.lat,
    lon: raw.lon,
    altMsl: raw.altMsl ?? null,
    altAgl: raw.altAgl ?? null,
    heading: raw.heading ?? null,
    groundSpeedKt: raw.groundSpeedKt ?? null,
    iasKt: raw.iasKt ?? null,
    verticalSpeedFpm: raw.verticalSpeedFpm ?? null,
    pitch: raw.pitch ?? null,
    roll: raw.roll ?? null,
    tailNumber: raw.tailNumber ?? null,
    timestamp,
  }
}
