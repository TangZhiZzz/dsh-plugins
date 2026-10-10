/**
 * dsh-plugin-session-cost — Host 半。
 *
 * 目标：算清「每个会话消费了多少钱」。
 *
 * 事实来源（全部来自已提交的会话日志，可重放、可核对）：
 *   - `ctx.sessionQuery.listSessions()` 列出全部逻辑会话（活跃 + 已归档，newest-first）；
 *   - `ctx.sessionQuery.readSession(id)` 读回一个会话的完整事件日志（活跃会话优先读内存），
 *     并给出 `inheritedEventCount` —— 承接自父会话/fork 的事件条数，这部分不计入本会话消费；
 *   - `assistant/message` 事件里的 `usage`（provider 真实上报）与 `message.source.{provider,model}`
 *     是唯一计价依据。`inputTokens` 为「缓存未命中输入」，`cacheReadTokens` 为「缓存命中输入」，
 *     `outputTokens` 为输出（依 DeepSeek 语义，reasoning 已含在 output 内，不重复计）。
 *
 * 价格：核心不带价目表，所以本插件自带一张「按官方公开价」的默认表，并全部可在 Config 覆盖。
 * 默认表来自 DeepSeek 官方《模型 & 价格》（人民币 / 百万 tokens，高峰时段价）：
 *   deepseek-flash     命中 0.04  未命中 2   输出 8
 *   deepseek-v4-pro    命中 0.30  未命中 9   输出 27
 *   空闲时段 = 高峰 × offPeakFactor（官方为 0.5）。
 * 高峰时段：按 timeZone（默认 Asia/Shanghai）周一至周五 09:00-12:00 与 14:00-18:00，
 * 法定节假日由 Config.holidays 显式列出（无法凭空推算），列出后整天按空闲计价。
 *
 * 暴露给 UI 的唯一入口：`GET /dsh-session-cost/summary`（同源、仅本机/受信 Host 可读）。
 *
 * 关于依赖：本机 `plugin_manager` 对「目录 target」使用 pnpm 的 `link:` 协议，插件运行时
 * 的真实路径仍在工作区，Node 会从**真实路径**向上找 node_modules —— 因此 profile 里的
 * `@deepseek-ai/*` 解析不到（实测 ERR_MODULE_NOT_FOUND）。所以本文件不写任何静态裸导入：
 * Config 的 schema 用 best-effort 动态导入，解析不到时插件照常工作，配置改走
 * cordis.patch.yml 的原始 config（normalizeConfig 里带完整默认值与收敛）。
 *
 * 结构：本文件 = 纯逻辑 + 取数服务 + 路由骨架；agent 工具在 ./tool.js（**同一行**内注册，
 * 与路由共用同一个取数服务，所以两处金额必然一致）。
 */

import { registerSessionCostTool } from './tool.js'

/** schemastery 的 best-effort 加载结果；undefined 表示当前组合里解析不到（不影响功能）。 */
const SchemaModule = await (async () => {
  try {
    return (await import('@deepseek-ai/schemastery')).default
  } catch {
    return undefined
  }
})()

/** 本地别名：只在 Config 可构造时才被求值。 */
const Schema = SchemaModule

/** Plugin identity（必须与 package.json 的 name 一致）。 */
export const name = 'dsh-plugin-session-cost'

/** 硬依赖：读会话日志 + 注册取数路由。缺任一则本插件保持 pending 而不是抛错。 */
export const inject = ['sessionQuery', 'webServer']

/** 供 Client 半与验证脚本复用的路由路径。 */
export const ROUTE_PATH = '/dsh-session-cost/summary'

/** 官方公开价（人民币 / 百万 tokens，高峰时段）。键支持 `前缀*` 匹配，`*` 为兜底。 */
export const DEFAULT_RATES = {
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-flash-vision-exp': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4.1-flash*': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  'deepseek-reasoner': { cacheHit: 1, cacheMiss: 4, output: 16 },
  'deepseek-chat': { cacheHit: 0.5, cacheMiss: 2, output: 8 },
}

/**
 * 可调参数一律放 Config：用户能在 cordis.patch.yml 里整体覆盖。
 * schema 只负责校验与表单投影（cordis 的 resolveConfig 在 `!runtime.Config` 时原样放行），
 * 所以解析不到 schemastery 时这里给 undefined，配置仍按原始对象进入 normalizeConfig。
 */
export const Config = SchemaModule === undefined ? undefined : SchemaModule.object({
  currency: Schema.string().default('CNY')
    .description('币种代码，仅用于展示。'),
  symbol: Schema.string().default('¥')
    .description('金额前缀符号。'),
  decimals: Schema.natural().default(4)
    .description('金额显示小数位。'),
  timeZone: Schema.string().default('Asia/Shanghai')
    .description('判定高峰/空闲时段所用时区。'),
  peakWeekdays: Schema.array(Schema.natural()).default([1, 2, 3, 4, 5])
    .description('高峰时段的星期（1=周一 … 7=周日）。'),
  peakWindows: Schema.array(Schema.string()).default(['09:00-12:00', '14:00-18:00'])
    .description('高峰时段窗口，本地时间 HH:mm-HH:mm。'),
  offPeakFactor: Schema.number().default(0.5)
    .description('空闲时段折扣系数（官方：空闲价 = 高峰价的一半）。'),
  holidays: Schema.array(Schema.string()).default([])
    .description('法定节假日（YYYY-MM-DD，按 timeZone），列出的日期整天按空闲计价。'),
  rates: Schema.dict(Schema.object({
    cacheHit: Schema.number().required().description('缓存命中输入价 / 百万 tokens。'),
    cacheMiss: Schema.number().required().description('缓存未命中输入价 / 百万 tokens。'),
    output: Schema.number().required().description('输出价 / 百万 tokens。'),
    cacheWrite: Schema.number().description('缓存写入价；省略时按 cacheMiss 计。'),
  })).default(DEFAULT_RATES)
    .description('模型 id → 高峰时段单价（人民币 / 百万 tokens）；键以 * 结尾表示前缀匹配。'),
  refreshSeconds: Schema.natural().default(5)
    .description('服务端重算的最小间隔（秒）；页面轮询频率也取它。'),
  persistedCacheSeconds: Schema.natural().default(600)
    .description('非活跃（已归档）会话折叠结果的缓存秒数。'),
  includeSubagents: Schema.boolean().default(true)
    .description('是否统计 origin=subagent 的子会话。'),
  readConcurrency: Schema.natural().default(4)
    .description('折叠历史会话时的并发磁盘读取上限。'),
  exposeTool: Schema.boolean().default(true)
    .description('是否向 agent 暴露 session_cost 工具（关掉后每次请求的工具体积更小）。'),
  toolName: Schema.string().default('session_cost')
    .description('agent 工具名；改这里可避免与其它插件重名。'),
  topN: Schema.natural().default(5)
    .description('工具不带 sessionId 时，返回花费最高的前 N 个会话。'),
})

// ── 配置规范化 ──────────────────────────────────────────────────────────────

const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/** `HH:mm` → 分钟；非法返回 undefined。 */
function toMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim())
  if (!m) return undefined
  return Number(m[1]) * 60 + Number(m[2])
}

/** 把 Config 规范化成内部结构；缺失字段全部回落到默认值，非法条目丢弃并告警。 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  const warnings = []
  const rawRates = raw.rates && typeof raw.rates === 'object' && Object.keys(raw.rates).length > 0
    ? raw.rates
    : DEFAULT_RATES
  const rates = {}
  for (const [pattern, rate] of Object.entries(rawRates)) {
    if (rate === null || typeof rate !== 'object') {
      warnings.push(`rates.${pattern} 不是对象，已忽略`)
      continue
    }
    const cacheHit = Number(rate.cacheHit)
    const cacheMiss = Number(rate.cacheMiss)
    const output = Number(rate.output)
    if (!Number.isFinite(cacheHit) || !Number.isFinite(cacheMiss) || !Number.isFinite(output)) {
      warnings.push(`rates.${pattern} 的 cacheHit/cacheMiss/output 必须都是数字，已忽略该模型（它会被记为「未定价」）`)
      continue
    }
    rates[pattern] = {
      cacheHit,
      cacheMiss,
      output,
      ...(Number.isFinite(Number(rate.cacheWrite)) ? { cacheWrite: Number(rate.cacheWrite) } : {}),
    }
  }
  if (Object.keys(rates).length === 0) warnings.push('价目表为空：所有模型都会记为「未定价」')
  if (String(raw.timeZone ?? '') !== '' && !isValidTimeZone(raw.timeZone)) {
    warnings.push(`timeZone "${raw.timeZone}" 不被 Intl 识别，已回落到 Asia/Shanghai`)
  }
  const windows = (Array.isArray(raw.peakWindows) && raw.peakWindows.length > 0 ? raw.peakWindows : ['09:00-12:00', '14:00-18:00'])
    .map((w) => {
      const [start, end] = String(w).split('-')
      return { start: toMinutes(start), end: toMinutes(end) }
    })
    .filter((w) => w.start !== undefined && w.end !== undefined)
  if (windows.length === 0) warnings.push('peakWindows 里没有合法的 HH:mm-HH:mm 窗口，已回落到官方高峰时段')
  /** 实际生效的窗口（给端点回显用，避免再依赖原始 config）。 */
  const effectiveWindows = windows.length > 0 ? windows : [{ start: 540, end: 720 }, { start: 840, end: 1080 }]
  const label = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  return {
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : 'CNY',
    symbol: typeof raw.symbol === 'string' ? raw.symbol : '¥',
    decimals: Number.isFinite(raw.decimals) ? Math.max(0, Math.min(6, raw.decimals)) : 4,
    timeZone: typeof raw.timeZone === 'string' && raw.timeZone && isValidTimeZone(raw.timeZone) ? raw.timeZone : 'Asia/Shanghai',
    peakWeekdays: Array.isArray(raw.peakWeekdays) ? raw.peakWeekdays.map(Number) : [1, 2, 3, 4, 5],
    peakWindows: windows.length > 0 ? windows : [{ start: 540, end: 720 }, { start: 840, end: 1080 }],
    peakWindowLabels: effectiveWindows.map((w) => `${label(w.start)}-${label(w.end)}`),
    offPeakFactor: Number.isFinite(raw.offPeakFactor) ? raw.offPeakFactor : 0.5,
    holidays: Array.isArray(raw.holidays)
      ? raw.holidays.map((d) => (typeof d === 'object' && d !== null && 'date' in d ? d.date : d)).map(String)
      : [],
    rates,
    refreshMs: (Number.isFinite(raw.refreshSeconds) ? Math.max(1, raw.refreshSeconds) : 5) * 1000,
    persistedCacheMs: (Number.isFinite(raw.persistedCacheSeconds) ? Math.max(0, raw.persistedCacheSeconds) : 600) * 1000,
    includeSubagents: raw.includeSubagents !== false,
    readConcurrency: Number.isFinite(raw.readConcurrency) ? Math.max(1, Math.min(16, raw.readConcurrency)) : 4,
    exposeTool: raw.exposeTool !== false,
    toolName: typeof raw.toolName === 'string' && raw.toolName !== '' ? raw.toolName : 'session_cost',
    topN: Number.isFinite(raw.topN) ? Math.max(1, Math.min(50, raw.topN)) : 5,
    warnings,
  }
}

/** Intl 能构造出该时区就认。 */
function isValidTimeZone(name) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(name) })
    return true
  } catch {
    return false
  }
}

// ── 时间与计价 ──────────────────────────────────────────────────────────────

const formatterCache = new Map()

/** 取某时区下的本地时间分量（带缓存，避免每次调用新建 Intl 实例）。 */
function localParts(timeMs, timeZone) {
  let fmt = formatterCache.get(timeZone)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    formatterCache.set(timeZone, fmt)
  }
  const parts = {}
  for (const p of fmt.formatToParts(new Date(timeMs))) parts[p.type] = p.value
  return parts
}

/** 判定一次调用落在高峰还是空闲（`'peak'` / `'offPeak'`）。 */
export function tierOf(timeMs, cfg) {
  if (!Number.isFinite(timeMs)) return 'peak'
  const p = localParts(timeMs, cfg.timeZone)
  const date = `${p.year}-${p.month}-${p.day}`
  if (cfg.holidays.includes(date)) return 'offPeak'
  const weekday = WEEKDAY_INDEX[p.weekday]
  if (weekday === undefined || !cfg.peakWeekdays.includes(weekday)) return 'offPeak'
  const minutes = Number(p.hour) * 60 + Number(p.minute)
  for (const w of cfg.peakWindows) {
    if (minutes >= w.start && minutes < w.end) return 'peak'
  }
  return 'offPeak'
}

/** 解析模型单价：精确匹配 → 最长前缀匹配（`foo*`）→ `*` 兜底 → undefined（未定价）。 */
export function rateFor(model, rates) {
  if (typeof model !== 'string' || model === '') return undefined
  const exact = rates[model]
  if (exact !== undefined) return { rate: exact, pattern: model }
  let best
  for (const [pattern, rate] of Object.entries(rates)) {
    if (!pattern.endsWith('*')) continue
    const prefix = pattern.slice(0, -1)
    if (!model.startsWith(prefix)) continue
    if (best === undefined || prefix.length > best.prefix.length) best = { rate, pattern, prefix }
  }
  if (best !== undefined) return { rate: best.rate, pattern: best.pattern }
  if (rates['*'] !== undefined) return { rate: rates['*'], pattern: '*' }
  return undefined
}

const num = (v) => (Number.isFinite(v) ? v : 0)

/**
 * 归一化一次 provider usage。
 *
 * 关键点：DeepSeek（OpenAI/Anthropic 两种报文）里 `inputTokens` 是**不含缓存命中的**输入，
 * 与 `cacheReadTokens`、`outputTokens` 相加等于 `totalTokens`。本函数保留这个语义，
 * 并对「inputTokens 已含缓存命中」的其它 provider 风格做一次自洽性纠正。
 */
export function tokensOf(usage) {
  const input = num(usage?.inputTokens)
  const hit = num(usage?.cacheReadTokens)
  const write = num(usage?.cacheWriteTokens)
  const output = num(usage?.outputTokens)
  const total = num(usage?.totalTokens)
  let miss = input
  if (hit > 0 && total > 0 && input + hit + output > total) miss = Math.max(0, input - hit)
  return {
    cacheHit: hit,
    cacheMiss: miss,
    cacheWrite: write,
    output,
    total: total > 0 ? total : miss + hit + write + output,
  }
}

/** 一次调用的金额（元）。factor 用于空闲时段折扣。 */
export function computeCost(tokens, rate, factor = 1) {
  const writeRate = Number.isFinite(rate.cacheWrite) ? rate.cacheWrite : rate.cacheMiss
  const raw = tokens.cacheHit * num(rate.cacheHit)
    + tokens.cacheMiss * num(rate.cacheMiss)
    + tokens.cacheWrite * writeRate
    + tokens.output * num(rate.output)
  return (raw / 1e6) * factor
}

// ── 会话折叠 ────────────────────────────────────────────────────────────────

function emptyTokens() {
  return { cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, total: 0 }
}

/** 按 token 桶拆分的金额（元），用于 UI 明细。 */
function emptyCosts() {
  return { cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0 }
}

function addCosts(target, parts, factor) {
  target.cacheHit += parts.cacheHit * factor
  target.cacheMiss += parts.cacheMiss * factor
  target.cacheWrite += parts.cacheWrite * factor
  target.output += parts.output * factor
}

function addTokens(target, t) {
  target.cacheHit += t.cacheHit
  target.cacheMiss += t.cacheMiss
  target.cacheWrite += t.cacheWrite
  target.output += t.output
  target.total += t.total
}

function emptyAcc() {
  return {
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    usageMissingCalls: 0,
    cost: 0,
    costs: emptyCosts(),
    tokens: emptyTokens(),
    byModel: {},
    unpricedModels: [],
    aux: { title: 0, search: 0, other: 0 },
    firstTime: undefined,
    lastTime: undefined,
    titleFromLog: undefined,
    firstUserText: undefined,
  }
}

/** 从 `assistant/message.data` 取 usage：优先 `data.usage`，否则取流里最后一个 usage chunk。 */
export function usageOf(data) {
  const direct = data?.usage
  if (direct && typeof direct === 'object' && Number.isFinite(direct.inputTokens)) return direct
  const stream = Array.isArray(data?.stream) ? data.stream : []
  let last
  for (const record of stream) {
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage) last = record.chunk.usage
  }
  return last
}

/** 从消息里抽一段可读文本（标题兜底用）。 */
function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') return block.text
  }
  return undefined
}

/**
 * 折叠一个会话的事件日志。纯函数，便于单测与交叉验证。
 *
 * @param snapshot `{ events, inheritedEventCount }`（来自 sessionQuery.readSession）
 * @param cfg normalizeConfig 的结果
 */
export function foldSession(snapshot, cfg) {
  const acc = emptyAcc()
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  const inherited = Number(snapshot?.inheritedEventCount ?? 0) || 0

  for (let i = 0; i < events.length; i += 1) {
    if (i < inherited) continue // 承接自父会话/fork 的事件：token 花在别处，不重复计价
    const event = events[i]
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    const time = Number.isFinite(event.time) ? event.time : undefined
    if (time !== undefined) {
      if (acc.firstTime === undefined) acc.firstTime = time
      acc.lastTime = time
    }
    const data = event.data ?? {}

    if (event.type === 'assistant/message') {
      acc.calls += 1
      const source = data?.message?.source ?? {}
      const model = typeof source.model === 'string' && source.model !== '' ? source.model : 'unknown'
      const provider = typeof source.provider === 'string' ? source.provider : 'unknown'
      let bucket = acc.byModel[model]
      if (bucket === undefined) {
        bucket = { provider, calls: 0, cost: 0, costs: emptyCosts(), priced: false, unpricedCalls: 0, tokens: emptyTokens(), tiers: {} }
        acc.byModel[model] = bucket
      }
      bucket.calls += 1
      const usage = usageOf(data)
      if (usage === undefined) {
        acc.usageMissingCalls += 1
        bucket.unpricedCalls += 1
        continue
      }
      const tokens = tokensOf(usage)
      addTokens(acc.tokens, tokens)
      addTokens(bucket.tokens, tokens)
      const resolved = rateFor(model, cfg.rates)
      if (resolved === undefined) {
        acc.unpricedCalls += 1
        bucket.unpricedCalls += 1
        if (!acc.unpricedModels.includes(model)) acc.unpricedModels.push(model)
        continue
      }
      const tier = tierOf(time, cfg)
      const factor = tier === 'offPeak' ? cfg.offPeakFactor : 1
      const writeRate = Number.isFinite(resolved.rate.cacheWrite) ? resolved.rate.cacheWrite : resolved.rate.cacheMiss
      const parts = {
        cacheHit: (tokens.cacheHit * num(resolved.rate.cacheHit)) / 1e6,
        cacheMiss: (tokens.cacheMiss * num(resolved.rate.cacheMiss)) / 1e6,
        cacheWrite: (tokens.cacheWrite * writeRate) / 1e6,
        output: (tokens.output * num(resolved.rate.output)) / 1e6,
      }
      const cost = computeCost(tokens, resolved.rate, factor)
      acc.cost += cost
      bucket.cost += cost
      addCosts(acc.costs, parts, factor)
      addCosts(bucket.costs, parts, factor)
      acc.pricedCalls += 1
      bucket.priced = true
      bucket.pattern = resolved.pattern
      bucket.tiers[tier] = (bucket.tiers[tier] ?? 0) + 1
      continue
    }

    if (/-llm-request$/.test(event.type) && event.type !== 'request/header') {
      // 标题生成、联网搜索等辅路调用：日志里没有 provider usage，只能计数。
      if (event.type.includes('title')) acc.aux.title += 1
      else if (event.type.includes('search') || event.type.includes('web')) acc.aux.search += 1
      else acc.aux.other += 1
      continue
    }

    if (acc.titleFromLog === undefined && typeof data.title === 'string' && data.title.trim() !== '') {
      acc.titleFromLog = data.title.trim()
      continue
    }

    if (acc.firstUserText === undefined && event.type === 'user/message') {
      const text = textOfMessage(data?.message ?? data)
      if (text !== undefined) acc.firstUserText = text.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  }

  return acc
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

/** 有并发上限的 map，避免一次性对所有历史会话发起磁盘读取。 */
async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function titleOf(record, acc) {
  if (typeof acc.titleFromLog === 'string' && acc.titleFromLog !== '') return acc.titleFromLog
  if (typeof acc.firstUserText === 'string' && acc.firstUserText !== '') return acc.firstUserText
  const id = String(record?.header?.id ?? '')
  return id.startsWith('session-') ? id.slice(0, 16) : id
}

function roundCosts(costs) {
  return {
    cacheHit: Number(costs.cacheHit.toFixed(6)),
    cacheMiss: Number(costs.cacheMiss.toFixed(6)),
    cacheWrite: Number(costs.cacheWrite.toFixed(6)),
    output: Number(costs.output.toFixed(6)),
  }
}

function serializeSession(record, acc, stale) {
  const header = record?.header ?? {}
  return {
    id: String(header.id ?? ''),
    title: titleOf(record, acc),
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    createdAt: Number.isFinite(header.createdAt) ? header.createdAt : null,
    origin: typeof header.origin === 'string' ? header.origin : null,
    parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
    live: record?.live === true,
    persisted: record?.persisted === true,
    stale: stale === true,
    calls: acc.calls,
    pricedCalls: acc.pricedCalls,
    unpricedCalls: acc.unpricedCalls,
    usageMissingCalls: acc.usageMissingCalls,
    cost: Number(acc.cost.toFixed(6)),
    costs: roundCosts(acc.costs),
    priced: acc.pricedCalls > 0,
    unpricedModels: acc.unpricedModels.slice(),
    tokens: { ...acc.tokens },
    byModel: Object.fromEntries(Object.entries(acc.byModel).map(([model, bucket]) => [model, {
      provider: bucket.provider,
      calls: bucket.calls,
      cost: Number(bucket.cost.toFixed(6)),
      costs: roundCosts(bucket.costs),
      priced: bucket.priced,
      unpricedCalls: bucket.unpricedCalls,
      pattern: bucket.pattern ?? null,
      tiers: { ...bucket.tiers },
      tokens: { ...bucket.tokens },
    }])),
    aux: { ...acc.aux },
    firstTime: acc.firstTime ?? null,
    lastActive: acc.lastTime ?? (Number.isFinite(header.createdAt) ? header.createdAt : null),
  }
}

function emptyTotals() {
  return {
    sessions: 0,
    liveSessions: 0,
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    usageMissingCalls: 0,
    cost: 0,
    tokens: emptyTokens(),
    costs: emptyCosts(),
    unpricedModels: [],
    aux: { title: 0, search: 0, other: 0 },
  }
}

function accumulateTotals(totals, session) {
  totals.sessions += 1
  if (session.live) totals.liveSessions += 1
  totals.calls += session.calls
  totals.pricedCalls += session.pricedCalls
  totals.unpricedCalls += session.unpricedCalls
  totals.usageMissingCalls += session.usageMissingCalls
  totals.cost += session.cost
  addTokens(totals.tokens, session.tokens)
  addCosts(totals.costs, session.costs, 1)
  totals.aux.title += session.aux.title
  totals.aux.search += session.aux.search
  totals.aux.other += session.aux.other
  for (const model of session.unpricedModels) {
    if (!totals.unpricedModels.includes(model)) totals.unpricedModels.push(model)
  }
}

// ── HTTP 栅栏（与 /api 网关同语义：loopback 或受信 Host，且非跨站） ──────────

function headerValue(headers, key) {
  const value = headers?.[key]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isTrustedRequest(request, trustedHosts) {
  const host = headerValue(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)) {
    const trusted = trustedHosts.some((entry) => {
      const entryUrl = parseAuthority(entry)
      if (entryUrl === undefined) return false
      const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
      const canonical = port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
      return canonical === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
    })
    if (!trusted) return false
  }
  if (headerValue(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── 取数服务 ────────────────────────────────────────────────────────────────

/**
 * 会话消费服务：把「读会话日志 → 折叠 → 计价」收在一处，路由与 agent 工具共用同一份实现
 * （价目表只有一份，不会漂移）。
 *
 * 两条取数路径：
 *   - `summary({ sessionId })`：**只读那一个会话**。徽标每 5 秒轮询就走这条，
 *     不会为了一个会话把 28 个会话全折叠一遍（这是本插件最实在的一处优化）。
 *   - `summary()`：整个语料，给设置页面板用；非活跃会话的折叠结果按 `persistedCacheMs` 缓存，
 *     并发读取上限由 `readConcurrency` 控制，单飞 + TTL 避免多页面重复计算。
 */
export function createCostService(ctx, cfg) {
  /** 非活跃会话的折叠结果缓存：归档后日志不再变化，没必要反复解压。 */
  const foldCache = new Map()
  /** 单会话路径的短 TTL 缓存：同一个会话在 refreshMs 内被多个页面问也只算一次。 */
  const sessionCache = new Map()
  let corpusResult = null
  let corpusInflight = null

  const rateOf = (id) => ctx.get('sessions')?.get?.(id)

  /** 折叠一个会话并序列化；`record` 提供 header/live。 */
  async function foldRow(record, { cacheable }) {
    const id = String(record?.header?.id ?? '')
    const cached = foldCache.get(id)
    const reusable = cacheable && cached !== undefined && Date.now() - cached.at < cfg.persistedCacheMs
    if (reusable) return { row: serializeSession(record, cached.acc, false), error: null }
    try {
      const snapshot = await ctx.sessionQuery.readSession(id)
      const acc = foldSession(snapshot, cfg)
      if (cacheable) foldCache.set(id, { at: Date.now(), acc })
      return { row: serializeSession(record, acc, false), error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (cached !== undefined) return { row: serializeSession(record, cached.acc, true), error: null }
      return { row: null, error: { sessionId: id, message } }
    }
  }

  /** 单会话：只动这一个会话的日志。 */
  async function collectSession(sessionId) {
    const live = rateOf(sessionId)
    const record = { header: live?.header ?? { id: sessionId }, live: live !== undefined }
    const { row, error } = await foldRow(record, { cacheable: live === undefined })
    const sessions = row === null ? [] : [row]
    const totals = emptyTotals()
    if (row !== null) accumulateTotals(totals, row)
    totals.cost = Number(totals.cost.toFixed(6))
    return { sessions, totals, session: row, errors: error === null ? [] : [error] }
  }

  /** 整个语料：active 会话每次都读内存日志，历史会话走缓存。 */
  async function collectCorpus(signal) {
    const records = await ctx.sessionQuery.listSessions(signal)
    const wanted = records.filter((record) => cfg.includeSubagents || record?.header?.origin !== 'subagent')
    const results = await mapLimited(wanted, cfg.readConcurrency, async (record) => {
      const id = String(record?.header?.id ?? '')
      if (id === '') return null
      return foldRow(record, { cacheable: record?.live !== true })
    })

    // 清掉已经不在语料里的会话缓存，避免长期驻留。
    const liveIds = new Set(wanted.map((record) => String(record?.header?.id ?? '')))
    for (const key of foldCache.keys()) if (!liveIds.has(key)) foldCache.delete(key)

    const sessions = results.filter((result) => result !== null && result.row !== null).map((result) => result.row)
    sessions.sort((a, b) => (b.cost - a.cost) || ((b.lastActive ?? 0) - (a.lastActive ?? 0)))
    const errors = results.filter((result) => result !== null && result.error !== null).map((result) => result.error)
    const totals = emptyTotals()
    for (const session of sessions) accumulateTotals(totals, session)
    totals.cost = Number(totals.cost.toFixed(6))
    return { sessions, totals, session: null, errors }
  }

  /**
   * 统一出口：两种路径返回同一种载荷形状，客户端无需分支。
   *
   * `signal` 只在**进入时**检查一次：语料路径的结果是「单飞 + TTL」共享给所有调用者的，
   * 为单个调用者取消会把共享结果一起废掉，所以不往下传（会话路径本来也只读一个文件）。
   */
  async function summary(options = {}) {
    const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : null
    const now = Date.now()
    if (options.signal?.aborted === true) throw new Error('aborted')

    if (sessionId === null) {
      if (corpusResult !== null && now - corpusResult.generatedAt < cfg.refreshMs) return corpusResult
      if (corpusInflight !== null) return corpusInflight
      corpusInflight = collectCorpus()
        .then((collected) => (corpusResult = buildPayload(collected, cfg)))
        .finally(() => { corpusInflight = null })
      return corpusInflight
    }

    const cached = sessionCache.get(sessionId)
    if (cached !== undefined && now - cached.at < cfg.refreshMs) return cached.payload
    const payload = buildPayload(await collectSession(sessionId), cfg)
    sessionCache.set(sessionId, { at: now, payload })
    // 单会话缓存很小（一行），但也别无限增长。
    if (sessionCache.size > 64) sessionCache.delete(sessionCache.keys().next().value)
    return payload
  }

  return { summary, collectSession, collectCorpus }
}

/** 把收集结果包成对外载荷（两种路径同形）。 */
function buildPayload(collected, cfg) {
  return {
    ok: true,
    generatedAt: Date.now(),
    currency: cfg.currency,
    symbol: cfg.symbol,
    decimals: cfg.decimals,
    timeZone: cfg.timeZone,
    pricing: {
      source: 'DeepSeek 官方公开价（高峰时段价 / 百万 tokens），空闲时段按 offPeakFactor 折扣',
      peakWindows: cfg.peakWindowLabels,
      peakWeekdays: cfg.peakWeekdays,
      offPeakFactor: cfg.offPeakFactor,
      holidays: cfg.holidays,
      patterns: Object.keys(cfg.rates),
      fallback: cfg.rates['*'] !== undefined ? '*' : null,
    },
    totals: collected.totals,
    sessions: collected.sessions,
    session: collected.session,
    errors: collected.errors,
    configWarnings: cfg.warnings,
    refreshMs: cfg.refreshMs,
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const service = createCostService(ctx, cfg)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (request, response) => {
      const webRuntime = ctx.get('webRuntime')
      const trustedHosts = Array.isArray(webRuntime?.trustedHosts) ? webRuntime.trustedHosts : []
      if (!isTrustedRequest(request, trustedHosts)) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('forbidden')
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('method not allowed')
        return
      }
      try {
        const url = new URL(request.url ?? ROUTE_PATH, 'http://dsh.internal')
        const payload = await service.summary({ sessionId: url.searchParams.get('sessionId') })
        const body = Buffer.from(JSON.stringify(payload), 'utf8')
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.byteLength),
          'cache-control': 'no-store',
        })
        if (request.method === 'HEAD') response.end()
        else response.end(body)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const body = Buffer.from(JSON.stringify({ ok: false, error: message }), 'utf8')
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength) })
        response.end(body)
      }
    },
  }), 'dsh-plugin-session-cost: /dsh-session-cost/summary route')

  // agent 工具挂在**同一行**里（不再单独占一行）：用作用域注入拿到 tools，
  // 没装这个服务时插件照常工作，只是没有工具。
  if (cfg.exposeTool && typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scoped) => registerSessionCostTool(scoped, {
      toolName: cfg.toolName,
      topN: cfg.topN,
      summary: (options) => service.summary(options),
    }))
  }
}
