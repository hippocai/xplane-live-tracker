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

// —— 百度瓦片 y 轴与 Leaflet 相反（关键坑，2026-09 实证）——
// 本 CRS 的像素 y = -scale·y_MC（北为上），瓦片行号 L = floor(pixel_y/256) 对北半球为负；
// 而百度服务器的 y 以赤道为 0 向北递增（大连/北京实测：z12 北京城 y=+292..296 为真实
// 内容、y=-293 为空白瓦片；y=292 实为大兴青云店 39.65N、y=296 为昌平顺义交界 40.12N，
// 与 floor(y_MC·2^(z-18)/256) 公式吻合）。若不翻转，请求到的全是南半球瓦片——
// 表现为"飞机飘到澳大利亚"。
// 两者的精确关系（y_MC·scale/256 非整数时恒成立）：baidu_y = -leaflet_y - 1
export function baiduTileY(leafletY) {
  return -leafletY - 1
}

/**
 * 创建百度瓦片图层（不能用普通 L.tileLayer 模板：y 需要取负翻转）
 * @param {typeof import('leaflet')} L Leaflet 全局
 */
export function createBaiduTileLayer(L) {
  const BaiduTileLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      return L.Util.template(this._url, {
        s: this._getSubdomain(coords),
        x: coords.x,
        y: baiduTileY(coords.y),
        z: this._getZoomForUrl(),
      })
    },
  })
  return new BaiduTileLayer(BAIDU_TILE_URL, {
    subdomains: BAIDU_TILE_SUBDOMAINS,
    maxZoom: 19,
    attribution: BAIDU_ATTRIBUTION,
  })
}
