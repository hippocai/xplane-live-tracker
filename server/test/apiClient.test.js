// public/js/api.js 测试：REST 封装的 token 携带、请求头、错误形状
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { api, getToken, saveToken } from '../../public/js/api.js'

const calls = []
let respond

beforeEach(() => {
  calls.length = 0
  globalThis.localStorage = {
    _s: {},
    getItem(k) {
      return this._s[k] ?? null
    },
    setItem(k, v) {
      this._s[k] = String(v)
    },
  }
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return respond
  }
})

test('GET 成功：返回解析后的 JSON，未存 token 时不带鉴权头', async () => {
  respond = { ok: true, status: 200, json: async () => ({ activeMode: 'webapi' }) }
  const data = await api('/api/status')
  assert.equal(data.activeMode, 'webapi')
  assert.equal(calls[0].input, '/api/status')
  assert.equal(calls[0].init.headers['x-access-token'], undefined)
})

test('localStorage 已存 token：请求自动携带 x-access-token', async () => {
  saveToken('t1')
  respond = { ok: true, status: 200, json: async () => ({}) }
  await api('/api/status')
  assert.equal(calls[0].init.headers['x-access-token'], 't1')
})

test('POST：自动设置 content-type 并透传 body', async () => {
  respond = { ok: true, status: 200, json: async () => ({}) }
  await api('/api/xplane-mode', { method: 'POST', body: JSON.stringify({ activeMode: 'udp' }) })
  const c = calls[0]
  assert.equal(c.init.method, 'POST')
  assert.equal(c.init.headers['content-type'], 'application/json')
  assert.equal(c.init.body, JSON.stringify({ activeMode: 'udp' }))
})

test('非 2xx：抛出带 code 与 message 的错误', async () => {
  respond = {
    ok: false,
    status: 401,
    json: async () => ({ error: { code: 'UNAUTHORIZED', message: '访问口令缺失或不正确' } }),
  }
  await assert.rejects(
    api('/api/status'),
    (err) => err.code === 'UNAUTHORIZED' && err.message === '访问口令缺失或不正确',
  )
})

test('非 2xx 且响应体非 JSON：仍抛出含状态码信息的错误', async () => {
  respond = {
    ok: false,
    status: 502,
    json: async () => {
      throw new Error('bad json')
    },
  }
  await assert.rejects(api('/x'), (err) => err.message.includes('502'))
})

test('localStorage 不可用时 getToken 返回 null 而不抛错', () => {
  globalThis.localStorage = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {},
  }
  assert.equal(getToken(), null)
})
