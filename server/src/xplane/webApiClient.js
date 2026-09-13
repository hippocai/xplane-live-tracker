// 方案 A：X-Plane 12 内置 Web API 客户端（设计文档 §4.1 / §15.3.3）。
// 协议按官方文档 + 真实安装实测（2026-09，X-Plane 12.1.x，developer.x-plane.com/article/x-plane-web-api）：
//   - 探测：GET /api/capabilities（注意无版本前缀）。任何 HTTP 响应都说明 Web 服务在线
//     （老版本无此端点返回 404 属正常）；403 = Network 设置里禁了传入流量；仅连接失败视为不可达。
//   - dataref 查询：GET /api/v2/datarefs?filter[name]=...（信封 {data:[{id,name,value_type}]}，
//     id 为大数字，单会话内稳定、跨会话会变）。
//   - WebSocket：ws://host:port/api/v1（REST 是 /api/v2，WS 用 v1 路径——实测 v1 可用）。
//   - 订阅：{"req_id":<数字>, type:"dataref_subscribe_values", params:{datarefs:[{id},...]}}。
//     无频率参数，服务器固定 10Hz 推送（后端 wsHub 仍按 updateHz 节流广播给前端）。
//   - 推送：{"type":"dataref_update_values", data:{ "<id>": value, ... }}——只含**变化的**字段
//     （首帧全量），因此客户端必须跨帧缓存合并出完整值表再组装 position。
//   - 字符串型 dataref（如 acf_tailnum）value_type 为 'data'，值以 base64 下发。
// 断线按 1s→2s→5s→10s（封顶）指数退避自动重连（§4.4）。
import { EventEmitter } from 'node:events'
import axios from 'axios'
import WebSocket from 'ws'
import { logger } from '../utils/logger.js'

const MS_TO_KT = 1.94384 // 地速 m/s → 节

const REST_PREFIX = '/api/v2'
const WS_PATH = '/api/v1'

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
    // dataref 数值 ID → 字段规格 的映射（每次 connect 重新解析，ID 跨会话不稳定）
    this.idToField = new Map()
    // 跨帧值缓存：官方推送只含变化字段，需合并成完整值表再组装 position
    this.lastValues = new Map()
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
    this.lastValues.clear()
    // 1. 可达性探测。任何 HTTP 响应（含 404）都说明 Web 服务在线——
    //    capabilities 端点在 12.1.4 之前不存在，404 不能当作"连不上"。
    try {
      const res = await axios.get(`${this.baseUrl}/api/capabilities`, {
        timeout: 3000,
        validateStatus: () => true,
      })
      if (res.status === 403) {
        const message =
          'X-Plane Web API 返回 403：请在 Settings → Network 中允许传入连接（不要选 Disable Incoming Traffic）'
        this.#emitError('FORBIDDEN', message)
        throw { code: 'FORBIDDEN', message } // eslint-disable-line no-throw-literal
      }
    } catch (err) {
      if (err?.code === 'FORBIDDEN') throw err
      const message = `无法连接 X-Plane Web API（${this.host}:${this.port}）：${err.message}`
      this.#emitError('WEBAPI_UNREACHABLE', message)
      throw { code: 'WEBAPI_UNREACHABLE', message } // eslint-disable-line no-throw-literal
    }
    // 2. 解析 dataref ID（只查一次并缓存，ID 在同一 X-Plane 会话内稳定）
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
        const res = await axios.get(`${this.baseUrl}${REST_PREFIX}/datarefs`, {
          params: { 'filter[name]': spec.name },
          timeout: 3000,
        })
        const list = Array.isArray(res.data?.data) ? res.data.data : []
        // 取 name 完全匹配的第一条
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
      const ws = new WebSocket(`ws://${this.host}:${this.port}${WS_PATH}`)
      this.ws = ws
      let settled = false

      ws.on('open', () => {
        // 官方订阅格式：req_id 必须是数字，datarefs 为 [{id}] 数组，无频率参数（服务器固定 10Hz）
        ws.send(
          JSON.stringify({
            req_id: 1,
            type: 'dataref_subscribe_values',
            params: { datarefs: [...this.idToField.keys()].map((id) => ({ id })) },
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
        // 重连时重新探测 + 重新解析 dataref ID（X-Plane 重启后 ID 会变化）
        await this.connect()
      } catch (err) {
        this.#emitError(err?.code || 'WEBAPI_UNREACHABLE', err?.message || '重连失败')
        this.#scheduleReconnect()
      }
    }, delay)
    this.reconnectTimer.unref?.()
  }

  #handleMessage(msg) {
    // 订阅/操作结果：失败记 warn（如 dataref id 失效），不中断连接
    if (msg?.type === 'result') {
      if (msg.success === false) {
        logger.warn(
          { error_code: msg.error_code, error_message: msg.error_message },
          'Web API 请求失败',
        )
      }
      return
    }
    // 数值推送：{ type: 'dataref_update_values', data: { '<id>': value } }
    if (msg?.type !== 'dataref_update_values' || !msg.data || typeof msg.data !== 'object') return
    // 增量合并：官方只推变化的字段（首帧全量），跨帧缓存合并出完整值表
    for (const [k, v] of Object.entries(msg.data)) {
      this.lastValues.set(Number(k), v)
    }
    const position = buildPositionFromValues(this.idToField, this.lastValues, Date.now())
    if (position) this.emit('position', position)
  }

  #emitError(code, message) {
    logger.error({ code, message }, 'WebApiClient 错误')
    this.emit('error', { code, message })
  }
}

/**
 * 把"当前已知的全部 dataref 值"组装为 AircraftPosition（纯函数，便于单元测试）。
 * 缺失的字段置 null；经纬度缺失或非法时返回 null（没有位置就没有有效帧）。
 * @param {Map<number, {field: string, convert?: Function}>} idToField
 * @param {Map<number, any>|Object<string, any>|Array<{id, value}>} values 完整值表（支持 Map / 对象 / 数组形态）
 * @param {number} timestamp
 * @returns {Object|null}
 */
export function buildPositionFromValues(idToField, values, timestamp) {
  let pairs
  if (Array.isArray(values)) {
    pairs = values.map((v) => [v?.id, v?.value])
  } else if (values instanceof Map) {
    pairs = [...values.entries()]
  } else {
    pairs = Object.entries(values || {}).map(([id, value]) => [Number(id), value])
  }

  const raw = {}
  for (const [id, value] of pairs) {
    const spec = idToField.get(id)
    if (!spec) continue
    // 字符串型 dataref（value_type 'data'）以 base64 下发；兼容 char 数组形态
    if (spec.field === 'tailNumber') {
      let v = null
      if (typeof value === 'string') {
        try {
          v = Buffer.from(value, 'base64').toString('ascii')
        } catch {
          v = value
        }
      } else if (Array.isArray(value)) {
        v = String.fromCharCode(...value.filter((c) => Number.isFinite(c) && c > 0))
      }
      raw[spec.field] = (v || '').replace(/\0/g, '').trim() || null
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
