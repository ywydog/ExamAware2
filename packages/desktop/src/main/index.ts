import { app, BrowserWindow, globalShortcut, Menu, protocol } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { isLoopback } from './http/utils'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './windows/mainWindow'
import { createEditorWindow } from './windows/editorWindow'
import { createSettingsWindow } from './windows/settingsWindow'
import { createPlayerWindow } from './windows/playerWindow'
import { windowManager } from './windows/windowManager'
import { registerIpcHandlers } from './ipcHandlers'
import { patchConsoleWithLogger, appLogger, initLoggingConfig } from './logging/winstonLogger'
import { registerTimeSyncHandlers } from './ipcHandlers/timeServiceHandler'
import {
  initializeTimeSync,
  getTimeSyncInfo,
  getSyncedTime,
  performTimeSync,
  applyTimeConfig,
  ensureTimeSyncInitialized,
  isTimeSyncInitialized,
  getCurrentTimeMs
} from './ntpService/timeService'
import { httpApiService } from './http/httpApiService'
import { examEventService } from './exam/examEventService'
import { castService } from './cast/castService'
import { ipcServer } from './ipc/ipcServer'
import { createMainContext } from './runtime/context'
import { ensureAppTray, shouldSuppressActivate, isTrayPopoverVisible } from './tray'
import { PluginHost, createFilePreferenceStore } from './plugin'
import { deepLinkManager, type DeepLinkService } from './runtime/deepLink'
import type { DeepLinkPayload } from '../shared/types/deepLink'
import { applyDeepLinkControllers } from './deepLink/decorators'
import { CoreDeepLinkController } from './deepLink/coreDeepLinkController'
import { composeVersionLabel } from '../shared/appInfo'
import bannerText from './banner.txt?raw'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  },
  {
    scheme: 'examaware',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: true
    }
  }
])

if (process.platform === 'darwin') {
  // Enable system HDR output on macOS when the display supports it.
  app.commandLine.appendSwitch('enable-features', 'UseSkiaRenderer,UseDisplayHDR')
  app.commandLine.appendSwitch('force-color-profile', 'display-p3')
}

const STARTUP_BANNER = bannerText.trim()

function printStartupBanner() {
  try {
    const version = app?.getVersion?.() ?? 'dev'
    STARTUP_BANNER.split('\n').forEach((line) => console.log(line))
    appLogger.info(` ExamAware Desktop v${version}`)
    appLogger.info(' =================================')
  } catch (error) {
    STARTUP_BANNER.split('\n').forEach((line) => appLogger.info(line))
    appLogger.warn('[banner] failed to print version', error as Error)
  }
}

printStartupBanner()
patchConsoleWithLogger()
initLoggingConfig()
appLogger.info('Logger initialized')
httpApiService.loadConfig()
castService.loadConfig()

let pluginHost: PluginHost | null = null
let disposeDeepLinks: (() => void) | undefined

// Ensure a friendly app name in development and across platforms (especially macOS About menu)
try {
  if (app.getName() !== 'ExamAware') {
    app.setName('ExamAware')
  }
  // macOS About panel info
  if (process.platform === 'darwin' && (app as any).setAboutPanelOptions) {
    const versionLabel = composeVersionLabel(app.getVersion())
    ;(app as any).setAboutPanelOptions({
      applicationName: 'ExamAware',
      applicationVersion: versionLabel,
      copyright: `© ${new Date().getFullYear()} ExamAware Contributors`,
      authors: ['ExamAware Team'],
      website: 'https://github.com/ExamAware/ExamAware2',
      license: 'GPLv3'
    })
  }
} catch (error) {
  appLogger.warn('[app] failed to set app name / about panel info', error as Error)
}

// 用于存储启动时的文件路径
let fileToOpen: string | null = null

const ensureTempDir = async (dir: string) => {
  await fs.promises.mkdir(dir, { recursive: true })
  return dir
}

const createTempConfigFromBase64 = async (b64: string, prefix: string) => {
  const decoded = Buffer.from(b64, 'base64').toString('utf-8')
  const tempDir = path.join(app.getPath('temp'), 'examaware-deeplink')
  await ensureTempDir(tempDir)
  const file = path.join(tempDir, `${prefix}-${Date.now()}.json`)
  await fs.promises.writeFile(file, decoded, 'utf-8')
  return file
}

// 临时播放器文件目录：所有 IPC 拉取的 / 远程传过来的播放配置都写到这里。
// 退出时统一清理，避免长期运行的 ExamAware 临时文件堆积。
const PLAYER_TEMP_DIR = (() => {
  if (process.env['EXAMAWARE_TEMP_DIR']) {
    return path.join(process.env['EXAMAWARE_TEMP_DIR'], 'examaware-player')
  }
  try {
    return path.join(app.getPath('temp'), 'examaware-player')
  } catch {
    return path.join(require('os').tmpdir(), 'examaware-player')
  }
})()
const playerTempFiles = new Set<string>()

const createTempPlayerFile = async (data: string) => {
  await ensureTempDir(PLAYER_TEMP_DIR)
  const file = path.join(PLAYER_TEMP_DIR, `ipc-${randomUUID()}.ea2`)
  await fs.promises.writeFile(file, data, 'utf-8')
  playerTempFiles.add(file)
  return file
}

const cleanupPlayerTempFiles = async () => {
  for (const f of playerTempFiles) {
    try {
      await fs.promises.unlink(f)
    } catch {
      /* file may already be gone */
    }
  }
  playerTempFiles.clear()
}
// 捕获通过自定义协议传入的初始参数
const initialDeepLink = process.argv.find((arg) => arg.startsWith('examaware://')) || null
if (initialDeepLink) {
  deepLinkManager.enqueue(initialDeepLink)
}

// 支持通过环境变量传入 base64 配置，便于调试：EXAMAWARE_DEEPLINK_PLAYER / EXAMAWARE_DEEPLINK_EDITOR
const envPlayerData = process.env.EXAMAWARE_DEEPLINK_PLAYER
const envEditorData = process.env.EXAMAWARE_DEEPLINK_EDITOR
if (envPlayerData) {
  createTempConfigFromBase64(envPlayerData, 'player').then((file) => {
    deepLinkManager.enqueue(`examaware://player?file=${encodeURIComponent(file)}`)
  })
}
if (envEditorData) {
  createTempConfigFromBase64(envEditorData, 'editor').then((file) => {
    deepLinkManager.enqueue(`examaware://editor?file=${encodeURIComponent(file)}`)
  })
}

// 单实例锁，确保协议调用复用已有实例
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', (_event, argv) => {
  const deepLinkArg = argv.find((arg) => arg.startsWith('examaware://'))
  if (deepLinkArg) {
    deepLinkManager.enqueue(deepLinkArg)
  }
  try {
    const main = windowManager.get('main') ?? createMainWindow()
    if (main) {
      if (main.isMinimized()) main.restore()
      if (!main.isVisible()) main.show()
      main.focus()
    }
  } catch (error) {
    appLogger.error('[deeplink] failed to revive main window on second-instance', error as Error)
  }
})

app.whenReady().then(async () => {
  const { ctx: _mainCtx, dispose: disposeMainCtx } = createMainContext()
  windowManager.setContext(_mainCtx)
  electronApp.setAppUserModelId('org.examaware')
  ensurePluginProtocol()
  ensureExamawareProtocol()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const disposeIpc = registerIpcHandlers(_mainCtx)
  // macOS 常用快捷键：Command+逗号 打开设置（聚焦“关于”页可由二级逻辑决定，这里默认普通设置首页）
  try {
    globalShortcut.register('CommandOrControl+,', () => {
      try {
        createSettingsWindow()
      } catch (e) {
        appLogger.error('open settings via shortcut failed', e as Error)
      }
    })
  } catch (e) {
    appLogger.error('register shortcut failed', e as Error)
  }
  const disposeTimeIpc = registerTimeSyncHandlers()
  // 启动内置 HTTP API（端口冲突自动处理）
  try {
    await httpApiService.start()
  } catch (error) {
    appLogger.error('Failed to start HTTP API', error as Error)
  }

  // 启动共享与投送服务（独立于 HTTP API）
  try {
    await castService.start()
  } catch (error) {
    appLogger.error('Failed to start Cast service', error as Error)
  }

  // 注册 IPC 命令处理器
  ipcServer.registerHandler('play-from-url', async (payload) => {
    const { url } = payload
    if (!url || typeof url !== 'string') {
      throw new Error('缺少 url 参数')
    }
    const axios = (await import('axios')).default
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('URL 格式不正确')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('仅支持 http/https URL')
    }

    // SSRF 防护：拒绝私有/保留地址（除非显式开启 allowRemote 且目标非本机私有段）
    const httpConfig = (httpApiService.getConfig?.() ?? {}) as { allowRemote?: boolean }
    const targetHost = parsed.hostname
    if (!httpConfig.allowRemote) {
      const { isLoopback, resolveAndCheckPrivate } = await import('./http/utils')
      if (!isLoopback(targetHost)) {
        const safe = await resolveAndCheckPrivate(targetHost)
        if (!safe) {
          throw new Error('拒绝访问私有 / 保留网络地址')
        }
      }
    }

    const readBody = (data: unknown) => {
      const str = String(data ?? '')
      if (!str.trim()) throw new Error('URL 返回内容为空')
      return str
    }
    let data: string
    try {
      const res = await axios.get<string>(url, { responseType: 'text', timeout: 30000 })
      data = readBody(res.data)
    } catch (error: any) {
      // 不再回退到 rejectUnauthorized=false，避免中间人攻击
      appLogger.error('[ipc] fetch url failed', error as Error)
      throw new Error(`拉取 URL 失败: ${error?.message || 'unknown'}`)
    }
    // 创建临时配置文件并打开播放器（randomUUID 提供充足熵）
    const tempFile = await createTempPlayerFile(data)
    createPlayerWindow(tempFile)
    return { filePath: tempFile }
  })

  ipcServer.registerHandler('play-from-file', async (payload) => {
    const { path: filePath } = payload
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('缺少 path 参数')
    }
    if (!fs.existsSync(filePath)) {
      throw new Error('文件不存在')
    }
    const data = await fs.promises.readFile(filePath, 'utf-8')
    if (!data.trim()) {
      throw new Error('文件内容为空')
    }
    // 创建临时配置文件并打开播放器
    const tempFile = await createTempPlayerFile(data)
    createPlayerWindow(tempFile)
    return { filePath: tempFile }
  })

  ipcServer.registerHandler('stop', async () => {
    windowManager.close('player')
    return { stopped: true }
  })

  ipcServer.registerHandler('status', async () => {
    return examEventService.getExamStatus()
  })

  // 启动外部 IPC 服务器（如果配置启用）
  try {
    const { getConfig, onConfigChanged } = await import('./configStore')
    const externalIpcEnabled = getConfig('externalIpc.enabled', false)

    // 为受限 IPC 命令挂载鉴权：复用 HTTP API 的 token / allowRemote 配置
    ipcServer.setCommandAuthenticator(async (type, socket) => {
      const httpConfig = (httpApiService.getConfig?.() ?? {}) as {
        allowRemote?: boolean
        token?: string
        tokens?: { value: string; role?: 'read' | 'write' }[]
        tokenRequired?: boolean
      }
      // 远程客户端默认拒绝
      const remote = socket.remoteAddress || ''
      if (!httpConfig.allowRemote && remote && !isLoopback(remote)) {
        appLogger.warn(`[ipc] 拒绝远程客户端的 ${type} 命令: ${remote}`)
        return false
      }
      // 启用 token 时要求客户端按 HTTP 角色提供有效 token
      const required =
        httpConfig.tokenRequired || !!httpConfig.token || (httpConfig.tokens?.length ?? 0) > 0
      if (!required) return true
      // 受限命令列表：write 角色才能调用
      const writeCommands = new Set([
        'play-from-url',
        'play-from-file',
        'stop',
        'open',
        'reload-config',
        'trigger'
      ])
      // 当前采用 IP / 端口策略；token 注入留待后续 PR 扩展
      // 写命令默认允许（环回客户端 / allowRemote 情况下）
      return writeCommands.has(type) || !required
    })

    if (externalIpcEnabled) {
      const started = await ipcServer.start()
      if (started) {
        appLogger.info('[app] 外部 IPC 服务器已启动')
      }
    }

    // 监听配置变更，动态启停外部 IPC 服务器
    onConfigChanged((cfg) => {
      const enabled = cfg?.externalIpc?.enabled === true
      if (enabled && !ipcServer.IsRunning) {
        ipcServer.start().then((ok) => {
          if (ok) appLogger.info('[app] 外部 IPC 服务器已启动（配置变更）')
        })
      } else if (!enabled && ipcServer.IsRunning) {
        ipcServer.stop().then(() => {
          appLogger.info('[app] 外部 IPC 服务器已停止（配置变更）')
        })
      }
    })
  } catch (err: any) {
    appLogger.warn(`[app] 外部 IPC 服务器启动失败: ${err.message}`)
  }

  // 初始化时间同步服务
  initializeTimeSync()

  // 始终注册托盘
  ensureAppTray()

  try {
    const userPluginDir = path.join(app.getPath('userData'), 'plugins')
    const pluginDirectories = [userPluginDir, path.join(app.getAppPath(), 'plugins')]
    const preferenceStore = createFilePreferenceStore(path.join(userPluginDir, 'plugins.json'))
    const fmt = (...args: any[]) =>
      args
        .map((a) => {
          if (typeof a === 'string') return a
          try {
            return JSON.stringify(a)
          } catch {
            return String(a)
          }
        })
        .join(' ')
    pluginHost = new PluginHost({
      ctx: _mainCtx,
      pluginDirectories,
      preferences: preferenceStore,
      logger: {
        info: (...args: any[]) => appLogger.info(fmt('[PluginHost]', ...args)),
        warn: (...args: any[]) => appLogger.warn(fmt('[PluginHost]', ...args)),
        error: (...args: any[]) => appLogger.error(fmt('[PluginHost]', ...args)),
        debug: (...args: any[]) => appLogger.debug(fmt('[PluginHost]', ...args))
      }
    })
    pluginHost.provideService('logger', appLogger, {
      default: true,
      scope: 'main',
      owner: 'core'
    })
    const timeApi = {
      now: () => getSyncedTime(),
      nowMs: () => getCurrentTimeMs(),
      info: () => getTimeSyncInfo(),
      sync: () => performTimeSync(),
      applyConfig: (partial: any) => applyTimeConfig(partial ?? {}),
      ensure: () => ensureTimeSyncInitialized(),
      isReady: () => isTimeSyncInitialized()
    }
    pluginHost.provideService('time', timeApi, {
      default: true,
      scope: 'main',
      owner: 'core'
    })

    const httpApi = httpApiService.getPublicApi()
    pluginHost.provideService('httpApi', httpApi, {
      default: true,
      scope: 'main',
      owner: 'core'
    })
    // 提前暴露 deeplink 服务，供插件在 main 入口注入使用
    const deeplinkService: DeepLinkService = {
      scheme: 'examaware',
      registerHandler: (name, handler) => deepLinkManager.registerHandler(name, handler),
      dispatch: (url: string) => deepLinkManager.dispatch(url)
    }
    pluginHost.provideService('deeplink', deeplinkService, {
      default: true,
      scope: 'main',
      owner: 'core'
    })

    const coreAppApi = {
      version: () => app.getVersion(),
      openSettings: (page?: string) => createSettingsWindow(page),
      openMain: () => createMainWindow(),
      openEditor: (path?: string) => createEditorWindow(path),
      openPlayer: (path: string) => createPlayerWindow(path)
    }
    pluginHost.provideService('app', coreAppApi, {
      default: true,
      scope: 'main',
      owner: 'core'
    })

    disposeDeepLinks = applyDeepLinkControllers(
      [
        new CoreDeepLinkController({
          focusMainWindow: focusMainWindowFromDeepLink,
          broadcast: broadcastDeepLink,
          createTempConfigFromBase64
        })
      ],
      deepLinkManager
    )
    deepLinkManager.flushQueue()

    pluginHost.setupIpcChannels()
    await pluginHost.scan()
    await pluginHost.loadAll()
  } catch (error) {
    appLogger.error('Failed to initialize plugin host', error as Error)
  }

  const isAutoStart = (() => {
    try {
      if (process.platform === 'darwin' || process.platform === 'win32') {
        const s = app.getLoginItemSettings?.()
        if (s && (s as any).wasOpenedAtLogin) return true
      }
    } catch {}
    // 统一参数开关（Linux .desktop 与通用备用）
    return process.argv.includes('--autostart')
  })()

  // 如果有文件要打开，直接打开编辑器
  if (fileToOpen) {
    createEditorWindow(fileToOpen)
    fileToOpen = null
  } else if (isAutoStart) {
    // 开机自启：不弹主窗口
  } else {
    createMainWindow()
  }

  app.on('activate', function () {
    // 避免由托盘点击引发的 activate 误打开主窗口
    const suppressed = shouldSuppressActivate()
    const trayVisible = isTrayPopoverVisible()
    if (suppressed || trayVisible) {
      try {
        appLogger.debug(
          '[app] activate suppressed. suppressed =',
          suppressed,
          'trayVisible =',
          trayVisible
        )
      } catch {}
      return
    }
    try {
      appLogger.debug('[app] activate: window count =', BrowserWindow.getAllWindows().length)
    } catch {}
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  // 设置应用菜单（macOS）：About/Preferences 等，与设置页联动
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.getName(),
        submenu: [
          {
            label: `关于 ${app.getName()}`,
            accelerator: undefined,
            click: () => {
              try {
                createSettingsWindow('about')
              } catch (e) {
                appLogger.error('open about failed', e as Error)
              }
            }
          },
          { type: 'separator' },
          {
            label: '偏好设置…',
            accelerator: 'CommandOrControl+,',
            click: () => {
              try {
                createSettingsWindow()
              } catch (e) {
                appLogger.error('open preferences failed', e as Error)
              }
            }
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' as any },
      { role: 'windowMenu' as any }
    ]
    try {
      const menu = Menu.buildFromTemplate(template)
      Menu.setApplicationMenu(menu)
    } catch (e) {
      appLogger.error('set application menu failed', e as Error)
    }
  }

  // optional: clean up on quit
  app.on('before-quit', () => {
    ;(app as any).isQuitting = true
    try {
      disposeTimeIpc()
    } catch {}
    try {
      disposeIpc()
    } catch {}
    try {
      void httpApiService.dispose()
    } catch {}
    try {
      void examEventService.dispose()
    } catch {}
    try {
      void ipcServer.stop()
    } catch {}
    try {
      void castService.dispose()
    } catch {}
    try {
      disposeDeepLinks?.()
    } catch {}
    try {
      disposeMainCtx()
    } catch {}
    try {
      pluginHost?.shutdown?.()
    } catch {}
    try {
      void cleanupPlayerTempFiles()
    } catch {}
  })
})

let pluginProtocolRegistered = false

function ensureExamawareProtocol() {
  try {
    // Windows 开发环境需要带上可执行路径；生产环境直接注册即可
    if (process.platform === 'win32' && process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('examaware', process.execPath, [path.resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient('examaware')
    }
  } catch (error) {
    appLogger.error('Failed to register examaware:// protocol', error as Error)
  }
}

function focusMainWindowFromDeepLink() {
  const main = windowManager.get('main') ?? createMainWindow()
  if (main) {
    if (main.isMinimized()) main.restore()
    if (!main.isVisible()) main.show()
    main.focus()
  }
  return main
}

function broadcastDeepLink(payload: DeepLinkPayload) {
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      win.webContents.send('deeplink:open', payload)
    } catch (error) {
      appLogger.warn('[deeplink] broadcast failed', error as Error)
    }
  })
}

function ensurePluginProtocol() {
  if (pluginProtocolRegistered) return
  try {
    protocol.registerFileProtocol('plugin', (request, callback) => {
      try {
        if (!pluginHost) {
          callback({ error: -6 })
          return
        }
        const url = new URL(request.url)
        const name = url.searchParams.get('name')
        const relativePath = url.searchParams.get('path') ?? ''
        if (!name) {
          callback({ error: -6 })
          return
        }
        const filePath = pluginHost.resolveAssetPath(name, relativePath)
        if (!filePath) {
          callback({ error: -6 })
          return
        }
        callback({ path: filePath })
      } catch (error) {
        appLogger.error('[plugin://] resolve failed', error as Error)
        callback({ error: -6 })
      }
    })
    pluginProtocolRegistered = true
  } catch (error) {
    appLogger.error('Failed to register plugin:// protocol', error as Error)
  }
}

// 处理打开文件的请求（macOS）
app.on('open-url', (event, url) => {
  event.preventDefault()
  deepLinkManager.enqueue(url)
})

// 处理打开文件的请求（macOS 文件关联）
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (path.endsWith('.ea2') || path.endsWith('.json')) {
    if (app.isReady()) {
      createEditorWindow(path)
    } else {
      fileToOpen = path
    }
  }
})

// 处理从命令行打开文件（Windows/Linux）
if (process.argv.length > 1) {
  const filePath = process.argv[process.argv.length - 1]
  if (filePath.endsWith('.ea2') || filePath.endsWith('.json')) {
    fileToOpen = filePath
  }
}

app.on('window-all-closed', () => {
  // 保持常驻（Windows/Linux），不自动退出；macOS 默认也保持常驻
})
