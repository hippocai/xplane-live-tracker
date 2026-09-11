// trackStore 单元测试：过期淘汰、跳变标记、清空
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as trackStore from '../src/utils/trackStore.js'

beforeEach(() => {
  trackStore.clear()
  trackStore.configure({ trackMaxMinutes: 30 })
})

test('push/getRecent：正常点全部保留', () => {
  const now = Date.now()
  trackStore.push({ lat: 1, lon: 1, timestamp: now })
  trackStore.push({ lat: 1.001, lon: 1, timestamp: now + 1000 })
  trackStore.push({ lat: 1.002, lon: 1, timestamp: now + 2000 })
  assert.equal(trackStore.getRecent(5).length, 3)
})

test('过期点被自动淘汰（环形缓冲）', () => {
  trackStore.configure({ trackMaxMinutes: 1 })
  const now = Date.now()
  trackStore.push({ lat: 1, lon: 1, timestamp: now - 10 * 60 * 1000 }) // 10 分钟前，超出 1 分钟窗口
  trackStore.push({ lat: 1.0001, lon: 1, timestamp: now })
  const recent = trackStore.getRecent(1)
  assert.equal(recent.length, 1)
  assert.equal(recent[0].lat, 1.0001)
})

test('teleport 跳变：相邻两点隐含速度超阈值时标记 breakBefore', () => {
  const now = Date.now()
  trackStore.push({ lat: 0, lon: 0, timestamp: now })
  // 1 秒内跨 1 个经度（赤道处约 111km → 40 万 km/h），必为跳变
  const jumped = { lat: 0, lon: 1, timestamp: now + 1000 }
  trackStore.push(jumped)
  const recent = trackStore.getRecent(5)
  assert.equal(recent.length, 2)
  assert.equal(recent[1].breakBefore, true)
})

test('正常飞行速度不会误标 breakBefore', () => {
  const now = Date.now()
  trackStore.push({ lat: 0, lon: 0, timestamp: now })
  // 1 秒移动 0.001 度 ≈ 111m → 400km/h，真实飞机可达，不标记
  trackStore.push({ lat: 0.001, lon: 0, timestamp: now + 1000 })
  const recent = trackStore.getRecent(5)
  assert.equal(recent[1].breakBefore, undefined)
})

test('clear 清空全部航迹', () => {
  trackStore.push({ lat: 1, lon: 1, timestamp: Date.now() })
  trackStore.clear()
  assert.equal(trackStore.getRecent(30).length, 0)
})
