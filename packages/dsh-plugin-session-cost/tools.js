/**
 * dsh-plugin-session-cost/tools —— **同一个包的第二行（子路径行）**。
 *
 * 为什么单独一行：loader 行是「可独立启停 / 独立 Config」的最小单位。
 * 本行只做一件事：给 agent 一个 `session_cost` 工具，查询当前或指定会话花了多少钱。
 * 关掉它不影响第一行（HTTP 路由 + UI），反之亦然。
 *
 * 与第一行共享同一份纯逻辑（`./index.js` 导出的折叠/计价函数），但**有自己的 Config**
 * （工具名、条数、是否统计子会话、货币符号、价目表）—— 两行各自定价，互不干扰。
 *
 * 依赖处理（踩过的坑）：本包以 pnpm `link:` 方式装进 profile 时，运行时的真实路径在仓库里，
 * 静态裸导入 `@deepseek-ai/*` 解析不到。所以这里**没有任何静态裸导入**：
 * `@deepseek-ai/dsh-tools` 用 best-effort 动态导入，拿不到就打印告警并让本行保持 inert，
 * 绝不连带影响第一行。
 */

import {
  DEFAULT_RATES,
  foldSession,
  normalizeConfig,
} from './index.js'

/** 工具契约助手：解析不到时本行跳过注册（只告警，不抛错）。 */
const toolsModule = await (async () => {
  try {
    return await import('@deepseek-ai/dsh-tools')
  } catch {
    return undefined
  }
})()

/** Config 的 schema 同样 best-effort：解析不到时用原始 config，由 normalizeConfig 收敛。 */
const SchemaModule = await (async () => {
  try {
    return (await import('@deepseek-ai/schemastery')).default
  } catch {
    return undefined
  }
})()

/** 行标识：子路径行的 moduleName 就是它。 */
export const name = 'dsh-plugin-session-cost/tools'

/** 硬依赖：注册工具 + 读会话日志。缺任一则本行保持 pending，而不是抛错。 */
export const inject = ['tools', 'sessionQuery']

export const Config = SchemaModule === undefined ? undefined : SchemaModule.object({
  toolName: SchemaModule.string().default('session_cost')
    .description('暴露给 agent 的工具名；改这里可以避免与其它插件重名。'),
  topN: SchemaModule.natural().default(5)
    .description('不指定 sessionId 时，返回花费最高的前 N 个会话。'),
  includeSubagents: SchemaModule.boolean().default(true)
    .description('是否统计 origin=subagent 的子会话。'),
  symbol: SchemaModule.string().default('¥')
    .description('结果里的金额前缀（本行独立配置，与第一行互不影响）。'),
  decimals: SchemaModule.natural().default(4)
    .description('金额小数位。'),
  rates: SchemaModule.dict(SchemaModule.object({
    cacheHit: SchemaModule.number().required(),
    cacheMiss: SchemaModule.number().required(),
    output: SchemaModule.number().required(),
    cacheWrite: SchemaModule.number(),
  })).default(DEFAULT_RATES)
    .description('本行的价目表（高峰时段价 / 百万 tokens）；省略即用官方默认。'),
})

/** 一次汇总结果里单个会话的形状（纯数据，便于单测与 schema 对齐）。 */
export function sessionRow(record, acc) {
  const header = record?.header ?? {}
  const id = String(header.id ?? '')
  return {
    id,
    title: acc.titleFromLog
      ?? acc.firstUserText
      ?? (id.startsWith('session-') ? id.slice(0, 16) : id),
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    live: record?.live === true,
    calls: acc.calls,
    priced: acc.pricedCalls > 0,
    unpricedCalls: acc.unpricedCalls,
    cost: Number(acc.cost.toFixed(6)),
    cacheHit: acc.tokens.cacheHit,
    cacheMiss: acc.tokens.cacheMiss,
    output: acc.tokens.output,
    models: Object.keys(acc.byModel),
  }
}

/** 收集语料（可选单个会话 / 前 N 个）。抽成导出函数，便于单测直接喂假 ctx。 */
export async function collect(ctx, cfg, options = {}) {
  const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : null
  const fallbackTopN = Number.isFinite(cfg.topN) ? cfg.topN : 5
  const limit = Math.max(1, Math.min(50, Number.isFinite(options.limit) ? options.limit : fallbackTopN))
  const rows = []
  const notes = []

  if (sessionId !== null) {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    // 别用 `ctx.sessions?.…`：cordis 对**未 inject 的服务**是「访问即抛错」，可选链救不了它；
    // 可选服务必须走 ctx.get(name)（宿主自己的契约里也是这么写的）。
    const live = ctx.get('sessions')?.get?.(sessionId) !== undefined
    const record = { header: snapshot?.session ?? { id: sessionId }, live }
    rows.push(sessionRow(record, foldSession(snapshot, cfg)))
  } else {
    const records = await ctx.sessionQuery.listSessions(options.signal)
    const wanted = records.filter((record) => cfg.includeSubagents || record?.header?.origin !== 'subagent')
    for (const record of wanted) {
      const id = String(record?.header?.id ?? '')
      if (id === '') continue
      try {
        const snapshot = await ctx.sessionQuery.readSession(id)
        rows.push(sessionRow(record, foldSession(snapshot, cfg)))
      } catch (error) {
        notes.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    rows.sort((a, b) => (b.cost - a.cost) || (b.calls - a.calls))
    rows.length = Math.min(rows.length, limit)
  }

  return {
    scope: sessionId === null ? 'top' : 'session',
    currency: cfg.currency,
    symbol: cfg.symbol,
    decimals: cfg.decimals,
    generatedAt: Date.now(),
    totalCost: Number(rows.reduce((sum, row) => sum + row.cost, 0).toFixed(6)),
    sessions: rows,
    notes,
  }
}

/** 模型/用户看到的内容：一张紧凑的文本表。 */
export function renderReport(value) {
  const money = (amount) => `${value.symbol}${amount.toFixed(value.decimals)}`
  const compact = (n) => (n < 1e3 ? String(n) : n < 1e6 ? `${Math.round(n / 1e3)}K` : `${Math.round(n / 1e5) / 10}M`)
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
  lines.push('金额按 DeepSeek 官方公开价估算，高峰/空闲自动区分。')
  return lines.join('\n')
}

export function apply(ctx, config) {
  // normalizeConfig 只认主行那套字段；本行特有的 topN 在这里单独收敛。
  const topN = Number.isFinite(config?.topN) ? Math.max(1, Math.min(50, config.topN)) : 5
  const cfg = { ...normalizeConfig({ rates: config?.rates ?? DEFAULT_RATES, ...config }), topN }
  const toolName = typeof config?.toolName === 'string' && config.toolName !== '' ? config.toolName : 'session_cost'
  const defineTool = toolsModule?.defineTool

  if (typeof defineTool !== 'function') {
    ctx.logger?.warn?.('dsh-plugin-session-cost/tools: 解析不到 @deepseek-ai/dsh-tools，本行未注册 session_cost 工具（第一行不受影响）')
    return
  }

  ctx.tools.register(defineTool({
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
      schema: {
        type: 'object',
        properties: {
          scope: { type: 'string' },
          currency: { type: 'string' },
          symbol: { type: 'string' },
          decimals: { type: 'number' },
          generatedAt: { type: 'number' },
          totalCost: { type: 'number' },
          notes: { type: 'array', items: { type: 'string' } },
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
              // 会话行还带 cwd 等字段：不进 schema（避免 nullable 数组类型），靠 additionalProperties 放行
              additionalProperties: true,
            },
          },
        },
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    async execute(args, exec) {
      return collect(ctx, cfg, {
        sessionId: args?.sessionId,
        limit: args?.limit,
        signal: exec?.signal,
      })
    },
  }))
}
