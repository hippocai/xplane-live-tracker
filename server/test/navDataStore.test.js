// navDataStore 纯函数测试：aptmeta/apt.dat / earth_nav.dat / earth_fix.dat 解析 + 空间查询
// 类型码与列序按真实安装实测（XP1200 Navigraph 数据，见 navDataStore.js 注释）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAptContent,
  parseAptMetaContent,
  parseNavContent,
  parseFixContent,
  queryPoints,
  PER_TYPE_LIMIT,
} from '../src/utils/navDataStore.js'

test('apt.dat：1302 行取机场基准点，含名称/ICAO', () => {
  const apt = parseAptContent(
    [
      'I',
      '1100 Version 12.00 data',
      '1 ZBAA 1 0 1 Beijing Capital Intl',
      '1302 40.08011100 116.58455600 apt_ref',
      '100 60 1 0 0.25 0 0 0 0 1 40.05 116.58 0 39.97 116.62 0',
      '1 ZBAD 1 0 0 Beijing Daxing Intl',
      '1302 39.50980700 116.41051300 apt_ref',
    ].join('\n'),
  )
  assert.equal(apt.length, 2)
  assert.equal(apt[0].ident, 'ZBAA')
  assert.equal(apt[0].name, 'Beijing Capital Intl')
  assert.equal(apt[0].lat, 40.080111)
  assert.equal(apt[0].type, 'airport')
  assert.equal(apt[1].ident, 'ZBAD')
})

test('apt.dat：无 1302 时回退到首条跑道的经纬度；直升机坪也收录', () => {
  const apt = parseAptContent(
    [
      'I',
      '1 KJFK 1 0 1 John F Kennedy Intl',
      '100 150 1 0 0.25 0 0 0 0 0 40.63980100 -73.77890000 13 0 40.62120100 -73.76699300 11 0',
      '17 BJHeli 0 0 1 Beijing Heliport',
      '1302 39.9 116.4 apt_ref',
    ].join('\n'),
  )
  assert.equal(apt.length, 2)
  // KJFK 无 1302 → 跑道兜底取到第一对合法经纬度
  assert.ok(Math.abs(apt[0].lat - 40.639801) < 1e-6, `lat=${apt[0].lat}`)
  assert.ok(Math.abs(apt[0].lon - -73.7789) < 1e-6)
  assert.equal(apt[1].ident, 'BJHeli')
})

test('apt.dat：全程没有坐标的机场被丢弃', () => {
  const apt = parseAptContent(
    'I\n1 NOPOS 1 0 1 Nowhere Field\n1 ZBAD 1 0 0 Daxing\n1302 39.5 116.4 apt_ref',
  )
  assert.equal(apt.length, 1)
  assert.equal(apt[0].ident, 'ZBAD')
})

test('earth_aptmeta.dat（XP12 机场元数据）：取 ICAO 与坐标，无名称列', () => {
  const apt = parseAptMetaContent(
    [
      'I',
      '1210 Version - data cycle 2608, build 20260727, metadata AptXP1210.',
      '00AN PA  59.093472222 -156.455833333    80 P  4500 0 18000 FL180',
      'ZBAA ZB  40.080111000 116.584556000   116 C  3800 1 18000 FL180',
      '99',
    ].join('\n'),
  )
  assert.equal(apt.length, 2)
  assert.equal(apt[0].ident, '00AN')
  assert.ok(Math.abs(apt[0].lat - 59.093472222) < 1e-9)
  assert.ok(Math.abs(apt[0].lon - -156.455833333) < 1e-9)
  assert.equal(apt[1].ident, 'ZBAA')
})

test('earth_nav.dat：类型码实测语义（2=NDB、3=VOR；DME/ILS/GS/信标跳过），名称去掉 ENRT 与国家码', () => {
  const nav = parseNavContent(
    [
      'I',
      '1200 Version - data cycle 2406, metadata NavXP1200.',
      ' 3   9.037805556    7.285111111  1191  11630  130  -0.000  ABC ENRT DN ABUJA VOR/DME',
      ' 2  37.619553000 -122.363875000     0    387   25  15.000  SQ  ENRT US SQL NDB',
      '12   9.037805556    7.285111111  1191  11630  130   0.000  ABC ENRT DN ABUJA VOR/DME DME',
      ' 4  11.549222222   43.154861111    40  11460  130   2.000  ABI ENRT HD DJIBOUTI TACAN',
      '99 0 0 0 0 0 0 0 END',
    ].join('\n'),
  )
  assert.equal(nav.length, 2)
  assert.equal(nav[0].kind, 'vor')
  assert.equal(nav[0].ident, 'ABC')
  assert.equal(nav[0].name, 'ABUJA VOR/DME', '应去掉 ENRT 与国家码前缀')
  assert.equal(nav[1].kind, 'ndb')
  assert.equal(nav[1].ident, 'SQ')
  assert.equal(nav[1].name, 'SQL NDB')
})

test('earth_fix.dat：实测列序为"纬度 经度 名称"，头尾行被经纬度范围校验过滤', () => {
  const fixes = parseFixContent(
    [
      'I',
      '1200 Version - data cycle 2406, metadata FixXP1200.',
      ' 39.916666667  116.083333333  BAWLR ENRT ZB 2115159',
      '99 END OF FILE',
    ].join('\n'),
  )
  assert.equal(fixes.length, 1)
  assert.equal(fixes[0].ident, 'BAWLR')
  assert.equal(fixes[0].type, 'fix')
  assert.ok(Math.abs(fixes[0].lat - 39.916666667) < 1e-9)
})

test('queryPoints：半径过滤、类型过滤、按距离升序', () => {
  const data = {
    airport: [
      { type: 'airport', ident: 'A1', name: '', lat: 40.0, lon: 116.0 },
      { type: 'airport', ident: 'A2', name: '', lat: 40.5, lon: 116.0 }, // ~56km
      { type: 'airport', ident: 'FAR', name: '', lat: 10.0, lon: 100.0 }, // 圈外
    ],
    navaid: [{ type: 'navaid', kind: 'vor', ident: 'V1', name: '', lat: 39.9, lon: 116.1 }],
    fix: [],
  }
  const r1 = queryPoints(data, { lat: 40.0, lon: 116.0, radiusKm: 100 })
  assert.equal(r1.points.length, 3) // A1 A2 V1；FAR 圈外
  assert.ok(r1.points[0].distKm <= r1.points[1].distKm, '应按距离升序')
  const r2 = queryPoints(data, { lat: 40.0, lon: 116.0, radiusKm: 100, types: ['airport'] })
  assert.equal(r2.points.length, 2)
  assert.ok(r2.points.every((p) => p.type === 'airport'))
})

test('queryPoints：单类超过上限截断并标记 truncated', () => {
  const airports = []
  for (let i = 0; i < PER_TYPE_LIMIT + 5; i++) {
    airports.push({ type: 'airport', ident: `A${i}`, name: '', lat: 40 + i * 0.01, lon: 116 })
  }
  const r = queryPoints(
    { airport: airports, navaid: [], fix: [] },
    { lat: 40, lon: 116, radiusKm: 800 },
  )
  assert.equal(r.points.length, PER_TYPE_LIMIT)
  assert.equal(r.truncated, true)
  // 半径参数会被钳制到上限 800
  assert.ok(r.points.every((p) => p.distKm <= 800.5))
})
