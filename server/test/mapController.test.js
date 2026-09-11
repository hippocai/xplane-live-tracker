// public/js/mapController.js 测试（极简 Leaflet 替身）。
// 覆盖：未激活时忽略更新、图标创建/旋转、航迹分段（breakBefore）、
// 无飞行置灰、进入大陆自动切百度、迟滞防抖、离开恢复 OSM、loadTrack 补画、
// 拖动关闭跟随、recenter。
// 注意：mapController 持有模块级状态（segments 等），本文件按真实使用顺序
// 组织为一条流水（node:test 文件内默认串行执行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeElement, fakeDocument } from './frontendHelpers.js'
import { initMap, api } from '../../public/js/mapController.js'

// —— 极简 Leaflet 替身：记录全部创建的实例供断言 ——
function makeFakeL() {
  const created = { maps: [], markers: [], polylines: [], tiles: [] }
  const L = {
    CRS: { Earth: { code: 'Earth' } },
    Transformation: class {
      constructor(a, b, c, d) {
        this.k = [a, b, c, d]
      }
    },
    point: (x, y) => ({ x, y }),
    bounds: (a, b) => ({ min: a, max: b }),
    latLng: (lat, lng) => ({ lat, lng }),
    map: (container, opts = {}) => {
      const m = fakeElement('map')
      m.options = opts
      m.center = null
      m.zoom = null
      m.pannedTo = []
      m.handlers = {}
      m.setView = (c, z) => {
        m.center = c
        m.zoom = z
        return m
      }
      m.getCenter = () => m.center ?? { lat: 30, lng: 120 }
      m.getZoom = () => m.zoom ?? 4
      m.panTo = (ll) => m.pannedTo.push(ll)
      m.getContainer = () => container
      m.on = (ev, fn) => {
        ;(m.handlers[ev] ||= []).push(fn)
      }
      m.remove = () => {
        m.removed = true
      }
      created.maps.push(m)
      return m
    },
    tileLayer: (url, options) => {
      const t = { url, options, addTo: () => t }
      created.tiles.push(t)
      return t
    },
    divIcon: (options) => ({ options }),
    marker: (latlng, options) => {
      const el = fakeElement('marker')
      const img = fakeElement('img')
      el.querySelector = (sel) => (sel === 'img' ? img : null)
      const mk = {
        latlng,
        options,
        addTo: () => mk,
        setLatLng: (ll) => {
          mk.latlng = ll
          return mk
        },
        getElement: () => el,
      }
      mk._img = img
      created.markers.push(mk)
      return mk
    },
    polyline: (latlngs, options) => {
      const pl = {
        latlngs: [...latlngs],
        options: { ...options },
        addTo: () => pl,
        setLatLngs: (ls) => {
          pl.latlngs = [...ls]
        },
        setStyle: (o) => Object.assign(pl.options, o),
        remove: () => {
          pl.removed = true
        },
      }
      created.polylines.push(pl)
      return pl
    },
  }
  return { L, created }
}

const { L: fakeL, created } = makeFakeL()
const container = fakeElement('map')
const toastEl = fakeElement('toast')
globalThis.L = fakeL
globalThis.document = fakeDocument({ toast: toastEl })
initMap(container, 'osm', { trackEnabled: true })

const livePolylines = () => created.polylines.filter((p) => !p.removed)
const pos = (lat, lon, extra = {}) => ({ lat, lon, heading: 0, timestamp: Date.now(), ...extra })

test('初始为 OSM 底图；flightActive=false 时忽略位置更新（§15.4.2）', () => {
  assert.equal(created.maps.length, 1)
  assert.ok(created.tiles[0].url.includes('openstreetmap'))
  api.updatePosition(pos(35.68, 139.69)) // 东京
  assert.equal(created.markers.length, 0, '未激活时不应创建飞机图标')
})

test('激活后：创建图标、随航向旋转、跟随居中', () => {
  api.setFlightActive(true)
  assert.ok(!container.classList.contains('map-disabled'))
  api.updatePosition(pos(35.68, 139.69, { heading: 90 }))
  assert.equal(created.markers.length, 1)
  assert.deepEqual(created.markers[0].latlng, [35.68, 139.69])
  assert.equal(created.markers[0]._img.style.transform, 'rotate(90deg)')
  assert.equal(created.maps[0].pannedTo.length, 1, '默认跟随应触发 panTo')
})

test('航迹：连续点进同一段，breakBefore 分段（§11）', () => {
  api.updatePosition(pos(35.68, 139.7))
  assert.equal(livePolylines().length, 1)
  assert.equal(livePolylines()[0].latlngs.length, 2)
  // 用境外点（大阪）做跳变，避免顺带触发底图切换（下一个用例专门测）
  api.updatePosition(pos(34.69, 135.5, { breakBefore: true }))
  assert.equal(livePolylines().length, 2, '跳变后应另起一段')
})

test('进入中国大陆：自动切百度（重建地图、恢复视图、提示），航迹与图标保留', () => {
  const mapCount = created.maps.length
  api.updatePosition(pos(40.0, 116.6)) // 北京 → 触发切换
  assert.equal(created.maps.length, mapCount + 1)
  assert.equal(created.maps[mapCount - 1].removed, true, '旧地图应销毁')
  const newMap = created.maps.at(-1)
  assert.ok(newMap.options.crs, '百度地图应带自定义 CRS')
  assert.ok(created.tiles.at(-1).url.includes('bdimg.com'))
  assert.ok(toastEl.textContent.includes('百度地图'))
  assert.ok(created.markers.length >= 2, '切换后图标应重建')
  assert.ok(livePolylines().length >= 2, '已有航迹段应重建保留')
})

test('迟滞防抖：主矩形外但 margin(0.3°) 内不回切', () => {
  const mapCount = created.maps.length
  api.updatePosition(pos(40.0, 135.3)) // 主矩形东界 135.1 之外、135.4 之内
  assert.equal(created.maps.length, mapCount, '迟滞区间内不应重建')
  assert.ok(created.tiles.at(-1).url.includes('bdimg.com'))
})

test('离开大陆：恢复 OSM 底图', () => {
  api.updatePosition(pos(40.0, 136.5)) // 超出迟滞边界
  assert.ok(created.tiles.at(-1).url.includes('openstreetmap'))
  assert.ok(toastEl.textContent.includes('OpenStreetMap'))
})

test('无飞行置灰：地图加 .map-disabled、图标隐藏、航迹降透明度（§6.6）', () => {
  api.setFlightActive(false)
  assert.ok(container.classList.contains('map-disabled'))
  const marker = created.markers.at(-1)
  assert.equal(marker.getElement().style.display, 'none')
  assert.equal(livePolylines().at(-1).options.opacity, 0.3)
  api.setFlightActive(true)
  assert.ok(!container.classList.contains('map-disabled'))
  assert.equal(livePolylines().at(-1).options.opacity, 0.9)
})

test('loadTrack：补画历史航迹（含跳变分段），最后位置在大陆时立即切百度', () => {
  const mapCount = created.maps.length
  api.loadTrack([
    { lat: 35.68, lon: 139.69, timestamp: 1 },
    { lat: 40.0, lon: 116.6, timestamp: 2, breakBefore: true },
  ])
  assert.equal(created.maps.length, mapCount + 1, '最后点在大陆应立即切百度')
  assert.ok(created.tiles.at(-1).url.includes('bdimg.com'))
})

test('recenter：以最后位置居中并至少 12 级缩放', () => {
  api.recenter()
  const m = created.maps.at(-1)
  assert.equal(m.center[0], 40.0)
  assert.ok(m.zoom >= 12)
})

test('用户拖动地图后关闭自动跟随', () => {
  const m = created.maps.at(-1)
  const before = m.pannedTo.length
  m.handlers.dragstart[0]()
  api.updatePosition(pos(40.01, 116.61))
  assert.equal(m.pannedTo.length, before, '关闭跟随后不应再 panTo')
})
