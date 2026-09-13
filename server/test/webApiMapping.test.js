// Web API 数值映射单元测试：id→字段、单位换算、字符串 dataref、缺失字段
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPositionFromValues, DATAREF_SPECS } from '../src/xplane/webApiClient.js'

function makeIdToField() {
  // 按 DATAREF_SPECS 顺序构造 id: 1..n 的映射（模拟 connect() 解析结果）
  const m = new Map()
  DATAREF_SPECS.forEach((spec, i) => m.set(i + 1, spec))
  return m
}

test('values 数组 → AircraftPosition，含 m/s→kt 换算', () => {
  const idToField = makeIdToField()
  const values = [
    { id: 1, value: 35.5 }, // latitude
    { id: 2, value: 139.0 }, // longitude
    { id: 3, value: 1000 }, // elevation m
    { id: 4, value: 300 }, // y_agl m
    { id: 5, value: 273 }, // psi
    { id: 6, value: 50 }, // groundspeed m/s → 97.19 kt
    { id: 8, value: 4.5 }, // phi roll
    { id: 9, value: -1.2 }, // theta pitch
    { id: 10, value: -320 }, // vh_ind fpm
  ]
  const pos = buildPositionFromValues(idToField, values, 777)
  assert.equal(pos.lat, 35.5)
  assert.equal(pos.altMsl, 1000)
  assert.equal(pos.heading, 273)
  assert.ok(Math.abs(pos.groundSpeedKt - 97.192) < 0.01)
  assert.equal(pos.verticalSpeedFpm, -320)
  assert.equal(pos.roll, 4.5)
  assert.equal(pos.timestamp, 777)
  assert.equal(pos.tailNumber, null) // 未推送 → null
})

test('可选字段缺失：置 null 而不影响其余字段（§15.3.3 边界情况）', () => {
  const pos = buildPositionFromValues(
    makeIdToField(),
    [
      { id: 1, value: 10 },
      { id: 2, value: 20 },
    ],
    1,
  )
  assert.equal(pos.lat, 10)
  assert.equal(pos.lon, 20)
  assert.equal(pos.altMsl, null)
  assert.equal(pos.heading, null)
})

test('经纬度缺失或非数值：返回 null（无有效帧）', () => {
  assert.equal(buildPositionFromValues(makeIdToField(), [{ id: 3, value: 1 }], 1), null)
  assert.equal(
    buildPositionFromValues(
      makeIdToField(),
      [
        { id: 1, value: 'NaN' },
        { id: 2, value: 2 },
      ],
      1,
    ),
    null,
  )
})

test('对象映射形态的 values（以 id 为键）也能解析', () => {
  const pos = buildPositionFromValues(makeIdToField(), { 1: 12.34, 2: 56.78 }, 1)
  assert.equal(pos.lat, 12.34)
  assert.equal(pos.lon, 56.78)
})

test('字符串型 dataref：char 数组 → 注册号字符串', () => {
  const pos = buildPositionFromValues(
    makeIdToField(),
    [
      { id: 1, value: 1 },
      { id: 2, value: 2 },
      { id: 11, value: [78, 49, 50, 51, 52, 53, 0] }, // "N12345" + 结尾 NUL
    ],
    1,
  )
  assert.equal(pos.tailNumber, 'N12345')
})

test('官方真实协议形态：Map 值表 + 大数字 id + base64 注册号（value_type data）', () => {
  const BIG = 2349669257976 // 实测真机 dataref id 量级（>int32，<2^53 精确）
  const idToField = new Map()
  idToField.set(BIG, DATAREF_SPECS[0]) // latitude
  idToField.set(BIG + 1, DATAREF_SPECS[1]) // longitude
  idToField.set(BIG + 10, DATAREF_SPECS[10]) // acf_tailnum
  const values = new Map([
    [BIG, 30.803722],
    [BIG + 1, 104.123456],
    [BIG + 10, Buffer.from('B-20AC', 'ascii').toString('base64')],
  ])
  const pos = buildPositionFromValues(idToField, values, 1)
  assert.equal(pos.lat, 30.803722)
  assert.equal(pos.lon, 104.123456)
  assert.equal(pos.tailNumber, 'B-20AC')
})

test('增量推送语义：Map 里只有部分字段变化时，缺失字段置 null（客户端负责跨帧合并）', () => {
  const idToField = makeIdToField()
  // 只有高度在变（真实服务器只推变化的字段）
  const partial = new Map([
    [1, 31.2],
    [2, 121.5],
    [3, 5000],
  ])
  const pos = buildPositionFromValues(idToField, partial, 1)
  assert.equal(pos.altMsl, 5000)
  assert.equal(pos.heading, null, '未推送的字段应为 null 而非报错')
})
