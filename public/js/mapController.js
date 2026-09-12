// 地图控制器（设计文档 §15.4.3 + 底图自动切换增强）：
// 封装 Leaflet 初始化、飞机图标旋转、航迹绘制（含跳变断线）、
// "无飞行"灰色样式切换、自动跟随，以及——
// 飞机进入中国大陆时自动切换百度底图、离开后自动恢复（FR: 用户需求 2026-09）。
// 坐标体系：所有对外坐标一律 WGS84；百度瓦片的 BD09 纠偏在 baiduCrs.js 内部完成。
import { isMainlandChina } from './geo.js'
import { createBaiduCrs, createBaiduTileLayer } from './baiduCrs.js'
import { toast } from './ui.js'

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const MAX_SEGMENT_POINTS = 2000 // 单段航迹最大点数，超过后从队首移除
const MAX_SEGMENTS = 20 // 最多保留段数（配合服务端 30 分钟窗口足够）
const EXIT_MARGIN_DEG = 0.3 // 离开大陆判定的外扩余量：防止沿海岸线飞行时底图来回抖动

let map = null
let marker = null
let markerImg = null
let polylines = [] // 与 segments 一一对应的 Leaflet polyline 实例
let segments = [] // 航迹唯一真源：Array<Array<[lat, lng]>>，跳变处分段
let lastPosition = null
let follow = true
let flightActive = false
let trackEnabled = true
let baiduAuto = true // 进入大陆自动切百度（可在设置面板开关，默认开）
let baseProvider = 'osm' // /api/config 指定的底图（google 目前兜底为 osm）
let activeProvider = null // 当前实际使用的底图
let containerEl = null

/**
 * 初始化地图
 * @param {HTMLElement} container
 * @param {'osm'|'google'} provider
 * @param {{trackEnabled?: boolean, baiduAuto?: boolean}} [opts]
 */
export function initMap(container, provider = 'osm', opts = {}) {
  containerEl = container
  trackEnabled = opts.trackEnabled !== false
  baiduAuto = opts.baiduAuto !== false
  // Google Maps 底图为设计文档 M8 可选项，v1 统一以 OSM 兜底
  baseProvider = provider === 'google' ? 'osm' : provider
  buildMap(baseProvider)
  return api
}

/** 按指定 provider 构建地图实例（也用于区域自动切换时的重建） */
function buildMap(provider, restore = {}) {
  activeProvider = provider
  const useBaidu = provider === 'baidu'
  const mapOpts = {
    zoomControl: true,
    minZoom: useBaidu ? 3 : 2,
    maxZoom: 19,
  }
  if (useBaidu) mapOpts.crs = createBaiduCrs(L)
  map = L.map(containerEl, mapOpts)
  // 缩放控件放右下角：默认左上角会与局域网地址/二维码卡片（#lan-box）重叠
  map.zoomControl?.setPosition?.('bottomright')
  if (useBaidu) {
    createBaiduTileLayer(L).addTo(map)
  } else {
    L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }).addTo(map)
  }

  // 恢复视图：优先用飞机位置（跟随模式），否则保持原中心/缩放
  if (restore.center) {
    map.setView(restore.center, restore.zoom)
  } else if (lastPosition && flightActive && follow) {
    map.setView([lastPosition.lat, lastPosition.lon], Math.max(map.getZoom(), 10))
  } else {
    map.setView([30, 120], 4)
  }

  // 用户手动拖动地图后自动关闭"跟随飞机"（§6.3）
  map.on('dragstart', () => {
    follow = false
  })

  // 重建航迹与飞机图标（坐标数值为 WGS84，两种 CRS 下通用）
  rebuildPolylines()
  if (lastPosition && flightActive) {
    createMarker(lastPosition)
  }
}

/** 销毁当前地图并按目标 provider 重建，完整恢复视图/航迹/图标/样式状态 */
function switchProvider(provider) {
  if (!map || activeProvider === provider) return
  const restore = {
    center: map.getCenter(),
    zoom: map.getZoom(),
  }
  // 显式移除航迹层（虽然整张地图销毁时 Leaflet 会连带清理，显式做避免依赖实现细节）
  for (const line of polylines) line?.remove?.()
  map.remove()
  map = null
  marker = null
  markerImg = null
  polylines = []
  buildMap(provider, restore)
  toast(
    provider === 'baidu'
      ? '🗺 已切换至百度地图（中国大陆范围自动启用）'
      : '🗺 已恢复 OpenStreetMap 底图',
  )
}

export const api = {
  /** 更新飞机位置/朝向、追加航迹点，并按区域自动切换底图 */
  updatePosition(pos) {
    // flightActive === false 期间不更新，避免"灰色遮罩下图标仍在跳动"（§15.4.2 边界情况）
    if (!map || !flightActive || !pos) return

    // —— 底图区域自动切换（含迟滞：进入用精确边界，离开用外扩 0.3° 边界）——
    if (baiduAuto && activeProvider !== 'baidu' && isMainlandChina(pos.lat, pos.lon)) {
      switchProvider('baidu')
    } else if (activeProvider === 'baidu' && !isMainlandChina(pos.lat, pos.lon, EXIT_MARGIN_DEG)) {
      switchProvider(baseProvider)
    }

    const latlng = [pos.lat, pos.lon]

    if (!marker) {
      createMarker(pos)
    } else {
      marker.setLatLng(latlng)
      if (!markerImg) markerImg = marker.getElement()?.querySelector('img')
    }
    // 图标随航向旋转：图标素材机头朝北，顺时针旋转 heading 度即为真航向
    if (markerImg && Number.isFinite(pos.heading)) {
      markerImg.style.transform = `rotate(${pos.heading}deg)`
    }

    // 航迹：跳变处断开不连线（服务端已标记 breakBefore，设计文档 §11）
    if (trackEnabled) {
      let seg = segments[segments.length - 1]
      if (!seg || pos.breakBefore) {
        seg = []
        segments.push(seg)
        if (segments.length > MAX_SEGMENTS) segments.shift()
        syncPolylines()
      }
      seg.push(latlng)
      if (seg.length > MAX_SEGMENT_POINTS) seg.shift()
      const line = polylines[polylines.length - 1]
      if (line) line.setLatLngs(seg)
    }
    lastPosition = pos

    if (follow) map.panTo(latlng, { animate: true, duration: 0.5 })
  },

  /** "无飞行"灰色样式切换（§6.6.3）：active=false 置灰、隐藏图标、航迹降透明度 */
  setFlightActive(active) {
    if (!map || active === flightActive) return
    flightActive = active
    map.getContainer().classList.toggle('map-disabled', !active)
    if (marker) {
      const el = marker.getElement()
      if (el) el.style.display = active ? '' : 'none'
    }
    for (const line of polylines) {
      line.setStyle({ opacity: active ? 0.9 : 0.3 })
    }
    if (!active) {
      follow = false // 置灰期间停止自动居中，避免最后位置反复拉扯视野
    }
  },

  /** 自动居中开关 */
  setFollowMode(on) {
    follow = Boolean(on)
  },

  /** "回到飞机位置"按钮：重新居中并恢复跟随 */
  recenter() {
    if (!map || !lastPosition) return
    follow = true
    map.setView([lastPosition.lat, lastPosition.lon], Math.max(map.getZoom(), 12))
  },

  /** 页面刷新后用 /api/track 的历史点补画航迹（§5.4） */
  loadTrack(points) {
    if (!map || !Array.isArray(points)) return
    for (const p of points) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue
      let seg = segments[segments.length - 1]
      if (!seg || p.breakBefore) {
        seg = []
        segments.push(seg)
        syncPolylines()
      }
      seg.push([p.lat, p.lon])
      lastPosition = p
    }
    // 超出保留段数的老段直接丢弃
    if (segments.length > MAX_SEGMENTS) {
      segments.splice(0, segments.length - MAX_SEGMENTS)
      syncPolylines()
    }
    // 若最后已知位置在大陆境内，立即切百度底图（不等下一个 position 帧）
    const lastSeg = segments[segments.length - 1]
    const last = lastSeg?.[lastSeg.length - 1]
    if (baiduAuto && last && activeProvider !== 'baidu' && isMainlandChina(last[0], last[1])) {
      switchProvider('baidu')
    }
  },

  /**
   * "进入大陆自动切百度"开关（默认开）。变更立即生效：
   * 关闭时若正在百度底图 → 切回基础底图；开启时若最后位置在境内 → 立即切百度。
   */
  setBaiduAutoSwitch(on) {
    baiduAuto = Boolean(on)
    if (!map) return
    if (!baiduAuto && activeProvider === 'baidu') {
      switchProvider(baseProvider)
    } else if (
      baiduAuto &&
      lastPosition &&
      activeProvider !== 'baidu' &&
      isMainlandChina(lastPosition.lat, lastPosition.lon)
    ) {
      switchProvider('baidu')
    }
  },

  getBaiduAutoSwitch() {
    return baiduAuto
  },

  /** 当前是否跟随飞机（拖动地图/置灰会自动关闭，recenter/开关恢复） */
  isFollowing() {
    return follow
  },
}

function createMarker(pos) {
  const icon = L.divIcon({
    className: 'plane-icon',
    html: `<img src="assets/plane-icon.svg" alt="plane" />`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  })
  marker = L.marker([pos.lat, pos.lon], { icon, keyboard: false }).addTo(map)
  markerImg = marker.getElement()?.querySelector('img')
  if (markerImg && Number.isFinite(pos.heading)) {
    markerImg.style.transform = `rotate(${pos.heading}deg)`
  }
  if (!flightActive) {
    const el = marker.getElement()
    if (el) el.style.display = 'none'
  }
}

/** 按当前 segments 全量重建 Leaflet polyline 实例（初始化/切换底图后调用） */
function rebuildPolylines() {
  for (const line of polylines) line?.remove?.()
  polylines = []
  for (const seg of segments) {
    const line = L.polyline(seg, { color: '#e8442f', weight: 3, opacity: flightActive ? 0.9 : 0.3 })
    line.addTo(map)
    polylines.push(line)
  }
}

/** segments 结构变化（新增段/淘汰老段）时同步 polyline 实例数量 */
function syncPolylines() {
  // 先全量重建——段数变化不频繁，成本可忽略，逻辑最简单可靠
  if (map) rebuildPolylines()
}
