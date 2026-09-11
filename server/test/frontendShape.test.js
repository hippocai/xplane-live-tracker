// 前端模块形状冒烟测试。
// 背景：历史 bug —— app.js 以 `import * as map` 后直接调 map.setFlightActive()，
// 但该方法在 initMap() 返回的 api 对象上、不在模块命名空间上，运行时抛
// "map.setFlightActive is not a function"（用户在设置面板保存时踩中）。
// mapController 顶层无 DOM 访问，可在 node 中直接导入做形状断言；
// app.js 顶层会执行 boot()（依赖 document），只能做源码静态检查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mapController from '../../public/js/mapController.js'

const publicJsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
  'js'
)

// app.js 依赖的控制器方法（须存在于 initMap() 返回的 api 对象上）
const API_METHODS = ['updatePosition', 'setFlightActive', 'setFollowMode', 'recenter', 'loadTrack']

test('mapController.api 具备 app.js 依赖的全部方法', () => {
  assert.equal(typeof mapController.initMap, 'function')
  for (const m of API_METHODS) {
    assert.equal(typeof mapController.api[m], 'function', `api.${m} 应为函数`)
  }
})

test('app.js 不通过模块命名空间误调 api 方法（须走 initMap() 返回的实例）', () => {
  const src = readFileSync(path.join(publicJsDir, 'app.js'), 'utf8')
  for (const m of API_METHODS) {
    // 允许 mapApi?.method；禁止 map.method（不会误伤 mapApi.，因为其后是字母不是点）
    assert.ok(
      !new RegExp(`\\bmap\\.${m}\\b`).test(src),
      `app.js 不应调用 map.${m}（这些方法在 initMap() 返回的实例上）`
    )
  }
})
