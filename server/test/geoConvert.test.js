// 地理坐标转换单元测试。
// 投影部分以 proj4（与百度通用插件相同的 Krassovsky 椭球墨卡托定义）为 oracle，
// 验证 public/js/geo.js 的闭式实现与其一致——这是"百度瓦片能否精确对齐"的根基。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import proj4 from 'proj4'
import {
  wgs84ToGcj02,
  wgs84ToBd09,
  bd09ToWgs84,
  bd09LLToMC,
  mcToBd09LL,
  wgs84ToBaiduMC,
  baiduMCToWgs84,
  isMainlandChina,
} from '../../public/js/geo.js'

// 百度通用插件（leaflet-tileLayer-baidugaode 等）使用的百度墨卡托定义
const BAIDU_PROJ =
  '+proj=merc +a=6378206 +b=6356584.314245179 +lat_ts=0.0 +lon_0=0.0 +x_0=0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +no_defs'
const oracle = proj4(BAIDU_PROJ)

// 覆盖中国大陆多个区域 + 境外一点的 BD09 采样点（BD09 值本身，非 WGS84）
const BD09_SAMPLES = [
  { name: '北京', lat: 39.915119, lng: 116.403891 },
  { name: '上海', lat: 31.230371, lng: 121.473704 },
  { name: '广州', lat: 23.129913, lng: 113.264385 },
  { name: '乌鲁木齐', lat: 43.825615, lng: 87.61688 },
  { name: '哈尔滨', lat: 45.803775, lng: 126.534967 },
  { name: '海口', lat: 20.044437, lng: 110.1999 },
]

test('BD09 → 百度墨卡托：与 proj4 oracle 一致（< 0.01 米）', () => {
  for (const p of BD09_SAMPLES) {
    const mine = bd09LLToMC(p.lat, p.lng)
    const [ox, oy] = oracle.forward([p.lng, p.lat])
    assert.ok(
      Math.abs(mine.x - ox) < 0.01 && Math.abs(mine.y - oy) < 0.01,
      `${p.name}: mine=(${mine.x}, ${mine.y}) oracle=(${ox}, ${oy})`,
    )
  }
})

test('墨卡托反投影：MC → BD09 往返误差 < 1e-6 度', () => {
  for (const p of BD09_SAMPLES) {
    const mc = bd09LLToMC(p.lat, p.lng)
    const back = mcToBd09LL(mc.x, mc.y)
    assert.ok(Math.abs(back.lat - p.lat) < 1e-6, `${p.name} lat: ${back.lat} vs ${p.lat}`)
    assert.ok(Math.abs(back.lng - p.lng) < 1e-6, `${p.name} lng: ${back.lng} vs ${p.lng}`)
  }
})

test('经度 ±180 处墨卡托 x = ±a·π（全图范围校验）', () => {
  const { x } = bd09LLToMC(0, 180)
  const expected = 6378206 * Math.PI
  assert.ok(Math.abs(x - expected) < 0.01)
})

test('WGS84 → BD09：偏移量级正确（北京应偏移数百米，即 0.004~0.02 度）', () => {
  const wgs = { lat: 39.907344, lng: 116.391343 } // 北京附近
  const bd = wgs84ToBd09(wgs.lat, wgs.lng)
  const dLat = Math.abs(bd.lat - wgs.lat)
  const dLng = Math.abs(bd.lng - wgs.lng)
  assert.ok(dLat > 0.002 && dLat < 0.02, `dLat=${dLat}`)
  assert.ok(dLng > 0.004 && dLng < 0.02, `dLng=${dLng}`)
})

test('WGS84 → BD09 → WGS84：往返误差 < 5e-4 度（近似逆变换，米级）', () => {
  const wgs = { lat: 31.2304, lng: 121.4737 }
  const bd = wgs84ToBd09(wgs.lat, wgs.lng)
  const back = bd09ToWgs84(bd.lat, bd.lng)
  assert.ok(Math.abs(back.lat - wgs.lat) < 5e-4)
  assert.ok(Math.abs(back.lng - wgs.lng) < 5e-4)
})

test('WGS84 → 百度墨卡托组合投影：与 proj4 链式结果一致', () => {
  // oracle 链：proj4 无法做 GCJ/BD09 纠偏（那是私有基准），因此对比"BD09 经纬度 → MC"环节
  const wgs = { lat: 39.907344, lng: 116.391343 }
  const mine = wgs84ToBaiduMC(wgs.lat, wgs.lng)
  // 用本模块 bd09 结果喂给 oracle，验证组合链与分步链一致
  const bd = wgs84ToBd09(wgs.lat, wgs.lng)
  const [ox, oy] = oracle.forward([bd.lng, bd.lat])
  assert.ok(Math.abs(mine.x - ox) < 0.01)
  assert.ok(Math.abs(mine.y - oy) < 0.01)
  // 反投影回到 WGS84
  const back = baiduMCToWgs84(mine.x, mine.y)
  assert.ok(Math.abs(back.lat - wgs.lat) < 5e-4)
  assert.ok(Math.abs(back.lng - wgs.lng) < 5e-4)
})

test('境外坐标：GCJ 纠偏应原样返回（outOfChina 短路）', () => {
  const p = { lat: 35.6895, lng: 139.6917 } // 东京
  const gcj = wgs84ToGcj02(p.lat, p.lng)
  assert.equal(gcj.lat, p.lat)
  assert.equal(gcj.lng, p.lng)
})

test('isMainlandChina：大陆命中、港澳台排除、境外不命中', () => {
  assert.equal(isMainlandChina(39.9, 116.4), true) // 北京
  assert.equal(isMainlandChina(31.23, 121.47), true) // 上海
  assert.equal(isMainlandChina(20.03, 110.2), true) // 海口（海南属大陆）
  assert.equal(isMainlandChina(45.8, 126.53), true) // 哈尔滨
  assert.equal(isMainlandChina(25.03, 121.56), false) // 台北
  assert.equal(isMainlandChina(22.32, 114.17), false) // 香港
  assert.equal(isMainlandChina(22.19, 113.54), false) // 澳门
  assert.equal(isMainlandChina(35.68, 139.69), false) // 东京
  assert.equal(isMainlandChina(48.86, 2.35), false) // 巴黎
})

test('isMainlandChina margin：迟滞外扩生效', () => {
  // 主矩形南界 18.0：界外一点 margin=0 不命中，margin=0.3 命中
  assert.equal(isMainlandChina(17.9, 110.0), false)
  assert.equal(isMainlandChina(17.9, 110.0, 0.3), true)
})
