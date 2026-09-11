// configStore 单元测试：默认生成、合并写盘、损坏回退（§15.3.2 验收标准）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  loadConfig,
  saveConfig,
  getConfig,
  setConfigFilePathForTests,
} from '../src/utils/configStore.js'

let tmpDir

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'xplt-config-'))
  setConfigFilePathForTests(path.join(tmpDir, 'config.json'))
})

test('首次 loadConfig：config.json 不存在时生成默认配置', async () => {
  const cfg = await loadConfig()
  assert.equal(cfg.activeMode, 'webapi')
  assert.equal(cfg.webapi.port, 8086)
  assert.equal(cfg.udp.listenPort, 49005)
  assert.ok(existsSync(path.join(tmpDir, 'config.json')))
})

test('saveConfig 合并写入并持久化；重启（重新 load）后仍保留', async () => {
  await loadConfig()
  const next = await saveConfig({ activeMode: 'udp', udp: { listenPort: 49006 } })
  assert.equal(next.activeMode, 'udp')
  assert.equal(next.udp.listenPort, 49006)
  // 模拟重启：清内存后重新读取
  setConfigFilePathForTests(path.join(tmpDir, 'config.json'))
  const reloaded = await loadConfig()
  assert.equal(reloaded.activeMode, 'udp')
  assert.equal(reloaded.udp.listenPort, 49006)
  // 未触及的字段保持不变
  assert.equal(reloaded.webapi.host, '127.0.0.1')
})

test('只持久化运行时键，.env 专属项（port/密钥）不落盘', async () => {
  await loadConfig()
  await saveConfig({ activeMode: 'udp' })
  const raw = JSON.parse(readFileSync(path.join(tmpDir, 'config.json'), 'utf8'))
  assert.ok(!('port' in raw))
  assert.ok(!('accessToken' in raw))
  assert.ok(!('googleMapsApiKey' in raw))
})

test('config.json 被改坏：备份为 .bak 并回退默认配置，不抛异常', async () => {
  await loadConfig()
  await saveConfig({ activeMode: 'udp' })
  // 手动写坏文件
  writeFileSync(path.join(tmpDir, 'config.json'), '{ this is not json', 'utf8')
  setConfigFilePathForTests(path.join(tmpDir, 'config.json'))
  const cfg = await loadConfig()
  assert.equal(cfg.activeMode, 'webapi') // 回退默认
  // 坏文件已备份
  assert.ok(readFileSync(path.join(tmpDir, 'config.json.bak'), 'utf8').includes('not json'))
})

test('getConfig 同步读取内存配置；未加载时返回默认快照', () => {
  const cfg = getConfig()
  assert.equal(cfg.activeMode, 'webapi')
})

test('临时目录清理', () => {
  rmSync(tmpDir, { recursive: true, force: true })
})
