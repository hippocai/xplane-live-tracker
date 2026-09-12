// 导航图层（机场 / 导航台 / 航路点）：
// - 三个可独立开关的图层，数据来自后端 /api/navpoints（本机 X-Plane 导航数据库）
// - 开启后按"当前视野中心 → 视野角落"的半径拉取；地图拖动/缩放（moveend）防抖后重新拉取
// - 底图切换会销毁重建地图实例：通过 onMapRebuilt 重挂 moveend 并立即重绘
// - 坐标一律 WGS84，直接叠加在两种 CRS 上（百度 CRS 内部完成纠偏）
import { api } from './api.js'
import { haversineKm } from './geo.js'

const REFETCH_DEBOUNCE_MS = 600
const MIN_RADIUS_KM = 20
const MAX_RADIUS_KM = 800

// 图标字形与样式类；机场为蓝色✈、导航台紫色◉、航路点灰色小菱形
const ICONS = {
  airport: '✈',
  navaid: '◉',
  fix: '◆',
}

let getMapFn = null
let rebuildRegFn = null
let attachedMap = null
let fetchTimer = null
const layers = {} // type -> { enabled, group }
let inited = false

/**
 * @param {{getMap: Function, onMapRebuilt: Function}} deps
 * @returns {{setLayerEnabled: Function, isLayerEnabled: Function, refresh: Function}}
 */
export function initNavLayers({ getMap, onMapRebuilt }) {
  getMapFn = getMap
  rebuildRegFn = onMapRebuilt
  if (!inited) {
    inited = true
    rebuildRegFn?.(() => {
      attachMoveend()
      refresh(true) // 地图重建后立即重绘已开启的图层
    })
    attachMoveend()
  }
  return {
    setLayerEnabled,
    isLayerEnabled,
    refresh,
  }
}

function setLayerEnabled(type, on) {
  if (!(type in ICONS)) return
  const map = getMapFn?.()
  layers[type] = layers[type] || { enabled: false, group: null }
  const layer = layers[type]
  layer.enabled = Boolean(on)
  if (!map) return
  if (layer.enabled && !layer.group) {
    layer.group = L.layerGroup().addTo(map)
  } else if (!layer.enabled && layer.group) {
    layer.group.remove()
    layer.group = null
  }
  if (layer.enabled) refresh()
}

function isLayerEnabled(type) {
  return Boolean(layers[type]?.enabled)
}

/** 立即按当前视野重拉所有已开启图层（immediate=true 跳过防抖） */
function refresh(immediate = false) {
  const enabledTypes = Object.keys(layers).filter((t) => layers[t].enabled)
  if (!enabledTypes.length) return
  const run = () => fetchAndRender(enabledTypes)
  if (immediate) {
    clearTimeout(fetchTimer)
    run()
  } else {
    clearTimeout(fetchTimer)
    fetchTimer = setTimeout(run, REFETCH_DEBOUNCE_MS)
  }
}

/** moveend 防抖重拉（拖动/缩放后视野变化） */
function attachMoveend() {
  const map = getMapFn?.()
  if (!map || attachedMap === map) return
  attachedMap = map
  map.on('moveend', () => refresh())
}

async function fetchAndRender(types) {
  const map = getMapFn?.()
  if (!map) return
  const center = map.getCenter()
  // 半径 = 中心到视野左上角的距离（覆盖整个可视区），并做上下限
  const corner = map.containerPointToLatLng?.({ x: 0, y: 0 })
  let radiusKm = 200
  if (center && corner) {
    radiusKm = Math.min(Math.max(haversineKm(center, corner), MIN_RADIUS_KM), MAX_RADIUS_KM)
  }
  try {
    const res = await api(
      `/api/navpoints?lat=${center.lat.toFixed(5)}&lon=${(center.lng ?? center.lon).toFixed(5)}` +
        `&radiusKm=${Math.round(radiusKm)}&types=${types.join(',')}`,
    )
    if (!res.loaded) return // 数据源未配置/未加载，开关层提示由 app.js 状态区负责
    renderPoints(types, res.points || [])
  } catch {
    /* 拉取失败静默（下一次 moveend 会重试），不打断地图交互 */
  }
}

function renderPoints(types, points) {
  const map = getMapFn?.()
  if (!map) return
  const wanted = new Set(types)
  for (const t of types) {
    layers[t]?.group?.clearLayers()
  }
  for (const p of points) {
    if (!wanted.has(p.type)) continue
    const group = layers[p.type]?.group
    if (!group) continue
    const label =
      p.type === 'airport'
        ? `${p.ident} ${p.name}`
        : p.type === 'navaid'
          ? `${p.ident} ${(p.kind || '').toUpperCase()} ${p.name}`
          : p.ident
    const icon = L.divIcon({
      className: 'nav-icon',
      html: `<span class="nav-ico nav-${p.type}${p.kind === 'ndb' ? ' ndb' : ''}">${ICONS[p.type]}</span>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    })
    L.marker([p.lat, p.lon], { icon, keyboard: false })
      .bindTooltip(label, { direction: 'top', offset: [0, -6] })
      .addTo(group)
  }
}

/** 仅供单元测试：重置模块级状态（生产代码不要调用；app.js 每个页面只 init 一次） */
export function resetNavLayersForTests() {
  clearTimeout(fetchTimer)
  fetchTimer = null
  for (const t of Object.keys(layers)) {
    layers[t]?.group?.remove?.()
    delete layers[t]
  }
  attachedMap = null
  inited = false
}
