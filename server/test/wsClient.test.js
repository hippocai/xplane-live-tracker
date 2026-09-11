// public/js/wsClient.js 测试：握手、消息分发、断线重连、鉴权失败停止重连、reopen。
// 用可控的 MockWebSocket 替代全局 WebSocket，测试驱动 open/message/close 事件。
// 教训（本文件第一版踩过）：若断言失败时未清理 connect() 建立的 25s ping
// setInterval，测试进程会因泄漏的定时器永不退出——因此每个用例都用 t.after 兜底 close()。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from '../../public/js/wsClient.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class MockWS {
  // 与浏览器 WebSocket 对齐的 readyState 常量（wsClient.send 用 WebSocket.OPEN 判断）
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this._closed = false
    MockWS.instances.push(this)
  }
  send(d) {
    this.sent.push(JSON.parse(d))
  }
  close() {
    if (this._closed) return
    this._closed = true
    this.readyState = 3
    this.onclose?.()
  }
  // —— 测试驱动 ——
  fireOpen() {
    this.readyState = 1
    this.onopen?.()
  }
  fireMessage(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  fireClose() {
    this._closed = true
    this.readyState = 3
    this.onclose?.()
  }
}

function setup() {
  MockWS.instances = []
  globalThis.location = { protocol: 'http:', host: 'backend.local:3000' }
  globalThis.WebSocket = MockWS
}

/** connect + 注册兜底清理，返回 { handle } */
function connectWithCleanup(t, handlers = {}) {
  const handle = connect(handlers)
  t.after(() => handle.close())
  return handle
}

test('连接建立即发 hello（携带 token），URL 按 location 拼接', (t) => {
  setup()
  connectWithCleanup(t, { onOpen: () => {}, getToken: () => 'abc' })
  const ws = MockWS.instances[0]
  assert.equal(ws.url, 'ws://backend.local:3000/ws')
  ws.fireOpen()
  assert.equal(ws.sent[0].type, 'hello')
  assert.equal(ws.sent[0].token, 'abc')
})

test('position / xplane_status 消息正确分发；未知类型与非法 JSON 被忽略', (t) => {
  setup()
  const got = { position: null, status: null }
  connectWithCleanup(t, {
    onPosition: (d) => (got.position = d),
    onStatus: (d) => (got.status = d),
  })
  const ws = MockWS.instances[0]
  ws.fireOpen()
  ws.fireMessage({ type: 'position', data: { lat: 1, lon: 2 } })
  ws.fireMessage({ type: 'xplane_status', data: { connected: true, flightActive: true } })
  ws.fireMessage({ type: 'unknown-ignored', data: {} })
  ws.onmessage({ data: '{invalid json' })
  assert.deepEqual(got.position, { lat: 1, lon: 2 })
  assert.deepEqual(got.status, { connected: true, flightActive: true })
})

test('意外断线：回调 onClose 并在退避后自动重连', async (t) => {
  setup()
  let closed = 0
  connectWithCleanup(t, { onClose: () => closed++ })
  const ws = MockWS.instances[0]
  ws.fireOpen()
  ws.fireClose()
  assert.equal(closed, 1)
  await sleep(1150) // 首个退避 1s
  assert.equal(MockWS.instances.length, 2, '应已重建连接')
  MockWS.instances[1].fireOpen()
  assert.equal(MockWS.instances[1].sent[0].type, 'hello')
})

test('auth_required：触发回调、停止自动重连，reopen 后重新握手', async (t) => {
  setup()
  let authReq = 0
  const handle = connectWithCleanup(t, { onAuthRequired: () => authReq++ })
  const ws = MockWS.instances[0]
  ws.fireOpen()
  ws.fireMessage({ type: 'auth_required', data: { reason: 'token 无效或缺失' } })
  assert.equal(authReq, 1)
  assert.equal(ws.readyState, 3, '口令被拒后客户端应主动断开')
  await sleep(1150)
  assert.equal(MockWS.instances.length, 1, '口令被拒后不应自动重连')
  // 用户重新输入口令后 reopen
  handle.reopen()
  assert.equal(MockWS.instances.length, 2)
  MockWS.instances[1].fireOpen()
  assert.equal(MockWS.instances[1].sent[0].type, 'hello')
})

test('send：连接打开时可用（ping 心跳通道）', (t) => {
  setup()
  const handle = connectWithCleanup(t, {})
  const ws = MockWS.instances[0]
  ws.fireOpen()
  handle.send({ type: 'ping' })
  assert.equal(ws.sent.at(-1).type, 'ping')
})
