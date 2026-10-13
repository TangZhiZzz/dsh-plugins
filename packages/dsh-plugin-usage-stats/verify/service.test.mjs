/**
 * 服务级测试：直接驱动 Host 半的取数服务（不经过 HTTP、不依赖运行中的进程）。
 *
 * 为什么需要这个文件：Node 的 ESM 模块按 specifier 缓存，`plugin_manager set_bundle`
 * 只重新 apply、不会重新 import 同一个包名 —— 改了 index.js 后线上进程仍跑旧模块，
 * 直到重启。所以 Host 逻辑必须在这里独立证明，不能只看线上路由。
 *
 * 本文件的重点是 **快**：`foldSessionDaily` 与窗口无关，所以换时间范围只在天行上聚合、
 * 不再读日志。这一点用「readSession 调用次数」直接钉住，而不是用计时断言（计时在 CI 会飘）。
 *
 * 运行：node verify/service.test.mjs
 */
import assert from 'node:assert/strict'
import { createDashboardService, normalizeConfig, noPersistence } from '../index.js'

let passed = 0
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

// ── 假会话语料：两个会话，事件时间刻意远离窗口边界，避免边界抖动。 ────────

const DAY = 86400000
const now = Date.now()

function message(time, inputTokens) {
  return {
    type: 'assistant/message',
    seq: time,
    time,
    data: {
      usage: { inputTokens, outputTokens: 0 },
      message: { source: { provider: 'deepseek', model: 'test-model' } },
    },
  }
}

const records = [
  { header: { id: 'recent', createdAt: now - 2 * DAY }, live: true, persisted: true },
  { header: { id: 'archived', createdAt: now - 120 * DAY }, live: false, persisted: true },
]

const logs = {
  recent: {
    session: { id: 'recent' },
    inheritedEventCount: 0,
    events: [message(now - 1 * DAY, 10), message(now - 20 * DAY, 1000)],
  },
  archived: {
    session: { id: 'archived' },
    inheritedEventCount: 0,
    events: [message(now - 60 * DAY, 5000), message(now - 100 * DAY, 99999)],
  },
}

let reads = 0

/**
 * 默认注入**空实现**的持久化：否则这些测试会去读真实临时目录里的缓存文件，
 * 结果取决于这台机器上次跑过什么 —— 那就不叫测试了。
 */
function makeService(config, persistence = noPersistence()) {
  const ctx = {
    sessionQuery: {
      async listSessions() { return records },
      async readSession(id) {
        reads += 1
        const log = logs[id]
        if (log === undefined) throw new Error(`unknown session ${id}`)
        return log
      },
    },
  }
  return createDashboardService(ctx, normalizeConfig(config), persistence)
}

/** 假的磁盘缓存读写：测试不碰真实文件系统。 */
function fakeIo(initial = {}) {
  const state = { loads: 0, saves: 0, saved: null }
  return {
    state,
    io: {
      async load() { state.loads += 1; return initial },
      async save(sessions) { state.saves += 1; state.saved = sessions },
    },
  }
}

/** 一份「上次进程退出时落盘」的天行（形状必须与 foldSessionDaily 一致）。 */
function diskFold(title, missTokens) {
  const tokens = { hit: 0, miss: missTokens, output: 0, total: missTokens }
  return {
    title,
    fold: {
      title,
      inheritedEventCount: 0,
      days: {
        '2026-01-01': {
          calls: 1,
          toolCalls: 0,
          tokens,
          hours: new Array(24).fill(0),
          // 关键形状：每个模型的桶是 { calls, tokens }，不是数字。
          models: { 'disk-model': { calls: 1, tokens } },
          tools: {},
        },
      },
    },
  }
}

/**
 * 形状坏掉的天行（旧版本写的 / 文件被改坏 / 写了一半）。
 * `models['x']` 是数字而不是 `{ calls, tokens }` —— aggregate 会在这里直接抛。
 */
function brokenDiskFold() {
  const tokens = { hit: 0, miss: 1, output: 0, total: 1 }
  return {
    title: 'broken',
    fold: {
      title: 'broken',
      inheritedEventCount: 0,
      days: {
        '2026-01-01': {
          calls: 1,
          toolCalls: 0,
          tokens,
          hours: new Array(24).fill(0),
          models: { 'disk-model': 1 },
          tools: {},
        },
      },
    },
  }
}

// ── 窗口化统计 ──────────────────────────────────────────────────────────────

await testAsync('days 决定窗口：窗口越宽，纳入的历史越多', async () => {
  const service = makeService({ liveFoldSeconds: 60 })
  const expectations = [
    [7, 10],
    [14, 10],
    [30, 1010],
    [90, 6010],
    [365, 106009],
  ]
  for (const [days, expected] of expectations) {
    const payload = await service.metrics({ days })
    assert.equal(payload.windowDays, days, `windowDays 应为 ${days}`)
    assert.equal(payload.days.length, days, `每日序列长度应为 ${days}`)
    assert.equal(payload.totals.tokens.total, expected, `days=${days} 的 token 总量`)
  }
})

await testAsync('每个载荷都带 365 天年度序列与 24 小时分布（与所选窗口无关）', async () => {
  const service = makeService({ liveFoldSeconds: 60 })
  const payload = await service.metrics({ days: 7 })
  assert.equal(payload.days.length, 7, '窗口序列是 7 天')
  assert.equal(payload.year.length, 365, '年度序列恒为 365 天')
  assert.equal(payload.hours.length, 24)
  // 年度序列能覆盖窗口外的历史：100 天前那 99999 token 只在年度里
  const old = payload.year.find((row) => row.tokens.total >= 99999)
  assert.ok(old !== undefined, '年度序列应包含窗口外的历史')
})

await testAsync('字符串入参（HTTP 查询串那种）也能用', async () => {
  const service = makeService({ liveFoldSeconds: 60 })
  const payload = await service.metrics({ days: '30' })
  assert.equal(payload.windowDays, 30)
  assert.equal(payload.totals.tokens.total, 1010)
})

await testAsync('非法与越界入参收敛到合法区间（含 null / 空串）', async () => {
  const service = makeService({ liveFoldSeconds: 60 })
  assert.equal((await service.metrics({ days: 'abc' })).windowDays, 14, '非法值回落配置默认 14')
  assert.equal((await service.metrics({ days: 9999 })).windowDays, 365, '上限 365')
  assert.equal((await service.metrics({ days: 0 })).windowDays, 1, '下限 1')
  assert.equal((await service.metrics({ days: -5 })).windowDays, 1, '负数收敛到 1')
  assert.equal((await service.metrics({})).windowDays, 14, '不传就是配置默认')
  // 回归：HTTP 查询串取不到参数时是 null（不是 undefined），而 Number(null) === 0。
  assert.equal((await service.metrics({ days: null })).windowDays, 14, 'null 必须走默认')
  assert.equal((await service.metrics({ days: '' })).windowDays, 14, '空串必须走默认')
  assert.equal((await service.metrics({ days: undefined })).windowDays, 14, 'undefined 走默认')
})

await testAsync('配置里的 days 是不同的默认窗口', async () => {
  const service = makeService({ days: 30, liveFoldSeconds: 60 })
  assert.equal((await service.metrics({})).windowDays, 30)
})

// ── 「快」的根据：切窗口不重读日志 ──────────────────────────────────────────

await testAsync('切时间范围不重读日志（天行与窗口无关，可复用）', async () => {
  reads = 0
  const service = makeService({ liveFoldSeconds: 60 })
  await service.metrics({ days: 7 })
  assert.equal(reads, 2, '首次要读两个会话')
  await service.metrics({ days: 30 })
  await service.metrics({ days: 90 })
  await service.metrics({ days: 365 })
  assert.equal(reads, 2, '换窗口只是在天行上聚合，不应再读日志')
})

await testAsync('perf 反映缓存命中：换窗口时 folded=0、reused=全部', async () => {
  const service = makeService({ liveFoldSeconds: 60 })
  const first = await service.metrics({ days: 7 })
  // unverified 是「还在用磁盘缓存、尚未后台校验」的条目数；这里没注入磁盘缓存，所以是 0。
  assert.deepEqual(first.perf, { sessions: 2, folded: 2, reused: 0, unverified: 0 })
  const second = await service.metrics({ days: 30 })
  assert.deepEqual(second.perf, { sessions: 2, folded: 0, reused: 2, unverified: 0 })
  assert.ok(Number.isFinite(second.computeMs) && second.computeMs >= 0, 'computeMs 应存在')
})

// ── 载荷缓存 ────────────────────────────────────────────────────────────────

await testAsync('载荷级缓存：同一窗口重复调用不再读日志并返回同一对象', async () => {
  reads = 0
  const service = makeService({ liveFoldSeconds: 60 })
  const first = await service.metrics({ days: 7 })
  const readsAfterFirst = reads
  const second = await service.metrics({ days: 7 })
  assert.equal(readsAfterFirst, 2)
  assert.equal(reads, readsAfterFirst, '同一窗口的第二次调用不应再读日志')
  assert.equal(second, first, '应返回同一个缓存对象')
})

await testAsync('活跃会话天行按 liveFoldSeconds 过期重折，归档会话继续复用', async () => {
  const readIds = []
  const service = createDashboardService({
    sessionQuery: {
      async listSessions() { return records },
      async readSession(id) { readIds.push(id); return logs[id] },
    },
  }, normalizeConfig({ refreshSeconds: 1, liveFoldSeconds: 1, foldCacheSeconds: 600 }), noPersistence())

  await service.metrics({ days: 7 })
  assert.deepEqual([...readIds].sort(), ['archived', 'recent'], '首次两个都要读')

  await new Promise((resolve) => setTimeout(resolve, 1200))
  readIds.length = 0
  await service.metrics({ days: 7 })
  assert.deepEqual(readIds, ['recent'], '活跃会话 TTL 到期要重折；归档会话继续复用')
})

// ── 失败隔离与子会话 ────────────────────────────────────────────────────────

await testAsync('单个会话读失败只记 errors，不影响整体', async () => {
  const service = createDashboardService({
    sessionQuery: {
      async listSessions() { return records },
      async readSession(id) {
        if (id === 'archived') throw new Error('boom')
        return logs[id]
      },
    },
  }, normalizeConfig({ liveFoldSeconds: 60 }), noPersistence())
  const payload = await service.metrics({ days: 7 })
  assert.equal(payload.errors.length, 1)
  assert.equal(payload.errors[0].sessionId, 'archived')
  assert.equal(payload.totals.tokens.total, 10, '未失败的那个会话照常统计')
})

await testAsync('子会话默认不计入', async () => {
  const withSub = [...records, { header: { id: 'sub', createdAt: now, origin: 'subagent' }, live: false, persisted: true }]
  const service = createDashboardService({
    sessionQuery: {
      async listSessions() { return withSub },
      async readSession(id) {
        if (id === 'sub') return { session: { id: 'sub' }, inheritedEventCount: 0, events: [message(now - DAY, 777)] }
        return logs[id]
      },
    },
  }, normalizeConfig({ liveFoldSeconds: 60 }), noPersistence())
  const payload = await service.metrics({ days: 7 })
  assert.equal(payload.totals.tokens.total, 10, '子会话的 777 不应计入')
  assert.equal(payload.totals.sessions, 1, '只有 recent 有窗口内数据')
})

await testAsync('并发折叠去重：预热与面板请求同时发生，同一个会话只读一次', async () => {
  reads = 0
  const service = makeService({ liveFoldSeconds: 60 })
  const [warm, panel] = await Promise.all([service.warm(), service.metrics({ days: 7 })])
  assert.equal(reads, 2, '两个会话各读一次（并发共享同一次折叠，不重复做功）')
  assert.equal(warm.sessions, 2)
  assert.equal(panel.ok, true)
  // 预热之后面板再取一次：全部命中缓存，不再读日志。
  reads = 0
  await service.metrics({ days: 30 })
  assert.equal(reads, 0, '预热过的缓存应被后续请求直接复用')
})

await testAsync('warm() 只热缓存、不建载荷', async () => {
  reads = 0
  const service = makeService({ liveFoldSeconds: 60 })
  const result = await service.warm()
  assert.deepEqual(result, { restored: 0, sessions: 2, folded: 2, reused: 0 })
  // 再 warm 一次：天行都在缓存里，不读日志。
  reads = 0
  const again = await service.warm()
  assert.deepEqual(again, { restored: 0, sessions: 2, folded: 0, reused: 2 })
  assert.equal(reads, 0)
})

// ── 磁盘缓存（跨进程复用非活跃会话的天行） ──────────────────────────────────

await testAsync('磁盘缓存：非活跃会话跨进程复用，重启后第一次取数只读活跃会话', async () => {
  const { state, io } = fakeIo({ archived: diskFold('cached', 7) })
  reads = 0
  const service = makeService({ liveFoldSeconds: 60 }, io)
  const payload = await service.metrics({ days: 365 })

  assert.equal(state.loads, 1, 'restore 只装载一次')
  assert.equal(reads, 1, '只有活跃会话需要读日志（归档那份来自磁盘缓存）')
  // 磁盘里的天行确实被用上了：7 个 miss token 进了总量（活跃会话是 10 + 1000）。
  assert.equal(payload.totals.tokens.miss, 7 + 1010)
  assert.equal(payload.perf.folded, 1)
  assert.equal(payload.perf.reused, 1)
})

await testAsync('活跃会话绝不吃磁盘缓存（它的日志还在追加写）', async () => {
  const { io } = fakeIo({ recent: diskFold('stale', 999999) })
  reads = 0
  const service = makeService({ liveFoldSeconds: 60 }, io)
  const payload = await service.metrics({ days: 365 })

  assert.equal(reads, 2, '活跃会话必须重折')
  // 磁盘里那 999999 是被恢复过的旧值，绝不能进总量；总量只应是日志里的
  // recent(10 + 1000) + archived(5000 + 99999)。
  assert.equal(payload.totals.tokens.miss, 1010 + 5000 + 99999)
})

await testAsync('后台轮转校验：过了 revalidateSeconds 就重折一个磁盘条目（逐步收敛）', async () => {
  const { io } = fakeIo({ archived: diskFold('cached', 7) })
  reads = 0
  const service = makeService({ liveFoldSeconds: 60, revalidateSeconds: 1 }, io)
  await service.metrics({ days: 365 })
  assert.equal(reads, 1, '第一次只用磁盘缓存')

  await new Promise((resolve) => setTimeout(resolve, 1100))
  reads = 0
  // 换一个窗口：绕开按窗口缓存的载荷，同时触发新一轮 loadEntries → 轮转校验。
  await service.metrics({ days: 90 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(reads >= 1, '过了校验间隔后应开始后台重折')

  // 校验把磁盘条目换成了真实天行：归档那份从 7 变成日志里的 5000 + 99999。
  // （用第三个窗口，避免又命中载荷缓存。）
  const payload = await service.metrics({ days: 200 })
  assert.equal(payload.totals.tokens.miss, 1010 + 5000 + 99999)
})

await testAsync('落盘只写非活跃会话（活跃会话的日志还在长，不写盘）', async () => {
  const { state, io } = fakeIo({})
  reads = 0
  const service = makeService({ liveFoldSeconds: 60 }, io)
  await service.metrics({ days: 7 })
  service.dispose() // dispose 会立刻把待写的缓存落盘
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(state.saves, 1)
  assert.ok(state.saved.archived !== undefined, '归档会话应写盘')
  assert.equal(state.saved.recent, undefined, '活跃会话不该写盘')
})

await testAsync('磁盘缓存读写失败都不影响功能（静默退回没有缓存）', async () => {
  const broken = {
    async load() { throw new Error('boom') },
    async save() { throw new Error('boom') },
  }
  reads = 0
  const service = makeService({ liveFoldSeconds: 60 }, broken)
  const payload = await service.metrics({ days: 7 })
  assert.equal(payload.ok, true)
  assert.equal(reads, 2, '缓存不可用时要老老实实读日志')
  service.dispose() // 不应抛出
})

await testAsync('persistFolds=false 时不装载也不落盘', async () => {
  const { state, io } = fakeIo({ archived: diskFold('cached', 7) })
  reads = 0
  const service = makeService({ liveFoldSeconds: 60, persistFolds: false }, io)
  await service.metrics({ days: 365 })
  service.dispose()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.loads, 0, '关掉持久化后不该读盘')
  assert.equal(state.saves, 0, '关掉持久化后不该写盘')
  assert.equal(reads, 2, '两个会话都要读日志')
})

await testAsync('损坏的磁盘缓存被拒绝，不会把面板搞崩（退回读日志）', async () => {
  const { io } = fakeIo({ archived: brokenDiskFold() })
  reads = 0
  const service = makeService({ liveFoldSeconds: 60 }, io)
  // 关键：这里**不能抛**。磁盘缓存是不受信任的输入，以前会在 aggregate 里直接炸。
  const payload = await service.metrics({ days: 365 })
  assert.equal(payload.ok, true)
  assert.equal(reads, 2, '坏条目应被丢弃 → 退回读日志')
  assert.equal(payload.perf.folded, 2)
  assert.equal(payload.perf.reused, 0)
})

await testAsync('JSON 往返无损：落盘再装载的天行与直接从日志折叠的结果完全一致', async () => {
  // 第一次：从日志折叠，落盘（+ 真的过一遍 JSON —— 磁盘上发生的正是这件事）
  const { state, io } = fakeIo({})
  reads = 0
  const first = makeService({ liveFoldSeconds: 60 }, io)
  const fromLog = await first.metrics({ days: 365 })
  first.dispose()
  await new Promise((resolve) => setImmediate(resolve))
  const onDisk = JSON.parse(JSON.stringify(state.saved))
  assert.ok(onDisk.archived !== undefined, '归档会话应落盘')

  // 第二次：新建服务 + 只给磁盘缓存（等价于进程重启后的第一次取数）
  const { io: io2 } = fakeIo(onDisk)
  reads = 0
  const second = makeService({ liveFoldSeconds: 60 }, io2)
  const fromDisk = await second.metrics({ days: 365 })

  assert.deepEqual(fromDisk.totals, fromLog.totals, '总量必须一致')
  assert.deepEqual(fromDisk.days, fromLog.days, '逐日明细必须一致')
  assert.deepEqual(fromDisk.year, fromLog.year, '年度序列必须一致')
  assert.deepEqual(fromDisk.hours, fromLog.hours, '小时分布必须一致')
  assert.deepEqual(fromDisk.models, fromLog.models, '模型排行必须一致')
  assert.deepEqual(fromDisk.tools, fromLog.tools, '工具排行必须一致')
  assert.deepEqual(fromDisk.sessions, fromLog.sessions, '会话排行必须一致')
  assert.equal(reads, 1, '只有活跃会话需要重读日志 —— 这就是「重启后秒开」')
})

console.log(`\n${passed} 项通过（service）`)
