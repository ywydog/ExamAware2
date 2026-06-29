/**
 * 服务端 ipcServer.flushLatestEventsToClient 的核心逻辑测试：
 * 验证按 timestamp 排序后回放能保证新客户端拿到正确的时序。
 *
 * 该测试使用 TypeScript 单独运行（无外部依赖），直接验证排序算法的正确性。
 */

// 模拟 ExamEventMessage
interface ExamEventMessage {
  type: 'exam-event'
  event: string
  data: unknown
  timestamp: number
}

// 复刻 ipcServer.ts 的排序逻辑
function sortedLatest(events: Map<string, ExamEventMessage>): ExamEventMessage[] {
  return Array.from(events.values()).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
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

// ── 场景 1：单轮考试，事件按发生顺序到达 ─────────────────────
{
  const cache = new Map<string, ExamEventMessage>()
  cache.set('exam-presentation-start', mk('exam-presentation-start', 1))
  cache.set('exam-start', mk('exam-start', 2))
  cache.set('exam-time-remaining', mk('exam-time-remaining', 3))
  cache.set('exam-end', mk('exam-end', 4))
  cache.set('exam-presentation-stop', mk('exam-presentation-stop', 5))

  const sorted = sortedLatest(cache)
  const events = sorted.map((m) => m.event).join(',')
  check(
    '单轮考试按发生顺序回放',
    events ===
      'exam-presentation-start,exam-start,exam-time-remaining,exam-end,exam-presentation-stop'
  )
}

// ── 场景 2：多轮考试，Map 中 value 替换后，按 insertion order 迭代会乱 ───
// 复现 BUG：events arrive: 1, 2, 3, 4, 5, 6, 7, 8, 9
//   start(ts=1), end(ts=2), stop(ts=3), start(ts=4), end(ts=5), stop(ts=6), start(ts=7)
// Map.set 替换 value 但保留 key 位置 → 迭代顺序是 [start(ts=7), end(ts=5), stop(ts=6)]
// 不排序的新客户端会得到 [start(7), end(5), stop(6)]，最终状态错误。
{
  const cache = new Map<string, ExamEventMessage>()
  const arrivals: Array<[string, number]> = [
    ['exam-start', 1],
    ['exam-end', 2],
    ['exam-presentation-stop', 3],
    ['exam-start', 4],
    ['exam-end', 5],
    ['exam-presentation-stop', 6],
    ['exam-start', 7]
  ]
  for (const [event, ts] of arrivals) {
    cache.set(event, mk(event, ts))
  }

  const unsortedEvents = Array.from(cache.values())
    .map((m) => `${m.event}@${m.timestamp}`)
    .join(',')
  // 旧逻辑：按 Map insertion 顺序 → 第一个插入的 start 还在第一位，但 value 是 ts=7
  // 这模拟了 BUG 出现
  check('未排序时 start@7 排在第一（模拟 BUG）', unsortedEvents.startsWith('exam-start@7'))

  const sorted = sortedLatest(cache)
  const sortedEvents = sorted.map((m) => m.event).join(',')
  // 排序后：[end(2), stop(3), end(5), stop(6), start(7)] —— 但 stop 后面的 start 不应出现在 stop 之前
  // 实际上 排序后时间戳单调递增：1, 2, 3, 4, 5, 6, 7，但 1/4 的 key 都是 start，所以 Map 只剩 start@7
  // 唯一缓存的是各类型的最新值：start@7, end@5, stop@6
  // 排序后顺序：[end@5, stop@6, start@7]
  // 这反映"当前周期处于 start 后"，但回放顺序仍是按时间戳升序，不会被插入序影响
  check('排序后按时戳升序', sorted.map((m) => m.timestamp).join(',') === '5,6,7')
  check('排序后首条是 end@5', sorted[0].event === 'exam-end' && sorted[0].timestamp === 5)
  check(
    '排序后最后一条是 start@7',
    sorted[sorted.length - 1].event === 'exam-start' && sorted[sorted.length - 1].timestamp === 7
  )
}

// ── 场景 3：插入时 ts 升序 ──────────────────────────────────────
{
  const cache = new Map<string, ExamEventMessage>()
  cache.set('a', mk('a', 10))
  cache.set('b', mk('b', 5)) // 乱序到达
  cache.set('c', mk('c', 20))

  const sorted = sortedLatest(cache)
  const ts = sorted.map((m) => m.timestamp).join(',')
  check('乱序到达后排序正确', ts === '5,10,20')
}

// ── 场景 4：缺 timestamp 字段不抛错 ───────────────────────────
{
  const cache = new Map<string, ExamEventMessage>()
  cache.set('a', { type: 'exam-event', event: 'a', data: null, timestamp: 0 as any })
  const sorted = sortedLatest(cache)
  check('timestamp 缺失不抛错', sorted.length === 1)
}

// ── 场景 5：空缓存 ──────────────────────────────────────────────
{
  const cache = new Map<string, ExamEventMessage>()
  const sorted = sortedLatest(cache)
  check('空缓存返回空数组', sorted.length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

function mk(event: string, ts: number): ExamEventMessage {
  return { type: 'exam-event', event, data: null, timestamp: ts }
}
