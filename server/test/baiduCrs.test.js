// public/js/baiduCrs.js 测试：自定义 CRS 的形状与投影往返（数值精度由 geoConvert.test 保证）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBaiduCrs, BAIDU_TILE_URL } from '../../public/js/baiduCrs.js'

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
