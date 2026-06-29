import Koa from 'koa'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import os from 'os'
import path from 'path'
import * as fs from 'fs'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { Bonjour } from 'bonjour-service'
import type { Service, Browser } from 'bonjour-service'
import { findAvailablePort } from '../http/utils'
import { patchConfig, getConfig as cfgGet } from '../configStore'
import {
  getSharedConfigPayload,
  listSharedConfigs,
  setSharedConfigs,
  upsertSharedConfig,
  type SharedConfigEntry
} from '../state/sharedConfigStore'
import { createPlayerWindow } from '../windows/playerWindow'
import { appLogger } from '../logging/winstonLogger'

type RouterInstance = InstanceType<typeof Router>

export interface CastConfig {
  enabled: boolean
  name: string
  port: number
  shareEnabled: boolean
  /**
   * 允许把内容推送到任意主机（不仅是环回 / 私有网段）。
   * 默认 false：仅在 LAN 内投屏；true：可用于跨网络投屏。
   */
  allowRemote?: boolean
}

export interface CastPeer {
  id: string
  name: string
  host: string
  port: number
  txt?: Record<string, any>
  lastSeen: number
}

export interface ShareEntry {
  id: string
  examName: string
  examCount: number
  updatedAt: number
  deviceName: string
}

const DEFAULT_CAST_CONFIG: CastConfig = {
  enabled: false,
  name: os.hostname?.() || 'ExamAware',
  port: 31235,
  shareEnabled: false
}

export class CastService {
  private config: CastConfig = { ...DEFAULT_CAST_CONFIG }
  private app: Koa | null = null
  private server: import('http').Server | null = null
  private bonjour: Bonjour | null = null
  private published: Service | null = null
  private browser: Browser | null = null
  private peers = new Map<string, CastPeer>()

  private getLocalAddressSet() {
    const set = new Set<string>()
    const hostname = os.hostname?.()
    if (hostname) {
      set.add(hostname)
      set.add(hostname.replace(/\.local\.?$/, ''))
    }
    const nets = os.networkInterfaces()
    Object.values(nets).forEach((items) =>
      items?.forEach((net) => {
        if (net?.address) set.add(net.address)
      })
    )
    set.add('127.0.0.1')
    set.add('::1')
    return set
  }

  loadConfig() {
    const saved = (cfgGet('cast') ?? {}) as Partial<CastConfig>
    this.config = { ...DEFAULT_CAST_CONFIG, ...saved }
    return this.config
  }

  getConfig() {
    return { ...this.config }
  }

  async setConfig(partial: Partial<CastConfig>) {
    const prev = this.config
    const next: CastConfig = {
      ...DEFAULT_CAST_CONFIG,
      ...prev,
      ...partial
    }
    const shouldRestart =
      next.enabled !== prev.enabled ||
      next.port !== prev.port ||
      next.name !== prev.name ||
      next.shareEnabled !== prev.shareEnabled
    this.config = next
    await patchConfig({ cast: next })
    if (shouldRestart) {
      await this.restart()
    }
    return this.getConfig()
  }

  private buildShareEntries(): ShareEntry[] {
    if (!this.config.shareEnabled) return []
    const list = listSharedConfigs()
    return list.map((item) => ({
      id: item.id,
      examName: item.examName,
      examCount: item.examCount,
      updatedAt: item.updatedAt,
      deviceName: this.config.name
    }))
  }

  setSharedEntries(entries: SharedConfigEntry[]) {
    setSharedConfigs(entries || [])
  }

  upsertSharedEntry(entry: SharedConfigEntry) {
    upsertSharedConfig(entry)
  }

  private async ensureBonjourStarted() {
    if (this.bonjour) return
    const mdnsOptions = {
      multicast: true,
      interface: '0.0.0.0',
      loopback: true,
      reuseAddr: true,
      ip: '224.0.0.251',
      port: 5353
    }
    const instance = new Bonjour(mdnsOptions)
    ;(instance as any).on?.('error', (err: Error) => appLogger.error('[cast] bonjour error', err))
    appLogger.info('[cast] bonjour init', {
      interfaces: Array.from(this.getLocalAddressSet()),
      options: mdnsOptions
    })
    this.bonjour = instance
  }

  private publishBonjour() {
    if (!this.bonjour || !this.config.enabled) return
    const previous = this.published
    this.published = null
    const stopPrev = previous
      ? new Promise<void>((resolve) => {
          try {
            previous.stop?.()
          } catch {
            /* 旧 service 关闭时可能已 dispose，吞掉 */
          }
          // 兜底：500ms 后强制 resolve，防止 stop 不触发回调导致死锁
          setTimeout(resolve, 500).unref?.()
        })
      : Promise.resolve()
    stopPrev.then(() => {
      if (!this.bonjour || !this.config.enabled) return
      // 净化主机名：mDNSResponder 在 host 含非 ASCII / 特殊字符时会拒绝
      const rawHost = os.hostname?.() || 'examaware'
      const safeHost =
        rawHost
          .normalize('NFKD')
          .replace(/[^a-zA-Z0-9-]/g, '-')
          .replace(/-{2,}/g, '-')
          .replace(/^-+|-+$/g, '') || 'examaware'
      appLogger.info('[cast] bonjour publish start', {
        name: this.config.name || 'ExamAware',
        port: this.config.port,
        share: this.config.shareEnabled
      })
      this.published = this.bonjour.publish({
        name: this.config.name || 'ExamAware',
        type: 'examaware',
        port: this.config.port,
        host: `${safeHost}.local`,
        txt: {
          v: app.getVersion?.() || 'dev',
          share: this.config.shareEnabled ? '1' : '0'
        }
      })
      this.published.start?.()
      this.published?.on('error', (err) => appLogger.error('[cast] publish error', err))
      this.published?.on('up', () =>
        appLogger.info('[cast] bonjour publish up', {
          name: this.published?.name,
          port: this.published?.port
        })
      )
    })
  }

  private startBrowser() {
    if (!this.bonjour) return
    const previous = this.browser
    this.browser = null
    const stopPrev = previous
      ? new Promise<void>((resolve) => {
          try {
            previous.stop?.()
          } catch {
            /* 旧 browser 关闭时可能已 dispose，吞掉 */
          }
          setTimeout(resolve, 500).unref?.()
        })
      : Promise.resolve()
    stopPrev.then(() => {
      if (!this.bonjour) return
      this.peers.clear()
      this.browser = this.bonjour.find({ type: 'examaware' })
      appLogger.info('[cast] bonjour browse start')
      this.browser.on('up', (service) => this.onServiceUp(service))
      this.browser.on('down', (service) => this.onServiceDown(service))
      ;(this.browser as any).on?.('error', (err: Error) =>
        appLogger.error('[cast] bonjour browse error', err)
      )
      this.browser.start?.()
    })
  }

  private isSelfService(host: string, port: number, addresses: string[] = []) {
    if (port !== this.config.port) return false
    const locals = this.getLocalAddressSet()
    if (locals.has(host)) return true
    return addresses.some((addr) => locals.has(addr.replace(/\.local\.?$/, '')))
  }

  private onServiceUp(service: Service) {
    const host = (
      service.addresses?.find((a) => a.includes('.')) ||
      service.host ||
      'localhost'
    ).replace(/\.local\.?:?$/, '')
    const port = service.port
    const id = service.fqdn || `${host}:${port}`
    if (this.isSelfService(host, port, service.addresses || [])) return
    appLogger.info('[cast] peer discovered', {
      id,
      host,
      port,
      addresses: service.addresses,
      txt: service.txt
    })
    this.peers.set(id, {
      id,
      name: service.name || host,
      host,
      port,
      txt: service.txt || {},
      lastSeen: Date.now()
    })
  }

  private onServiceDown(service: Service) {
    const host = (
      service.addresses?.find((a) => a.includes('.')) ||
      service.host ||
      'localhost'
    ).replace(/\.local\.?:?$/, '')
    const port = service.port
    const id = service.fqdn || `${host}:${port}`
    appLogger.info('[cast] peer left', { id, host, port })
    this.peers.delete(id)
  }

  listPeers(): CastPeer[] {
    return Array.from(this.peers.values()).sort((a, b) => b.lastSeen - a.lastSeen)
  }

  getLocalShares() {
    return this.buildShareEntries()
  }

  getSharedConfigRaw(id?: string) {
    return getSharedConfigPayload(id)
  }

  async fetchPeerShares(peerId: string) {
    const peer = this.peers.get(peerId)
    if (!peer) return []
    const url = `http://${peer.host}:${peer.port}/share/list`
    if (!(await this.assertPeerHostSafe(peer))) {
      appLogger.warn('[cast] peer host rejected by SSRF guard', { id: peerId, host: peer.host })
      return []
    }
    try {
      const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
      if (!res.ok) return []
      const body = await res.json()
      return body?.data?.shares || body?.shares || []
    } catch (error) {
      appLogger.warn('[cast] fetch peer shares failed', error as Error)
      return []
    }
  }

  async castToPeer(peerId: string, config: string) {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error('Peer not found')
    if (!(await this.assertPeerHostSafe(peer))) {
      throw new Error('peer host rejected by SSRF guard')
    }
    const url = `http://${peer.host}:${peer.port}/cast/play`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config })
    })
    if (!res.ok) {
      throw new Error(`Cast failed: ${res.status}`)
    }
    return true
  }

  async fetchPeerConfig(peerId: string, shareId?: string) {
    const peer = this.peers.get(peerId)
    if (!peer) return null
    if (!(await this.assertPeerHostSafe(peer))) return null
    const url = `http://${peer.host}:${peer.port}/share/config${shareId ? `?id=${encodeURIComponent(shareId)}` : ''}`
    try {
      const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
      if (!res.ok) return null
      const body = await res.json()
      return body?.config ?? null
    } catch (error) {
      appLogger.warn('[cast] fetch peer config failed', error as Error)
      return null
    }
  }

  /**
   * 校验对端 host 是否在允许的网络范围内：
   * - shareEnabled 关闭时，禁止所有出站
   * - allowRemote 开启时，允许任意公网
   * - 否则只允许环回 / RFC1918 / link-local 等私有地址（局域网投屏场景）
   */
  private async assertPeerHostSafe(peer: CastPeer): Promise<boolean> {
    if (!peer?.host) return false
    if (!this.config.shareEnabled) return false
    if (this.config.allowRemote) return true
    const { isLoopback, isPrivateOrReservedIp, resolveHost } = await import('../http/utils')
    if (isLoopback(peer.host)) return true
    if (/^[\d:.]+$/.test(peer.host)) {
      // host 已是 IP 字面量：仅当为私有/保留地址时允许
      return isPrivateOrReservedIp(peer.host)
    }
    // host 是 hostname：解析后任何地址是私有的就允许
    const addrs = await resolveHost(peer.host)
    if (addrs.length === 0) return false
    return addrs.some((a) => isPrivateOrReservedIp(a))
  }

  private async createTempConfigFile(content: string) {
    const dir = path.join(app.getPath('temp'), 'examaware-cast')
    await fs.promises.mkdir(dir, { recursive: true })
    const file = path.join(dir, `cast-${Date.now()}-${randomUUID()}.ea2`)
    await fs.promises.writeFile(file, content, 'utf-8')
    return file
  }

  private registerRoutes(router: RouterInstance) {
    router.get('/health', (ctx) => {
      ctx.body = { success: true }
    })

    router.get('/share/list', (ctx) => {
      const shares = this.buildShareEntries()
      ctx.body = { success: true, shares }
    })

    router.get('/share/config', (ctx) => {
      if (!this.config.shareEnabled) {
        ctx.status = 404
        ctx.body = { success: false, message: 'share disabled' }
        return
      }
      const shareId = (ctx.query.id as string | undefined) || undefined
      const raw = getSharedConfigPayload(shareId)
      if (!raw) {
        ctx.status = 404
        ctx.body = { success: false, message: 'no config' }
        return
      }
      ctx.body = { success: true, config: raw }
    })

    router.post('/cast/play', async (ctx) => {
      const body = (ctx.request.body ?? {}) as { config?: unknown }
      const config = typeof body.config === 'string' ? body.config : null
      if (!config) {
        ctx.status = 400
        ctx.body = { success: false, message: 'config is required' }
        return
      }
      try {
        const file = await this.createTempConfigFile(config)
        createPlayerWindow(file)
        ctx.body = { success: true }
      } catch (error) {
        appLogger.error('[cast] failed to launch player', error as Error)
        ctx.status = 500
        ctx.body = { success: false, message: 'failed to launch player' }
      }
    })
  }

  async start() {
    if (!this.config.enabled) return
    await this.stop()

    const { port, shifted } = await findAvailablePort(this.config.port, 10)
    if (shifted) {
      appLogger.warn(`[cast] configured port ${this.config.port} is busy, falling back to ${port}`)
    }
    this.config.port = port
    // 仅在用户配置的端口与实际端口一致时才持久化，避免覆盖用户的原始配置
    if (!shifted) {
      await patchConfig({ cast: this.config })
    }

    await this.ensureBonjourStarted()
    this.publishBonjour()
    this.startBrowser()

    this.app = new Koa()
    this.app.use(async (ctx, next) => {
      const start = Date.now()
      try {
        await next()
      } finally {
        appLogger.info(`[cast] ${ctx.method} ${ctx.path} -> ${ctx.status} ${Date.now() - start}ms`)
      }
    })

    this.app.use(
      bodyParser({
        enableTypes: ['json', 'text'],
        jsonLimit: '2mb',
        textLimit: '2mb'
      })
    )

    const router = new Router()
    this.registerRoutes(router as RouterInstance)
    this.app.use(router.routes())
    this.app.use(router.allowedMethods())

    this.server = this.app.listen(port, '0.0.0.0', () => {
      appLogger.info(`[cast] service listening on http://0.0.0.0:${port}`)
    })
  }

  async stop() {
    this.published?.stop?.()
    this.published = null
    this.browser?.stop()
    this.browser = null
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()))
    }
    this.server = null
    this.app = null
  }

  async restart() {
    await this.stop()
    await this.start()
  }

  async dispose() {
    await this.stop()
    if (this.bonjour) {
      this.bonjour.unpublishAll?.(() => {})
      this.bonjour.destroy()
    }
    this.bonjour = null
    this.peers.clear()
  }
}

export const castService = new CastService()
