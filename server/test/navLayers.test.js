// public/js/navLayers.js 测试（fake Leaflet + fetch mock）：
// 开关图层拉取与渲染、SVG 徽章图标、机场标签分级显示、moveend 防抖重取、
// 底图重建回调立即重取、关闭清理、未加载不渲染。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initNavLayers, resetNavLayersForTests } from '../../public/js/navLayers.js'
import { fakeElement } from './frontendHelpers.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = () => new Promise((r) => setImmediate(r))

const created = { markers: [], groups: [] }
let fakeMap
let fakeMapContainer
let rebuildCb = null
let navResponse
const fetchCalls = []

function setup() {
  resetNavLayersForTests()
  created.markers.length = 0
  created.groups.length = 0
  fetchCalls.length = 0
  rebuildCb = null
  fakeMapContainer = fakeElement('map')
  fakeMap = {
    handlers: {},
    zoomVal: 4,
    getZoom: () => fakeMap.zoomVal,
    getContainer: () => fakeMapContainer,
    getCenter: () => ({ lat: 40, lng: 116 }),
    containerPointToLatLng: () => ({ lat: 41, lng: 117 }), // ~140km 外的角落
    on: (ev, fn) => {
      ;(fakeMap.handlers[ev] ||= []).push(fn)
    },
  }
  globalThis.L = {
    layerGroup: () => {
      const g = {
        layers: [],
        removed: false,
        addedTo: null,
        addLayer: (m) => g.layers.push(m),
        clearLayers: () => {
          g.layers.length = 0
        },
        addTo: (m) => {
          g.addedTo = m
          created.groups.push(g)
          return g
        },
        remove: () => {
          g.removed = true
        },
      }
      return g
    },
    divIcon: (o) => ({ options: o }),
    marker: (ll, o) => {
      const m = {
        latlng: ll,
        options: o,
        tooltip: null,
        bindTooltip: (t) => {
          m.tooltip = t
          return m
        },
        addTo: (g) => {
          g.addLayer(m)
          created.markers.push(m)
          return m
        },
      }
      return m
    },
  }
  globalThis.localStorage = {
    _s: {},
    getItem(k) {
      return this._s[k] ?? null
    },
    setItem(k, v) {
      this._s[k] = String(v)
    },
  }
  globalThis.fetch = async (input) => {
    fetchCalls.push(String(input))
    return navResponse
  }
}

beforeEach(setup)

const ok = (points, loaded = true) => ({
  ok: true,
  status: 200,
  json: async () => ({ loaded, points }),
})

test('开启图层：防抖后按视野拉取并渲染 SVG 徽章标记（含 tooltip）', async () => {
  navResponse = ok([
    { type: 'airport', ident: 'ZBAA', name: 'Beijing Capital', lat: 40.08, lon: 116.58 },
    { type: 'navaid', kind: 'vor', ident: 'VYK', name: 'DAWANGZHUANG', lat: 40.08, lon: 116.61 },
  ])
  const nav = initNavLayers({ getMap: () => fakeMap, onMapRebuilt: (cb) => (rebuildCb = cb) })
  nav.setLayerEnabled('airport', true)
  await sleep(700)
  assert.equal(fetchCalls.length, 1)
  const url = fetchCalls[0]
  assert.ok(url.includes('lat=40.00000') && url.includes('lon=116.00000'), url)
  assert.ok(url.includes('types=airport'), url)
  assert.ok(url.includes('radiusKm='), url)
  // 只渲染 airport 类型的点；图标应为 SVG 徽章（白描边）
  assert.equal(created.markers.length, 1)
  assert.equal(created.markers[0].tooltip, 'ZBAA Beijing Capital')
  const html = created.markers[0].options.icon.options.html
  assert.ok(html.includes('<svg'), '应使用 SVG 图标')
  assert.ok(html.includes('#1565c0'), '机场徽章应为蓝色')
  assert.ok(created.groups[0].addedTo === fakeMap)
})

test('机场常显名称标签：缩放 ≥9 级才开启（容器 class 控制），低缩放不显示', async () => {
  navResponse = ok([{ type: 'airport', ident: 'ZBAA', name: '', lat: 40.08, lon: 116.58 }])
  const nav = initNavLayers({ getMap: () => fakeMap, onMapRebuilt: () => {} })
  nav.setLayerEnabled('airport', true)
  await sleep(700)
  assert.ok(!fakeMapContainer.classes.has('nav-labels-on'), 'zoom 4 不显示标签')
  fakeMap.zoomVal = 10
  fakeMap.handlers.moveend[0]()
  assert.ok(fakeMapContainer.classes.has('nav-labels-on'), 'zoom 10 应显示标签')
  await sleep(700) // 清理防抖任务
})

test('moveend：防抖后重取；渲染前清空旧标记', async () => {
  navResponse = ok([{ type: 'airport', ident: 'ZBAA', name: '', lat: 40.08, lon: 116.58 }])
  const nav = initNavLayers({ getMap: () => fakeMap, onMapRebuilt: () => {} })
  nav.setLayerEnabled('airport', true)
  await sleep(700)
  assert.equal(fetchCalls.length, 1)
  navResponse = ok([
    { type: 'airport', ident: 'ZBAA', name: '', lat: 40.08, lon: 116.58 },
    { type: 'airport', ident: 'ZBAD', name: '', lat: 39.51, lon: 116.41 },
  ])
  fakeMap.handlers.moveend[0]()
  await sleep(700)
  assert.equal(fetchCalls.length, 2)
  // 旧标记应被清空后重绘（看 layerGroup 当前层数，而非历史累计）
  assert.equal(created.groups[0].layers.length, 2, '旧标记应被清空后重绘')
})

test('底图重建回调：立即重取（无防抖等待）', async () => {
  navResponse = ok([])
  const nav = initNavLayers({ getMap: () => fakeMap, onMapRebuilt: (cb) => (rebuildCb = cb) })
  nav.setLayerEnabled('fix', true)
  await sleep(700)
  assert.equal(fetchCalls.length, 1)
  rebuildCb()
  await tick()
  await tick()
  assert.equal(fetchCalls.length, 2, '重建后应立即重取')
})

test('关闭图层：layerGroup 从地图移除', async () => {
  navResponse = ok([])
  const nav = initNavLayers({ getMap: () => fakeMap, onMapRebuilt: () => {} })
  nav.setLayerEnabled('navaid', true)
  await sleep(700)
  const group = created.groups[0]
  nav.setLayerEnabled('navaid', false)
  assert.equal(group.removed, true)
  assert.equal(nav.isLayerEnabled('navaid'), false)
})

test('数据未加载（loaded=false）：不渲染任何标记', async () => {
  navResponse = ok([{ type: 'airport', ident: 'X', name: '', lat: 40, lon: 116 }], false)
  const nav = initNavLayers({ getMap: () => fakeMap, onMapRebuilt: () => {} })
  nav.setLayerEnabled('airport', true)
  await sleep(700)
  assert.equal(fetchCalls.length, 1)
  assert.equal(created.markers.length, 0)
})
