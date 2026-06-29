import * as net from 'net'
import * as fs from 'fs'
import { appLogger } from '../logging/winstonLogger'
import { examEventService } from '../exam/examEventService'
import type { ExamEventMessage } from '../exam/examEventService'

const IPC_NAME = 'ExamAware2.examaware2'

/**
 * 把 IPC name 规整为 raw name（替换跨平台不合法字符）。
 * 与客户端 ExamAwareIpcClient.NormalizeIpcName 行为保持一致。
 */
function normalizeIpcName(name: string): string {
  if (!name) return name
  let n = name
  if (n.startsWith('\\\\.\\pipe\\')) {
    n = n.substring('\\\\.\\pipe\\'.length)
  }
  return n.replace(/[\\/\s:]/g, '_')
}

function getIpcAddress(): { address: string; isWindows: boolean } {
  const name = normalizeIpcName(IPC_NAME)
  if (process.platform === 'win32') {
    return { address: `\\\\.\\pipe\\${name}`, isWindows: true }
  }
  return { address: `/tmp/${name}.sock`, isWindows: false }
}

interface IpcRequest {
  type: string
  payload: Record<string, any>
}

interface IpcResponse {
  success: boolean
  type: string
  result?: any
  error?: string
}

interface ConnectedClient {
  id: number
  remoteAddress: string
  connectedAt: number
  lastActivityAt: number
  subscribedEvents: boolean
}

class IpcServer {
  private server: net.Server | null = null
  private isRunning = false
  private nextClientId = 0
  private clients: Map<net.Socket, ConnectedClient> = new Map()

  // 命令处理器映射
  private handlers: Map<string, (payload: Record<string, any>) => Promise<any>> = new Map()

  // 缓存最近发生的考试事件，用于新订阅客户端立即同步状态
  private latestEvents: Map<string, ExamEventMessage> = new Map()

  // examEventService 事件监听器引用
  private examEventHandler: ((msg: ExamEventMessage) => void) | null = null

  // 可选：受限命令（play-from-url、play-from-file、stop 等）在执行前的鉴权回调
  // 返回 true 表示放行；false 或抛错表示拒绝。
  private commandAuthenticator: ((type: string, socket: net.Socket) => Promise<boolean>) | null =
    null

  // 客户端最大并发数（防止 fd 耗尽）
  private maxClients = 32

  constructor() {
    // 构造时即注册事件监听，确保任何时刻发生的事件都不会丢失
    this.setupEventForwarding()
  }

  setMaxClients(n: number) {
    this.maxClients = Math.max(1, n | 0)
  }

  setCommandAuthenticator(fn: ((type: string, socket: net.Socket) => Promise<boolean>) | null) {
    this.commandAuthenticator = fn
  }

  registerHandler(type: string, handler: (payload: Record<string, any>) => Promise<any>) {
    this.handlers.set(type, handler)
  }

  async start(): Promise<boolean> {
    if (this.isRunning) {
      appLogger.warn('[ipc] IPC 服务器已在运行中')
      return true
    }

    const { address, isWindows } = getIpcAddress()

    // Linux 下清理旧的 socket 文件
    if (!isWindows) {
      try {
        fs.unlinkSync(address)
      } catch (err: any) {
        if (err?.code && err.code !== 'ENOENT') {
          appLogger.warn(
            `[ipc] 清理旧 socket 文件失败: ${err.message}（可能因权限问题，listen 仍可能成功）`
          )
        }
      }
    }

    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        this.handleConnection(socket)
      })

      let settled = false
      const onError = (err: any) => {
        if (settled) return
        settled = true
        appLogger.error(`[ipc] IPC 服务器错误: ${err.message}`)
        try {
          server.close()
        } catch {}
        this.isRunning = false
        this.server = null
        resolve(false)
      }
      server.on('error', onError)

      server.listen(address, () => {
        if (settled) return
        settled = true
        this.server = server
        this.isRunning = true
        appLogger.info(`[ipc] IPC 服务器已启动，监听: ${address}`)
        resolve(true)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return

    // 移除考试事件监听
    this.teardownEventForwarding()

    // 清空缓存事件
    this.latestEvents.clear()

    // 关闭所有客户端连接
    for (const [socket] of this.clients) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.isRunning = false
        this.server = null
        appLogger.info('[ipc] IPC 服务器已停止')

        // Linux 下清理 socket 文件
        const { address, isWindows } = getIpcAddress()
        if (!isWindows) {
          try {
            fs.unlinkSync(address)
          } catch {
            // 忽略
          }
        }
        resolve()
      })
    })
  }

  private handleConnection(socket: net.Socket) {
    if (this.clients.size >= this.maxClients) {
      appLogger.warn(`[ipc] 拒绝新连接：已达最大客户端数 ${this.maxClients}`)
      try {
        socket.end()
      } catch {}
      try {
        socket.destroy()
      } catch {}
      return
    }
    const clientId = this.nextClientId++
    const now = Date.now()
    const client: ConnectedClient = {
      id: clientId,
      remoteAddress: socket.remoteAddress || 'unknown',
      connectedAt: now,
      lastActivityAt: now,
      subscribedEvents: false
    }
    this.clients.set(socket, client)
    appLogger.info(
      `[ipc] 客户端已连接 #${clientId} (${client.remoteAddress})，当前连接数: ${this.clients.size}`
    )

    let buffer = ''

    socket.on('data', (data) => {
      client.lastActivityAt = Date.now()
      buffer += data.toString('utf-8')

      // 按换行符分割消息
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // 保留未完成的部分

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        this.processMessage(trimmed, socket)
          .then((response) => {
            if (socket.destroyed || !socket.writable) return
            socket.write(JSON.stringify(response) + '\n', 'utf-8')
          })
          .catch((err) => {
            if (socket.destroyed || !socket.writable) return
            const errorResponse: IpcResponse = {
              success: false,
              type: 'unknown',
              error: `处理消息时出错: ${err.message}`
            }
            socket.write(JSON.stringify(errorResponse) + '\n', 'utf-8')
          })
      }
    })

    socket.on('close', () => {
      this.clients.delete(socket)
      appLogger.info(`[ipc] 客户端已断开 #${clientId}，当前连接数: ${this.clients.size}`)
    })

    socket.on('error', (err) => {
      appLogger.debug(`[ipc] 客户端连接错误 #${clientId}: ${err.message}`)
      this.clients.delete(socket)
      try {
        socket.destroy()
      } catch {}
    })
  }

  private async processMessage(messageStr: string, socket?: net.Socket): Promise<IpcResponse> {
    let request: IpcRequest
    try {
      request = JSON.parse(messageStr)
    } catch {
      return { success: false, type: 'unknown', error: '无效的 JSON 格式' }
    }

    const { type, payload } = request
    appLogger.info(`[ipc] 收到命令: ${type}`)

    // ping / subscribe-events 始终允许；其它受限命令需要鉴权
    const requiresAuth = type !== 'ping' && type !== 'subscribe-events'
    if (requiresAuth && this.commandAuthenticator && socket) {
      try {
        const ok = await this.commandAuthenticator(type, socket)
        if (!ok) {
          return { success: false, type, error: '未授权' }
        }
      } catch (err: any) {
        return { success: false, type, error: `鉴权失败: ${err?.message || 'unknown'}` }
      }
    }

    // ping 命令
    if (type === 'ping') {
      return { success: true, type: 'ping', result: 'pong' }
    }

    // 订阅考试事件命令
    if (type === 'subscribe-events' && socket) {
      const client = this.clients.get(socket)
      if (client) {
        client.subscribedEvents = true
        appLogger.info(`[ipc] 客户端 #${client.id} 已订阅考试事件`)
        // 立即向该客户端推送缓存的最新事件，确保插件连接时已处于触发状态也能收到
        this.flushLatestEventsToClient(socket, client)
      }
      return { success: true, type: 'subscribe-events', result: 'subscribed' }
    }

    // 查找处理器
    const handler = this.handlers.get(type)
    if (!handler) {
      return { success: false, type, error: `未知的命令类型: ${type}` }
    }

    try {
      const result = await handler(payload || {})
      return { success: true, type, result }
    } catch (err: any) {
      appLogger.error(`[ipc] 命令处理失败: ${type} - ${err.message}`)
      return { success: false, type, error: err.message || '命令处理失败' }
    }
  }

  /**
   * 注册 examEventService 事件监听，将考试事件转发给所有已订阅的 IPC 客户端
   */
  private setupEventForwarding() {
    if (this.examEventHandler) return // 已注册

    this.examEventHandler = (msg: ExamEventMessage) => {
      // 缓存最近一次的每种事件，便于新订阅客户端立即同步
      this.latestEvents.set(msg.event, msg)
      // 收到 exam-presentation-stop 表示一个完整的考试放映周期结束，
      // 此时应清空缓存，避免多轮考试后回放时把上轮的事件带到新客户端造成状态错乱
      if (msg.event === 'exam-presentation-stop') {
        this.latestEvents.clear()
        this.latestEvents.set(msg.event, msg)
      }
      this.broadcastToSubscribedClients(msg)
    }
    examEventService.on('exam-event', this.examEventHandler)
    appLogger.info('[ipc] 已注册考试事件转发监听')
  }

  /**
   * 向指定客户端推送缓存的最新事件
   */
  private flushLatestEventsToClient(socket: net.Socket, client: ConnectedClient) {
    if (!client.subscribedEvents || this.latestEvents.size === 0) return

    // Map 的迭代顺序是 key 的插入顺序，并不等于事件的时间顺序。
    // 当同一事件类型被多次更新（key 复用、value 替换）时，按插入序回放会得到错乱的时序，
    // 例如 [exam-start(new), exam-end(old)]，导致新客户端状态错位。
    // 这里按时间戳升序排序，保证回放顺序与发生顺序一致。
    const sortedEvents = Array.from(this.latestEvents.values()).sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
    )

    let sentCount = 0
    for (const msg of sortedEvents) {
      try {
        if (!socket.destroyed && socket.writable) {
          socket.write(JSON.stringify(msg) + '\n', 'utf-8')
          sentCount++
        }
      } catch (err: any) {
        appLogger.debug(`[ipc] 向客户端 #${client.id} 同步历史事件失败: ${err.message}`)
      }
    }

    if (sentCount > 0) {
      appLogger.info(`[ipc] 已向客户端 #${client.id} 同步 ${sentCount} 条历史事件（按时间戳排序）`)
    }
  }

  /**
   * 移除 examEventService 事件监听
   */
  private teardownEventForwarding() {
    if (this.examEventHandler) {
      examEventService.off('exam-event', this.examEventHandler)
      this.examEventHandler = null
      appLogger.info('[ipc] 已移除考试事件转发监听')
    }
  }

  /**
   * 向所有已订阅考试事件的 IPC 客户端广播事件消息
   * 处理 write 背压：write() 返回 false 时挂 drain 事件，必要时把 socket 从 clients 移除
   */
  private broadcastToSubscribedClients(msg: ExamEventMessage) {
    const eventStr = JSON.stringify(msg) + '\n'
    let sentCount = 0
    let backpressured = 0

    for (const [socket, client] of this.clients) {
      if (!client.subscribedEvents) continue

      if (socket.destroyed || !socket.writable) {
        this.clients.delete(socket)
        continue
      }

      try {
        const ok = socket.write(eventStr, 'utf-8')
        if (ok === false) {
          backpressured++
          // 挂一次性 drain 监听；若 socket 在 drain 前被关闭则清理
          const onDrain = () => {
            socket.off('error', onError)
          }
          const onError = () => {
            socket.off('drain', onDrain)
            this.clients.delete(socket)
          }
          socket.once('drain', onDrain)
          socket.once('error', onError)
        }
        sentCount++
      } catch (err: any) {
        appLogger.debug(`[ipc] 向客户端 #${client.id} 推送事件失败: ${err.message}`)
        this.clients.delete(socket)
        try {
          socket.destroy()
        } catch {}
      }
    }

    if (sentCount > 0) {
      appLogger.info(
        `[ipc] 考试事件已推送给 ${sentCount} 个客户端: ${msg.event}` +
          (backpressured > 0 ? `（其中 ${backpressured} 个处于背压）` : '')
      )
    }
  }

  get IsRunning(): boolean {
    return this.isRunning
  }

  get ClientCount(): number {
    return this.clients.size
  }

  getConnectionStatus(): { isRunning: boolean; clientCount: number; clients: ConnectedClient[] } {
    return {
      isRunning: this.isRunning,
      clientCount: this.clients.size,
      clients: Array.from(this.clients.values())
    }
  }
}

export const ipcServer = new IpcServer()
export { IPC_NAME }
