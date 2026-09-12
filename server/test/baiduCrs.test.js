// public/js/baiduCrs.js 测试：自定义 CRS 形状、投影往返、瓦片 y 轴翻转
// （数值精度由 geoConvert.test 以 proj4 oracle 保证）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBaiduCrs,
  createBaiduTileLayer,
  baiduTileY,
  BAIDU_TILE_URL,
} from '../../public/js/baiduCrs.js'

// createBaiduCrs(L) 只用到 L 的这几个成员，用最小替身即可
const L = {
  CRS: { Earth: { code: 'L.CRS.Earth' } },
  Transformation: class {
    constructor(a, b, c, d) {
      this.k = [a, b, c, d]
    }
  },
  point: (x, y) => ({ x, y }),
  bounds: (a, b) => ({ min: a, max: b }),
  latLng: (lat, lng) => ({ lat, lng }),
}

test('CRS 形状：code / transformation / scale / zoom（百度瓦片 2^(18-z) 分辨率）', () => {
  const crs = createBaiduCrs(L)
  assert.equal(crs.code, 'Baidu')
  assert.deepEqual(crs.transformation.k, [1, 0, -1, 0])
  assert.equal(crs.scale(18), 1)
  assert.equal(crs.scale(3), Math.pow(2, -15))
  assert.equal(crs.zoom(1), 18)
  assert.ok(crs.projection.bounds)
})

test('project/unproject 往返：WGS84 → 墨卡托 → WGS84（< 5e-4 度，米级）', () => {
  const crs = createBaiduCrs(L)
  const samples = [
    { lat: 31.2304, lng: 121.4737 }, // 上海
    { lat: 39.9073, lng: 116.3913 }, // 北京
  ]
  for (const s of samples) {
    const p = crs.projection.project({ lat: s.lat, lng: s.lng })
    const back = crs.projection.unproject(p)
    assert.ok(Math.abs(back.lat - s.lat) < 5e-4, `lat: ${back.lat} vs ${s.lat}`)
    assert.ok(Math.abs(back.lng - s.lng) < 5e-4, `lng: ${back.lng} vs ${s.lng}`)
  }
})

test('百度瓦片 URL 为免 AK 地址', () => {
  assert.ok(BAIDU_TILE_URL.includes('bdimg.com'))
  assert.ok(BAIDU_TILE_URL.includes('qt=tile'))
})

test('baiduTileY：百度瓦片 y = -leaflet_y - 1（y 轴方向相反）', () => {
  // 北京 z12：Leaflet 北半球 y 为负（-293），百度 y 为正（292）。
  // 不翻转时请求到的是南半球瓦片——即用户报告的"飞机飘到澳大利亚"。
  assert.equal(baiduTileY(-293), 292)
  assert.equal(baiduTileY(-1), 0)
  assert.equal(baiduTileY(0), -1)
  assert.equal(baiduTileY(1131), -1132)
})

test('createBaiduTileLayer：getTileUrl 输出翻转后的 y，x/z 原样', () => {
  const L2 = {
    Util: {
      template: (url, data) => url.replace(/\{(\w+)\}/g, (m, k) => data[k] ?? m),
    },
    TileLayer: {
      extend(proto) {
        return function FakeTileLayer(url, options) {
          this._url = url
          this.options = options
          this._getSubdomain = () => '1'
          this._getZoomForUrl = () => 12
          this.getTileUrl = proto.getTileUrl
        }
      },
    },
  }
  const layer = createBaiduTileLayer(L2)
  const url = layer.getTileUrl({ x: 791, y: -293 })
  assert.ok(url.includes('maponline1.bdimg.com'), url)
  assert.ok(url.includes('x=791'), url)
  assert.ok(url.includes('y=292'), url)
  assert.ok(url.includes('z=12'), url)
})
