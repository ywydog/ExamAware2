import * as net from 'net'
import * as fs from 'fs'
import { appLogger } from '../logging/winstonLogger'

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

class IpcServer {
  private server: net.Server | null = null
  private isRunning = false

  // 命令处理器映射
  private handlers: Map<string, (payload: Record<string, any>) => Promise<any>> = new Map()

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
        resolve(true)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return

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
    let buffer = ''

    socket.on('data', (data) => {
      buffer += data.toString('utf-8')

      // 按换行符分割消息
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // 保留未完成的部分

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        this.processMessage(trimmed)
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

    socket.on('error', (err) => {
      appLogger.debug(`[ipc] 客户端连接错误: ${err.message}`)
    })
  }

  private async processMessage(messageStr: string): Promise<IpcResponse> {
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

  get IsRunning(): boolean {
    return this.isRunning
  }
}

export const ipcServer = new IpcServer()
export { IPC_NAME }
