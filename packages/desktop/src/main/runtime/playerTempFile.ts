import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * 播放器临时文件存储：所有"由外部 / 编辑器推送过来的播放配置"都先写到这里，
 * 再让播放器通过 `load-config` 事件读取。
 * 应用退出时统一清理，避免长期运行的 ExamAware 临时文件堆积。
 *
 * 注：用 require 而不是 import 引入 electron，是为了在 Node 上下文（比如单元测试）
 * 也能加载这个模块；真正的 `app.getPath` 调用被 try/catch 兜底成 `os.tmpdir()`。
 */
const PLAYER_TEMP_DIR = (() => {
  if (process.env['EXAMAWARE_TEMP_DIR']) {
    return path.join(process.env['EXAMAWARE_TEMP_DIR'], 'examaware-player')
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { getPath: (k: string) => string } }
    if (electron.app) {
      return path.join(electron.app.getPath('temp'), 'examaware-player')
    }
  } catch {
    /* 单元测试 / 非 Electron 环境 */
  }
  return path.join(os.tmpdir(), 'examaware-player')
})()

const playerTempFiles = new Set<string>()

async function ensureDir(dir: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true })
  return dir
}

/**
 * 把配置数据写到临时文件并登记退出清理。
 * prefix 用于区分来源（ipc / editor / url），方便排查。
 */
export async function createTempPlayerFile(data: string, prefix: string = 'ipc'): Promise<string> {
  await ensureDir(PLAYER_TEMP_DIR)
  const file = path.join(PLAYER_TEMP_DIR, `${prefix}-${randomUUID()}.ea2`)
  await fs.promises.writeFile(file, data, 'utf-8')
  playerTempFiles.add(file)
  return file
}

export function getPlayerTempDir(): string {
  return PLAYER_TEMP_DIR
}

export async function cleanupPlayerTempFiles(): Promise<void> {
  for (const f of playerTempFiles) {
    try {
      await fs.promises.unlink(f)
    } catch {
      /* file may already be gone */
    }
  }
  playerTempFiles.clear()
}
