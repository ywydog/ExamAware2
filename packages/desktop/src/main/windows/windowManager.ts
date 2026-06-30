import { BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import type { MainContext } from '../runtime/context'
import * as path from 'path'
import { is } from '@electron-toolkit/utils'
import { appLogger } from '../logging/winstonLogger'
import { getConfig, onConfigChanged } from '../configStore'

export interface CreateContext {
  isDev: boolean
  resolveRendererUrl: (route: string) => string | { file: string; hash: string }
  commonOptions: () => Electron.BrowserWindowConstructorOptions
}

export interface WindowFactoryResult {
  id: string
  route: string
  options: Electron.BrowserWindowConstructorOptions
  setup?: (win: BrowserWindow) => void | (() => void)
  /**
   * 当 windowManager 复用已存在的窗口时调用（典型场景：外部"播放/编辑"调用传入新文件路径）。
   * 工厂可以用它来通知 renderer 处理新参数（重新加载文件等），
   * 避免"setup 不执行 → 新参数被丢弃"的问题。
   */
  revive?: (win: BrowserWindow) => void
  externalOpenHandler?: boolean
}

type WindowRecord = { win: BrowserWindow; cleanup?: () => void }

const LIGHT_BG = '#f5f6f7'
const DARK_BG = '#0f172a'

export class WindowManager {
  private windows = new Map<string, WindowRecord>()
  private ctx: MainContext | undefined
  private backgroundColor = LIGHT_BG
  private disposeConfigWatcher: (() => void) | undefined
  private nativeThemeListener: (() => void) | undefined

  setContext(ctx: MainContext) {
    this.ctx = ctx
    this.refreshBackgroundColor()
    this.disposeConfigWatcher?.()
    this.disposeConfigWatcher = onConfigChanged(() => this.refreshBackgroundColor())
    if (!this.nativeThemeListener) {
      this.nativeThemeListener = () => this.refreshBackgroundColor()
      nativeTheme.on('updated', this.nativeThemeListener)
    }
  }

  get(id: string): BrowserWindow | undefined {
    return this.windows.get(id)?.win
  }

  isOpen(id: string): boolean {
    return this.windows.has(id) && !this.windows.get(id)!.win.isDestroyed()
  }

  close(id: string): void {
    const rec = this.windows.get(id)
    if (rec) {
      rec.win.close()
    }
  }

  async open(
    factory: (ctx: CreateContext) => WindowFactoryResult,
    forceRecreate = false
  ): Promise<BrowserWindow> {
    const ctx: CreateContext = {
      isDev: is.dev,
      resolveRendererUrl: (route: string) => {
        if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
          return `${process.env['ELECTRON_RENDERER_URL']}#/${route}`
        }
        // 注意：hash 路径必须以 "/" 开头，与 Vue Router 的 createWebHashHistory 匹配
        // （否则路由会落到默认的 MainpageView，让"播放器窗口"看起来像主界面）
        return {
          file: path.resolve(__dirname, '../renderer/index.html'),
          hash: `/${route}`
        }
      },
      commonOptions: () => ({
        show: false,
        autoHideMenuBar: true,
        // Follow theme background to avoid white flash during hide/close
        backgroundColor: this.backgroundColor,
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.mjs'),
          sandbox: false
        }
      })
    }

    const { id, route, options, setup, revive, externalOpenHandler = true } = factory(ctx)

    const existing = this.windows.get(id)
    if (existing && !existing.win.isDestroyed() && !forceRecreate) {
      const { win } = existing
      try {
        let didRevive = false
        if (win.isMinimized()) {
          win.restore()
          didRevive = true
        }
        if (!win.isVisible()) {
          win.show()
          didRevive = true
        }
        if (didRevive && !win.isFocused()) {
          win.focus()
        }
        // 复用现有窗口时，给工厂一次机会处理新参数（例如传入新文件路径）
        if (revive) {
          try {
            revive(win)
          } catch (error) {
            appLogger.error('[windowManager] revive callback failed', error as Error)
          }
        }
      } catch (error) {
        appLogger.error('[windowManager] failed to revive existing window', error as Error)
      }
      return win
    }

    if (existing && !existing.win.isDestroyed()) {
      existing.win.destroy()
      this.windows.delete(id)
    }

    const win = new BrowserWindow(options)
    // track window for disposal safety
    this.ctx?.windows.track(win)

    const showWindow = () => {
      try {
        if (!win.isDestroyed() && !win.isVisible()) {
          win.show()
        }
      } catch (error) {
        appLogger.error('[windowManager] failed to show window', error as Error)
      }
    }

    const onRendererReady = (event: Electron.IpcMainEvent, payload?: { windowId?: number }) => {
      if (event.sender !== win.webContents) return
      if (payload?.windowId && payload.windowId !== win.id) return
      showWindow()
    }

    ipcMain.on('renderer:ready', onRendererReady)
    const showFallbackTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        appLogger.warn('[windowManager] renderer ready timeout, showing window anyway', {
          id,
          route
        })
        showWindow()
      }
    }, 5000)

    // default: open external links in system browser
    if (externalOpenHandler) {
      win.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url)
        return { action: 'deny' }
      })
    }

    // Load renderer by route
    const resolved = ctx.resolveRendererUrl(route)
    if (typeof resolved === 'string') {
      win.loadURL(resolved)
    } else {
      win.loadFile(resolved.file, { hash: resolved.hash })
    }

    let cleanup: (() => void) | undefined
    if (setup) {
      const res = setup(win)
      if (typeof res === 'function') cleanup = res
    }

    win.on('closed', () => {
      if (cleanup) {
        try {
          cleanup()
        } catch {}
      }
      clearTimeout(showFallbackTimer)
      ipcMain.off('renderer:ready', onRendererReady)
      this.windows.delete(id)
    })

    this.windows.set(id, { win, cleanup })
    return win
  }

  private refreshBackgroundColor() {
    try {
      const mode = (getConfig('appearance.theme', 'auto') as 'light' | 'dark' | 'auto') ?? 'auto'
      const useDark = mode === 'dark' || (mode === 'auto' && nativeTheme.shouldUseDarkColors)
      const next = useDark ? DARK_BG : LIGHT_BG
      this.backgroundColor = next
      for (const { win } of this.windows.values()) {
        try {
          if (!win.isDestroyed()) {
            win.setBackgroundColor(next)
          }
        } catch {}
      }
    } catch (error) {
      appLogger.warn('[windowManager] refreshBackgroundColor failed', error as Error)
    }
  }
}

export const windowManager = new WindowManager()
