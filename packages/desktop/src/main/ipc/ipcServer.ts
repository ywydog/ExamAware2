import * as net from 'net'
import * as fs from 'fs'
import { appLogger } from '../logging/winstonLogger'
import { examEventService } from '../exam/examEventService'
import type { ExamEventMessage } from '../exam/examEventService'

const IPC_NAME = 'ExamAware2.examaware2'

function getIpcAddress(): { address: string; isWindows: boolean } {
  if (process.platform === 'win32') {
    return { address: `\\\\.\\pipe\\${IPC_NAME}`, isWindows: true }
  }
  return { address: `/tmp/${IPC_NAME}.sock`, isWindows: false }
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

  // examEventService 事件监听器引用
  private examEventHandler: ((msg: ExamEventMessage) => void) | null = null

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
      } catch {
        // 文件不存在，忽略
      }
    }

    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket)
      })

      this.server.on('error', (err: any) => {
        appLogger.error(`[ipc] IPC 服务器错误: ${err.message}`)
        this.isRunning = false
        resolve(false)
      })

      this.server.listen(address, () => {
        this.isRunning = true
        appLogger.info(`[ipc] IPC 服务器已启动，监听: ${address}`)
        // 注册考试事件监听，将事件推送给所有已订阅的 IPC 客户端
        this.setupEventForwarding()
        resolve(true)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return

    // 移除考试事件监听
    this.teardownEventForwarding()

    // 关闭所有客户端连接
    for (const [socket] of this.clients) {
      try { socket.destroy() } catch { /* ignore */ }
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
    appLogger.info(`[ipc] 客户端已连接 #${clientId} (${client.remoteAddress})，当前连接数: ${this.clients.size}`)

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
            const responseStr = JSON.stringify(response) + '\n'
            socket.write(responseStr, 'utf-8')
          })
          .catch((err) => {
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
      this.broadcastToSubscribedClients(msg)
    }
    examEventService.on('exam-event', this.examEventHandler)
    appLogger.info('[ipc] 已注册考试事件转发监听')
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
   */
  private broadcastToSubscribedClients(msg: ExamEventMessage) {
    const eventStr = JSON.stringify(msg) + '\n'
    let sentCount = 0

    for (const [socket, client] of this.clients) {
      if (!client.subscribedEvents) continue

      try {
        if (!socket.destroyed && socket.writable) {
          socket.write(eventStr, 'utf-8')
          sentCount++
        }
      } catch (err: any) {
        appLogger.debug(`[ipc] 向客户端 #${client.id} 推送事件失败: ${err.message}`)
      }
    }

    if (sentCount > 0) {
      appLogger.info(`[ipc] 考试事件已推送给 ${sentCount} 个客户端: ${msg.event}`)
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
