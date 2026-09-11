// 百度瓦片用的 Leaflet 自定义 CRS。
// 等价于通用方案"Proj4Leaflet + +proj=merc +a=6378206 +b=6356584.314245179，
// resolutions 2^(18-z)，origin [0,0]"，但不引入 proj4 运行时依赖：
// 投影数学在 ./geo.js 中闭式实现（有 proj4 oracle 单测保证一致）。
// 与通用插件的关键差异：project/unproject 在内部完成 WGS84→BD09 纠偏，
// 因此调用方（标记/航迹/视图）全程使用 WGS84 数值即可与瓦片精确对齐。
import { wgs84ToBaiduMC, baiduMCToWgs84 } from './geo.js'

// 百度墨卡托全图范围：x = a·π ≈ ±20037508.34，y 同量级
const MC_HALF = 20037508.342789244

export function createBaiduCrs(L) {
  return Object.assign({}, L.CRS.Earth, {
    code: 'Baidu',
    projection: {
      project(latlng) {
        const { x, y } = wgs84ToBaiduMC(latlng.lat, latlng.lng)
        return L.point(x, y)
      },
      unproject(point) {
        const { lat, lng } = baiduMCToWgs84(point.x, point.y)
        return L.latLng(lat, lng)
      },
      bounds: L.bounds(L.point(-MC_HALF, -MC_HALF), L.point(MC_HALF, MC_HALF)),
    },
    // y 翻转（北向上）+ 米 → 像素。百度瓦片：z 级分辨率 = 2^(18-z) 米/像素
    transformation: new L.Transformation(1, 0, -1, 0),
    scale(zoom) {
      return Math.pow(2, zoom - 18)
    },
    zoom(scale) {
      return Math.log(scale) / Math.LN2 + 18
    },
  })
}

// 百度免 AK 瓦片（BD-09 矢量底图）。scaler=1 提高清晰度。
export const BAIDU_TILE_URL =
  'https://maponline{s}.bdimg.com/onlinelabel/?qt=tile&x={x}&y={y}&z={z}&styles=pl&scaler=1&p=1'
export const BAIDU_TILE_SUBDOMAINS = '0123'
export const BAIDU_ATTRIBUTION = '&copy; <a href="https://map.baidu.com">百度地图</a>'
