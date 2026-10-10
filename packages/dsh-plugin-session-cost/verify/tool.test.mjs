/**
 * agent 工具（`tool.js`）的单测。
 *
 * 工具与 HTTP 路由**共用同一个取数服务**，所以这里不去重算价格，只守：
 *   - 载荷 → 工具输出值的形状映射（含 K/M 紧凑格式与「只列前 N 个」）；
 *   - 文本渲染；
 *   - `registerSessionCostTool` 的注册契约（名字、参数 schema、execute、render、参数校验）；
 *   - 拿不到 `@deepseek-ai/dsh-tools` 时「只告警、不注册」的降级路径。
 *
 * 运行（包目录内）：node verify/tool.test.mjs
 */

import assert from 'node:assert/strict'
import { buildToolValue, registerSessionCostTool, renderReport } from '../tool.js'
import { createCostService, normalizeConfig } from '../index.js'

const tests = []
const check = (label, fn) => tests.push({ label, fn })
const SKIP = Symbol('skip')

/** 手工造一个与 `createCostService().summary()` 同形的载荷。 */
function payloadOf({ scope = 'top', diagnostics = false } = {}) {
  const rows = [
    { id: 'session-a', title: 'A 会话', calls: 420, cost: 8.2797, priced: true, unpricedCalls: 0, live: true, tokens: { cacheHit: 189_200_000, cacheMiss: 897_000, output: 443_000 }, byModel: { 'deepseek-flash': 100 } },
    { id: 'session-b', title: 'B 会话', calls: 527, cost: 5.5105, priced: true, unpricedCalls: 2, live: false, tokens: { cacheHit: 115_600_000, cacheMiss: 174_000, output: 288_000 }, byModel: { 'deepseek-v4-pro': 5 } },
    { id: 'session-c', title: 'C 会话', calls: 12, cost: 0.5, priced: false, unpricedCalls: 12, live: false, tokens: { cacheHit: 1_000, cacheMiss: 500, output: 100 }, byModel: {} },
  ]
  return {
    ok: true,
    generatedAt: 1791511200000,
    currency: 'CNY',
    symbol: '¥',
    decimals: 4,
    totals: { cost: 14.2902, calls: 959, cacheHit: 304_801_000, cacheMiss: 1_071_500, output: 731_100 },
    sessions: scope === 'session' ? [rows[0]] : rows,
    session: scope === 'session' ? rows[0] : null,
    errors: diagnostics ? [{ sessionId: 'session-x', message: 'boom' }] : [],
    configWarnings: diagnostics ? ['rates.x 不是对象，已忽略'] : [],
    refreshMs: 5000,
  }
}

check('buildToolValue：载荷 → 工具输出值（展平 tokens、保留顺序、总额只算列出的）', () => {
  const value = buildToolValue(payloadOf(), { limit: 2 })
  assert.equal(value.scope, 'top')
  assert.equal(value.currency, 'CNY')
  assert.equal(value.symbol, '¥')
  assert.equal(value.sessions.length, 2, 'limit=2 只列前两个')
  assert.deepEqual(value.sessions.map((row) => row.id), ['session-a', 'session-b'])
  assert.equal(value.sessions[0].cacheHit, 189_200_000, 'tokens 展平成扁平字段')
  assert.equal(value.sessions[0].output, 443_000)
  assert.equal(value.sessions[0].live, true)
  assert.deepEqual(value.sessions[1].models, ['deepseek-v4-pro'])
  assert.equal(value.totalCost, Number((8.2797 + 5.5105).toFixed(6)), '总额 = 列出的会话之和')
  assert.deepEqual(value.notes, [])
})

check('buildToolValue：单会话载荷 → scope=session，总额即该会话', () => {
  const value = buildToolValue(payloadOf({ scope: 'session' }), {})
  assert.equal(value.scope, 'session')
  assert.equal(value.sessions.length, 1)
  assert.equal(value.totalCost, 8.2797)
})

check('buildToolValue：读取失败与配置告警进入 notes/configWarnings', () => {
  const value = buildToolValue(payloadOf({ diagnostics: true }), {})
  assert.equal(value.notes.length, 1)
  assert.ok(value.notes[0].includes('boom'))
  assert.equal(value.configWarnings.length, 1)
})

check('renderReport：金额、标题、K/M 紧凑 tokens、未定价与诊断提示', () => {
  const text = renderReport(buildToolValue(payloadOf({ diagnostics: true }), {}))
  assert.ok(text.includes('花费最高的 3 个会话，合计 ¥14.2902'), text)
  assert.ok(text.includes('A 会话 · ¥8.2797 · 420 次调用 · 命中/未命中/输出 189.2M/897K/443K · 活跃'), text)
  assert.ok(text.includes('未定价'), text)
  assert.ok(text.includes('未定价模型的调用'), text)
  assert.ok(text.includes('1 个会话读取失败'), text)
  assert.ok(text.includes('配置问题 1 条'), text)
})

check('renderReport：单会话模式文案', () => {
  const text = renderReport(buildToolValue(payloadOf({ scope: 'session' }), {}))
  assert.ok(text.startsWith('本会话：¥8.2797（420 次调用）'), text)
})

check('registerSessionCostTool：注册契约（名字/参数/execute/render/参数校验）', async () => {
  const calls = []
  const registered = []
  const ctx = {
    logger: { warn: () => {} },
    tools: { register: (definition) => { registered.push(definition); return 'disposer' } },
  }
  const disposer = registerSessionCostTool(ctx, {
    toolName: 'cost_probe',
    topN: 2,
    summary: async (options) => { calls.push(options); return payloadOf({ scope: options.sessionId === undefined ? 'top' : 'session' }) },
  })
  assert.equal(disposer, 'disposer')
  assert.equal(registered.length, 1)
  const definition = registered[0]
  assert.equal(definition.name, 'cost_probe')
  assert.equal(typeof definition.description, 'string')
  assert.equal(definition.parameters.type, 'object', 'defineTool 把参数规格转成 JSON Schema')
  assert.ok(definition.parameters.properties.sessionId)
  assert.equal(definition.output.schema.type, 'object')

  const ranked = await definition.execute({})
  assert.deepEqual(calls[0], { sessionId: undefined, signal: undefined })
  assert.equal(ranked.sessions.length, 2, 'topN=2 生效')
  assert.equal(ranked.totalCost, Number((8.2797 + 5.5105).toFixed(6)))

  await definition.execute({ sessionId: 'session-a', limit: 1 })
  assert.deepEqual(calls[1].sessionId, 'session-a')
  assert.equal(calls[1].signal, undefined)

  const content = definition.output.render({}, ranked)
  assert.equal(content[0].type, 'text')
  assert.ok(content[0].text.includes('¥13.7902'), content[0].text)

  const rejected = await definition.execute({ sessionId: 42 }).then(() => null, (error) => error)
  assert.ok(rejected !== null, '参数类型不符应被 defineTool 的参数校验拒绝')
})

check('registerSessionCostTool：转发 exec.signal', async () => {
  const calls = []
  const ctx = { logger: { warn: () => {} }, tools: { register: (definition) => definition } }
  const definition = registerSessionCostTool(ctx, {
    summary: async (options) => { calls.push(options); return payloadOf() },
  })
  const controller = new AbortController()
  await definition.execute({}, { signal: controller.signal })
  assert.equal(calls[0].signal, controller.signal)
})

check('registerSessionCostTool：拿不到 defineTool 时只告警、不注册（降级）', () => {
  const warnings = []
  let registered = 0
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    tools: { register: () => { registered += 1 } },
  }
  const result = registerSessionCostTool(ctx, { defineTool: undefined, summary: async () => payloadOf() })
  assert.equal(result, undefined)
  assert.equal(registered, 0)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('dsh-tools'))
})

check('registerSessionCostTool：缺少 summary 时立刻报错', () => {
  const ctx = { logger: { warn: () => {} }, tools: { register: () => 'x' } }
  assert.throws(() => registerSessionCostTool(ctx, { toolName: 'x' }), /缺少 summary/)
})

check('端到端：真实取数服务 → 工具输出（金额与路由同源）', async () => {
  const USAGE = { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100, totalTokens: 10100 }
  const PEAK = 1791511200000
  const snapshot = {
    inheritedEventCount: 0,
    session: { id: 'session-a' },
    events: [{
      type: 'assistant/message',
      seq: 1,
      time: PEAK,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
        usage: USAGE,
        stream: [],
      },
    }],
  }
  const ctx = {
    sessionQuery: { listSessions: async () => [{ header: { id: 'session-a' }, live: false }], readSession: async () => snapshot },
    get: () => undefined,
  }
  const service = createCostService(ctx, normalizeConfig(undefined))
  const registered = []
  registerSessionCostTool({ logger: { warn: () => {} }, tools: { register: (definition) => { registered.push(definition); return () => {} } } }, {
    toolName: 'session_cost',
    topN: 5,
    summary: (options) => service.summary(options),
  })
  const value = await registered[0].execute({})
  assert.equal(value.totalCost, 0.00316, '与路由共用同一份折叠与计价：¥0.00316')
  assert.equal(value.sessions[0].cacheHit, 9000)
  const text = registered[0].output.render({}, value)[0].text
  assert.ok(text.includes('¥0.0032'), text)
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
