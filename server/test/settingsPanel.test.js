// public/js/settingsPanel.js 测试：打开回填、单选联动、默认值回落、
// 端口校验（非法不发请求）、保存成功/失败流程、连接指示灯三态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeElement, fakeDocument } from './frontendHelpers.js'
import { initSettingsPanel, updateConnIndicator } from '../../public/js/settingsPanel.js'

const tick = () => new Promise((r) => setImmediate(r))

// —— DOM 与 fetch 替身 ——
const els = {}
const radios = [
  Object.assign(fakeElement('radio-webapi'), { value: 'webapi' }),
  Object.assign(fakeElement('radio-udp'), { value: 'udp' }),
]
const panel = fakeElement('settings-panel')
panel.querySelectorAll = (sel) => (sel.includes('input[name="mode"]') ? radios : [])
panel.querySelector = (sel) =>
  sel.includes(':checked') ? (radios.find((r) => r.checked) ?? null) : null
for (const id of [
  'settings-btn',
  'settings-close',
  'settings-cancel',
  'settings-save',
  'settings-error',
  'webapi-host',
  'webapi-port',
  'udp-port',
  'webapi-params',
  'udp-params',
  'conn-indicator',
  'conn-last',
  'toast',
]) {
  els[id] = fakeElement(id)
}
els['settings-panel'] = panel
globalThis.document = fakeDocument(els)

const calls = []
let getResponse
let postResponse
globalThis.localStorage = {
  _s: {},
  getItem(k) {
    return this._s[k] ?? null
  },
  setItem(k, v) {
    this._s[k] = String(v)
  },
}
globalThis.fetch = async (input, init = {}) => {
  calls.push({ input, init })
  return init.method === 'POST' ? postResponse : getResponse
}

const statusUpdates = []
initSettingsPanel({ onStatusUpdate: (s) => statusUpdates.push(s) })
const postCalls = () => calls.filter((c) => c.init.method === 'POST')

// 模拟 index.html 输入框的默认 value 属性
function setHtmlDefaults() {
  els['webapi-host'].value = '127.0.0.1'
  els['webapi-port'].value = '8086'
  els['udp-port'].value = '49005'
}
setHtmlDefaults()

test('打开面板：回填服务端当前配置，单选与参数组联动', async () => {
  getResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      activeMode: 'webapi',
      webapi: { host: '10.0.0.5', port: 9000 },
      udp: { listenPort: 49010 },
    }),
  }
  els['settings-btn'].dispatch('click')
  await tick()
  await tick()
  assert.equal(els['webapi-host'].value, '10.0.0.5')
  assert.equal(els['webapi-port'].value, '9000')
  assert.equal(els['udp-port'].value, '49010')
  assert.equal(radios[0].checked, true)
  assert.ok(!els['webapi-params'].classList.contains('disabled'))
  assert.ok(els['udp-params'].classList.contains('disabled'))
})

test('切到 UDP 单选：参数组启停互换', () => {
  radios[0].checked = false
  radios[1].checked = true
  radios[1].dispatch('change')
  assert.ok(els['udp-params'].classList.contains('disabled') === false)
  assert.ok(els['webapi-params'].classList.contains('disabled'))
})

test('保存：按表单值提交，成功后提示并关闭面板', async () => {
  postResponse = {
    ok: true,
    status: 200,
    json: async () => ({ activeMode: 'udp', connected: false }),
  }
  els['udp-port'].value = '49006'
  els['settings-save'].dispatch('click')
  await tick()
  await tick()
  const last = postCalls().at(-1)
  assert.equal(last.input, '/api/xplane-mode')
  assert.deepEqual(JSON.parse(last.init.body), { activeMode: 'udp', udp: { listenPort: 49006 } })
  assert.equal(panel.hidden, true)
  assert.equal(els['toast'].textContent, '切换成功')
  assert.deepEqual(statusUpdates.at(-1), { activeMode: 'udp', connected: false })
  assert.equal(els['settings-save'].textContent, '保存并切换') // loading 状态复位
  assert.equal(els['settings-save'].disabled, false)
})

test('保存：输入留空时回落默认值（127.0.0.1 / 8086 / 49005）', async () => {
  radios[1].checked = false
  radios[0].checked = true
  radios[0].dispatch('change')
  els['webapi-host'].value = ''
  els['webapi-port'].value = ''
  els['settings-save'].dispatch('click')
  await tick()
  await tick()
  const body = JSON.parse(postCalls().at(-1).init.body)
  assert.deepEqual(body.webapi, { host: '127.0.0.1', port: 8086 })
})

test('保存：非法端口直接提示，不发送请求', async () => {
  radios[0].checked = false
  radios[1].checked = true
  radios[1].dispatch('change')
  els['udp-port'].value = '99999'
  panel.hidden = false // 模拟用户已打开面板
  const postsBefore = postCalls().length
  els['settings-save'].dispatch('click')
  await tick()
  assert.equal(postCalls().length, postsBefore, '非法端口不应发请求')
  assert.ok(els['settings-error'].textContent.includes('端口'))
  assert.equal(panel.hidden, false, '面板保持打开便于修改')
})

test('保存失败：展示服务端错误且不关闭面板', async () => {
  postResponse = {
    ok: false,
    status: 409,
    json: async () => ({ error: { code: 'PORT_IN_USE', message: '端口已被占用' } }),
  }
  els['udp-port'].value = '49007'
  panel.hidden = false // 模拟用户已打开面板
  els['settings-save'].dispatch('click')
  await tick()
  await tick()
  assert.equal(els['settings-error'].textContent, '端口已被占用')
  assert.equal(panel.hidden, false)
})

test('打开面板读取失败：显示错误且输入框保留默认值', async () => {
  getResponse = {
    ok: false,
    status: 500,
    json: async () => ({ error: { code: 'INTERNAL', message: 'x' } }),
  }
  setHtmlDefaults()
  panel.hidden = false
  els['settings-btn'].dispatch('click')
  await tick()
  await tick()
  assert.ok(els['settings-error'].textContent.includes('读取当前配置失败'))
  assert.equal(els['webapi-host'].value, '127.0.0.1')
})

test('连接指示灯三态：已连接 / 曾有数据 / 从未连接', () => {
  updateConnIndicator({ connected: true, webapi: {}, udp: {} })
  assert.equal(els['conn-indicator'].textContent, '🟢 已连接')
  updateConnIndicator({ connected: false, webapi: { lastUpdate: 123 }, udp: {} })
  assert.equal(els['conn-indicator'].textContent, '🟡 连接中 / 未连接')
  updateConnIndicator({ connected: false, webapi: {}, udp: {} })
  assert.equal(els['conn-indicator'].textContent, '🔴 未连接')
})
