import net from 'net'
import { lookup } from 'dns/promises'

export function isLoopback(ip: string) {
  if (!ip) return false
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.')
}

/**
 * 判断 IP 是否属于私有 / 链路本地 / 回环 / 多播 / 未指定地址段。
 * 用于 SSRF 防护：阻止 fetch 指向 RFC1918 / link-local / cloud-metadata 等敏感地址。
 */
export function isPrivateOrReservedIp(ip: string) {
  if (!ip) return true
  // IPv4-mapped IPv6（如 ::ffff:192.168.1.1）
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4mapped) return isPrivateOrReservedIp(v4mapped[1])

  // 标准化 IPv6 回环
  if (ip === '::1' || ip === '::') return true
  if (ip === '127.0.0.1' || ip === '0.0.0.0') return true

  // IPv4 私有段 / 链路本地 / 多播 / 保留段
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 10) return true
    if (a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // link-local
    if (a === 100 && b >= 64 && b <= 127) return true // CGN
    if (a === 0) return true
    if (a >= 224) return true // 多播 / 保留
  }

  // IPv6 私有段 (fc00::/7, fe80::/10, ::1/128)
  if (/^f[cd]/i.test(ip)) return true
  if (/^fe[89ab]/i.test(ip)) return true

  return false
}

/**
 * 把任意 hostname / IP 字符串解析为 IP 列表（不去重、不做 SSRF 校验）。
 * 解析失败返回空数组。
 */
export async function resolveHost(host: string): Promise<string[]> {
  if (!host) return []
  try {
    const addrs = await lookup(host, { all: true, verbatim: true })
    return addrs.map((a) => a.address)
  } catch {
    return []
  }
}

/**
 * 把任意 hostname / IP 字符串解析为 IP，若解析失败返回 null。
 * 同时校验解析结果是否属于私有 / 保留地址段。
 */
export async function resolveAndCheckPrivate(host: string): Promise<string | null> {
  if (!host) return null
  // 如果已经是 IP，直接校验
  if (/^[\d:.]+$/.test(host)) {
    return isPrivateOrReservedIp(host) ? null : host
  }
  try {
    const addrs = await lookup(host, { all: true, verbatim: true })
    for (const a of addrs) {
      if (isPrivateOrReservedIp(a.address)) return null
    }
    return addrs[0]?.address ?? null
  } catch {
    return null
  }
}

export async function findAvailablePort(
  start: number,
  maxTries = 25
): Promise<{ port: number; shifted: boolean }> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.once('listening', () => {
        server.close(() => resolve(port))
      })
      server.listen(port, '0.0.0.0')
    })

  let port = start
  for (let i = 0; i < maxTries; i++) {
    try {
      const free = await tryPort(port)
      return { port: free, shifted: free !== start }
    } catch (err: any) {
      if (err?.code !== 'EADDRINUSE') throw err
      port += 1
      if (port > 65535) port = 30000
    }
  }
  // 全部尝试都失败时返回原 port，由调用方决定如何处理（抛错 / 接受冲突）
  return { port: start, shifted: false }
}

export function normalizePath(namespace: string | undefined, path: string) {
  const base = path.startsWith('/') ? path : `/${path}`
  if (!namespace) return base
  const ns = namespace.startsWith('/') ? namespace : `/${namespace}`
  return `${ns}${base}`
}
