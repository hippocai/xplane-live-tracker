// 统一调度与状态机（设计文档 §4.3 / §4.5 / §15.3.5 —— 核心模块）。
// 职责：
//   1. 按 configStore 的 activeMode 启用 webApiClient 或 udpClient（二者互斥，不同时推流）；
//   2. 统一维护 xplaneConnected / flightActive / lastUpdate（flightActive 判定在此实现）；
//   3. 对外提供唯一事件源（'position' / 'status'），屏蔽底层差异；
//   4. switchMode() 供 POST /api/xplane-mode 调用，执行"先断后连"的热切换。
// 错误原则：底层客户端的任何错误都转换为状态信息，绝不让本模块或进程崩溃（§15.1）。
import { EventEmitter } from 'node:events'
import { WebApiClient } from './webApiClient.js'
import { UdpClient } from './udpClient.js'
import { getConfig, saveConfig } from '../utils/configStore.js'
import { logger } from '../utils/logger.js'

const STALE_CHECK_INTERVAL_MS = 1000 // flightActive 检查周期（§4.5.1）
const CONNECT_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000]

export class XPlaneManager extends EventEmitter {
  constructor() {
    super()
    this.activeMode = null
    this.client = null
    this.flightActive = false
    this.lastPositionTimestamp = 0
    this.stopped = false
    // 各模式独立的连接状态（互斥运行但状态各自保留，切回时不丢失，§4.4）
    this.modeState = {
      webapi: { connected: false, lastUpdate: null },
      udp: { connected: false, lastUpdate: null },
    }
    this.staleTimer = null
    this.retryTimer = null
    // 切换请求串行化：用 promise 链保证"先断后连"严格按提交顺序执行，
    // 用户快速连点两次时两次都会生效、最终状态与最后一次点击一致（T8）
    this.switchChain = Promise.resolve()
    // 连接重试代际号：切换/停止后使旧的重试循环失效
    this.connectEpoch = 0
  }

  /** 应用启动时调用。绝不因 X-Plane 不可达而失败：后台持续重试（T1/T2）。 */
  async start() {
    const cfg = getConfig()
    this.activeMode = cfg.activeMode
    this.#startStaleChecker()
    await this.#activateClient(this.activeMode, cfg, { retryInBackground: true })
  }

  /** 优雅关闭：停止判定定时器、断开客户端、终止重试 */
  async stop() {
    this.stopped = true
    this.connectEpoch++
    if (this.staleTimer) {
      clearInterval(this.staleTimer)
      this.staleTimer = null
    }
    if (this.client) {
      await this.client.disconnect().catch(() => {})
      this.client = null
    }
  }

  /**
   * 运行时热切换通讯模式（§4.3.1 切换步骤严格串行：先断后连）。
   * @param {'webapi'|'udp'} newMode
   * @param {{webapi?: {host?, port?}, udp?: {listenPort?}}} [params] 部分更新即可
   * @returns {Promise<Object>} 成功后返回最新状态；失败抛出 {code, message} 并回退原模式
   */
  switchMode(newMode, params = {}) {
    // 串行化：即使前一次切换尚未完成，也排队执行（幂等检查在执行时判断）
    const result = this.switchChain.then(() => this.#doSwitch(newMode, params))
    this.switchChain = result.catch(() => {}) // 链上吞掉错误，避免污染后续排队请求
    return result
  }

  /** 同步获取当前完整状态（§10 XPlaneModeConfig 结构） */
  getStatus() {
    const cfg = getConfig()
    const active = this.modeState[this.activeMode] || { connected: false, lastUpdate: null }
    return {
      activeMode: this.activeMode,
      connected: active.connected,
      flightActive: this.flightActive,
      flightStaleTimeoutMs: cfg.flightStaleTimeoutMs,
      webapi: {
        host: cfg.webapi.host,
        port: cfg.webapi.port,
        connected: this.modeState.webapi.connected,
        lastUpdate: this.modeState.webapi.lastUpdate,
      },
      udp: {
        listenPort: cfg.udp.listenPort,
        connected: this.modeState.udp.connected,
        lastUpdate: this.modeState.udp.lastUpdate,
      },
    }
  }

  async #doSwitch(newMode, params) {
    const cfg = getConfig()
    if (!['webapi', 'udp'].includes(newMode)) {
      throw { code: 'INVALID_PARAMS', message: `未知通讯模式：${newMode}` } // eslint-disable-line no-throw-literal
    }
    // 合并出新参数（只允许传对应模式的合法字段），并做范围校验
    const nextCfg = mergeModeParams(cfg, newMode, params)
    validateModeParams(nextCfg)

    const curCfg = getConfig()
    // 幂等：模式相同且参数未变，直接返回（§15.3.5 边界情况）
    if (newMode === this.activeMode && this.client && isParamsEqual(newMode, curCfg, nextCfg)) {
      return this.getStatus()
    }

    // ③ 停用当前客户端
    if (this.client) {
      await this.client.disconnect().catch(() => {})
      this.modeState[this.activeMode].connected = false
      this.client = null
    }
    // ④ 重置状态并广播"切换中"（前端据此刻意显示"连接中…"，不清空最后位置）
    this.flightActive = false
    this.lastPositionTimestamp = 0
    this.#broadcastStatus()

    // ⑤⑥ 用新参数实例化并连接；失败则回退原模式并重连（保持在原模式，§4.3.2）
    try {
      this.activeMode = newMode
      await this.#activateClient(newMode, nextCfg, { retryInBackground: false })
    } catch (err) {
      logger.warn({ err }, '模式切换失败，回退到原模式')
      this.activeMode = curCfg.activeMode
      // 原模式在后台重连（它之前能工作，通常很快恢复）
      this.#activateClient(this.activeMode, curCfg, { retryInBackground: true }).catch(() => {})
      throw err
    }
    // ⑦ 持久化新配置（成功后才写盘，§4.3.1）
    await saveConfig({
      activeMode: newMode,
      ...(newMode === 'webapi' ? { webapi: nextCfg.webapi } : {}),
      ...(newMode === 'udp' ? { udp: nextCfg.udp } : {}),
    })
    this.#broadcastStatus()
    return this.getStatus()
  }

  /**
   * 实例化并连接指定模式的客户端。
   * @param {boolean} opts.retryInBackground true：连接失败不抛错、后台按退避序列持续重试（启动场景）；
   *                                         false：首次连接失败直接抛错（切换场景，由调用方回退）。
   */
  async #activateClient(mode, cfg, { retryInBackground }) {
    const epoch = ++this.connectEpoch
    const client =
      mode === 'webapi'
        ? new WebApiClient({ host: cfg.webapi.host, port: cfg.webapi.port })
        : new UdpClient({ listenPort: cfg.udp.listenPort })
    this.client = client
    this.#wireEvents(client, mode)
    // 每次激活都作废之前激活留下的重试定时器（显式清理，不单纯依赖 epoch 检查）
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    const attempt = async (n) => {
      if (this.stopped || this.connectEpoch !== epoch) return
      try {
        await client.connect()
      } catch (err) {
        if (this.stopped || this.connectEpoch !== epoch) return
        if (!retryInBackground) throw err
        const delay = CONNECT_RETRY_DELAYS_MS[Math.min(n, CONNECT_RETRY_DELAYS_MS.length - 1)]
        logger.warn({ mode, delay, epoch, err: err?.message }, 'X-Plane 连接失败，将自动重试')
        this.retryTimer = setTimeout(() => attempt(n + 1), delay)
        this.retryTimer.unref?.()
        return
      }
      logger.info({ mode, epoch }, 'X-Plane 客户端已启动')
    }
    await attempt(0)
  }

  #wireEvents(client, mode) {
    client.on('connected', () => {
      if (this.client !== client) return
      this.modeState[mode].connected = true
      logger.info({ mode }, '已连接 X-Plane')
      this.#broadcastStatus()
    })
    client.on('disconnected', () => {
      if (this.client !== client) return
      this.modeState[mode].connected = false
      this.#broadcastStatus()
    })
    client.on('position', (pos) => {
      if (this.client !== client) return // 已被切换淘汰的旧客户端的残留帧，丢弃
      this.modeState[mode].lastUpdate = pos.timestamp
      this.lastPositionTimestamp = Date.now()
      if (!this.flightActive) {
        this.flightActive = true
        logger.info({ mode }, '收到有效飞行数据，flightActive = true')
        this.#broadcastStatus()
      }
      this.emit('position', pos)
    })
    client.on('error', ({ code, message }) => {
      // 底层错误转换为状态/日志，绝不上抛导致崩溃（§15.3.5 边界情况）
      logger.error({ mode, code, message }, 'X-Plane 客户端错误')
    })
  }

  /** flightActive 判定（§4.5.1 V1）：每秒检查最近位置数据是否超时 */
  #startStaleChecker() {
    this.staleTimer = setInterval(() => {
      if (!this.flightActive) return
      const staleFor = Date.now() - this.lastPositionTimestamp
      if (staleFor > getConfig().flightStaleTimeoutMs) {
        this.flightActive = false
        logger.warn({ staleFor }, '位置数据超时，判定为无飞行（flightActive = false）')
        this.#broadcastStatus()
      }
    }, STALE_CHECK_INTERVAL_MS)
    this.staleTimer.unref?.()
  }

  #broadcastStatus() {
    this.emit('status', this.getStatus())
  }
}

// —— 参数合并与校验 ——

/** 把用户提交的部分参数合并进当前配置（只接受对应模式的合法字段，忽略其余） */
function mergeModeParams(cfg, mode, params) {
  const next = { ...cfg, webapi: { ...cfg.webapi }, udp: { ...cfg.udp } }
  if (mode === 'webapi' && params?.webapi) {
    if (params.webapi.host !== undefined) next.webapi.host = String(params.webapi.host).trim()
    if (params.webapi.port !== undefined) next.webapi.port = Number(params.webapi.port)
  }
  if (mode === 'udp' && params?.udp) {
    if (params.udp.listenPort !== undefined) next.udp.listenPort = Number(params.udp.listenPort)
  }
  return next
}

/** 校验参数合法性：非法直接抛错（§15.3.5 switchMode 步骤 ①） */
function validateModeParams(cfg) {
  if (!cfg.webapi.host) {
    throw { code: 'INVALID_PARAMS', message: 'Web API host 不能为空' } // eslint-disable-line no-throw-literal
  }
  if (!isPort(cfg.webapi.port)) {
    throw { code: 'INVALID_PARAMS', message: `Web API 端口非法：${cfg.webapi.port}` } // eslint-disable-line no-throw-literal
  }
  if (!isPort(cfg.udp.listenPort)) {
    throw { code: 'INVALID_PARAMS', message: `UDP 监听端口非法：${cfg.udp.listenPort}` } // eslint-disable-line no-throw-literal
  }
}

function isPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

function isParamsEqual(mode, a, b) {
  if (mode === 'webapi') return a.webapi.host === b.webapi.host && a.webapi.port === b.webapi.port
  return a.udp.listenPort === b.udp.listenPort
}
