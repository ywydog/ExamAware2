/**
 * 临时播放器文件工具的单元测试：
 * - 写文件确实落盘
 * - 同一进程内调用 cleanupPlayerTempFiles 后所有登记过的文件都被删
 * - 调用多次 createTempPlayerFile 都会登记
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// 切到临时目录，避免污染真实 /tmp
const sandbox = path.join(
  os.tmpdir(),
  `ea2-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
)
fs.mkdirSync(sandbox, { recursive: true })
process.env['EXAMAWARE_TEMP_DIR'] = sandbox

let checkCount = 0
const check = (cond: boolean, label: string) => {
  checkCount++
  if (!cond) {
    console.error(`FAIL: ${label}`)
    process.exit(1)
  } else {
    console.log(`PASS: ${label}`)
  }
}

;(async () => {
  const mod = await import('../playerTempFile')
  const { createTempPlayerFile, cleanupPlayerTempFiles, getPlayerTempDir } = mod

  check(
    typeof getPlayerTempDir() === 'string' && getPlayerTempDir().length > 0,
    'getPlayerTempDir 返回非空字符串'
  )

  // 写第一个文件
  const f1 = await createTempPlayerFile('hello-1', 'ipc')
  check(fs.existsSync(f1), 'createTempPlayerFile 落盘到磁盘')
  check(fs.readFileSync(f1, 'utf-8') === 'hello-1', '内容写入正确')
  check(f1.includes('ipc-'), '文件名前缀正确（ipc-）')

  // 写第二个文件
  const f2 = await createTempPlayerFile('hello-2', 'editor')
  check(fs.existsSync(f2), 'createTempPlayerFile 落盘到磁盘（editor 前缀）')
  check(f2.includes('editor-'), '文件名前缀正确（editor-）')

  // cleanup 应该删掉两个文件
  await cleanupPlayerTempFiles()
  check(!fs.existsSync(f1), 'cleanupPlayerTempFiles 删除了 ipc 前缀文件')
  check(!fs.existsSync(f2), 'cleanupPlayerTempFiles 删除了 editor 前缀文件')

  // cleanup 再调一次也不会报错
  await cleanupPlayerTempFiles()
  check(true, '重复调用 cleanupPlayerTempFiles 不抛错')

  // 清理沙箱
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {}

  console.log(`\n${checkCount} passed, 0 failed`)
})().catch((err) => {
  console.error('TEST CRASHED:', err)
  process.exit(1)
})
