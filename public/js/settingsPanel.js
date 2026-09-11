// 通讯模式设置面板（设计文档 §6.4 / §15.4.5）：
// 打开时 GET /api/xplane-mode 回填表单；保存时 POST 提交热切换；
// loading / 错误提示 / 单选联动参数输入框的启停都在本模块内处理。
import { api } from './api.js'
import { setConnecting } from './ui.js'

let busy = false

/**
 * @param {{onStatusUpdate: Function}} opts 状态更新回调（供连接指示灯刷新）
 */
export function initSettingsPanel({ onStatusUpdate }) {
  const panel = document.getElementById('settings-panel')
  const btnOpen = document.getElementById('settings-btn')
  const btnClose = document.getElementById('settings-close')
  const btnCancel = document.getElementById('settings-cancel')
  const btnSave = document.getElementById('settings-save')
  const errBox = document.getElementById('settings-error')
  const radios = () => panel.querySelectorAll('input[name="mode"]')

  btnOpen.addEventListener('click', async () => {
    panel.hidden = false
    errBox.textContent = ''
    await fillForm()
  })
  btnClose.addEventListener('click', () => (panel.hidden = true))
  btnCancel.addEventListener('click', () => (panel.hidden = true))

  // 单选联动：仅选中模式的参数可编辑，另一组置灰（§6.4 交互流程 2）
  for (const radio of radios()) {
    radio.addEventListener('change', () => syncParamGroups())
  }

  btnSave.addEventListener('click', async () => {
    if (busy) return
    const mode = panel.querySelector('input[name="mode"]:checked')?.value
    if (!mode) return
    busy = true
    btnSave.disabled = true
    btnSave.textContent = '正在切换…'
    errBox.textContent = ''
    setConnecting(true)
    try {
      const body = { activeMode: mode }
      if (mode === 'webapi') {
        body.webapi = {
          host: document.getElementById('webapi-host').value.trim(),
          port: Number(document.getElementById('webapi-port').value),
        }
      } else {
        body.udp = { listenPort: Number(document.getElementById('udp-port').value) }
      }
      const status = await api('/api/xplane-mode', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      onStatusUpdate?.(status)
      showToast('切换成功')
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

  async function fillForm() {
    try {
      const status = await api('/api/xplane-mode')
      onStatusUpdate?.(status)
      for (const radio of radios()) radio.checked = radio.value === status.activeMode
      document.getElementById('webapi-host').value = status.webapi?.host ?? '127.0.0.1'
      document.getElementById('webapi-port').value = status.webapi?.port ?? 8086
      document.getElementById('udp-port').value = status.udp?.listenPort ?? 49005
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
  if (status.connected) {
    ind.textContent = '🟢 已连接'
  } else if (status.activeMode) {
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

function showToast(text) {
  const toast = document.getElementById('toast')
  if (!toast) return
  toast.textContent = text
  toast.hidden = false
  clearTimeout(showToast._t)
  showToast._t = setTimeout(() => (toast.hidden = true), 2200)
}
