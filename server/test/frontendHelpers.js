// 前端模块测试共用的极简 DOM 替身。
// 被测前端代码为无构建的原生 ESM（public/js/*.js），可在 node 中直接 import；
// 只需在调用前把 document / L / WebSocket / fetch / localStorage 注入 globalThis。
// 本文件仅实现被测模块实际用到的 API 面（getElementById / addEventListener /
// classList / style / value 等），不引入 jsdom 依赖。
export function fakeElement(id = '') {
  const listeners = {}
  const el = {
    id,
    textContent: '',
    hidden: false,
    checked: false,
    disabled: false,
    open: true, // <details> 的 open 属性
    style: {},
    classes: new Set(),
    classList: null, // 下方赋值（闭包需引用 el 自身）
    // input.value 与 DOM 一致：赋值一律 coerce 为字符串
    _value: '',
    get value() {
      return this._value
    },
    set value(v) {
      this._value = v == null ? '' : String(v)
    },
    addEventListener(type, fn) {
      ;(listeners[type] ||= []).push(fn)
    },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn)
    },
    dispatch(type, ev = {}) {
      for (const fn of listeners[type] || []) fn(ev)
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    focus() {},
    select() {},
  }
  el.classList = {
    add: (...cs) => cs.forEach((c) => el.classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el.classes.delete(c)),
    toggle(c, force) {
      const on = force === undefined ? !el.classes.has(c) : Boolean(force)
      if (on) el.classes.add(c)
      else el.classes.delete(c)
      return on
    },
    contains: (c) => el.classes.has(c),
  }
  return el
}

export function fakeDocument(byId = {}) {
  return { getElementById: (id) => byId[id] ?? null }
}
