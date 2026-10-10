/**
 * 取数服务的单测（`createCostService`）。
 *
 * 重点守两件事：
 *   1. **单会话路径只读那一个会话** —— 徽标每 5 秒轮询，绝不该把整个语料折叠一遍；
 *   2. 语料路径的缓存语义：历史会话按 `persistedCacheMs` 复用、live 会话每次重读、
 *      单飞 + TTL 让多页面轮询只算一次、`readConcurrency` 限制并发。
 *
 * 运行（包目录内）：node verify/service.test.mjs
 */

import assert from 'node:assert/strict'
import { createCostService, normalizeConfig } from '../index.js'

// 2026-10-09(周五) 10:00 高峰 / 22:00 空闲（+08）
const PEAK = 1791511200000
const OFF_PEAK = 1791554400000
const USAGE = { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100, totalTokens: 10100 }
// deepseek-flash 高峰 0.00316 / 空闲 0.00158；deepseek-v4-pro 高峰 0.0144
const FLASH_PEAK = 0.00316
const FLASH_OFFPEAK = 0.00158
const PRO_PEAK = 0.0144

const assistant = (time, model) => ({
  type: 'assistant/message',
  seq: 1,
  time,
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model } },
    usage: USAGE,
    stream: [],
  },
})

const RECORDS = [
  { header: { id: 'session-a', cwd: 'C:\\a' }, live: false, persisted: true },
  { header: { id: 'session-b', cwd: 'C:\\b' }, live: true, persisted: true },
  { header: { id: 'session-c', cwd: 'C:\\c', origin: 'subagent' }, live: false, persisted: true },
]
const SNAPSHOTS = {
  'session-a': { inheritedEventCount: 0, session: { id: 'session-a' }, events: [assistant(PEAK, 'deepseek-flash'), { type: 'session/title', seq: 2, time: PEAK, data: { title: 'A 会话' } }] },
  'session-b': { inheritedEventCount: 0, session: { id: 'session-b' }, events: [assistant(OFF_PEAK, 'deepseek-flash')] },
  'session-c': { inheritedEventCount: 0, session: { id: 'session-c' }, events: [assistant(PEAK, 'deepseek-v4-pro')] },
}

function makeCtx({ failIds = [], readDelayMs = 0 } = {}) {
  const reads = []
  let inFlight = 0
  let maxInFlight = 0
  const ctx = {
    sessionQuery: {
      listSessions: async () => RECORDS,
      readSession: async (id) => {
        reads.push(id)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs))
          if (failIds.includes(id)) throw new Error(`boom:${id}`)
          if (SNAPSHOTS[id] === undefined) throw new Error(`no such session: ${id}`)
          return SNAPSHOTS[id]
        } finally {
          inFlight -= 1
        }
      },
    },
    get: (name) => (name === 'sessions' ? { get: (id) => (id === 'session-b' ? { header: { id } } : undefined) } : undefined),
  }
  return { ctx, reads, stats: () => ({ maxInFlight }) }
}

const cfg = normalizeConfig(undefined)
const tests = []
const check = (label, fn) => tests.push({ label, fn })

check('单会话路径：只读那一个会话（不折叠整个语料）', async () => {
  const { ctx, reads } = makeCtx()
  const service = createCostService(ctx, cfg)
  const payload = await service.summary({ sessionId: 'session-a' })
  assert.deepEqual(reads, ['session-a'], `只应读 session-a，实际：${reads.join(',')}`)
  assert.equal(payload.ok, true)
  assert.equal(payload.session.id, 'session-a')
  assert.equal(payload.session.title, 'A 会话')
  assert.equal(payload.session.cost, FLASH_PEAK)
  assert.equal(payload.sessions.length, 1, '单会话载荷只含这一个会话')
  assert.equal(payload.totals.cost, FLASH_PEAK)
  assert.equal(payload.totals.calls, 1)
})

check('单会话路径：active 会话带上 live 标记（走 ctx.get，不碰未 inject 的服务）', async () => {
  const { ctx } = makeCtx()
  const service = createCostService(ctx, cfg)
  const payload = await service.summary({ sessionId: 'session-b' })
  assert.equal(payload.session.live, true)
  assert.equal(payload.session.cost, FLASH_OFFPEAK, '空闲时段按 0.5 折')
})

check('单会话路径：短 TTL 内复用（第二次不再读盘）', async () => {
  const { ctx, reads } = makeCtx()
  const service = createCostService(ctx, cfg)
  const first = await service.summary({ sessionId: 'session-a' })
  const second = await service.summary({ sessionId: 'session-a' })
  assert.equal(reads.length, 1, `refreshMs 内只该读一次，实际 ${reads.length} 次`)
  assert.equal(first, second, '返回同一个载荷对象')
})

check('单会话路径：读不到时返回空载荷 + errors，而不是抛错', async () => {
  const { ctx } = makeCtx()
  const service = createCostService(ctx, cfg)
  const payload = await service.summary({ sessionId: 'session-zzz' })
  assert.equal(payload.session, null)
  assert.deepEqual(payload.sessions, [])
  assert.equal(payload.totals.cost, 0)
  assert.equal(payload.errors.length, 1)
  assert.ok(payload.errors[0].message.includes('no such session'))
})

check('语料路径：按金额降序、总额正确、subagent 计入', async () => {
  const { ctx, reads } = makeCtx()
  const service = createCostService(ctx, cfg)
  const payload = await service.summary()
  assert.deepEqual(payload.sessions.map((row) => row.id), ['session-c', 'session-a', 'session-b'])
  assert.equal(payload.sessions[0].cost, PRO_PEAK)
  assert.equal(payload.totals.cost, Number((PRO_PEAK + FLASH_PEAK + FLASH_OFFPEAK).toFixed(6)))
  assert.equal(payload.totals.calls, 3)
  assert.equal(payload.session, null)
  assert.equal(reads.length, 3, '语料路径读三个会话')
})

check('语料路径：includeSubagents=false 时排除子会话', async () => {
  const { ctx, reads } = makeCtx()
  const service = createCostService(ctx, { ...cfg, includeSubagents: false })
  const payload = await service.summary()
  assert.deepEqual(payload.sessions.map((row) => row.id), ['session-a', 'session-b'])
  assert.equal(payload.totals.cost, Number((FLASH_PEAK + FLASH_OFFPEAK).toFixed(6)))
  assert.equal(reads.length, 2)
})

check('语料路径：单飞（并发调用只算一次）', async () => {
  const { ctx, reads } = makeCtx({ readDelayMs: 5 })
  const service = createCostService(ctx, cfg)
  const [first, second] = await Promise.all([service.summary(), service.summary()])
  assert.equal(first, second, '并发调用共享同一个结果对象')
  assert.equal(reads.length, 3, `只该折叠一轮，实际 ${reads.length} 次读取`)
})

check('语料路径：TTL 内直接复用上次结果', async () => {
  const { ctx, reads } = makeCtx()
  const service = createCostService(ctx, cfg)
  const first = await service.summary()
  const second = await service.summary()
  assert.equal(first, second)
  assert.equal(reads.length, 3, 'TTL 内不该再读盘')
})

check('语料路径：TTL 过后 live 会话重读、历史会话沿用折叠缓存', async () => {
  const { ctx, reads } = makeCtx()
  const service = createCostService(ctx, { ...cfg, refreshMs: 1000 })
  await service.summary()
  assert.equal(reads.length, 3)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await service.summary()
  const secondRound = reads.slice(3)
  assert.deepEqual(secondRound, ['session-b'], `第二轮只该重读 live 会话，实际 ${secondRound.join(',')}`)
})

check('语料路径：单个会话读失败 → errors 记录，其余照常', async () => {
  const { ctx } = makeCtx({ failIds: ['session-b'] })
  const service = createCostService(ctx, cfg)
  const payload = await service.summary()
  assert.deepEqual(payload.sessions.map((row) => row.id), ['session-c', 'session-a'])
  assert.equal(payload.errors.length, 1)
  assert.equal(payload.errors[0].sessionId, 'session-b')
})

check('readConcurrency：并发读取不超过配置值', async () => {
  const { ctx, stats } = makeCtx({ readDelayMs: 10 })
  const service = createCostService(ctx, { ...cfg, readConcurrency: 2 })
  await service.summary()
  assert.equal(stats().maxInFlight, 2, '三个会话 + 上限 2 → 峰值并发应为 2')
})

check('载荷自带展示所需的元信息与配置告警', async () => {
  const { ctx } = makeCtx()
  const service = createCostService(ctx, normalizeConfig({ symbol: '$', currency: 'USD', decimals: 2, rates: { 'x*': { cacheHit: 'a', cacheMiss: 1, output: 1 } } }))
  const payload = await service.summary()
  assert.equal(payload.symbol, '$')
  assert.equal(payload.currency, 'USD')
  assert.equal(payload.decimals, 2)
  assert.ok(payload.configWarnings.length >= 1, '非法价目条目应产生 configWarnings')
  assert.equal(payload.pricing.patterns.includes('x*'), false)
  assert.equal(typeof payload.refreshMs, 'number')
})

check('signal 已中止时立刻失败（不启动取数）', async () => {
  const { ctx, reads } = makeCtx()
  const service = createCostService(ctx, cfg)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => service.summary({ signal: controller.signal }), /aborted/)
  assert.equal(reads.length, 0)
})

let passed = 0
for (const { label, fn } of tests) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${label}`)
}

console.log(`\n${passed} checks passed`)
