// 运行时配置持久化（设计文档 §15.3.2）：
// config.json 是 activeMode 等运行时状态的唯一真源（single source of truth）。
// .env 仅在首次启动（config.json 不存在）时作为默认值；
// 之后一切以 config.json 为准，设置面板的修改写回该文件（不回写 .env）。
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig, PERSISTED_KEYS } from '../config.js'
import { logger } from './logger.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let CONFIG_PATH = path.join(rootDir, 'config.json')

let currentConfig = null

// 仅供单元测试使用：重定向 config.json 路径到临时目录
export function setConfigFilePathForTests(p) {
  CONFIG_PATH = p
  currentConfig = null
}

// 不存在则用 defaultConfig 创建文件并返回
export async function loadConfig() {
  if (currentConfig) return currentConfig
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    currentConfig = mergeConfig(defaultConfig, JSON.parse(raw))
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // 首次启动：用 .env 默认值生成 config.json
      currentConfig = mergeConfig(defaultConfig, {})
      await persist(currentConfig)
      logger.info({ path: CONFIG_PATH }, '首次启动，已生成默认 config.json')
    } else {
      // 文件被手动改坏：备份为 .bak 后回退默认值，绝不让启动失败
      logger.error({ err, path: CONFIG_PATH }, 'config.json 解析失败，已回退默认配置')
      try {
        await copyFile(CONFIG_PATH, `${CONFIG_PATH}.bak`)
      } catch {
        /* 备份失败不影响启动 */
      }
      currentConfig = mergeConfig(defaultConfig, {})
      await persist(currentConfig)
    }
  }
  return currentConfig
}

// 同步读取内存中的当前配置（高频调用场景，避免每次读文件）。
// 尚未 loadConfig() 时返回 defaultConfig 快照。
export function getConfig() {
  return currentConfig ?? mergeConfig(defaultConfig, {})
}

// 合并写入并持久化，返回合并后的完整配置
export async function saveConfig(partial) {
  const next = mergeConfig(getConfig(), partial)
  await persist(next)
  currentConfig = next
  return next
}

// 只持久化 §15.2 定义的运行时键；port / 密钥等 .env 专属项不落盘。
// 写文件采用"先写临时文件再 rename"，避免进程中途崩溃导致 config.json 损坏。
async function persist(cfg) {
  const runtimeOnly = {}
  for (const key of PERSISTED_KEYS) {
    if (cfg[key] !== undefined) runtimeOnly[key] = cfg[key]
  }
  const tmpPath = `${CONFIG_PATH}.tmp`
  await writeFile(tmpPath, JSON.stringify(runtimeOnly, null, 2), 'utf8')
  await rename(tmpPath, CONFIG_PATH)
}

// 顶层浅合并 + webapi/udp 两个嵌套对象深一层合并
function mergeConfig(base, patch) {
  return {
    ...base,
    ...patch,
    webapi: { ...base.webapi, ...(patch.webapi || {}) },
    udp: { ...base.udp, ...(patch.udp || {}) },
  }
}
