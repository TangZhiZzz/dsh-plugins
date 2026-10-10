/**
 * 主行的内部模块：给 agent 的 `session_cost` 工具。
 *
 * 设计取舍（与"拆成第二行"相比）：
 *   - 工具**不再单独占一行**，也不再有自己的 Config —— 两行意味着两份价目表，迟早漂移；
 *   - 工具与 HTTP 路由共用 `createCostService(ctx, cfg)` 的同一份结果（同一份折叠、同一份定价、同一份缓存），
 *     所以 UI 上看到的金额与工具报出来的金额必然一致；
 *   - 本模块只做「转形状 + 渲染」，不含任何计价逻辑。
 *
 * 依赖：`@deepseek-ai/dsh-tools` 走 best-effort 动态导入（本包不允许静态裸导入，见 README 第 2 节）。
 * 解析不到时只告警：插件其余功能照常，只是没有这个工具。
 */

/** 工具契约助手；解析不到时本模块只告警不注册。 */
const toolsModule = await (async () => {
  try {
    return await import('@deepseek-ai/dsh-tools')
  } catch {
    return undefined
  }
})()

/** 与服务载荷同源的紧凑数字格式（K/M）——与 client.js 的 fmt 保持完全一致。 */
function compact(n) {
  const value = Number.isFinite(n) ? n : 0
  if (value < 1e3) return String(value)
  if (value < 1e6) return `${Math.round(value / 1e3)}K`
  return `${Math.round(value / 1e5) / 10}M`
}

/**
 * 把服务载荷转成工具的输出值（纯函数，便于单测）。
 * @param payload `createCostService().summary()` 的返回值
 * @param options.limit 最多列几个会话（不传表示全列）
 */
export function buildToolValue(payload, options = {}) {
  const all = Array.isArray(payload?.sessions) ? payload.sessions : []
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, options.limit)) : all.length
  const sessions = all.slice(0, limit).map((row) => ({
    id: String(row.id ?? ''),
    title: String(row.title ?? row.id ?? ''),
    live: row.live === true,
    calls: Number(row.calls ?? 0),
    priced: row.priced === true,
    unpricedCalls: Number(row.unpricedCalls ?? 0),
    cost: Number(row.cost ?? 0),
    cacheHit: Number(row.tokens?.cacheHit ?? 0),
    cacheMiss: Number(row.tokens?.cacheMiss ?? 0),
    output: Number(row.tokens?.output ?? 0),
    models: Object.keys(row.byModel ?? {}),
  }))
  const totalCost = Number(sessions.reduce((sum, row) => sum + row.cost, 0).toFixed(6))
  return {
    scope: payload?.session === null || payload?.session === undefined ? 'top' : 'session',
    currency: String(payload?.currency ?? 'CNY'),
    symbol: String(payload?.symbol ?? '¥'),
    decimals: Number.isFinite(payload?.decimals) ? payload.decimals : 4,
    generatedAt: Number(payload?.generatedAt ?? Date.now()),
    totalCost,
    sessions,
    notes: Array.isArray(payload?.errors) && payload.errors.length > 0
      ? payload.errors.map((entry) => `${entry.sessionId}: ${entry.message}`)
      : [],
    configWarnings: Array.isArray(payload?.configWarnings) ? payload.configWarnings : [],
  }
}

/** 模型/用户看到的内容：一张紧凑的文本表。 */
export function renderReport(value) {
  const money = (amount) => `${value.symbol}${amount.toFixed(value.decimals)}`
  const lines = [
    value.scope === 'session'
      ? `本会话：${money(value.totalCost)}（${value.sessions[0]?.calls ?? 0} 次调用）`
      : `花费最高的 ${value.sessions.length} 个会话，合计 ${money(value.totalCost)}`,
  ]
  for (const row of value.sessions) {
    const priced = row.priced ? money(row.cost) : '未定价'
    lines.push(`- ${row.title} · ${priced} · ${row.calls} 次调用 · 命中/未命中/输出 ${compact(row.cacheHit)}/${compact(row.cacheMiss)}/${compact(row.output)}${row.live ? ' · 活跃' : ''}`)
  }
  if (value.sessions.some((row) => row.unpricedCalls > 0)) lines.push('（有未定价模型的调用，金额只累计可定价部分）')
  if (value.notes.length > 0) lines.push(`（${value.notes.length} 个会话读取失败，已跳过）`)
  if (value.configWarnings.length > 0) lines.push(`（配置问题 ${value.configWarnings.length} 条，见设置页「会话消费」）`)
  lines.push('金额按 DeepSeek 官方公开价估算，高峰/空闲自动区分。')
  return lines.join('\n')
}

/** 输出 schema：与 `buildToolValue` 的形状一一对应（defineTool 只认单类型/oneOf 方言）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    scope: { type: 'string' },
    currency: { type: 'string' },
    symbol: { type: 'string' },
    decimals: { type: 'number' },
    generatedAt: { type: 'number' },
    totalCost: { type: 'number' },
    notes: { type: 'array', items: { type: 'string' } },
    configWarnings: { type: 'array', items: { type: 'string' } },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          live: { type: 'boolean' },
          calls: { type: 'number' },
          priced: { type: 'boolean' },
          unpricedCalls: { type: 'number' },
          cost: { type: 'number' },
          cacheHit: { type: 'number' },
          cacheMiss: { type: 'number' },
          output: { type: 'number' },
          models: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
}

/**
 * 把 `session_cost` 注册到宿主工具表。
 * @param ctx 已注入 `tools` 的作用域上下文（调用方用 `ctx.inject(['tools'], …)` 拿到）
 * @param options.toolName 工具名（来自主行 Config）
 * @param options.topN 不带 sessionId 时的默认条数
 * @param options.summary 取数函数：`(options) => Promise<payload>`，与路由共用同一条服务
 * @param options.defineTool 可注入的工具构造器；省略时用 `@deepseek-ai/dsh-tools` 的 `defineTool`
 *   （留出这个缝是为了能在没有该依赖的环境里验证「只告警、不注册」的降级路径）
 * @returns 注册 disposer；`defineTool` 不可用时返回 undefined（只告警）
 */
export function registerSessionCostTool(ctx, options = {}) {
  // 显式传入 defineTool（哪怕是 undefined）就以传入的为准；省略才回落到动态导入的那份。
  const defineTool = Object.hasOwn(options, 'defineTool') ? options.defineTool : toolsModule?.defineTool
  const toolName = typeof options.toolName === 'string' && options.toolName !== '' ? options.toolName : 'session_cost'
  if (typeof defineTool !== 'function') {
    ctx.logger?.warn?.(`dsh-plugin-session-cost: 解析不到 @deepseek-ai/dsh-tools，未注册 ${toolName} 工具（其余功能不受影响）`)
    return undefined
  }
  if (typeof options.summary !== 'function') throw new Error('registerSessionCostTool: 缺少 summary 取数函数')

  return ctx.tools.register(defineTool({
    name: toolName,
    description:
      'Report how much money DeepSeek Harness sessions have cost, estimated from provider-reported token usage and the official DeepSeek price list (peak/off-peak applied). Call it without arguments for the most expensive sessions, or pass sessionId for one session.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Session id to report. Omit it to rank the most expensive sessions instead.',
      },
      limit: {
        type: 'number',
        description: 'How many sessions to rank when sessionId is omitted. Defaults to the plugin config.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    async execute(args, exec) {
      const payload = await options.summary({ sessionId: args?.sessionId, signal: exec?.signal })
      return buildToolValue(payload, { limit: Number.isFinite(args?.limit) ? args.limit : options.topN })
    },
  }))
}
