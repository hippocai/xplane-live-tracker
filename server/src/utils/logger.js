// 全局 pino 日志实例（设计文档 §15.1 日志规范）：
// debug（高频 dataref 原始值，默认关闭）、info（连接/切换/启动）、
// warn（重连、无飞行判定）、error（连接失败、解析异常）。生产默认 info。
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
})
