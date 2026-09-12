// 前端入口（设计文档 §15.4.6）：
// 拉取 /api/config → 初始化地图 →（可选）口令校验 → 建立 WS 连接并绑定事件 →
// 补画历史航迹 → 初始化设置面板。
import { api, getToken, saveToken } from './api.js'
import * as map from './mapController.js'
import * as ui from './ui.js'
import { initSettingsPanel, updateConnIndicator } from './settingsPanel.js'
import { initNavLayers } from './navLayers.js'
import { connect as connectWs } from './wsClient.js'

let ws = null
let mapApi = null // mapController.initMap() 返回的控制器实例（updatePosition 等是它的方法，不在模块命名空间上）
let lastConfig = null

boot()

async function boot() {
  // 页面首次加载、WS 尚未建立时默认视为未连接（§6.6.3），避免"假正常状态"闪烁
  ui.updateStatusBanner({ connected: false, flightActive: false })

  try {
    lastConfig = await api('/api/config')
  } catch (err) {
    console.error('读取 /api/config 失败：', err)
    return
  }

  if (lastConfig.authRequired && !getToken()) {
    await promptForToken() // 口令校验通过后再继续
  }

  mapApi = map.initMap(document.getElementById('map'), lastConfig.mapProvider, {
    trackEnabled: lastConfig.trackEnabled !== false,
    baiduAuto: readBaiduAutoPref(), // 默认开；关闭过则记住（localStorage）
  })

  initSettingsPanel({
    onStatusUpdate: onStatus,
    getMapSettings: () => ({
      baiduAuto: mapApi?.getBaiduAutoSwitch() ?? true,
      follow: mapApi?.isFollowing() ?? true,
    }),
    onMapSettings: ({ baiduAuto, follow }) => {
      if (baiduAuto !== undefined) {
        mapApi?.setBaiduAutoSwitch(baiduAuto)
        try {
          localStorage.setItem('xplt_baidu_auto', baiduAuto ? '1' : '0')
        } catch {
          /* localStorage 不可用时忽略 */
        }
      }
      if (follow !== undefined) mapApi?.setFollowMode(follow)
    },
  })
  bindButtons()
  initNavUi()
  renderLanBox(lastConfig.lanUrls || [])

  openSocket()
  backfillTrack()
}

function openSocket() {
  ws = connectWs({
    onPosition: (pos) => {
      mapApi?.updatePosition(pos)
      ui.updateInfoPanel(pos)
    },
    onStatus: onStatus,
    onOpen: () => {
      ui.showWsLost(false)
    },
    onClose: () => ui.showWsLost(true),
    onAuthRequired: () => {
      // 口令被拒：清掉本地 token，重新弹出输入框，通过后重连
      saveToken('')
      promptForToken().then(() => ws.reopen())
    },
    getToken,
  })
}

function onStatus(status) {
  mapApi?.setFlightActive(Boolean(status.flightActive))
  ui.updateStatusBanner(status)
  updateConnIndicator(status)
}

/** 读取"进入大陆自动切百度"偏好：默认开，仅显式关闭过才返回 false */
function readBaiduAutoPref() {
  try {
    return localStorage.getItem('xplt_baidu_auto') !== '0'
  } catch {
    return true
  }
}

function bindButtons() {
  document.getElementById('recenter-btn')?.addEventListener('click', () => mapApi?.recenter())
}

// —— 导航图层 UI（🧭 按钮 + 弹层开关 + 设置里的数据源配置）——

const LAYER_PREF_KEY = 'xplt_layers'
const DEFAULT_LAYERS = { airport: true, navaid: true, fix: false }

function readLayerPrefs() {
  try {
    return { ...DEFAULT_LAYERS, ...JSON.parse(localStorage.getItem(LAYER_PREF_KEY)) }
  } catch {
    return { ...DEFAULT_LAYERS }
  }
}

function initNavUi() {
  const navLayers = initNavLayers({
    getMap: () => mapApi?.getMap(),
    onMapRebuilt: (cb) => mapApi?.onMapRebuilt(cb),
  })

  // 🧭 按钮开关弹层
  const panel = document.getElementById('layers-panel')
  document.getElementById('layers-btn')?.addEventListener('click', () => {
    panel.hidden = !panel.hidden
  })

  // 三个图层开关：立即生效并持久化
  const boxes = { airport: 'layer-airport', navaid: 'layer-navaid', fix: 'layer-fix' }
  const prefs = readLayerPrefs()
  for (const [type, id] of Object.entries(boxes)) {
    const box = document.getElementById(id)
    if (!box) continue
    box.checked = Boolean(prefs[type])
    box.addEventListener('change', () => {
      navLayers.setLayerEnabled(type, box.checked)
      const next = readLayerPrefs()
      next[type] = box.checked
      try {
        localStorage.setItem(LAYER_PREF_KEY, JSON.stringify(next))
      } catch {
        /* localStorage 不可用时忽略 */
      }
    })
    navLayers.setLayerEnabled(type, Boolean(prefs[type]))
  }

  initNavConfigSection()
}

async function initNavConfigSection() {
  const input = document.getElementById('nav-xplane-path')
  const status = document.getElementById('nav-data-status')
  const apply = document.getElementById('nav-apply')
  const render = (s) => {
    if (!status) return
    if (s.loading) status.textContent = '正在加载…'
    else if (s.error) status.textContent = `[!] ${s.error}`
    else if (s.loaded) {
      status.textContent = `已加载：机场 ${s.counts.airport} / 导航台 ${s.counts.navaid} / 航路点 ${s.counts.fix}`
    } else status.textContent = '未加载'
    // 弹层里的提示同步显示错误，方便发现"图层没数据"的原因
    const popStatus = document.getElementById('nav-layer-status')
    if (popStatus && s.error) popStatus.textContent = `[!] ${s.error}`
  }
  try {
    render(await api('/api/nav-config'))
  } catch {
    /* 初始读取失败不打断页面 */
  }
  apply?.addEventListener('click', async () => {
    apply.disabled = true
    try {
      render(
        await api('/api/nav-config', {
          method: 'POST',
          body: JSON.stringify({ xplanePath: input?.value.trim() || '' }),
        }),
      )
      ui.toast('导航数据已更新')
    } catch (err) {
      if (status) status.textContent = `[!] ${err.message}`
    } finally {
      apply.disabled = false
    }
  })
}

/** 历史航迹补画（§5.4：刷新页面后补画最近 N 分钟航迹） */
async function backfillTrack() {
  try {
    const minutes = lastConfig?.trackMaxMinutes ?? 30
    const data = await api(`/api/track?minutes=${minutes}`)
    mapApi?.loadTrack(data.points || [])
  } catch {
    /* 航迹补画失败不影响主流程 */
  }
}

/** 首页展示局域网地址 + 二维码（F10） */
function renderLanBox(lanUrls) {
  const list = document.getElementById('lan-list')
  if (!list) return
  if (!lanUrls.length) {
    list.innerHTML = '<div class="hint">未检测到局域网地址，请直接使用本机地址访问</div>'
    return
  }
  list.innerHTML = lanUrls
    .map(
      (u) => `
      <div class="lan-item">
        <img src="${u.qrDataUrl}" alt="QR" />
        <div class="url">${u.url}</div>
        <div class="iface">${u.iface}</div>
      </div>`,
    )
    .join('')
  // 二维码卡片较长，非首次访问默认收起（记忆上次折叠状态）
  try {
    if (localStorage.getItem('xplt_lan_collapsed') === '1') {
      document.getElementById('lan-box').open = false
    }
  } catch {
    /* localStorage 不可用时忽略 */
  }
  document.getElementById('lan-box')?.addEventListener('toggle', (e) => {
    try {
      localStorage.setItem('xplt_lan_collapsed', e.target.open ? '0' : '1')
    } catch {
      /* 忽略 */
    }
  })
}

/** 访问口令输入层（§9）：用受保护接口做一次校验试探，通过后才放行 */
function promptForToken() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('auth-overlay')
    const input = document.getElementById('auth-token')
    const errBox = document.getElementById('auth-error')
    const btn = document.getElementById('auth-submit')
    overlay.hidden = false
    input.focus()
    const submit = async () => {
      const token = input.value.trim()
      if (!token) return
      btn.disabled = true
      errBox.textContent = ''
      try {
        // /api/config 不做鉴权，须用受保护的 /api/status 试探
        await api('/api/status', { headers: { 'x-access-token': token } })
        saveToken(token)
        overlay.hidden = true
        btn.removeEventListener('click', submit)
        resolve()
      } catch {
        errBox.textContent = '口令不正确，请重试'
        input.select()
      } finally {
        btn.disabled = false
      }
    }
    btn.addEventListener('click', submit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit()
    })
  })
}
