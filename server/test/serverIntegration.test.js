// 服务端集成测试：spawn 真实的 server/src/index.js（独立端口），
// 覆盖全部 REST 接口的形状/校验/截断行为与 WebSocket 协议（hello 回放 / ping-pong）。
// 说明：X-Plane 不可达属于预期初始状态（T1），连接重试在后台进行不影响断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 3199
const BASE = `http://127.0.0.1:${PORT}`
const CONFIG_PATH = path.join(rootDir, 'config.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForReady(timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/status`)
      if (res.ok) return
    } catch {
      /* 尚未开始监听 */
    }
    await sleep(200)
  }
  throw new Error('服务启动超时')
}

async function getJson(pathname) {
  const res = await fetch(BASE + pathname)
  return { status: res.status, data: await res.json() }
}

async function postJson(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

test('REST 接口与 WS 协议（真实进程）', async (t) => {
  // 用 env 默认值启动：先移除可能残留的 config.json，保证 activeMode=webapi 等初始值确定
  rmSync(CONFIG_PATH, { force: true })
  const child = spawn(process.execPath, ['server/src/index.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      XPLANE_MODE: 'webapi',
      // 隔离：把 X-Plane Web API 指到一个必然无人监听的端口，避免测试进程
      // 连上开发机上真实运行的 X-Plane（会导致 connected 断言不稳定）
      XPLANE_WEBAPI_PORT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // 消费输出避免管道缓冲阻塞
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  t.after(async () => {
    child.kill()
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    rmSync(CONFIG_PATH, { force: true }) // 不把测试生成的配置留在仓库
  })

  await waitForReady()

  // —— GET /api/status（T1：无 X-Plane 不崩溃，状态正确）——
  const status = await getJson('/api/status')
  assert.equal(status.status, 200)
  assert.equal(status.data.activeMode, 'webapi')
  assert.equal(status.data.connected, false)
  assert.equal(status.data.flightActive, false)

  // —— GET /api/config ——
  const config = await getJson('/api/config')
  assert.equal(config.status, 200)
  assert.equal(config.data.mapProvider, 'osm')
  assert.equal(config.data.authRequired, false)
  assert.equal(config.data.updateHz, 2)
  assert.equal(config.data.trackMaxMinutes, 30)
  assert.ok(Array.isArray(config.data.lanUrls))

  // —— GET /api/xplane-mode：全量状态形状 ——
  const mode = await getJson('/api/xplane-mode')
  assert.equal(mode.status, 200)
  assert.equal(mode.data.activeMode, 'webapi')
  assert.equal(mode.data.webapi.host, '127.0.0.1')
  assert.equal(mode.data.webapi.port, 1, '应使用隔离 env 指定的端口（见 spawn env）')
  assert.equal(mode.data.udp.listenPort, 49005)
  assert.equal(typeof mode.data.flightStaleTimeoutMs, 'number')

  // —— POST /api/xplane-mode：非法模式 400 ——
  const bad = await postJson('/api/xplane-mode', { activeMode: 'bogus' })
  assert.equal(bad.status, 400)
  assert.equal(bad.data.error.code, 'INVALID_PARAMS')

  // —— POST /api/xplane-mode：非法端口 400 ——
  const badPort = await postJson('/api/xplane-mode', { activeMode: 'udp', udp: { listenPort: 0 } })
  assert.equal(badPort.status, 400)
  assert.equal(badPort.data.error.code, 'INVALID_PARAMS')

  // —— POST /api/xplane-mode：同模式同参数幂等成功（不引发连接扰动）——
  const idem = await postJson('/api/xplane-mode', { activeMode: 'webapi' })
  assert.equal(idem.status, 200)
  assert.equal(idem.data.activeMode, 'webapi')

  // —— GET /api/track：minutes 非法/越界截断而非报错 ——
  const t1 = await getJson('/api/track?minutes=9999')
  assert.equal(t1.data.minutes, 30)
  const t2 = await getJson('/api/track?minutes=abc')
  assert.equal(t2.data.minutes, 30)
  const t3 = await getJson('/api/track?minutes=5')
  assert.equal(t3.data.minutes, 5)
  assert.ok(Array.isArray(t3.data.points))

  // —— 导航图层接口：形状与参数校验（是否加载取决于本机是否有 X-Plane）——
  const nav = await getJson('/api/navpoints?lat=40&lon=116&radiusKm=100&types=airport')
  assert.equal(nav.status, 200)
  assert.ok(Array.isArray(nav.data.points))
  assert.equal(typeof nav.data.loaded, 'boolean')
  assert.ok('counts' in nav.data)
  const navBad = await getJson('/api/navpoints?lat=abc&lon=116')
  assert.equal(navBad.status, 400)
  assert.equal(navBad.data.error.code, 'INVALID_PARAMS')
  const navCfg = await getJson('/api/nav-config')
  assert.equal(navCfg.status, 200)
  assert.ok('loaded' in navCfg.data && 'xplanePath' in navCfg.data)

  // —— 静态首页 ——
  const page = await fetch(`${BASE}/`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(html.includes('X-Plane Live Tracker'))

  // —— WebSocket：hello 立即回放当前状态；ping → pong ——
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const received = []
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  ws.send(JSON.stringify({ type: 'hello' }))
  await sleep(300)
  const statusMsg = received.find((m) => m.type === 'xplane_status')
  assert.ok(statusMsg, 'hello 应立即收到 xplane_status')
  assert.equal(statusMsg.data.activeMode, 'webapi')
  ws.send(JSON.stringify({ type: 'ping' }))
  await sleep(300)
  assert.ok(
    received.some((m) => m.type === 'pong'),
    'ping 应收到 pong',
  )
  ws.close()
})
