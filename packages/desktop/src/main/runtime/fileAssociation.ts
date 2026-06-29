import { BrowserWindow, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { appLogger } from '../logging/winstonLogger'
import { getConfig, patchConfig } from '../configStore'
import { createEditorWindow } from '../windows/editorWindow'
import { createPlayerWindow } from '../windows/playerWindow'
import { windowManager } from '../windows/windowManager'
import { parseExamConfig, validateExamConfig } from '@dsz-examaware/core'

/**
 * 默认打开 .ea2 文件时的行为
 *  - player:  直接进入播放器（推荐：考试档案主要是用来放映的）
 *  - editor:  进入编辑器（编辑考试配置）
 *  - ask:     弹一个对话框让用户选
 */
export type FileOpenMode = 'player' | 'editor' | 'ask'

const SUPPORTED_EXTS = new Set(['.ea2', '.json'])

/**
 * 判断一个 argv 项看起来是不是 .ea2 / .json 文件路径
 * - 不做文件存在性检查（有些系统会把不存在的路径也传过来）
 * - 排除明显是 Electron / 框架 flag 的项（以 `-` 开头）
 */
export function looksLikeFilePath(arg: string): boolean {
  if (!arg) return false
  if (arg.startsWith('-')) return false
  const ext = path.extname(arg).toLowerCase()
  return SUPPORTED_EXTS.has(ext)
}

/**
 * 在 argv 列表里扫描出所有 .ea2 / .json 文件路径
 * - 跳过 electron.exe / 自身 / .js / 路径不存在项
 */
export function extractFilePathsFromArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  for (const a of argv) {
    if (!looksLikeFilePath(a)) continue
    try {
      // 存在且是文件
      if (fs.existsSync(a) && fs.statSync(a).isFile()) {
        out.push(path.resolve(a))
      }
    } catch {
      /* 跳过 */
    }
  }
  return out
}

/**
 * 验证文件是合法 ExamAware 配置（扩展名 + parse + validate）
 * 验证失败抛 Error。
 */
export async function validateExamConfigFile(filePath: string): Promise<unknown> {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`)
  }
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    throw new Error(`不是一个文件: ${filePath}`)
  }
  if (stat.size === 0) {
    throw new Error('文件为空')
  }
  if (stat.size > 50 * 1024 * 1024) {
    throw new Error('文件过大（>50MB）')
  }
  const ext = path.extname(filePath).toLowerCase()
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(`不支持的文件类型: ${ext}（仅支持 .ea2 / .json）`)
  }
  const text = await fs.promises.readFile(filePath, 'utf-8')
  const config = parseExamConfig(text)
  if (!config) {
    throw new Error('文件不是有效的 ExamAware 配置（JSON 解析失败）')
  }
  if (!validateExamConfig(config)) {
    throw new Error('文件不是有效的 ExamAware 配置（结构校验失败）')
  }
  return config
}

export function getFileOpenMode(): FileOpenMode {
  const v = getConfig('fileAssociation.openMode', 'player') as FileOpenMode
  if (v === 'player' || v === 'editor' || v === 'ask') return v
  return 'player'
}

/**
 * 打开一个 .ea2 / .json 文件（从文件关联 / 命令行 / 拖拽等渠道进入）
 */
export async function openExamConfigFile(
  filePath: string,
  options: { fromOS?: boolean } = {}
): Promise<'player' | 'editor' | 'cancelled' | 'error'> {
  try {
    await validateExamConfigFile(filePath)
  } catch (err: any) {
    appLogger.error('[fileAssociation] invalid file', err as Error)
    if (options.fromOS) {
      const main = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      await dialog.showMessageBox(main ?? undefined!, {
        type: 'error',
        title: '无法打开考试档案',
        message: 'ExamAware 无法打开此文件',
        detail: `${filePath}\n\n${err?.message ?? err}`,
        buttons: ['确定'],
        defaultId: 0,
        noLink: true
      })
    }
    return 'error'
  }

  let mode = getFileOpenMode()

  if (mode === 'ask') {
    const main = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showMessageBox(main ?? undefined!, {
      type: 'question',
      title: '如何打开考试档案',
      message: path.basename(filePath),
      detail: '请选择打开方式（可到设置中修改默认值）',
      buttons: ['立即放映', '打开编辑器', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })
    if (result.response === 0) mode = 'player'
    else if (result.response === 1) mode = 'editor'
    else return 'cancelled'
  }

  if (mode === 'player') {
    // 记忆最近目录到文件对话框默认值
    try {
      patchConfig({ fileAssociation: { lastOpenDir: path.dirname(filePath) } as any })
    } catch {}
    createPlayerWindow(filePath)
    return 'player'
  }

  createEditorWindow(filePath)
  return 'editor'
}

/**
 * 在 app 启动时从 process.argv 提取待打开的文件
 */
export function pickInitialFileFromArgv(): string | null {
  const paths = extractFilePathsFromArgv(process.argv)
  return paths[0] ?? null
}

/**
 * 处理 second-instance：主实例已经存在，新实例带 .ea2 启动
 * 把文件路径转交给主实例去打开
 */
export function relayFilePathsToMainInstance(paths: string[]): void {
  if (paths.length === 0) return
  appLogger.info('[fileAssociation] relaying file paths to main instance', {
    count: paths.length,
    paths
  })
  // 主进程收到后会逐个打开
  for (const p of paths) {
    openExamConfigFile(p, { fromOS: true }).catch((err) => {
      appLogger.error('[fileAssociation] relayed open failed', err as Error)
    })
  }
  // 唤起主窗口
  const main =
    windowManager.get('main') ?? windowManager.get('editor') ?? windowManager.get('player')
  if (main) {
    if (main.isMinimized()) main.restore()
    if (!main.isVisible()) main.show()
    main.focus()
  }
}
