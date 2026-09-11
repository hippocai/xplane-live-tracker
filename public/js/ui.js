// UI 渲染（设计文档 §15.4.4 / §6.6.2）：
// 信息面板数值渲染、顶部状态条文案。文案常量集中在此，便于后续多语言扩展。

// —— 文案常量（§6.6.2 两种子状态）——
export const MSG = {
  DISCONNECTED:
    '⚠️ 未连接到 X-Plane — 请确认 X-Plane 12 已启动，且通讯模式配置正确（点击右上角"设置"检查）',
  NO_FLIGHT: '✈️ 当前没有飞机在飞行 — 请在 X-Plane 中加载飞机并开始飞行，地图将自动恢复显示',
  CONNECTING: '⏳ 正在连接 X-Plane…',
  WS_LOST: '📡 与服务的连接已断开，正在重连…',
}

let connecting = false

/** 设置面板切换过程中显示"连接中…"（§6.4 交互流程 4） */
export function setConnecting(on) {
  connecting = Boolean(on)
}

/**
 * 刷新顶部状态条。connected=false 显示"未连接"，connected 且非 flightActive
 * 显示"当前没有飞机在飞行"。
 * @param {{connected: boolean, flightActive: boolean, activeMode?: string}} status
 */
export function updateStatusBanner(status) {
  const banner = document.getElementById('status-banner')
  if (!banner) return
  let text = null
  let dim = false
  if (connecting) {
    text = MSG.CONNECTING
    dim = true
  } else if (!status.connected) {
    text = MSG.DISCONNECTED
  } else if (!status.flightActive) {
    text = MSG.NO_FLIGHT
  }
  banner.textContent = text || ''
  banner.classList.toggle('visible', Boolean(text))
  banner.classList.toggle('dim', dim)
}

/** WS 断开时的独立提示（与 X-Plane 状态无关） */
export function showWsLost(show) {
  const banner = document.getElementById('status-banner')
  if (!banner) return
  if (show) {
    banner.textContent = MSG.WS_LOST
    banner.classList.add('visible', 'dim')
  } else {
    banner.classList.remove('dim')
  }
}

/**
 * 信息面板渲染。pos 为 null 时全部显示 "--"（数值区域整体置灰由 CSS .inactive 控制）。
 * @param {Object|null} pos AircraftPosition
 */
export function updateInfoPanel(pos) {
  const set = (id, v) => {
    const el = document.getElementById(id)
    if (el) el.textContent = v
  }
  const panel = document.getElementById('info-panel')
  if (!pos) {
    panel?.classList.add('inactive')
    for (const id of [
      'i-tail',
      'i-alt',
      'i-agl',
      'i-gs',
      'i-ias',
      'i-hdg',
      'i-vs',
      'i-pos',
      'i-delay',
    ]) {
      set(id, '--')
    }
    return
  }
  panel?.classList.remove('inactive')
  set('i-tail', pos.tailNumber || '未知机号')
  set(
    'i-alt',
    fmtNum(pos.altMsl, 0, ' m') +
      ' / ' +
      fmtNum(pos.altMsl != null ? pos.altMsl * 3.28084 : null, 0, ' ft'),
  )
  set('i-agl', fmtNum(pos.altAgl, 0, ' m'))
  set('i-gs', fmtNum(pos.groundSpeedKt, 0, ' kt'))
  set('i-ias', pos.iasKt != null ? fmtNum(pos.iasKt, 0, ' kt') : '--')
  set('i-hdg', pos.heading != null ? String(Math.round(pos.heading)).padStart(3, '0') + '°' : '--')
  set('i-vs', pos.verticalSpeedFpm != null ? fmtNum(pos.verticalSpeedFpm, 0, ' fpm') : '--')
  set('i-pos', `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`)
  const delay = Date.now() - pos.timestamp
  set('i-delay', delay >= 0 ? delay + ' ms' : '--')
}

function fmtNum(v, digits = 1, unit = '') {
  if (v == null || !Number.isFinite(v)) return '--'
  return (
    v.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 }) + unit
  )
}
