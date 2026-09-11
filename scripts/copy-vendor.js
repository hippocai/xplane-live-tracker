// postinstall：把 Leaflet 静态资源复制到 public/vendor/，
// 避免前端强依赖 CDN（设计文档 §15.4.1：部分部署场景可能无外网）。
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(rootDir, 'node_modules', 'leaflet', 'dist')
const dest = path.join(rootDir, 'public', 'vendor', 'leaflet')

if (existsSync(src)) {
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
  console.log('[postinstall] Leaflet 已复制到 public/vendor/leaflet')
} else {
  console.warn('[postinstall] 未找到 leaflet 包（node_modules/leaflet/dist），跳过 vendor 复制')
}
