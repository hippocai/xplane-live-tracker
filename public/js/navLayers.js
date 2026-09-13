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
const NAV_LABEL_MIN_ZOOM = 9 // 机场常显名称标签的最低缩放级别（再低太密）

// 徽章式 SVG 图标：彩色填充 + 白描边（地图 POI 的标准做法，彩色底图上依然醒目）。
// 样式参照航空图习惯：机场=蓝色圆+白✈、VOR=紫色六边形、NDB=玫红圆点、航路点=橙色菱形。
const ICONS = {
  airport: {
    size: 22,
    svg: '<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9.5" fill="#1565c0" stroke="#ffffff" stroke-width="2.5"/><text x="11" y="15.5" text-anchor="middle" font-size="11" fill="#ffffff" font-family="sans-serif">✈</text></svg>',
  },
  vor: {
    size: 19,
    svg: '<svg width="19" height="19" viewBox="0 0 19 19"><polygon points="9.5,1.5 16.6,5.6 16.6,13.4 9.5,17.5 2.4,13.4 2.4,5.6" fill="#7b1fa2" stroke="#ffffff" stroke-width="2.2"/></svg>',
  },
  ndb: {
    size: 17,
    svg: '<svg width="17" height="17" viewBox="0 0 17 17"><circle cx="8.5" cy="8.5" r="6.8" fill="#ad1457" stroke="#ffffff" stroke-width="2.2"/></svg>',
  },
  fix: {
    size: 14,
    svg: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="4" y="4" width="6" height="6" transform="rotate(45 7 7)" fill="#ef6c00" stroke="#ffffff" stroke-width="1.8"/></svg>',
  },
}

function iconSpec(p) {
  if (p.type === 'navaid') return p.kind === 'ndb' ? ICONS.ndb : ICONS.vor
  return ICONS[p.type]
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

// 图层类型（与后端 /api/navpoints 的 type 一致）；图标形态由 iconSpec() 按类型/子类型映射
const LAYER_TYPES = ['airport', 'navaid', 'fix']

function setLayerEnabled(type, on) {
  if (!LAYER_TYPES.includes(type)) return
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
  const run = () => {
    syncLabels()
    fetchAndRender(enabledTypes)
  }
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
  // 缩放变化时标签显隐立即生效（数据重取走防抖）
  map.on('moveend', () => {
    syncLabels()
    refresh()
  })
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
        ? `${p.ident} ${p.name}`.trim()
        : p.type === 'navaid'
          ? `${p.ident} ${(p.kind || '').toUpperCase()} ${p.name}`.trim()
          : p.ident
    const spec = iconSpec(p)
    const icon = L.divIcon({
      className: 'nav-icon',
      html: spec.svg,
      iconSize: [spec.size, spec.size],
      iconAnchor: [spec.size / 2, spec.size / 2],
    })
    // 机场用常显名称标签（缩放级别由容器 class 控制）；其余悬停显示
    const tooltipOpts =
      p.type === 'airport'
        ? { permanent: true, direction: 'right', offset: [12, 0], className: 'nav-label' }
        : { direction: 'top', offset: [0, -6] }
    L.marker([p.lat, p.lon], { icon, keyboard: false }).bindTooltip(label, tooltipOpts).addTo(group)
  }
}

/** 机场常显标签的显隐：缩放 ≥ NAV_LABEL_MIN_ZOOM 时给地图容器加 class（低缩放太密） */
function syncLabels() {
  const map = getMapFn?.()
  const container = map?.getContainer?.()
  container?.classList?.toggle('nav-labels-on', (map.getZoom?.() ?? 4) >= NAV_LABEL_MIN_ZOOM)
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
