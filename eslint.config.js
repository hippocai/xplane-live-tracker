import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['node_modules/**', 'public/vendor/**', '**/*.min.js'],
  },
  js.configs.recommended,
  {
    // 后端与脚本：Node 环境
    files: ['server/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // 项目刻意以 { code, message } 字面量在内部模块间传递结构化错误
      //（REST 统一错误格式依赖此约定，见设计文档 §15.1）
      'no-throw-literal': 'error',
    },
  },
  {
    // 前端：浏览器环境（Leaflet 以 UMD 引入，全局变量 L）
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, L: 'readonly' },
    },
  },
]
