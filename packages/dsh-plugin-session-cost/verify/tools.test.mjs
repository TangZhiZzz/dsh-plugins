/**
 * 第二行（`dsh-plugin-session-cost/tools`）的单测：
 *   - 纯函数 `collect` / `sessionRow` / `renderReport` 用假 ctx 直接喂数据；
 *   - `apply` 注册出来的工具定义逐项检查（名字、参数 schema、execute、render、参数校验）；
 *   - 解析不到 `@deepseek-ai/dsh-tools` 时必须是「告警 + 不注册」，而不是抛错。
 *
 * 运行（包目录内）：node verify/tools.test.mjs
 */

import assert from 'node:assert/strict'
import { Config, apply, collect, inject, name, renderReport, sessionRow } from '../tools.js'
import { normalizeConfig } from '../index.js'

// 与 fold.test.mjs 同一组基准点：2026-10-09(周五) 10:00 高峰 / 22:00 空闲（+08）
const PEAK = 1791511200000
const OFF_PEAK = 1791554400000
const USAGE = { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100, totalTokens: 10100 }
// deepseek-flash 高峰 = 9000×0.04 + 1000×2 + 100×8 = 0.00316 元；空闲 ×0.5 = 0.00158 元
const PEAK_COST = 0.00316
const OFF_PEAK_COST = 0.00158

const assistant = (time, model = 'deepseek-flash') => ({
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
  { header: { id: 'session-a', cwd: 'C:\\work\\a' }, live: false, persisted: true },
  { header: { id: 'session-b', cwd: 'C:\\work\\b' }, live: true, persisted: true },
]
const SNAPSHOTS = {
  'session-a': {
    inheritedEventCount: 0,
    session: { id: 'session-a' },
    events: [assistant(PEAK), { type: 'session/title', seq: 2, time: PEAK, data: { title: 'A 会话' } }],
  },
  'session-b': { inheritedEventCount: 0, session: { id: 'session-b' }, events: [assistant(OFF_PEAK)] },
}

const LIVE_SESSIONS = new Map([['session-b', { id: 'session-b' }]])

/**
 * 假 ctx —— **刻意复刻 cordis 的硬约束**：未 inject 的服务直接访问会抛错
 * （`ctx.sessions` 不行，可选链也救不了），可选服务只能走 `ctx.get(name)`。
 * 这样「不小心写了 ctx.sessions?.…」这类回归会被测试当场抓住。
 */
function makeCtx(overrides = {}) {
  const base = {
    logger: { warn: () => {} },
    tools: { register: () => { throw new Error('本用例不该注册工具') } },
    sessionQuery: {
      listSessions: async () => RECORDS,
      readSession: async (id) => {
        if (SNAPSHOTS[id] === undefined) throw new Error(`no such session: ${id}`)
        return SNAPSHOTS[id]
      },
    },
    get: (name) => (name === 'sessions' ? { get: (id) => LIVE_SESSIONS.get(id) } : undefined),
    ...overrides,
  }
  return new Proxy(base, {
    get(target, key) {
      if (key === 'sessions') throw new Error('cannot get property "sessions" without inject')
      return target[key]
    },
  })
}

const cfg = { ...normalizeConfig(undefined), topN: 5 }
const tests = []
const check = (label, fn) => tests.push({ label, fn })
const SKIP = Symbol('skip')

check('行标识与依赖声明符合子路径行约定', () => {
  assert.equal(name, 'dsh-plugin-session-cost/tools')
  assert.deepEqual(inject, ['tools', 'sessionQuery'])
})

check('Config（best-effort schema）含本行特有字段 toolName / topN / rates', () => {
  if (typeof Config !== 'function') throw SKIP
  const resolved = Config({})
  assert.equal(resolved.toolName, 'session_cost')
  assert.equal(resolved.topN, 5)
  assert.equal(resolved.rates['deepseek-flash'].cacheMiss, 2)
  assert.equal(resolved.symbol, '¥')
})

check('collect：不带 sessionId → 按金额降序，字段/总额/tokens 正确', async () => {
  const all = await collect(makeCtx(), cfg, {})
  assert.equal(all.scope, 'top')
  assert.equal(all.sessions.length, 2)
  assert.equal(all.sessions[0].id, 'session-a', '高峰会话金额更高，应排第一')
  assert.equal(all.sessions[0].title, 'A 会话', '标题来自日志里的 session/title')
  assert.equal(all.sessions[0].cost, PEAK_COST)
  assert.equal(all.sessions[1].id, 'session-b')
  assert.equal(all.sessions[1].cost, OFF_PEAK_COST)
  assert.equal(all.sessions[1].title, 'session-b', '无标题时回落到 id')
  assert.equal(all.totalCost, Number((PEAK_COST + OFF_PEAK_COST).toFixed(6)))
  assert.deepEqual(
    [all.sessions[0].cacheHit, all.sessions[0].cacheMiss, all.sessions[0].output],
    [9000, 1000, 100],
  )
  assert.deepEqual([all.sessions[0].live, all.sessions[1].live], [false, true])
  assert.equal(all.currency, 'CNY')
  assert.equal(all.symbol, '¥')
})

check('collect：limit 生效（topN 只影响默认值）', async () => {
  const limited = await collect(makeCtx(), cfg, { limit: 1 })
  assert.equal(limited.sessions.length, 1)
  assert.equal(limited.sessions[0].id, 'session-a')
  const byConfig = await collect(makeCtx(), { ...cfg, topN: 1 }, {})
  assert.equal(byConfig.sessions.length, 1, '不传 limit 时用 cfg.topN')
})

check('collect：单会话模式（按事件时间判空闲价，活跃标记走 ctx.get 而非 ctx.sessions）', async () => {
  const one = await collect(makeCtx(), cfg, { sessionId: 'session-b' })
  assert.equal(one.scope, 'session')
  assert.equal(one.sessions.length, 1)
  assert.equal(one.sessions[0].cost, OFF_PEAK_COST)
  assert.equal(one.totalCost, OFF_PEAK_COST)
  assert.equal(one.sessions[0].live, true, 'session-b 在假 sessions 服务里 → live 应为 true')
  // 若哪天又写成 ctx.sessions?.…，上面的 collect 会因 Proxy 抛错而直接失败
})

check('collect：单个会话读失败 → 记 notes，不抛错、不影响其它会话', async () => {
  const ctx = makeCtx({
    sessionQuery: {
      listSessions: async () => RECORDS,
      readSession: async () => { throw new Error('boom') },
    },
  })
  const result = await collect(ctx, cfg, {})
  assert.equal(result.sessions.length, 0)
  assert.equal(result.notes.length, 2)
  assert.ok(result.notes[0].includes('boom'))
})

check('sessionRow：无标题时截断 id', () => {
  const row = sessionRow({ header: { id: 'session-abcdefghijklmnop' } }, {
    titleFromLog: undefined,
    firstUserText: undefined,
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    cost: 0,
    tokens: { cacheHit: 0, cacheMiss: 0, output: 0 },
    byModel: {},
  })
  assert.equal(row.title, 'session-abcdefgh')
  assert.equal(row.cost, 0)
  assert.equal(row.priced, false)
})

check('renderReport：文本含金额、标题、紧凑 tokens 与计价说明', () => {
  const text = renderReport({
    scope: 'top',
    symbol: '¥',
    decimals: 4,
    totalCost: 0.00474,
    notes: [],
    sessions: [
      { title: 'A 会话', cost: PEAK_COST, calls: 1, cacheHit: 9000, cacheMiss: 1000, output: 100, live: false, priced: true, unpricedCalls: 0 },
      { title: 'B 会话', cost: OFF_PEAK_COST, calls: 1, cacheHit: 9000, cacheMiss: 1000, output: 100, live: true, priced: true, unpricedCalls: 0 },
    ],
  })
  assert.ok(text.includes('¥0.0047'), text)
  assert.ok(text.includes('A 会话') && text.includes('B 会话'), text)
  assert.ok(text.includes('9K/1K/100'), text)
  assert.ok(text.includes('官方公开价'), text)
})

check('apply：注册工具（名字来自 config、topN 生效、execute/render/参数校验都正常）', async () => {
  const registered = []
  const warnings = []
  const ctx = makeCtx({
    logger: { warn: (message) => warnings.push(message) },
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
  })
  apply(ctx, { toolName: 'cost_probe', topN: 1, includeSubagents: true, symbol: '¥', decimals: 4 })

  if (registered.length === 0) {
    assert.ok(warnings.some((line) => line.includes('@deepseek-ai/dsh-tools')), `应给出降级告警：${warnings.join('|')}`)
    throw SKIP
  }

  const definition = registered[0]
  assert.equal(definition.name, 'cost_probe', '工具名来自本行 config')
  assert.equal(typeof definition.description, 'string')
  assert.equal(definition.parameters.type, 'object', 'defineTool 会把参数规格转成 JSON Schema')
  assert.ok(definition.parameters.properties.sessionId, '应有 sessionId 参数')
  assert.equal(definition.output.schema.type, 'object')

  const ranked = await definition.execute({})
  assert.equal(ranked.scope, 'top')
  assert.equal(ranked.sessions.length, 1, 'topN=1 应只返回一个会话')
  assert.equal(ranked.sessions[0].id, 'session-a')

  const single = await definition.execute({ sessionId: 'session-b' })
  assert.equal(single.scope, 'session')
  assert.equal(single.totalCost, OFF_PEAK_COST)

  const content = definition.output.render({}, ranked)
  assert.equal(content[0].type, 'text')
  assert.ok(content[0].text.includes('¥0.0032'), content[0].text)

  const rejected = await definition.execute({ sessionId: 42 }).then(() => null, (error) => error)
  assert.ok(rejected !== null, '参数类型不符应被 defineTool 的参数校验拒绝')
})

let passed = 0
let skipped = 0
for (const { label, fn } of tests) {
  try {
    await fn()
    passed += 1
    console.log(`ok ${passed} - ${label}`)
  } catch (error) {
    if (error === SKIP) {
      skipped += 1
      console.log(`skip - ${label}`)
      continue
    }
    throw error
  }
}

console.log(`\n${passed} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''}`)
