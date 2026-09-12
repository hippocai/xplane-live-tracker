// X-Plane 导航数据库（机场 / 导航台 / 航路点）加载与空间查询。
// 数据源是 X-Plane 安装目录自带的导航数据（工具与模拟器同机部署，无需联网）：
//   机场   Custom Data/earth_aptmeta.dat（XP12.1+ / Navigraph，无名称列只有 ICAO）
//          或 Resources/.../Earth nav data/apt.dat（旧版兜底）
//   导航台 Custom Data/earth_nav.dat 或 Resources/default data/earth_nav.dat
//   航路点 Custom Data/earth_fix.dat 或 Resources/default data/earth_fix.dat
// Custom Data 优先：装了 Navigraph 数据周期时模拟器实际使用的是它（比 Resources 新）。
// 解析器实现为纯函数（parseXxxContent，整段文本进、结构化数组出）便于单元测试；
// 类型码/列序按真实安装实测核对（2026-09，XP1200 Navigraph 数据）。
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { logger } from './logger.js'

// 各数据集候选相对路径（按优先级排列）
const SOURCES = {
  aptmeta: [path.join('Custom Data', 'earth_aptmeta.dat')],
  aptdat: [path.join('Resources', 'default data', 'default scenery', 'Earth nav data', 'apt.dat')],
  nav: [
    path.join('Custom Data', 'earth_nav.dat'),
    path.join('Resources', 'default data', 'earth_nav.dat'),
  ],
  fix: [
    path.join('Custom Data', 'earth_fix.dat'),
    path.join('Resources', 'default data', 'earth_fix.dat'),
  ],
}

// earth_nav.dat 实测类型码（XP1200 Navigraph）：
// 2=NDB、3=VOR/VOR-DME/TACAN；4/5=ILS 航向道、6=下滑台、7/8/9=外/中/内信标、
// 12/13=DME（旧文档把 12/13 记作 NDB，已过时）、14=LPV、15=GLS。
// 图层只取航路导航台（VOR/NDB）；进近类组件（ILS/GS/信标/DME）不显示。
const CODE_VOR = new Set([3])
const CODE_NDB = new Set([2])

// —— 纯函数解析器（供单元测试直接调用）——

/**
 * 解析 apt.dat 文本：只取机场（含直升机坪/水上机场）位置与名称。
 * ARP 取 1302 行；缺失时回退到首条跑道行（100）中第一对合法经纬度。
 */
export function parseAptContent(text) {
  const airports = []
  let cur = null // { ident, name, lat, lon, arpSeen, rwySeen }
  const finish = () => {
    if (cur && Number.isFinite(cur.lat) && Number.isFinite(cur.lon)) {
      airports.push({
        type: 'airport',
        ident: cur.ident || '',
        name: cur.name || '',
        lat: cur.lat,
        lon: cur.lon,
      })
    }
    cur = null
  }
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/)
    const code = t[0]
    if (code === '1' || code === '16' || code === '17') {
      finish() // 下一个机场头
      cur = { ident: t[1] || '', name: t.slice(5).join(' '), lat: NaN, lon: NaN }
    } else if (code === '1302' && cur) {
      cur.lat = Number(t[1])
      cur.lon = Number(t[2])
    } else if (code === '100' && cur && !Number.isFinite(cur.lat)) {
      // 跑道行兜底：从第 10 个字段起找第一对"合法纬度+经度"
      for (let i = 9; i + 1 < t.length; i++) {
        const la = Number(t[i])
        const lo = Number(t[i + 1])
        if (Math.abs(la) <= 90 && Math.abs(lo) <= 180 && la !== 0 && lo !== 0) {
          cur.lat = la
          cur.lon = lo
          break
        }
      }
    }
  }
  finish()
  return airports
}

/**
 * 解析 earth_aptmeta.dat（XP12 机场元数据）：每行 "ICAO 地区码 纬度 经度 标高 类型 ..."。
 * 文件没有机场名称列，图层标签只显示 ICAO 识别码（飞行员本就以 ICAO 标识机场）。
 */
export function parseAptMetaContent(text) {
  const airports = []
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/)
    if (t.length < 4 || t[0] === 'I') continue
    // 注意：ICAO 可能以数字开头（如美国 00AN/0MI9），不能用"数字开头"识别头行；
    // 版本行（1210 Version ...）与 EOF 行的第 3/4 列不是合法经纬度，由下方范围校验过滤。
    const lat = Number(t[2])
    const lon = Number(t[3])
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      continue
    }
    airports.push({ type: 'airport', ident: t[0], name: '', lat, lon })
  }
  return airports
}

/** 解析 earth_nav.dat 文本：仅保留航路导航台 VOR(3)/NDB(2)，归并为 type:'navaid' */
export function parseNavContent(text) {
  const navaids = []
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/)
    if (!t.length || t[0] === 'I' || t[0].startsWith('99') || /^\d00\s/.test(line.trim())) continue
    const code = Number(t[0])
    let kind = null
    if (CODE_VOR.has(code)) kind = 'vor'
    else if (CODE_NDB.has(code)) kind = 'ndb'
    else continue
    const lat = Number(t[1])
    const lon = Number(t[2])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    // 名称列形如 "ENRT DN ABUJA VOR/DME"：去掉 ENRT 前缀与两位国家码，取 "ABUJA VOR/DME"
    let parts = t.slice(8)
    if (parts[0] === 'ENRT') parts = parts.slice(1)
    if (parts.length > 1 && /^[A-Z]{2}$/.test(parts[0])) parts = parts.slice(1)
    navaids.push({ type: 'navaid', kind, ident: t[7] || '', name: parts.join(' '), lat, lon })
  }
  return navaids
}

/** 解析 earth_fix.dat 文本：每行 "纬度 经度 名称 [ENRT ...]"（XP1200 实测列序） */
export function parseFixContent(text) {
  const fixes = []
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/)
    if (t.length < 3) continue
    const lat = Number(t[0])
    const lon = Number(t[1])
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      continue // I / 版本行 / EOF 行经纬度越界自然被过滤
    }
    fixes.push({ type: 'fix', ident: t[2], name: '', lat, lon })
  }
  return fixes
}

// —— 空间查询（纯函数，供单元测试）——

const EARTH_R_KM = 6371
function hav(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(s)))
}

export const MAX_QUERY_RADIUS_KM = 800
export const PER_TYPE_LIMIT = 200

/**
 * 中心+半径查询：按距离升序、每类限量。
 * @param {{airport: Array, navaid: Array, fix: Array}} dataByType
 */
export function queryPoints(dataByType, { lat, lon, radiusKm = 200, types }) {
  const want = new Set(types?.length ? types : ['airport', 'navaid', 'fix'])
  const radius = Math.min(Math.max(radiusKm, 1), MAX_QUERY_RADIUS_KM)
  const out = []
  let truncated = false
  for (const type of ['airport', 'navaid', 'fix']) {
    if (!want.has(type)) continue
    const list = dataByType[type] || []
    const hits = []
    for (const p of list) {
      const distKm = hav(lat, lon, p.lat, p.lon)
      if (distKm <= radius) hits.push({ ...p, distKm })
    }
    hits.sort((a, b) => a.distKm - b.distKm)
    if (hits.length > PER_TYPE_LIMIT) truncated = true
    out.push(...hits.slice(0, PER_TYPE_LIMIT))
  }
  out.sort((a, b) => a.distKm - b.distKm)
  return { points: out, truncated }
}

// —— 加载与状态管理 ——

const state = {
  loaded: false,
  loading: false,
  xplanePath: null,
  counts: { airport: 0, navaid: 0, fix: 0 },
  error: null,
}
const data = { airport: [], navaid: [], fix: [] }

/** 在安装目录下按候选优先级找第一个存在的文件；找不到返回 null */
function firstExisting(root, rels) {
  for (const r of rels) {
    const p = path.join(root, r)
    if (existsSync(p)) return p
  }
  return null
}

/** 目录是否像一个 X-Plane 安装（任一位置的 earth_nav.dat 存在即可） */
function looksLikeXplaneDir(p) {
  return Boolean(firstExisting(p, SOURCES.nav))
}

/** 常见安装位置探测（常规安装、Steam 库、macOS/Linux；以导航数据存在为准） */
export function detectXplanePath() {
  const candidates = []
  for (const d of ['C', 'D', 'E', 'F', 'G']) {
    candidates.push(`${d}:\\X-Plane 12`)
    candidates.push(`${d}:\\Program Files (x86)\\Steam\\steamapps\\common\\X-Plane 12`)
    candidates.push(`${d}:\\SteamLibrary\\steamapps\\common\\X-Plane 12`)
  }
  candidates.push('/Applications/X-Plane 12', path.join(os.homedir(), 'X-Plane 12'))
  for (const p of candidates) {
    if (looksLikeXplaneDir(p)) return p
  }
  return null
}

/** 应用启动时调用：按配置路径（空则自动探测）加载；不阻塞服务启动 */
export async function initNavData(xplanePath) {
  const resolved = xplanePath && existsSync(xplanePath) ? xplanePath : detectXplanePath()
  if (!resolved) {
    state.error = '未找到 X-Plane 安装目录，请在设置中填写安装路径后应用'
    logger.warn({ configured: xplanePath }, '导航数据库未加载：未找到 X-Plane 安装目录')
    return getNavStatus()
  }
  return reloadNavData(resolved)
}

/** （重新）加载指定安装目录的导航数据 */
export async function reloadNavData(xplanePath) {
  if (!looksLikeXplaneDir(xplanePath)) {
    state.error = `目录不像 X-Plane 安装目录（未找到 earth_nav.dat）：${xplanePath}`
    return getNavStatus()
  }
  state.loading = true
  state.error = null
  try {
    // 机场：XP12 的 earth_aptmeta.dat 优先，旧版安装回退 apt.dat
    const aptMetaPath = firstExisting(xplanePath, SOURCES.aptmeta)
    const aptDatPath = firstExisting(xplanePath, SOURCES.aptdat)
    const navPath = firstExisting(xplanePath, SOURCES.nav)
    const fixPath = firstExisting(xplanePath, SOURCES.fix)
    const readOpt = (p) => (p ? readFile(p, 'utf8') : Promise.resolve(''))
    const [aptMetaRaw, aptDatRaw, navRaw, fixRaw] = await Promise.all([
      readOpt(aptMetaPath),
      readOpt(aptDatPath),
      readOpt(navPath),
      readOpt(fixPath),
    ])
    data.airport = aptMetaPath ? parseAptMetaContent(aptMetaRaw) : parseAptContent(aptDatRaw)
    data.navaid = parseNavContent(navRaw)
    data.fix = parseFixContent(fixRaw)
    state.loaded = data.airport.length > 0 || data.navaid.length > 0 || data.fix.length > 0
    state.xplanePath = xplanePath
    state.counts = {
      airport: data.airport.length,
      navaid: data.navaid.length,
      fix: data.fix.length,
    }
    logger.info(state.counts, '导航数据库已加载')
    if (!state.loaded) state.error = '导航数据文件为空（X-Plane 版本数据格式可能变化）'
    return getNavStatus()
  } catch (err) {
    state.loaded = false
    state.error = `导航数据库加载失败：${err.message}`
    logger.error({ err }, '导航数据库加载失败')
    return getNavStatus()
  } finally {
    state.loading = false
  }
}

export function getNavStatus() {
  return {
    loaded: state.loaded,
    loading: state.loading,
    xplanePath: state.xplanePath,
    counts: { ...state.counts },
    error: state.error,
  }
}

/** 供 REST 路由调用：基于当前已加载数据的空间查询 */
export function queryNavPoints(params) {
  return queryPoints(data, params)
}
