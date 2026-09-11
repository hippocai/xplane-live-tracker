// REST 请求小工具：自动附带访问口令（§9，token 存 localStorage）
const TOKEN_KEY = 'xplt_token'

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null // 隐私模式等场景 localStorage 不可用
  }
}

export function saveToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* 忽略存储失败 */
  }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  const token = getToken()
  if (token) headers['x-access-token'] = token
  if (options.body) headers['content-type'] = 'application/json'
  const res = await fetch(path, { ...options, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw Object.assign(new Error(data?.error?.message || `请求失败（${res.status}）`), {
      code: data?.error?.code,
    })
  }
  return data
}
