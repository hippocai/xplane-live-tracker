// X-Plane 协议模拟器 —— 在没有真实 X-Plane 的环境下联调后端与前端。
//
// 模拟两种协议（与 design_specs.md §4 对应）：
//   A. Web API：GET /api/v2/capabilities、GET /api/v2/datarefs?filter[name]=...、
//      WS /api/v2/ws 上的 dataref_subscribe_values / dataref_values 推送
//   B. UDP：DATA 帧广播（行 18 经纬高度 / 20 姿态航向 / 21 速度 / 3 速度分量），
//      小端编码（后端 udpClient 有大小端自适应，LE 为现代 X-Plane 实际行为）
//
// 用法：npm run simulate [-- --mode both --scenario enter-china --hz 5 --speed 60 ...]
// 控制命令（stdin 回车确认，或 curl 同进程的 HTTP 控制端点）：
//   p = 暂停/恢复数据推送（测 flightActive 置灰恢复，T3）
//   t = 传送跳变（测航迹断线 breakBefore，T7）
//   d = 断开所有 WebSocket（测后端指数退避重连，T2）
//   q = 退出
// HTTP 控制端点（仅 webapi/both 模式）：GET /sim/pause /sim/resume /sim/teleport /sim/drop /sim/status
import http from 'node:http'
import dgram from 'node:dgram'
import readline from 'node:readline'
import { WebSocketServer } from 'ws'

// ---------- CLI 参数 ----------
function parseArgs(argv) {
  const args = {
    mode: 'both', // webapi | udp | both
    scenario: 'enter-china',
    hz: 5,
    httpPort: 8086,
    udpPort: 49005,
    // 时间倍速。默认 4x：客机 240m/s × 4 = 隐含 3456km/h，仍在后端传送检测阈值
    // （3600km/h，见 trackStore.JUMP_SPEED_KMH）之内。倍速再高会让每个点都被判为
    // "传送跳变"，航迹将完全断线——那是检测机制在正确工作，不是模拟器 bug。
    speed: 4,
    tail: 'B-20AC'
  }
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i]
    const val = () => argv[++i]
    switch (key) {
      case '--mode': args.mode = val(); break
      case '--scenario': args.scenario = val(); break
      case '--hz': args.hz = Number(val()); break
      case '--http-port': args.httpPort = Number(val()); break
      case '--udp-port': args.udpPort = Number(val()); break
      case '--speed': args.speed = Number(val()); break
      case '--tail': args.tail = val(); break
      default: console.warn(`[!!] 未知参数 ${key}，已忽略`)
    }
  }
  return args
}

// ---------- 飞行场景 ----------
// 航线场景：wp[i] → wp[i+1] 期间以 wp[i+1].speed 巡航、高度从 wp[i].alt 线性过渡到 wp[i+1].alt。
// 注意：前端底图切换的判定边界是"粗矩形 − 港澳台"（见 public/js/geo.js），
// 东京在矩形外、上海在矩形内，因此 enter/exit 场景能真实触发切换。
const SCENARIOS = {
  'enter-china': {
    desc: '东京 → 上海（从判定边界外飞入，验证百度底图自动切入）',
    wps: [
      { name: '东京成田', lat: 35.772, lon: 140.393, alt: 0, speed: 0 },
      { name: '太平洋上空', lat: 34.0, lon: 136.5, alt: 10000, speed: 240 },
      { name: '东海上空', lat: 32.5, lon: 128.0, alt: 10000, speed: 240 },
      { name: '上海浦东', lat: 31.15, lon: 121.8, alt: 0, speed: 240 }
    ]
  },
  'exit-china': {
    desc: '上海 → 东京（从判定矩形内飞出，验证恢复 OSM）',
    wps: [
      { name: '上海浦东', lat: 31.15, lon: 121.8, alt: 0, speed: 0 },
      { name: '东海上空', lat: 32.5, lon: 128.0, alt: 10000, speed: 240 },
      { name: '太平洋上空', lat: 34.0, lon: 136.5, alt: 10000, speed: 240 },
      { name: '东京成田', lat: 35.772, lon: 140.393, alt: 0, speed: 240 }
    ]
  },
  domestic: {
    desc: '上海 → 北京（全程境内，验证常规数据流与百度底图保持）',
    wps: [
      { name: '上海虹桥', lat: 31.198, lon: 121.336, alt: 0, speed: 0 },
      { name: '江淮上空', lat: 33.5, lon: 119.0, alt: 10000, speed: 240 },
      { name: '华北上空', lat: 37.0, lon: 117.5, alt: 10000, speed: 240 },
      { name: '北京首都', lat: 40.08, lon: 116.58, alt: 0, speed: 240 }
    ]
  },
  circle: {
    desc: '绕北京上空盘旋（无限循环）',
    circle: { lat: 39.9, lon: 116.6, radiusDeg: 0.35, alt: 1200, speedMps: 80 }
  },
  'cross-boundary': {
    desc: '东海 → 大阪湾（短途穿越判定边界 135.1°E，快速验证底图切出）',
    wps: [
      { name: '东海上空', lat: 32.8, lon: 133.5, alt: 9500, speed: 0 },
      { name: '九州以南', lat: 33.6, lon: 134.8, alt: 9500, speed: 240 },
      { name: '大阪湾', lat: 34.6, lon: 136.4, alt: 9500, speed: 240 }
    ]
  }
}

// ---------- 飞行模型（推算定位，非精密导航，够联调用） ----------
const DEG = Math.PI / 180
const M_PER_DEG_LAT = 111320
const KT_PER_MPS = 1.94384
const FPM_PER_MPS = 196.85

class FlightModel {
  constructor(scenario) {
    this.scenario = scenario
    this.t = 0 // 模拟时间（秒）
    this.dtStep = 0
    if (scenario.circle) {
      this.theta = 0
      this.#updateCircleState()
    } else {
      this.leg = 0
      this.legRemaining = 0
      this.pos = { lat: scenario.wps[0].lat, lon: scenario.wps[0].lon }
      this.alt = scenario.wps[0].alt
      this.arrived = false
      this.#startLeg(0)
    }
    this.pitch = 0
    this.roll = 0
  }

  #startLeg(i) {
    this.leg = i
    const from = this.scenario.wps[i]
    const to = this.scenario.wps[i + 1]
    // 腿长（米，等距圆柱近似）
    const dLat = (to.lat - from.lat) * M_PER_DEG_LAT
    const dLon = (to.lon - from.lon) * M_PER_DEG_LAT * Math.cos(from.lat * DEG)
    this.legTotal = Math.sqrt(dLat * dLat + dLon * dLon)
    this.legRemaining = this.legTotal
  }

  #updateCircleState() {
    const c = this.scenario.circle
    const radiusM = c.radiusDeg * M_PER_DEG_LAT
    const omega = c.speedMps / radiusM // 角速度 rad/s（模拟时间）
    this.theta += omega * this.dtStep
    this.state = {
      lat: c.lat + c.radiusDeg * Math.cos(this.theta),
      lon: c.lon + (c.radiusDeg * Math.sin(this.theta)) / Math.cos(c.lat * DEG),
      alt: c.alt,
      gsMps: c.speedMps,
      heading: ((this.theta * 180) / Math.PI + 90) % 360, // 逆时针切向
      vsMps: 0
    }
  }

  /** 推进模拟时间 dtSim 秒，返回新的状态快照 */
  step(dtSim) {
    this.dtStep = dtSim
    this.t += dtSim
    // 姿态轻微摆动，让画面更真实
    this.pitch = 2 * Math.sin(this.t * 0.15)
    this.roll = 8 * Math.sin(this.t * 0.3)

    if (this.scenario.circle) {
      this.#updateCircleState()
    } else if (this.arrived) {
      // 已到达：保持停机状态（继续发数据，模拟"已连接但飞机不动"）
      this.state = { ...this.state, pitch: 0, roll: 0, gsMps: 0, vsMps: 0 }
    } else {
      const to = this.scenario.wps[this.leg + 1]
      let dist = to.speed * dtSim
      if (dist >= this.legRemaining) {
        dist = this.legRemaining
        this.legRemaining = 0
      } else {
        this.legRemaining -= dist
      }
      // 朝目标等距推进（自引导，不做精密大圆）
      const brg = bearing(this.pos.lat, this.pos.lon, to.lat, to.lon)
      const altBefore = this.alt
      this.pos = {
        lat: this.pos.lat + (dist * Math.cos(brg)) / M_PER_DEG_LAT,
        lon: this.pos.lon + (dist * Math.sin(brg)) / (M_PER_DEG_LAT * Math.cos(this.pos.lat * DEG))
      }
      // 高度按腿进度线性过渡
      const progress = this.legTotal > 0 ? 1 - this.legRemaining / this.legTotal : 1
      const from = this.scenario.wps[this.leg]
      this.alt = from.alt + (to.alt - from.alt) * progress
      this.state = {
        lat: this.pos.lat,
        lon: this.pos.lon,
        alt: this.alt,
        gsMps: to.speed,
        heading: (brg / DEG + 360) % 360,
        vsMps: (this.alt - altBefore) / dtSim
      }
      if (this.legRemaining <= 0) {
        if (this.leg + 2 < this.scenario.wps.length) {
          this.#startLeg(this.leg + 1)
        } else {
          this.arrived = true
          console.log('[到达] 航班已到终点，保持停机发报（p 暂停 / t 传送 / q 退出）')
        }
      }
    }
    return this.snapshot()
  }

  snapshot() {
    const s = this.state
    return {
      lat: s.lat,
      lon: s.lon,
      altMsl: s.alt,
      altAgl: Math.max(0, s.alt - 30),
      heading: s.heading,
      gsMps: s.gsMps,
      iasKt: s.gsMps * KT_PER_MPS * 0.95,
      tasKt: s.gsMps * KT_PER_MPS,
      vsMps: s.vsMps,
      vsFpm: s.vsMps * FPM_PER_MPS,
      pitch: this.pitch,
      roll: this.roll
    }
  }

  /** 传送跳变：直接把位置瞬移到指定点（测 breakBefore 断线） */
  teleport() {
    const current = this.scenario.circle ? this.state : this.pos
    const inChina = isRoughlyChina(current)
    const target = inChina ? { lat: 40.71, lon: -74.01, alt: 10500 } : { lat: 39.9, lon: 116.6, alt: 10000 }
    console.log(`[跳变] 传送：${current.lat.toFixed(2)},${current.lon.toFixed(2)} -> ${target.lat},${target.lon}`)
    this.pos = { lat: target.lat, lon: target.lon }
    this.alt = target.alt
    if (this.scenario.circle) {
      // 圆形场景直接跳到圆心对面的角度
      this.theta += Math.PI
    } else {
      // 把当前腿的起点改写为传送目的地并重开该腿，进度/高度计算保持自洽
      this.pos = { lat: target.lat, lon: target.lon }
      this.alt = target.alt
      this.arrived = false
      this.scenario.wps[this.leg] = {
        ...this.scenario.wps[this.leg],
        lat: target.lat,
        lon: target.lon,
        alt: target.alt
      }
      this.#startLeg(this.leg)
    }
    this.state = { ...this.state, lat: target.lat, lon: target.lon, alt: target.alt }
    return this.snapshot()
  }
}

function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG
  const φ2 = lat2 * DEG
  const Δλ = (lon2 - lon1) * DEG
  return Math.atan2(
    Math.sin(Δλ) * Math.cos(φ2),
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  )
}

// 与前端 geo.js 的主矩形一致的粗略判定（仅用于 teleport 目的地选择）
function isRoughlyChina(pos) {
  return pos.lat >= 18 && pos.lat <= 53.7 && pos.lon >= 73.4 && pos.lon <= 135.1
}

// ---------- dataref 表（ID 与 server/test/webApiMapping.test.js 的约定一致） ----------
const DATAREFS = [
  { id: 1, name: 'sim/flightmodel/position/latitude', type: 'float' },
  { id: 2, name: 'sim/flightmodel/position/longitude', type: 'float' },
  { id: 3, name: 'sim/flightmodel/position/elevation', type: 'float' },
  { id: 4, name: 'sim/flightmodel/position/y_agl', type: 'float' },
  { id: 5, name: 'sim/flightmodel/position/psi', type: 'float' },
  { id: 6, name: 'sim/flightmodel/position/groundspeed', type: 'float' },
  { id: 7, name: 'sim/flightmodel/position/indicated_airspeed', type: 'float' },
  { id: 8, name: 'sim/flightmodel/position/phi', type: 'float' },
  { id: 9, name: 'sim/flightmodel/position/theta', type: 'float' },
  { id: 10, name: 'sim/flightmodel/position/vh_ind_fpm', type: 'float' },
  { id: 11, name: 'sim/aircraft/view/acf_tailnum', type: 'string' }
]
const DATAREF_BY_NAME = new Map(DATAREFS.map((d) => [d.name, d]))

// ---------- 主程序 ----------
const args = parseArgs(process.argv)
const scenario = SCENARIOS[args.scenario]
if (!scenario) {
  console.error(`[!!] 未知场景 "${args.scenario}"，可选：${Object.keys(SCENARIOS).join(' / ')}`)
  process.exit(1)
}

const model = new FlightModel(scenario)
let paused = false
let wsSendCount = 0
let udpSendCount = 0

// —— Web API（HTTP + WS）——
let httpServer = null
let wss = null
const subscriptions = new Map() // ws → { ids:Set, frequency, requestId }

if (args.mode === 'webapi' || args.mode === 'both') {
  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${args.httpPort}`)
    if (url.pathname === '/api/v2/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'X-Plane 12 (simulator)', version: '4.1.0', sdk_version: '4.1.0' }))
      return
    }
    if (url.pathname === '/api/v2/datarefs') {
      const name = url.searchParams.get('filter[name]')
      const hit = DATAREF_BY_NAME.get(name)
      res.writeHead(200, { 'content-type': 'application/json' })
      // 与真实 Web API 一致的分页信封：数据在 data 数组中，条目含 id/name/type
      res.end(JSON.stringify({ data: hit ? [hit] : [], total: hit ? 1 : 0, limit: 100, offset: 0 }))
      return
    }
    if (handleControlEndpoint(url, res)) return
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  wss = new WebSocketServer({ server: httpServer, path: '/api/v2/ws' })
  wss.on('connection', (ws) => {
    console.log('[连接] 客户端建立 WebSocket 连接')
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg?.type === 'dataref_subscribe_values') {
          subscriptions.set(ws, {
            ids: new Set(msg.data?.ids || []),
            frequency: msg.data?.frequency || args.hz,
            requestId: msg.request_id ?? 1
          })
          console.log(`[订阅] ${msg.data?.ids?.length ?? 0} 个 dataref @ ${msg.data?.frequency}Hz`)
        }
      } catch {
        /* 忽略非 JSON 消息 */
      }
    })
    ws.on('close', () => {
      subscriptions.delete(ws)
      console.log('[断开] 客户端 WebSocket 断开')
    })
  })

  httpServer.listen(args.httpPort, '127.0.0.1', () => {
    console.log(`[OK] Web API 模拟就绪：http://127.0.0.1:${args.httpPort}/api/v2/capabilities`)
  })
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[!!] 端口 ${args.httpPort} 被占用（真实 X-Plane 在运行？）。请用 --http-port 换端口，或关闭 X-Plane。`)
      process.exit(1)
    }
    throw err
  })
}

// —— UDP DATA 广播 ——
let udpSocket = null
if (args.mode === 'udp' || args.mode === 'both') {
  udpSocket = dgram.createSocket('udp4')
}

/** 组一个 DATA 帧：4 字节头 + 若干组 [int32 行号 + 8×float32]，小端 */
function buildDataPacket(st) {
  const parts = [Buffer.from('DATA', 'ascii')]
  const push = (row, floats) => {
    const b = Buffer.alloc(36)
    b.writeInt32LE(row, 0)
    floats.forEach((f, i) => b.writeFloatLE(f, 4 + i * 4))
    parts.push(b)
  }
  push(18, [st.lat, st.lon, st.altMsl, st.altAgl, 0, 0, 0, 0])
  push(20, [st.pitch, st.roll, st.heading, 0, 0, 0, 0, 0])
  push(21, [st.tasKt, st.iasKt, 0, 0, 0, 0, 0, 0])
  // 行 3（本机速度分量，m/s）：近似 X 向东 / Y 向上 / Z 向南——与后端 udpClient 的解析假设一致
  const brg = st.heading * DEG
  push(3, [st.gsMps * Math.cos(brg), st.vsMps, -st.gsMps * Math.sin(brg), 0, 0, 0, 0, 0])
  return Buffer.concat(parts)
}

function currentValues(st) {
  return [
    { id: 1, value: st.lat },
    { id: 2, value: st.lon },
    { id: 3, value: st.altMsl },
    { id: 4, value: st.altAgl },
    { id: 5, value: st.heading },
    { id: 6, value: st.gsMps },
    { id: 7, value: st.iasKt },
    { id: 8, value: st.roll },
    { id: 9, value: st.pitch },
    { id: 10, value: st.vsFpm },
    { id: 11, value: args.tail }
  ]
}

// —— 主节拍：推进飞行模型 + 推送数据（暂停时冻结）——
let tickCount = 0
const timer = setInterval(() => {
  if (paused) return
  const dtSim = args.speed / args.hz // 每个节拍推进的模拟秒数
  const st = model.step(dtSim)
  tickCount++

  // WS 推送：按各订阅者请求的频率节流（与真实 Web API 行为一致）
  if (wss) {
    for (const [ws, sub] of subscriptions) {
      if (ws.readyState !== ws.OPEN) continue
      const every = Math.max(1, Math.round(args.hz / Math.min(sub.frequency, args.hz)))
      if (tickCount % every !== 0) continue
      const values = currentValues(st).filter((v) => sub.ids.has(v.id))
      ws.send(
        JSON.stringify({
          type: 'dataref_values',
          request_id: sub.requestId,
          data: { values, timestamp: Date.now() }
        })
      )
      wsSendCount++
    }
  }

  // UDP 推送
  if (udpSocket) {
    const packet = buildDataPacket(st)
    udpSocket.send(packet, args.udpPort, '127.0.0.1', (err) => {
      if (!err) udpSendCount++
    })
  }
}, Math.round(1000 / args.hz))
timer.unref?.()

// —— 状态打印 ——
const statusTimer = setInterval(() => {
  const st = model.snapshot()
  console.log(
    `[飞机] ${st.lat.toFixed(4)}, ${st.lon.toFixed(4)}  高度 ${st.altMsl.toFixed(0)}m  地速 ${(st.gsMps * KT_PER_MPS).toFixed(0)}kt  航向 ${st.heading.toFixed(0)}°  [ws:${wsSendCount} udp:${udpSendCount}${paused ? ' [已暂停]' : ''}]`
  )
}, 5000)
statusTimer.unref?.()

// —— 控制逻辑（stdin 命令与 HTTP 端点共用）——
function doPause() {
  paused = !paused
  console.log(paused ? '[暂停] 数据推送已暂停（后端将在静默超时后判定"无飞行"）' : '[恢复] 数据推送已恢复')
  return paused
}

function doTeleport() {
  model.teleport()
}

function doDrop() {
  if (!wss) {
    console.log('[!!] 当前模式未启用 Web API，无 WebSocket 可断开')
    return
  }
  let n = 0
  for (const ws of wss.clients) {
    ws.close(1001, 'simulator drop')
    n++
  }
  console.log(`[断开] 已主动断开 ${n} 个 WebSocket 连接（观察后端退避重连日志）`)
}

function doQuit() {
  console.log('[退出] 模拟器退出')
  clearInterval(timer)
  clearInterval(statusTimer)
  if (wss) for (const ws of wss.clients) ws.close()
  if (wss) wss.close()
  if (httpServer) httpServer.close()
  if (udpSocket) udpSocket.close()
  setTimeout(() => process.exit(0), 200).unref()
}

function handleControlEndpoint(url, res) {
  const reply = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
    return true
  }
  switch (url.pathname) {
    case '/sim/pause': return reply({ paused: doPause() })
    case '/sim/resume':
      if (paused) doPause()
      return reply({ paused })
    case '/sim/teleport':
      doTeleport()
      return reply({ ok: true })
    case '/sim/drop':
      doDrop()
      return reply({ ok: true })
    case '/sim/status': {
      const st = model.snapshot()
      return reply({ paused, tickCount, wsSendCount, udpSendCount, ...st })
    }
    default:
      return false
  }
}

// —— stdin 命令 ——
if (process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase()
    if (cmd === 'p') doPause()
    else if (cmd === 't') doTeleport()
    else if (cmd === 'd') doDrop()
    else if (cmd === 'q') doQuit()
    else if (cmd) console.log('命令：p=暂停 t=传送 d=断开WS q=退出')
  })
}
process.on('SIGINT', doQuit)

// —— 启动横幅 ——
console.log('[OK] X-Plane 协议模拟器已启动')
console.log(`  模式: ${args.mode}  场景: ${args.scenario} —— ${scenario.desc}`)
console.log(`  推送频率: ${args.hz}Hz  时间倍速: ${args.speed}x（1 实秒 = ${args.speed} 模拟秒）`)
if (args.mode === 'webapi' || args.mode === 'both') {
  console.log(`  Web API: http://127.0.0.1:${args.httpPort} （后端设置面板选 Web API 模式即可连上）`)
}
if (args.mode === 'udp' || args.mode === 'both') {
  console.log(`  UDP DATA → 127.0.0.1:${args.udpPort} （后端设置面板选 UDP 模式、监听 ${args.udpPort}）`)
}
console.log('  命令: p=暂停/恢复  t=传送跳变  d=断开WebSocket  q=退出')
