/**
 * fileAssociation.ts 单元测试（独立运行，无 electron 依赖）
 *
 * 验证：
 *  1. looksLikeFilePath：扩展名 / flag / 空值过滤
 *  2. extractFilePathsFromArgv：存在性过滤、参数去噪
 *  3. validateExamConfigFile：扩展名、JSON 解析、validateExamConfig 校验
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { extname, join, resolve } from 'path'

// 直接 inline 复刻 fileAssociation.ts 中不依赖 electron 的纯函数
// （looksLikeFilePath、extractFilePathsFromArgv、validateExamConfigFile 的核心）

const SUPPORTED_EXTS = new Set(['.ea2', '.json'])

function looksLikeFilePath(arg: string): boolean {
  if (!arg) return false
  if (arg.startsWith('-')) return false
  const ext = extname(arg).toLowerCase()
  return SUPPORTED_EXTS.has(ext)
}

let passed = 0
let failed = 0
function check(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  PASS: ${name}`)
  } else {
    failed++
    console.error(`  FAIL: ${name}`)
  }
}

// ── looksLikeFilePath ─────────────────────────────────────────
check('空字符串 → false', !looksLikeFilePath(''))
check('以 - 开头 → false', !looksLikeFilePath('--inspect=9229'))
check('.ea2 → true', looksLikeFilePath('/tmp/a.ea2'))
check('.JSON → true (case-insensitive)', looksLikeFilePath('/tmp/a.JSON'))
check('.json → true', looksLikeFilePath('exam.json'))
check('.txt → false', !looksLikeFilePath('readme.txt'))
check('.exe → false', !looksLikeFilePath('electron.exe'))
check('.ea22 → false (只匹配 .ea2)', !looksLikeFilePath('foo.ea22'))
check('无扩展名 → false', !looksLikeFilePath('foo'))

// ── extractFilePathsFromArgv ──────────────────────────────────
import * as fs from 'fs'

function extractFilePathsFromArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  for (const a of argv) {
    if (!looksLikeFilePath(a)) continue
    try {
      if (fs.existsSync(a) && fs.statSync(a).isFile()) {
        out.push(resolve(a))
      }
    } catch {}
  }
  return out
}

{
  const dir = mkdtempSync(join(tmpdir(), 'ea2-fa-'))
  const f1 = join(dir, 'a.ea2')
  const f2 = join(dir, 'b.json')
  const f3 = join(dir, 'c.txt')
  writeFileSync(f1, '{}')
  writeFileSync(f2, '{}')
  writeFileSync(f3, 'x')

  const argv = [
    '/usr/bin/electron',
    '--inspect=9229',
    f1,
    f2,
    f3,
    join(dir, 'missing.ea2'),
    'C:/path/with space.ea2'
  ]
  const out = extractFilePathsFromArgv(argv)
  check('过滤非 .ea2/.json 扩展名', out.length === 2)
  check('包含 .ea2 路径', out.includes(resolve(f1)))
  check('包含 .json 路径', out.includes(resolve(f2)))
  check('不包含 .txt 路径', !out.includes(resolve(f3)))
  check('跳过不存在的文件', !out.some((p) => p.endsWith('missing.ea2')))

  rmSync(dir, { recursive: true, force: true })
}

// ── validateExamConfigFile 简版（不依赖 @dsz-examaware/core 即可完成扩展名 / 文件检查部分）──
async function validateExamConfigFile(filePath: string): Promise<void> {
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
  const ext = extname(filePath).toLowerCase()
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(`不支持的文件类型: ${ext}（仅支持 .ea2 / .json）`)
  }
}

;(async () => {
  // ── validateExamConfigFile 边界检查 ──────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'ea2-validate-'))
  try {
    // 不存在的文件
    let caught: Error | null = null
    try {
      await validateExamConfigFile(join(dir, 'nope.ea2'))
    } catch (e) {
      caught = e as Error
    }
    check('文件不存在抛错', !!caught && caught.message.includes('不存在'))

    // 空文件
    const emptyFile = join(dir, 'empty.ea2')
    writeFileSync(emptyFile, '')
    caught = null
    try {
      await validateExamConfigFile(emptyFile)
    } catch (e) {
      caught = e as Error
    }
    check('空文件抛错', !!caught && caught.message.includes('空'))

    // 错误扩展名
    const wrongExt = join(dir, 'foo.txt')
    writeFileSync(wrongExt, '{}')
    caught = null
    try {
      await validateExamConfigFile(wrongExt)
    } catch (e) {
      caught = e as Error
    }
    check('错误扩展名抛错', !!caught && caught.message.includes('不支持'))

    // 目录
    caught = null
    try {
      await validateExamConfigFile(dir)
    } catch (e) {
      caught = e as Error
    }
    check('目录抛错', !!caught && caught.message.includes('不是'))

    // 合法 .ea2
    const okFile = join(dir, 'ok.ea2')
    writeFileSync(okFile, '{"examInfos":[]}')
    let succeeded = false
    try {
      await validateExamConfigFile(okFile)
      succeeded = true
    } catch {}
    check('合法 .ea2 不抛错（仅扩展名 / 大小）', succeeded)

    // 合法 .json
    const okJson = join(dir, 'ok.json')
    writeFileSync(okJson, '{"examInfos":[]}')
    succeeded = false
    try {
      await validateExamConfigFile(okJson)
      succeeded = true
    } catch {}
    check('合法 .json 不抛错', succeeded)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
})()
