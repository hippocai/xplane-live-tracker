// 通讯模式设置面板（设计文档 §6.4 / §15.4.5）：
// 打开时 GET /api/xplane-mode 回填表单；保存时 POST 提交热切换；
// loading / 错误提示 / 单选联动参数输入框的启停都在本模块内处理。
import { api } from './api.js'
import { setConnecting, toast } from './ui.js'

let busy = false

// 连接参数默认值（与 index.html 输入框的 value 属性、.env.example 保持一致）。
// 目的：用户通常无需任何输入即可"保存并切换"；留空的输入框保存时回落到默认值。
const DEFAULTS = { webapiHost: '127.0.0.1', webapiPort: 8086, udpPort: 49005 }

/** 读端口输入框：留空回落默认值；填了但非法（非 1-65535 整数）返回 null */
function readPort(inputId, fallback) {
  const raw = document.getElementById(inputId).value.trim()
  if (raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  return n
}

/**
 * @param {{onStatusUpdate: Function, getMapSettings?: Function,
 *          onMapSettings?: Function}} opts
 * onStatusUpdate: 状态更新回调（供连接指示灯刷新）
 * getMapSettings/onMapSettings: 地图选项（百度自动切换/跟随飞机）——
 *   打开面板时读取当前值回填复选框，勾选变更立即回调生效（无需"保存"）
 */
export function initSettingsPanel({ onStatusUpdate, getMapSettings, onMapSettings }) {
  const panel = document.getElementById('settings-panel')
  const btnOpen = document.getElementById('settings-btn')
  const btnClose = document.getElementById('settings-close')
  const btnCancel = document.getElementById('settings-cancel')
  const btnSave = document.getElementById('settings-save')
  const errBox = document.getElementById('settings-error')
  const chkBaiduAuto = document.getElementById('opt-baidu-auto')
  const chkFollow = document.getElementById('opt-follow')
  const radios = () => panel.querySelectorAll('input[name="mode"]')

  btnOpen.addEventListener('click', async () => {
    panel.hidden = false
    errBox.textContent = ''
    fillMapSettings()
    await fillForm()
  })
  btnClose.addEventListener('click', () => (panel.hidden = true))
  btnCancel.addEventListener('click', () => (panel.hidden = true))

  // 单选联动：仅选中模式的参数可编辑，另一组置灰（§6.4 交互流程 2）
  for (const radio of radios()) {
    radio.addEventListener('change', () => syncParamGroups())
  }

  // 地图选项：勾选变更立即生效（这些是本机显示偏好，不涉及后端连接）
  chkBaiduAuto?.addEventListener('change', () =>
    onMapSettings?.({ baiduAuto: chkBaiduAuto.checked }),
  )
  chkFollow?.addEventListener('change', () => onMapSettings?.({ follow: chkFollow.checked }))

  btnSave.addEventListener('click', async () => {
    if (busy) return
    const mode = panel.querySelector('input[name="mode"]:checked')?.value
    if (!mode) return
    // 先做客户端校验（留空回落默认；非法端口直接提示，不发请求），减轻后端来回
    const host =
      mode === 'webapi'
        ? document.getElementById('webapi-host').value.trim() || DEFAULTS.webapiHost
        : undefined
    const port =
      mode === 'webapi'
        ? readPort('webapi-port', DEFAULTS.webapiPort)
        : readPort('udp-port', DEFAULTS.udpPort)
    if (port == null) {
      errBox.textContent = '端口需为 1-65535 的整数（留空使用默认值）'
      return
    }
    busy = true
    btnSave.disabled = true
    btnSave.textContent = '正在切换…'
    errBox.textContent = ''
    setConnecting(true)
    try {
      const body =
        mode === 'webapi'
          ? { activeMode: mode, webapi: { host, port } }
          : { activeMode: mode, udp: { listenPort: port } }
      const status = await api('/api/xplane-mode', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      onStatusUpdate?.(status)
      toast('切换成功')
      panel.hidden = true
    } catch (err) {
      // 失败：展示具体错误且不关闭面板，方便用户重试（§6.4 交互流程 3）
      errBox.textContent = err.message || '切换失败'
    } finally {
      busy = false
      btnSave.disabled = false
      btnSave.textContent = '保存并切换'
      setConnecting(false)
    }
  })

  function syncParamGroups() {
    const mode = panel.querySelector('input[name="mode"]:checked')?.value
    document.getElementById('webapi-params').classList.toggle('disabled', mode !== 'webapi')
    document.getElementById('udp-params').classList.toggle('disabled', mode !== 'udp')
  }

  /** 地图选项回填：以地图控制器当前实际状态为准（拖动地图等也会改变"跟随"） */
  function fillMapSettings() {
    if (!getMapSettings || !chkBaiduAuto || !chkFollow) return
    const ms = getMapSettings()
    chkBaiduAuto.checked = ms.baiduAuto !== false
    chkFollow.checked = Boolean(ms.follow)
  }

  async function fillForm() {
    try {
      const status = await api('/api/xplane-mode')
      onStatusUpdate?.(status)
      for (const radio of radios()) radio.checked = radio.value === status.activeMode
      document.getElementById('webapi-host').value = status.webapi?.host ?? DEFAULTS.webapiHost
      document.getElementById('webapi-port').value = status.webapi?.port ?? DEFAULTS.webapiPort
      document.getElementById('udp-port').value = status.udp?.listenPort ?? DEFAULTS.udpPort
      syncParamGroups()
    } catch (err) {
      errBox.textContent = `读取当前配置失败：${err.message}`
    }
  }
}

/** 由 app.js 在收到 xplane_status 广播时调用，刷新面板中的连接指示灯 */
export function updateConnIndicator(status) {
  const ind = document.getElementById('conn-indicator')
  const last = document.getElementById('conn-last')
  if (!ind) return
  // 三态：已连接 / 从未收到过数据（未连接）/ 收到过数据但当前断开（连接中）
  if (status.connected) {
    ind.textContent = '🟢 已连接'
  } else if (status.webapi?.lastUpdate || status.udp?.lastUpdate) {
    ind.textContent = '🟡 连接中 / 未连接'
  } else {
    ind.textContent = '🔴 未连接'
  }
  if (last) {
    last.textContent =
      status.webapi?.lastUpdate || status.udp?.lastUpdate
        ? new Date(status.webapi.lastUpdate || status.udp.lastUpdate).toLocaleTimeString('zh-CN')
        : '--'
  }
}
