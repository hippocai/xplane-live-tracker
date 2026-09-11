// UDP DATA 帧解析单元测试：LE/BE 字节序、字段映射、脏数据防御
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDataPacket, buildPositionFromRows } from '../src/xplane/udpClient.js'

// 构造一个 DATA 包：4 字节头 + 若干组 [int32 行号 + 8×float32]
function makePacket(littleEndian, rows) {
  const groups = []
  for (const [rowIndex, floats] of rows) {
    const buf = Buffer.alloc(36)
    if (littleEndian) {
      buf.writeInt32LE(rowIndex, 0)
      floats.forEach((f, i) => buf.writeFloatLE(f, 4 + i * 4))
    } else {
      buf.writeInt32BE(rowIndex, 0)
      floats.forEach((f, i) => buf.writeFloatBE(f, 4 + i * 4))
    }
    groups.push(buf)
  }
  return Buffer.concat([Buffer.from('DATA', 'ascii'), ...groups])
}

const SAMPLE_ROWS = [
  [18, [35.5, 139.0, 1000, 300, 0, 0, 0, 0]], // lat, lon, altMsl, altAgl
  [20, [-1.5, 4.0, 273.0, 0, 0, 0, 0, 0]], // pitch, roll, heading
  [21, [100, 95, 0, 0, 0, 0, 0, 0]], // tas, ias
  [3, [50, -2, 0, 0, 0, 0, 0, 0]], // vx, vy, vz
]

test('小端包：解析出正确字段与单位换算', () => {
  const parsed = parseDataPacket(makePacket(true, SAMPLE_ROWS))
  assert.ok(parsed)
  const pos = buildPositionFromRows(parsed, 12345)
  assert.equal(pos.lat, 35.5)
  assert.equal(pos.lon, 139.0)
  assert.equal(pos.altMsl, 1000)
  assert.equal(pos.altAgl, 300)
  assert.equal(pos.heading, 273)
  assert.equal(pos.pitch, -1.5)
  assert.equal(pos.roll, 4.0)
  assert.equal(pos.iasKt, 95)
  // 地速 = sqrt(50² + 0²) m/s → kt
  assert.ok(Math.abs(pos.groundSpeedKt - 50 * 1.94384) < 0.01)
  // 垂直速度 = -2 m/s → ft/min
  assert.ok(Math.abs(pos.verticalSpeedFpm - -2 * 3.28084 * 60) < 0.1)
  assert.equal(pos.timestamp, 12345)
  assert.equal(pos.tailNumber, null)
})

test('大端包：同样能正确解析（字节序自适应）', () => {
  const parsed = parseDataPacket(makePacket(false, SAMPLE_ROWS))
  assert.ok(parsed)
  const pos = buildPositionFromRows(parsed, 1)
  assert.equal(pos.lat, 35.5)
  assert.equal(pos.heading, 273)
})

test('非 DATA 头 / 过短包：返回 null（静默丢弃）', () => {
  assert.equal(parseDataPacket(Buffer.from('XXXX____'), 0) ?? null, null)
  assert.equal(parseDataPacket(Buffer.from('DATA')), null)
  assert.equal(parseDataPacket(Buffer.alloc(0)), null)
})

test('行号越界的脏包：返回 null', () => {
  const buf = Buffer.alloc(40)
  buf.write('DATA', 0, 'ascii')
  buf.writeInt32LE(99999, 4)
  assert.equal(parseDataPacket(buf), null)
})

test('经纬度越界（两种字节序都无效）：返回 null', () => {
  const parsed = parseDataPacket(makePacket(true, [[18, [999, -999, 0, 0, 0, 0, 0, 0]]]))
  assert.equal(parsed, null)
})

test('缺经纬度行的包：buildPositionFromRows 返回 null', () => {
  const parsed = parseDataPacket(makePacket(true, [[20, [0, 0, 90, 0, 0, 0, 0, 0]]]))
  assert.ok(parsed)
  assert.equal(buildPositionFromRows(parsed, 1), null)
})
