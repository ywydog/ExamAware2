import { BrowserWindow, ipcMain } from 'electron'
import * as fs from 'fs'
import { is } from '@electron-toolkit/utils'
import { windowManager } from './windowManager'
import { appLogger } from '../logging/winstonLogger'
import { setSharedConfig } from '../state/sharedConfigStore'

export function createPlayerWindow(configPath: string): BrowserWindow {
  // 抽取"读取文件 → 写共享配置 → 通知 renderer"的逻辑，
  // 让 setup（新建窗口）和 revive（复用窗口，传入新文件）共用同一份实现。
  const loadAndSend = (playerWindow: BrowserWindow) => {
    fs.readFile(configPath, 'utf-8', (err, data) => {
      if (err) {
        appLogger.error('Failed to read config file', err as Error)
        return
      }

      setSharedConfig(data)

      const sendConfig = () => {
        if (playerWindow.isDestroyed()) return
        try {
          playerWindow.webContents.send('load-config', data)
          appLogger.debug('Config file loaded and sent to renderer (len=%d)', data?.length ?? 0)
        } catch (error) {
          appLogger.warn('Failed to send load-config to player renderer', error as Error)
        }
      }

      if (playerWindow.webContents.isLoading()) {
        playerWindow.webContents.once('did-finish-load', sendConfig)
      } else {
        sendConfig()
      }
    })
  }

  return windowManager.open(({ commonOptions }) => ({
    id: 'player',
    route: 'playerview',
    options: {
      ...commonOptions(),
      width: 1920,
      height: 1080,
      fullscreen: !is.dev,
      kiosk: !is.dev
    },
    setup: (playerWindow) => {
      if (!is.dev) {
        playerWindow.setAlwaysOnTop(true, 'screen-saver')
      }

      let allowClose = false
      const handleClose = (e: Electron.Event) => {
        if (!allowClose) {
          e.preventDefault()
          playerWindow.focus()
          return false
        }
        return true
      }
      playerWindow.on('close', handleClose)

      const exitChannel = 'player-window-exit'
      const onRendererExit = (event: Electron.IpcMainEvent) => {
        if (event.sender === playerWindow.webContents) {
          allowClose = true
          playerWindow.close()
        }
      }
      ipcMain.on(exitChannel, onRendererExit)

      // windowManager 已统一设置外链打开处理

      playerWindow.webContents.on('before-input-event', (event, input) => {
        const key = (input.key || '').toLowerCase()
        const ctrlOrCmd = input.control || input.meta
        const alt = input.alt
        const shift = input.shift

        const block =
          // 退出/关闭/刷新
          (ctrlOrCmd && (key === 'q' || key === 'w' || key === 'r')) ||
          // 开发者工具
          (ctrlOrCmd && shift && key === 'i') ||
          // 最小化
          (ctrlOrCmd && key === 'm') ||
          // 切换全屏
          key === 'f11' ||
          // Windows 下的 Alt+F4（跨平台防御）
          (alt && key === 'f4')

        if (block) {
          event.preventDefault()
        }
      })

      loadAndSend(playerWindow)

      // 返回清理函数供 WindowManager 调用
      return () => {
        ipcMain.off(exitChannel, onRendererExit)
      }
    },
    // 窗口已存在时收到新文件路径：重新读取并通知现有 renderer
    revive: (playerWindow) => {
      appLogger.info('[player] 复用现有窗口，载入新文件', { configPath })
      loadAndSend(playerWindow)
    }
  })) as unknown as BrowserWindow
}
