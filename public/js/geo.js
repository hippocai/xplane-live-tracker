// 地理坐标纯函数模块（无 DOM 依赖，可直接被 node 单元测试导入）。
//
// X-Plane 输出 WGS-84 坐标；中国大陆的百度地图使用 BD-09 坐标系（且其瓦片
// 采用 Krassovsky 椭球墨卡托投影，与标准 Web Mercator 不同）。直接叠加会
// 偏移数百米。本模块提供：
//   1. WGS84 ⇄ GCJ02 ⇄ BD09 椭球/基准纠偏（公开通行常量，eviltransform/gcoord 同源）
//   2. BD09 经纬度 → 百度墨卡托（BD09MC）闭式投影与反投影
//   3. 中国大陆范围判定（粗矩形 − 港澳台，用于前端底图自动切换）
//
// 投影公式经 server/test/geoConvert.test.js 以 proj4（同椭球参数）作 oracle 验证。

const PI = Math.PI
const GCJ_A = 6378245.0 // GCJ02 纠偏用克拉索夫斯基参考值（通行实现）
const GCJ_EE = 0.006693421622965943

// —— 百度墨卡托（BD09MC）：Krassovsky 椭球 + 椭球墨卡托投影 ——
const MC_A = 6378206.0
const MC_B = 6356584.314245179
const MC_E = Math.sqrt(1 - (MC_B * MC_B) / (MC_A * MC_A)) // 第一偏心率

// —— WGS84 → GCJ02 ——

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

// 粗矩形判定：GCJ02 纠偏仅在中国大陆范围内有意义（通行约定），境外直接原样返回
function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

export function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng }
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * PI)
  return { lat: lat + dLat, lng: lng + dLng }
}

// 近似逆变换（迭代两次），误差在米级——仅用于鼠标事件反投影，足够
export function gcj02ToWgs84(lat, lng) {
  let wgsLat = lat
  let wgsLng = lng
  for (let i = 0; i < 2; i++) {
    const gcj = wgs84ToGcj02(wgsLat, wgsLng)
    wgsLat += lat - gcj.lat
    wgsLng += lng - gcj.lng
  }
  return { lat: wgsLat, lng: wgsLng }
}

// —— GCJ02 ⇄ BD09 ——

// BD09 旋转常量（通行值 0.0000039915519865865656923 的最短双精度表示）
const BD09_THETA = 0.000003991551986586565

export function gcj02ToBd09(lat, lng) {
  const z = Math.sqrt(lng * lng + lat * lat)
  const theta = Math.atan2(lat, lng) + BD09_THETA
  return { lat: z * Math.sin(theta) + 0.006, lng: z * Math.cos(theta) + 0.0065 }
}

export function bd09ToGcj02(lat, lng) {
  const x = lng - 0.0065
  const y = lat - 0.006
  const z = Math.sqrt(x * x + y * y)
  const theta = Math.atan2(y, x) - BD09_THETA
  return { lat: z * Math.sin(theta), lng: z * Math.cos(theta) }
}

// —— WGS84 ⇄ BD09（组合便捷方法）——

export function wgs84ToBd09(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng)
  return gcj02ToBd09(gcj.lat, gcj.lng)
}

export function bd09ToWgs84(lat, lng) {
  const gcj = bd09ToGcj02(lat, lng)
  return gcj02ToWgs84(gcj.lat, gcj.lng)
}

// —— BD09 经纬度 ⇄ 百度墨卡托（Krassovsky 椭球椭球墨卡托，闭式公式）——
// 正算：x = a·λ；y = a·ln[tan(π/4 + φ/2)·((1 − e·sinφ)/(1 + e·sinφ))^(e/2)]
// 反算纬度用不动点迭代（3 次内收敛到 1e-9 度）。

export function bd09LLToMC(lat, lng) {
  const lam = (lng * PI) / 180.0
  const phi = (lat * PI) / 180.0
  const x = MC_A * lam
  const y =
    MC_A *
    Math.log(
      Math.tan(PI / 4 + phi / 2) *
        Math.pow((1 - MC_E * Math.sin(phi)) / (1 + MC_E * Math.sin(phi)), MC_E / 2),
    )
  return { x, y }
}

export function mcToBd09LL(x, y) {
  const q = y / MC_A // 等量纬度
  const lng = ((x / MC_A) * 180.0) / PI
  let phi = 2 * Math.atan(Math.exp(q)) - PI / 2
  for (let i = 0; i < 5; i++) {
    phi =
      2 *
        Math.atan(
          Math.exp(q) * Math.pow((1 + MC_E * Math.sin(phi)) / (1 - MC_E * Math.sin(phi)), MC_E / 2),
        ) -
      PI / 2
  }
  return { lat: (phi * 180.0) / PI, lng }
}

// —— 组合：WGS84（Leaflet 中使用的坐标）⇄ 百度墨卡托 ——
// 注入 CRS 时，Leaflet 全程使用 WGS84 数值，纠偏与投影在本层内部完成。

export function wgs84ToBaiduMC(lat, lng) {
  const bd = wgs84ToBd09(lat, lng)
  return bd09LLToMC(bd.lat, bd.lng)
}

export function baiduMCToWgs84(x, y) {
  const bd = mcToBd09LL(x, y)
  return bd09ToWgs84(bd.lat, bd.lng)
}

// —— 中国大陆范围判定 ——
// 粗矩形近似（够用且无依赖）：主矩形覆盖除南海诸岛外的全部陆域，
// 减去台湾、香港、澳门三个小矩形（与"中国大陆"口径一致）。
// margin 参数用于切换迟滞：margin>0 时主矩形外扩，防止沿海岸线飞行时底图来回抖动。
const MAINLAND_BOX = { latMin: 18.0, latMax: 53.7, lngMin: 73.4, lngMax: 135.1 }
const EXCLUDED_BOXES = [
  { latMin: 21.8, latMax: 25.6, lngMin: 119.5, lngMax: 122.2 }, // 台湾
  { latMin: 22.1, latMax: 22.65, lngMin: 113.75, lngMax: 114.6 }, // 香港
  { latMin: 22.05, latMax: 22.3, lngMin: 113.5, lngMax: 113.7 }, // 澳门
]

export function isMainlandChina(lat, lng, margin = 0) {
  const b = MAINLAND_BOX
  const inside =
    lat >= b.latMin - margin &&
    lat <= b.latMax + margin &&
    lng >= b.lngMin - margin &&
    lng <= b.lngMax + margin
  if (!inside) return false
  for (const e of EXCLUDED_BOXES) {
    if (lat >= e.latMin && lat <= e.latMax && lng >= e.lngMin && lng <= e.lngMax) return false
  }
  return true
}

/** 两点大圆距离（km），供图层按视野半径取数。支持 {lat,lng} 与 {lat,lon} 两种形态 */
export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180
  const lng = (p) => (p.lng !== undefined ? p.lng : p.lon)
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(lng(b) - lng(a))
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)))
}
