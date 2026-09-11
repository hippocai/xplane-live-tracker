// 局域网 IP 与二维码（设计文档 §15.3.9）：
// 枚举本机网卡，过滤出局域网 IPv4 地址（排除回环与常见虚拟网卡），
// 生成访问 URL 和对应二维码（base64 PNG data URL），供终端打印与首页渲染。
import os from 'node:os'
import QRCode from 'qrcode'

// 常见虚拟/内部网卡名称特征（尽力而为的过滤，Windows 命名差异较大）
const VIRTUAL_IFACE_PATTERNS = [
  /vmware/i,
  /virtualbox/i,
  /vethernet/i, // Hyper-V
  /wsl/i,
  /loopback/i,
  /docker/i,
  /tailscale/i,
  /zerotier/i,
  /hamachi/i,
]

/**
 * 获取本机所有局域网访问地址及二维码
 * @param {number} port 服务监听端口
 * @returns {Promise<Array<{iface: string, address: string, url: string, qrDataUrl: string}>>}
 */
export async function getLocalUrls(port) {
  const ifaces = os.networkInterfaces()
  const results = []
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (VIRTUAL_IFACE_PATTERNS.some((re) => re.test(iface))) continue
      const url = `http://${addr.address}:${port}`
      // 二维码容错级别 L 即可（URL 短、内容可控），尺寸 200 便于手机扫码
      const qrDataUrl = await QRCode.toDataURL(url, {
        margin: 1,
        width: 200,
        errorCorrectionLevel: 'L',
      })
      results.push({ iface, address: addr.address, url, qrDataUrl })
    }
  }
  return results
}
