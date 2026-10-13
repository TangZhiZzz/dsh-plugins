/**
 * 纯逻辑单测：不读任何真实会话日志，全部用构造事件。
 * 运行：node verify/metrics.test.mjs
 *
 * 覆盖两件事：
 *   1. `foldSessionDaily` —— 按天折叠（与窗口无关，可长期缓存）；
 *   2. `aggregate` —— 在天行上按窗口聚合（切窗口快的原因）。
 */
import assert from 'node:assert/strict'
import {
  addTokens,
  aggregate,
  dayKey,
  emptyTokens,
  foldSessionDaily,
  hourOf,
  recentDays,
  safeTimeZone,
  titleOf,
  tokensOf,
  usageOf,
  weekdayOf,
} from '../metrics.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

const TZ = 'UTC'
const NOW = Date.parse('2026-10-13T12:00:00Z')
let seq = 0

const message = (iso, usage, model = 'model-a') => ({
  type: 'assistant/message',
  seq: ++seq,
  time: Date.parse(iso),
  data: { usage, message: { source: { provider: 'deepseek', model } } },
})
const bareMessage = (iso, model = 'model-a') => ({
  type: 'assistant/message',
  seq: ++seq,
  time: Date.parse(iso),
  data: { message: { source: { provider: 'deepseek', model } } },
})
const toolCall = (iso, name) => ({ type: 'tool/call', seq: ++seq, time: Date.parse(iso), data: { name } })
const titleEvent = (iso, title, type = 'session/title') => ({ type, seq: ++seq, time: Date.parse(iso), data: { title } })
const snap = (events, inheritedEventCount = 0) => ({ session: { id: 's' }, inheritedEventCount, events })
const fold = (events, inheritedEventCount = 0) => foldSessionDaily(snap(events, inheritedEventCount), { timeZone: TZ })
const entry = (sessionId, title, live, events, inherited = 0) => ({
  sessionId,
  title,
  live,
  fold: fold(events, inherited),
})

// ── token 归一化 ────────────────────────────────────────────────────────────

test('tokensOf 按 DeepSeek 语义拆分三段', () => {
  assert.deepEqual(
    tokensOf({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1050 }),
    { hit: 900, miss: 100, output: 50, total: 1050 },
  )
})

test('tokensOf 把 cacheWriteTokens 併进未命中侧', () => {
  assert.deepEqual(
    tokensOf({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 1 }),
    { hit: 20, miss: 15, output: 1, total: 36 },
  )
})

test('tokensOf 自洽纠正「inputTokens 已含缓存命中」的报文', () => {
  assert.deepEqual(
    tokensOf({ inputTokens: 1200, cacheReadTokens: 900, outputTokens: 0, totalTokens: 1000 }),
    { hit: 900, miss: 100, output: 0, total: 1000 },
  )
})

test('tokensOf 对缺失/非数字字段按 0；addTokens 累加正确', () => {
  assert.deepEqual(tokensOf({}), { hit: 0, miss: 0, output: 0, total: 0 })
  assert.deepEqual(tokensOf(undefined), { hit: 0, miss: 0, output: 0, total: 0 })
  const target = emptyTokens()
  addTokens(target, { hit: 1, miss: 2, output: 3, total: 6 })
  addTokens(target, { hit: 10, miss: 20, output: 30, total: 60 })
  assert.deepEqual(target, { hit: 11, miss: 22, output: 33, total: 66 })
})

test('usageOf 优先 data.usage，其次流里最后一个 usage chunk', () => {
  assert.deepEqual(usageOf({ usage: { inputTokens: 1 } }), { inputTokens: 1 })
  const data = {
    stream: [
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1 } } },
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 2 } } },
    ],
  }
  assert.deepEqual(usageOf(data), { inputTokens: 2 })
  assert.equal(usageOf({}), undefined)
})

// ── 时区 / 天 / 小时 ────────────────────────────────────────────────────────

test('safeTimeZone 对非法时区回落 UTC 而不是抛错', () => {
  assert.equal(safeTimeZone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(safeTimeZone('Not/AZone'), 'UTC')
  assert.equal(safeTimeZone(''), 'UTC')
})

test('dayKey 按给定时区落天（跨零点算对）', () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 13, 16, 30), 'Asia/Shanghai'), '2026-10-14')
  assert.equal(dayKey(Date.UTC(2026, 9, 13, 16, 30), 'UTC'), '2026-10-13')
  assert.equal(dayKey(NaN, 'UTC'), undefined)
})

test('hourOf 用 h23：午夜是 0 点而不是 24 点', () => {
  assert.equal(hourOf(Date.UTC(2026, 9, 13, 0, 5), 'UTC'), 0)
  assert.equal(hourOf(Date.UTC(2026, 9, 13, 23, 59), 'UTC'), 23)
  assert.equal(hourOf(Date.UTC(2026, 9, 13, 16, 30), 'Asia/Shanghai'), 0)
  assert.equal(hourOf(NaN, 'UTC'), undefined)
})

test('weekdayOf 把日期键映射到真实星期几', () => {
  assert.equal(weekdayOf('2026-10-11'), 0)
  assert.equal(weekdayOf('2026-10-13'), 2)
  assert.equal(weekdayOf('bad'), undefined)
})

test('recentDays 返回升序的最近 N 天且含今天', () => {
  assert.deepEqual(recentDays(NOW, 3, TZ), ['2026-10-11', '2026-10-12', '2026-10-13'])
  assert.equal(recentDays(NOW, 365, TZ).length, 365)
})

// ── foldSessionDaily ────────────────────────────────────────────────────────

test('foldSessionDaily 按天分桶，天行里带 token 三段、模型、小时', () => {
  const acc = fold([
    message('2026-10-13T01:00:00Z', { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 }, 'model-a'),
    message('2026-10-13T05:00:00Z', { inputTokens: 50, outputTokens: 5 }, 'model-b'),
    message('2026-10-12T09:00:00Z', { inputTokens: 7, outputTokens: 0 }, 'model-a'),
  ])
  assert.deepEqual(Object.keys(acc.days).sort(), ['2026-10-12', '2026-10-13'])
  const day13 = acc.days['2026-10-13']
  assert.equal(day13.calls, 2)
  assert.deepEqual(day13.tokens, { hit: 900, miss: 150, output: 15, total: 1065 })
  assert.equal(day13.hours[1], 1)
  assert.equal(day13.hours[5], 1)
  assert.equal(day13.hours[9], 0)
  assert.equal(day13.models['model-a'].calls, 1)
  assert.equal(day13.models['model-b'].calls, 1)
  assert.equal(acc.days['2026-10-12'].tokens.total, 7)
  assert.equal(acc.calls, 3)
  assert.deepEqual(acc.tokens, { hit: 900, miss: 157, output: 15, total: 1072 })
})

test('foldSessionDaily 工具按天计数', () => {
  const acc = fold([
    toolCall('2026-10-13T01:00:00Z', 'read'),
    toolCall('2026-10-13T02:00:00Z', 'read'),
    toolCall('2026-10-12T01:00:00Z', 'bash'),
  ])
  assert.equal(acc.days['2026-10-13'].tools.read, 2)
  assert.equal(acc.days['2026-10-12'].tools.bash, 1)
  assert.equal(acc.toolCalls, 3)
})

test('foldSessionDaily 缺 usage 的消息仍计入调用数，但不加 token', () => {
  const acc = fold([
    bareMessage('2026-10-13T01:00:00Z'),
    message('2026-10-13T02:00:00Z', { inputTokens: 5, outputTokens: 5 }),
  ])
  assert.equal(acc.calls, 2)
  assert.equal(acc.days['2026-10-13'].calls, 2)
  assert.equal(acc.tokens.total, 10)
})

test('foldSessionDaily 跳过 fork 继承的事件（token 花在父会话）', () => {
  const acc = fold([
    message('2026-10-13T01:00:00Z', { inputTokens: 999, outputTokens: 999 }),
    message('2026-10-13T02:00:00Z', { inputTokens: 10, outputTokens: 1 }),
  ], 1)
  assert.equal(acc.calls, 1)
  assert.equal(acc.tokens.total, 11)
})

test('foldSessionDaily 标题优先标题事件、两者都取最后一个', () => {
  const acc = fold([
    titleEvent('2026-10-11T00:00:00Z', '旧标题'),
    { type: 'other', seq: 99, time: Date.parse('2026-10-11T01:00:00Z'), data: { title: '干扰项' } },
    titleEvent('2026-10-12T00:00:00Z', '新标题'),
  ])
  assert.equal(acc.title, '新标题')

  const loose = fold([{ type: 'whatever', seq: 98, time: Date.parse('2026-10-11T00:00:00Z'), data: { title: ' 兜底 ' } }])
  assert.equal(loose.title, '兜底')
})

test('foldSessionDaily 忽略畸形事件', () => {
  const acc = fold([null, 'x', { type: 42 }, { type: 'other' }])
  assert.equal(acc.calls, 0)
  assert.equal(acc.toolCalls, 0)
  assert.deepEqual(Object.keys(acc.days), [])
})

test('titleOf 与 foldSessionDaily 的口径一致', () => {
  const events = [titleEvent('2026-10-11T00:00:00Z', 'A'), titleEvent('2026-10-12T00:00:00Z', 'B')]
  assert.equal(titleOf(snap(events)), 'B')
  assert.equal(fold(events).title, 'B')
})

// ── aggregate ───────────────────────────────────────────────────────────────

test('aggregate 汇总窗口内的总量、派生指标与峰值日', () => {
  const payload = aggregate([
    entry('s1', '会话一', true, [
      message('2026-10-13T01:00:00Z', { inputTokens: 100, cacheReadTokens: 300, outputTokens: 10 }),
      message('2026-10-12T01:00:00Z', { inputTokens: 20, cacheReadTokens: 0, outputTokens: 2 }),
    ]),
  ], { days: 3, now: NOW, timeZone: TZ })

  assert.equal(payload.ok, true)
  assert.equal(payload.windowDays, 3)
  assert.equal(payload.totals.sessions, 1)
  assert.equal(payload.totals.liveSessions, 1)
  assert.equal(payload.totals.calls, 2)
  assert.deepEqual(payload.totals.tokens, { hit: 300, miss: 120, output: 12, total: 432 })
  assert.equal(payload.totals.cacheHitRate, 300 / 420)
  assert.equal(payload.totals.activeDays, 2)
  assert.equal(payload.totals.avgTokensPerCall, 216)
  assert.equal(payload.totals.avgCallsPerActiveDay, 1)
  assert.deepEqual(payload.totals.peakDay, { day: '2026-10-13', tokens: 410 })
})

test('aggregate 每日序列覆盖整窗（含没有数据的天）并带 dow', () => {
  const payload = aggregate([
    entry('s1', 'S', true, [message('2026-10-13T01:00:00Z', { inputTokens: 500, outputTokens: 0 })]),
  ], { days: 3, now: NOW, timeZone: TZ })
  assert.deepEqual(payload.days.map((row) => row.day), ['2026-10-11', '2026-10-12', '2026-10-13'])
  assert.deepEqual(payload.days.map((row) => row.tokens.total), [0, 0, 500])
  assert.deepEqual(payload.days.map((row) => row.dow), [0, 1, 2])
})

test('aggregate 的年度序列恒为 365 天，与窗口无关', () => {
  const payload = aggregate([
    entry('s1', 'S', true, [
      message('2026-10-13T01:00:00Z', { inputTokens: 10, outputTokens: 0 }),
      message('2026-01-05T01:00:00Z', { inputTokens: 70, outputTokens: 0 }),
    ]),
  ], { days: 7, now: NOW, timeZone: TZ })
  assert.equal(payload.year.length, 365)
  assert.equal(payload.year[0].day, '2025-10-14')
  assert.equal(payload.year[payload.year.length - 1].day, '2026-10-13')
  // 窗口只算 7 天，但年度序列能看到更早的那天
  assert.equal(payload.totals.tokens.total, 10)
  const jan = payload.year.find((row) => row.day === '2026-01-05')
  assert.equal(jan.tokens.total, 70)
})

test('aggregate 小时分布：窗口内的调用按小时归位，token 按占比摊分', () => {
  const payload = aggregate([
    entry('s1', 'S', true, [
      message('2026-10-13T01:00:00Z', { inputTokens: 100, outputTokens: 0 }),
      message('2026-10-13T01:30:00Z', { inputTokens: 100, outputTokens: 0 }),
      message('2026-10-13T09:00:00Z', { inputTokens: 200, outputTokens: 0 }),
    ]),
  ], { days: 3, now: NOW, timeZone: TZ })
  assert.equal(payload.hours.length, 24)
  assert.equal(payload.hours[1].calls, 2)
  assert.equal(payload.hours[9].calls, 1)
  assert.equal(payload.hours[0].calls, 0)
  // 当天 400 token，按 2:1 摊到 1 点与 9 点
  assert.equal(payload.hours[1].tokens, 267)
  assert.equal(payload.hours[9].tokens, 133)
})

test('aggregate 模型与工具排行带份额，且受 topN 限制', () => {
  const payload = aggregate([
    entry('s1', 'S', true, [
      message('2026-10-13T01:00:00Z', { inputTokens: 900, outputTokens: 0 }, 'big'),
      message('2026-10-13T02:00:00Z', { inputTokens: 100, outputTokens: 0 }, 'small'),
      toolCall('2026-10-13T01:00:00Z', 'read'),
      toolCall('2026-10-13T02:00:00Z', 'read'),
      toolCall('2026-10-13T03:00:00Z', 'bash'),
    ]),
  ], { days: 3, now: NOW, timeZone: TZ, topN: 1 })
  assert.deepEqual(payload.models.map((row) => row.model), ['big'])
  assert.equal(payload.models[0].share, 0.9)
  assert.deepEqual(payload.tools.map((row) => row.name), ['read'])
  assert.equal(payload.tools[0].calls, 2)
  assert.equal(payload.tools[0].share, 2 / 3)
  assert.equal(payload.totals.models, 2, 'topN 只截断列表，不截断计数')
  assert.equal(payload.totals.tools, 2)
})

test('aggregate 会话排行带 activeDays 与窗口内首末活动日', () => {
  const payload = aggregate([
    entry('lo', '低', true, [message('2026-10-13T01:00:00Z', { inputTokens: 10, outputTokens: 0 })]),
    entry('hi', '高', false, [
      message('2026-10-11T01:00:00Z', { inputTokens: 900, outputTokens: 0 }),
      message('2026-10-13T02:00:00Z', { inputTokens: 100, outputTokens: 0 }),
    ]),
  ], { days: 3, now: NOW, timeZone: TZ })
  assert.deepEqual(payload.sessions.map((row) => row.id), ['hi', 'lo'])
  const hi = payload.sessions[0]
  assert.equal(hi.activeDays, 2)
  assert.equal(hi.firstDay, '2026-10-11')
  assert.equal(hi.lastDay, '2026-10-13')
  assert.equal(hi.tokens.total, 1000)
})

test('aggregate 不计入窗口内没有任何活动的会话', () => {
  const payload = aggregate([
    entry('idle', '闲置', true, []),
    entry('old', '很久以前', false, [message('2026-01-05T01:00:00Z', { inputTokens: 999, outputTokens: 0 })]),
    entry('now', '这几天在动', true, [message('2026-10-13T01:00:00Z', { inputTokens: 5, outputTokens: 0 })]),
  ], { days: 3, now: NOW, timeZone: TZ })
  assert.equal(payload.totals.sessions, 1)
  assert.deepEqual(payload.sessions.map((row) => row.id), ['now'])
  assert.equal(payload.totals.tokens.total, 5)
})

test('aggregate 错误透传、非法时区回落 UTC、generatedAt 保留', () => {
  const payload = aggregate([], {
    days: 2,
    now: NOW,
    timeZone: 'Bad/Zone',
    errors: [{ sessionId: 'x', message: 'boom' }],
    generatedAt: 12345,
  })
  assert.equal(payload.timeZone, 'UTC')
  assert.deepEqual(payload.errors, [{ sessionId: 'x', message: 'boom' }])
  assert.equal(payload.generatedAt, 12345)
  assert.equal(payload.days.length, 2)
  assert.equal(payload.year.length, 365)
  assert.equal(payload.totals.cacheHitRate, 0)
  assert.equal(payload.totals.peakDay, null)
  assert.equal(payload.hours.length, 24)
})

test('aggregate 忽略畸形 entry', () => {
  const payload = aggregate([null, 'x', {}, { sessionId: 's1' }, { sessionId: 's2', fold: null }], {
    days: 2, now: NOW, timeZone: TZ,
  })
  assert.equal(payload.totals.sessions, 0)
})

test('aggregate 的 days 收敛到 1–365', () => {
  assert.equal(aggregate([], { days: 9999, now: NOW, timeZone: TZ }).windowDays, 365)
  assert.equal(aggregate([], { days: 0, now: NOW, timeZone: TZ }).windowDays, 1)
  assert.equal(aggregate([], { days: 14, now: NOW, timeZone: TZ }).windowDays, 14)
})

console.log(`\n${passed} 项通过（metrics.js）`)
