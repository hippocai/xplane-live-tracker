// 地图控制器（设计文档 §15.4.3）：封装 Leaflet 初始化、飞机图标旋转、
// 航迹绘制（含跳变断线）、"无飞行"灰色样式切换、自动跟随。
// 说明：Google Maps 底图切换为设计文档 M8 可选项，v1 暂以 OSM 兜底并保留 provider 参数。
const MAX_LINE_POINTS = 2000 // 单条航迹线的最大点数，超过后从队首移除，避免无限增长
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

let map = null
let marker = null
let markerImg = null
let polylines = []
let currentLine = null
let linePoints = []
let lastPoint = null
let follow = true
let flightActive = false
let trackEnabled = true

/**
 * 初始化地图
 * @param {HTMLElement} container
 * @param {'osm'|'google'} provider
 * @param {{trackEnabled?: boolean}} [opts]
 */
export function initMap(container, provider = 'osm', opts = {}) {
  trackEnabled = opts.trackEnabled !== false
  map = L.map(container, { zoomControl: true }).setView([30, 120], 4)
  // 当前版本固定使用 OSM 瓦片（免费无 Key）；provider 为 google 时同样兜底到此并在控制台说明
  if (provider === 'google') {
    console.info('Google Maps 底图为可选扩展（设计文档 M8），当前使用 OSM 底图')
  }
  L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }).addTo(map)

  // 用户手动拖动地图后自动关闭"跟随飞机"（§6.3）
  map.on('dragstart', () => {
    follow = false
  })

  return api
}

export const api = {
  /** 更新飞机位置/朝向，并按需追加航迹点 */
  updatePosition(pos) {
    // flightActive === false 期间不更新，避免"灰色遮罩下图标仍在跳动"（§15.4.2 边界情况）
    if (!map || !flightActive || !pos) return
    const latlng = [pos.lat, pos.lon]

    if (!marker) {
      const icon = L.divIcon({
        className: 'plane-icon',
        html: `<img src="assets/plane-icon.svg" alt="plane" />`,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
      })
      marker = L.marker(latlng, { icon, keyboard: false }).addTo(map)
      markerImg = marker.getElement()?.querySelector('img')
    } else {
      marker.setLatLng(latlng)
      if (!markerImg) markerImg = marker.getElement()?.querySelector('img')
    }
    // 图标随航向旋转：图标素材机头朝北，顺时针旋转 heading 度即为真航向
    if (markerImg && Number.isFinite(pos.heading)) {
      markerImg.style.transform = `rotate(${pos.heading}deg)`
    }

    // 航迹：跳变处断开不连线（服务端已标记 breakBefore，§11）
    if (trackEnabled) {
      if (!currentLine || pos.breakBefore) {
        startNewLine(latlng, pos.breakBefore)
      } else {
        linePoints.push(latlng)
        if (linePoints.length > MAX_LINE_POINTS) linePoints.shift()
        currentLine.setLatLngs(linePoints)
      }
    }
    lastPoint = pos

    if (follow) map.panTo(latlng, { animate: true, duration: 0.5 })
  },

  /** "无飞行"灰色样式切换（§6.6.3）：active=false 置灰、隐藏图标、航迹降透明度 */
  setFlightActive(active) {
    if (!map || active === flightActive) return
    flightActive = active
    const container = map.getContainer()
    container.classList.toggle('map-disabled', !active)
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
    if (!map || !lastPoint) return
    follow = true
    map.setView([lastPoint.lat, lastPoint.lon], Math.max(map.getZoom(), 12))
  },

  /** 页面刷新后用 /api/track 的历史点补画航迹（§5.4） */
  loadTrack(points) {
    if (!map || !Array.isArray(points)) return
    for (const p of points) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue
      const latlng = [p.lat, p.lon]
      if (p.breakBefore || !currentLine) startNewLine(latlng, p.breakBefore)
      else {
        linePoints.push(latlng)
        currentLine.setLatLngs(linePoints)
      }
      lastPoint = p
    }
  },
}

function startNewLine(latlng, isBreak) {
  // 跳变处不连线：直接开一条新线（首点也走这里）
  linePoints = [latlng]
  currentLine = L.polyline(linePoints, {
    color: '#e8442f',
    weight: 3,
    opacity: flightActive ? 0.9 : 0.3,
  }).addTo(map)
  polylines.push(currentLine)
  if (polylines.length > 20) {
    // 最多保留 20 段：过老的整段移除（配合服务端 30 分钟窗口足够）
    const removed = polylines.shift()
    removed.remove()
  }
  void isBreak
}
