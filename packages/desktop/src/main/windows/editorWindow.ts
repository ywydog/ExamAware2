import { BrowserWindow, ipcMain } from 'electron'
import { windowManager } from './windowManager'
import {
  buildTitleBarOverlay,
  applyTitleBarOverlay,
  attachTitleBarOverlayLifecycle
} from './titleBarOverlay'
import { appLogger } from '../logging/winstonLogger'

/**
 * 编辑器启动时要打开的文件路径（用"拉"模式暴露给 renderer）。
 *
 * 旧实现是在 `ready-to-show` 推 `open-file-at-startup` 事件，
 * 但 renderer 的监听器在 useExamEditor 的 onMounted 里注册，
 * 触发时机晚于 ready-to-show → 冷启动时事件直接被丢掉。
 * 改为：主进程保留最新路径，renderer 在 onMounted 主动 `consumeEditorStartupFile()` 拉取。
 */
let pendingEditorFile: string | null = null

function setPendingEditorFile(p: string): void {
  pendingEditorFile = p
  appLogger.info('[editor] 记录待打开的启动文件', { p })
}

function consumePendingEditorFile(): string | null {
  if (!pendingEditorFile) return null
  const p = pendingEditorFile
  pendingEditorFile = null
  appLogger.info('[editor] renderer 拉取启动文件', { p })
  return p
}

export function createEditorWindow(filePath?: string): BrowserWindow {
  if (filePath) {
    setPendingEditorFile(filePath)
  }
  return windowManager.open(({ commonOptions }) => {
    const winOptions: Electron.BrowserWindowConstructorOptions = {
      ...commonOptions(),
      width: 920,
      height: 700
    }

    if (process.platform !== 'linux') {
      winOptions.titleBarStyle = 'hidden'
      ;(winOptions as any).titleBarOverlay = {
        ...buildTitleBarOverlay()
      }
      // macOS 交通灯位置可选
      if (process.platform === 'darwin') {
        ;(winOptions as any).trafficLightPosition = { x: 10, y: 10 }
      }
    }

    return {
      id: 'editor',
      route: 'editor',
      options: winOptions,
      setup(win) {
        applyTitleBarOverlay(win)
        attachTitleBarOverlayLifecycle(win)
        const FORCE_CLOSE_FLAG = '__ea_force_close__'

        // Intercept close to ask renderer; renderer will call back with window-close IPC when confirmed
        win.on('close', (e) => {
          if ((win as any)[FORCE_CLOSE_FLAG]) {
            delete (win as any)[FORCE_CLOSE_FLAG]
            return
          }
          e.preventDefault()
          try {
            win.webContents.send('editor:request-close')
          } catch {}
        })
      },
      // 窗口已存在时收到新文件路径：把它记下来并推给现有 renderer（renderer 监听器
      // 已在 onMounted 注册，不存在竞态）
      revive(win) {
        if (filePath) {
          try {
            win.webContents.send('open-file-at-startup', filePath)
            appLogger.info('[editor] 向已打开的编辑器推送新文件', { filePath })
          } catch (err) {
            appLogger.warn('[editor] 向已打开的编辑器推送文件失败', err as Error)
          }
        }
      }
    }
  }) as unknown as BrowserWindow
}

/**
 * 注册 renderer 主动拉取启动文件路径的 IPC 处理器。
 * 只在注册时挂一次（冷启动 / 拉取 / 二次拉取都通过同一个 handler）。
 */
export function registerEditorStartupFileIpc(): void {
  ipcMain.handle('editor:consume-startup-file', () => {
    return consumePendingEditorFile()
  })
}
