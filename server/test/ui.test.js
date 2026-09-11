// public/js/ui.js 测试：状态条双文案、连接中提示、信息面板格式化、toast
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeElement, fakeDocument } from './frontendHelpers.js'
import {
  MSG,
  setConnecting,
  updateStatusBanner,
  showWsLost,
  updateInfoPanel,
  toast,
} from '../../public/js/ui.js'

const els = {}
for (const id of [
  'status-banner',
  'info-panel',
  'i-tail',
  'i-alt',
  'i-agl',
  'i-gs',
  'i-ias',
  'i-hdg',
  'i-vs',
  'i-pos',
  'i-delay',
  'toast',
]) {
  els[id] = fakeElement(id)
}
globalThis.document = fakeDocument(els)

const banner = els['status-banner']
const panel = els['info-panel']

test('未连接：显示"未连接到 X-Plane"文案（§6.6.2）', () => {
  updateStatusBanner({ connected: false, flightActive: false })
  assert.equal(banner.textContent, MSG.DISCONNECTED)
  assert.ok(banner.classList.contains('visible'))
  assert.ok(!banner.classList.contains('dim'))
})

test('已连接但无飞行数据：显示"当前没有飞机在飞行"', () => {
  updateStatusBanner({ connected: true, flightActive: false })
  assert.equal(banner.textContent, MSG.NO_FLIGHT)
})

test('切换过程中（connecting）：优先显示"正在连接"且使用深色样式', () => {
  setConnecting(true)
  updateStatusBanner({ connected: true, flightActive: false })
  assert.equal(banner.textContent, MSG.CONNECTING)
  assert.ok(banner.classList.contains('dim'))
  setConnecting(false)
})

test('正常飞行：提示条隐藏', () => {
  updateStatusBanner({ connected: true, flightActive: true })
  assert.ok(!banner.classList.contains('visible'))
  assert.equal(banner.textContent, '')
})

test('WS 断开提示与恢复', () => {
  showWsLost(true)
  assert.equal(banner.textContent, MSG.WS_LOST)
  assert.ok(banner.classList.contains('visible') && banner.classList.contains('dim'))
  showWsLost(false)
  assert.ok(!banner.classList.contains('dim'))
})

test('updateInfoPanel(null)：全部显示 -- 且面板置灰', () => {
  updateInfoPanel(null)
  assert.ok(panel.classList.contains('inactive'))
  for (const id of ['i-tail', 'i-alt', 'i-hdg', 'i-pos']) {
    assert.equal(els[id].textContent, '--', id)
  }
})

test('updateInfoPanel(数据)：数值格式化正确', () => {
  updateInfoPanel({
    tailNumber: 'N12345',
    altMsl: 1520,
    altAgl: 300,
    groundSpeedKt: 250,
    iasKt: 245,
    heading: 73,
    verticalSpeedFpm: -320,
    lat: 31.2304,
    lon: 121.4737,
    timestamp: Date.now() - 120,
  })
  assert.ok(!panel.classList.contains('inactive'))
  assert.equal(els['i-tail'].textContent, 'N12345')
  assert.equal(els['i-hdg'].textContent, '073°') // 3 位补零
  assert.ok(els['i-alt'].textContent.includes(' / ')) // 米 / 英尺双单位
  assert.ok(els['i-alt'].textContent.includes('m'))
  assert.ok(/^\d+ ms$/.test(els['i-delay'].textContent))
  assert.ok(els['i-pos'].textContent.includes(','))
  assert.ok(els['i-vs'].textContent.includes('fpm'))
})

test('toast：显示文案并自动隐藏标记', () => {
  toast('已切换至百度地图')
  assert.equal(els['toast'].textContent, '已切换至百度地图')
  assert.equal(els['toast'].hidden, false)
})
