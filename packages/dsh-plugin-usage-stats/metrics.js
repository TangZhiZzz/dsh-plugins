/**
 * dsh-plugin-usage-stats — 纯逻辑层（无宿主依赖，可单测）。
 *
 * 事实来源：**已提交的会话日志**。不自己存状态，只做三件事：
 *   1. 从 `assistant/message.usage` 取 provider 真实上报的 token（命中 / 未命中 / 输出）；
 *   2. 从 `tool/call` 数工具使用；
 *   3. 按配置时区把事件落到「天」和「小时」。
 *
 * 计价不在本模块：金额由 dsh-plugin-session-cost 自己算（它持有价目表），
 * Client 半直接读它的路由。两个插件各算各的必然会漂移，所以钱只有一个来源。
 *
 * token 语义（与 dsh-plugin-session-cost 保持一致，DeepSeek / OpenAI 报文）：
 *   `inputTokens`       = **不含**缓存命中的输入（即 cacheMiss）
 *   `cacheReadTokens`   = 缓存命中输入
 *   `outputTokens`      = 输出（reasoning 已含在内，不重复计）
 *   少数 provider 把命中算进 input，做一次自洽纠正以免重复计数。
 *
 * ── 为什么是「按天折叠、与窗口无关」（v0.2 的核心改动） ──────────────────────
 *
 * v0.1 把会话折叠结果按「窗口 + 会话」缓存，于是**每换一次时间范围就把所有会话
 * 重新折一遍**（实测冷启动 7s、换窗口 7s）。这是「慢」的根因。
 *
 * 现在 `foldSessionDaily()` 只按「天」折叠一次，产出与窗口无关的天行：
 *
 *     天 → { 调用数, 工具数, token 三段, 24 小时计数, 各模型, 各工具 }
 *
 * 任何窗口（7 / 30 / 90 / 365 天）都只是在这些天行上做一次聚合（`aggregate()`），
 * 不碰日志。于是：
 *   - 切窗口几乎不花时间；
 *   - 年度热力图、逐日明细、小时分布、模型/工具排行全部来自同一份天行，零额外读取；
 *   - 缓存可以按会话长期复用（归档会话的日志不再变化）。
 */

/** 归一化一次 provider usage。 */
export function tokensOf(usage) {
  const num = (value) => (Number.isFinite(value) ? value : 0)
  const input = num(usage?.inputTokens)
  const hit = num(usage?.cacheReadTokens)
  const write = num(usage?.cacheWriteTokens)
  const output = num(usage?.outputTokens)
  const total = num(usage?.totalTokens)
  const miss = total > 0 && input + hit > total ? Math.max(0, total - hit) : input
  return { hit, miss: miss + write, output, total: miss + write + hit + output }
}

/** 从 `assistant/message.data` 取 usage：优先 `data.usage`，否则取流里最后一个 usage chunk。 */
export function usageOf(data) {
  const direct = data?.usage
  if (direct !== null && typeof direct === 'object' && Number.isFinite(direct.inputTokens)) return direct
  const stream = Array.isArray(data?.stream) ? data.stream : []
  let last
  for (const record of stream) {
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage) last = record.chunk.usage
  }
  return last
}

export function emptyTokens() {
  return { hit: 0, miss: 0, output: 0, total: 0 }
}

export function addTokens(target, part) {
  target.hit += part.hit
  target.miss += part.miss
  target.output += part.output
  target.total += part.total
}

/**
 * 会话标题。优先只认标题事件（类型里带 `title`），避免误取无关事件里的同名 `title`；
 * 都没有再退回宽松扫描，仍然取最后一个（重命名后应显示新名）。
 */
export function titleOf(snapshot) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  let strict
  let loose
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const title = event.data?.title
    if (typeof title !== 'string' || title.trim() === '') continue
    const trimmed = title.trim()
    loose = trimmed
    if (typeof event.type === 'string' && event.type.includes('title')) strict = trimmed
  }
  return strict ?? loose
}

// ── 时区 / 天 / 小时 ────────────────────────────────────────────────────────

const dayFormatterCache = new Map()
const hourFormatterCache = new Map()

/** 非法时区名一律回落 UTC，而不是抛错（配置写错不该让面板白屏）。 */
export function safeTimeZone(name) {
  const candidate = typeof name === 'string' && name !== '' ? name : 'UTC'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate })
    return candidate
  } catch {
    return 'UTC'
  }
}

/** `YYYY-MM-DD`（按给定时区）。en-CA 的短日期格式恰好就是 ISO 形状。 */
export function dayKey(timeMs, timeZone) {
  if (!Number.isFinite(timeMs)) return undefined
  let formatter = dayFormatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    dayFormatterCache.set(timeZone, formatter)
  }
  return formatter.format(new Date(timeMs))
}

/**
 * 0–23 小时（按给定时区）。
 * 明确用 `hourCycle: 'h23'`：默认的 h24 会把午夜给成 `24`，那样小时分布会多出一格。
 */
export function hourOf(timeMs, timeZone) {
  if (!Number.isFinite(timeMs)) return undefined
  let formatter = hourFormatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' })
    hourFormatterCache.set(timeZone, formatter)
  }
  const hour = Number(formatter.format(new Date(timeMs)))
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : undefined
}

/** `YYYY-MM-DD` → 0=周日 … 6=周六。只读日历日，不受本机时区影响。 */
export function weekdayOf(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day))
  if (match === null) return undefined
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(ms) ? new Date(ms).getUTCDay() : undefined
}

/** 最近 `days` 天的日期键，从旧到新，含今天。 */
export function recentDays(now, days, timeZone) {
  const keys = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(now - i * 86400000, timeZone)
    if (key !== undefined) keys.push(key)
  }
  return keys
}

// ── 会话折叠（与窗口无关，只按天） ──────────────────────────────────────────

function emptyDayRow() {
  return {
    calls: 0,
    toolCalls: 0,
    tokens: emptyTokens(),
    hours: new Array(24).fill(0),
    models: Object.create(null),
    tools: Object.create(null),
  }
}

function dayRowOf(days, key) {
  let row = days[key]
  if (row === undefined) {
    row = emptyDayRow()
    days[key] = row
  }
  return row
}

/**
 * 把一个会话的日志折叠成「天行」。纯函数，结果与时间窗口无关，可以长期缓存。
 *
 * `inheritedEventCount` 之前的整段是 fork/子会话承接自父会话的事件 —— 那些 token
 * 花在父会话里，重复计会让总量虚高，所以跳过（与 session-cost 口径一致）。
 *
 * @returns `{ title, firstTime, lastTime, calls, toolCalls, tokens, days }`
 */
export function foldSessionDaily(snapshot, options = {}) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  const inherited = Number(snapshot?.inheritedEventCount ?? 0) || 0
  const timeZone = safeTimeZone(options.timeZone)

  const acc = {
    titleStrict: undefined,
    titleLoose: undefined,
    firstTime: undefined,
    lastTime: undefined,
    calls: 0,
    toolCalls: 0,
    tokens: emptyTokens(),
    days: Object.create(null),
  }

  for (let i = 0; i < events.length; i += 1) {
    if (i < inherited) continue
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
      const day = dayKey(time, timeZone)
      const row = day === undefined ? null : dayRowOf(acc.days, day)
      if (row !== null) row.calls += 1

      const usage = usageOf(data)
      if (usage === undefined) continue
      const tokens = tokensOf(usage)
      addTokens(acc.tokens, tokens)
      if (row === null) continue
      addTokens(row.tokens, tokens)

      const hour = hourOf(time, timeZone)
      if (hour !== undefined) row.hours[hour] += 1

      const source = data.message?.source ?? {}
      const model = typeof source.model === 'string' && source.model !== '' ? source.model : 'unknown'
      let slot = row.models[model]
      if (slot === undefined) {
        slot = { calls: 0, tokens: emptyTokens() }
        row.models[model] = slot
      }
      slot.calls += 1
      addTokens(slot.tokens, tokens)
      continue
    }

    if (event.type === 'tool/call') {
      acc.toolCalls += 1
      const day = dayKey(time, timeZone)
      if (day === undefined) continue
      const row = dayRowOf(acc.days, day)
      row.toolCalls += 1
      const name = typeof data.name === 'string' && data.name !== '' ? data.name : 'unknown'
      row.tools[name] = (row.tools[name] ?? 0) + 1
      continue
    }

    // 标题：优先只认标题事件（类型里带 `title`），都没有再退回宽松扫描；
    // 两者都取**最后**一个，因为会话重命名后应该显示新名字。
    const looseTitle = typeof data.title === 'string' && data.title.trim() !== '' ? data.title.trim() : undefined
    if (looseTitle !== undefined) {
      acc.titleLoose = looseTitle
      if (event.type.includes('title')) acc.titleStrict = looseTitle
    }
  }

  return {
    title: acc.titleStrict ?? acc.titleLoose,
    firstTime: acc.firstTime,
    lastTime: acc.lastTime,
    calls: acc.calls,
    toolCalls: acc.toolCalls,
    tokens: acc.tokens,
    days: acc.days,
  }
}

// ── 窗口聚合（只在天行上做，不读日志） ──────────────────────────────────────

function emptyWindowDay() {
  return {
    calls: 0,
    toolCalls: 0,
    tokens: emptyTokens(),
    hours: new Array(24).fill(0),
    models: new Map(),
    tools: new Map(),
  }
}

function sumTokensTo(map, tokens) {
  addTokens(map, tokens)
}

/**
 * 把若干会话的天行聚合成一个窗口的载荷。纯函数、代价与「活跃天数」成正比，
 * 与日志长度无关 —— 这就是切窗口很快的原因。
 *
 * @param entries `[{ sessionId, title, live, fold }]`（fold 来自 foldSessionDaily）
 * @param options `{ days, topN, now, timeZone, errors, generatedAt, computeMs }`
 */
export function aggregate(entries, options = {}) {
  const timeZone = safeTimeZone(options.timeZone)
  const days = Number.isFinite(options.days) ? Math.max(1, Math.min(365, Math.trunc(options.days))) : 14
  const topN = Number.isFinite(options.topN) ? Math.max(1, Math.min(50, Math.trunc(options.topN))) : 8
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const errors = Array.isArray(options.errors) ? options.errors : []

  const windowKeys = recentDays(now, days, timeZone)
  const windowSet = new Set(windowKeys)
  const yearKeys = days === 365 ? windowKeys : recentDays(now, 365, timeZone)
  const yearSet = days === 365 ? windowSet : new Set(yearKeys)

  const windowDays = new Map(windowKeys.map((key) => [key, emptyWindowDay()]))
  const yearDays = new Map(yearKeys.map((key) => [key, { calls: 0, tokens: emptyTokens() }]))

  const totals = {
    sessions: 0,
    liveSessions: 0,
    calls: 0,
    toolCalls: 0,
    tokens: emptyTokens(),
  }
  const modelTotals = new Map()
  const toolTotals = new Map()
  const hourTotals = Array.from({ length: 24 }, () => ({ calls: 0, tokens: emptyTokens() }))
  const sessions = []

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const fold = entry.fold
    if (fold === null || typeof fold !== 'object' || fold.days === null || typeof fold.days !== 'object') continue

    const session = {
      id: typeof entry.sessionId === 'string' ? entry.sessionId : '',
      title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : (fold.title ?? ''),
      live: entry.live === true,
      calls: 0,
      toolCalls: 0,
      tokens: emptyTokens(),
      activeDays: 0,
      firstDay: undefined,
      lastDay: undefined,
    }

    for (const key of Object.keys(fold.days)) {
      const row = fold.days[key]
      const inYear = yearSet.has(key)
      const inWindow = windowSet.has(key)
      if (!inYear && !inWindow) continue

      if (inYear) {
        const yearRow = yearDays.get(key)
        yearRow.calls += row.calls
        sumTokensTo(yearRow.tokens, row.tokens)
      }
      if (!inWindow) continue

      const windowRow = windowDays.get(key)
      windowRow.calls += row.calls
      windowRow.toolCalls += row.toolCalls
      sumTokensTo(windowRow.tokens, row.tokens)
      for (let hour = 0; hour < 24; hour += 1) windowRow.hours[hour] += row.hours[hour] ?? 0
      for (const model of Object.keys(row.models)) {
        const bucket = row.models[model]
        let target = windowRow.models.get(model)
        if (target === undefined) {
          target = { calls: 0, tokens: emptyTokens() }
          windowRow.models.set(model, target)
        }
        target.calls += bucket.calls
        sumTokensTo(target.tokens, bucket.tokens)
      }
      for (const name of Object.keys(row.tools)) {
        windowRow.tools.set(name, (windowRow.tools.get(name) ?? 0) + row.tools[name])
      }

      session.calls += row.calls
      session.toolCalls += row.toolCalls
      sumTokensTo(session.tokens, row.tokens)
      session.activeDays += 1
      // 窗口内的首末活动日（ISO 日期串按字典序就是时间序）。
      if (session.firstDay === undefined || key < session.firstDay) session.firstDay = key
      if (session.lastDay === undefined || key > session.lastDay) session.lastDay = key
    }

    // 窗口内没有任何活动的会话不计入：否则切到 7 天窗口后，「会话数」会把一堆
    // 早期活跃、现在毫无动静的会话也算进来，这个指标就失去意义了。
    if (session.activeDays === 0) continue

    totals.sessions += 1
    if (session.live) totals.liveSessions += 1
    totals.calls += session.calls
    totals.toolCalls += session.toolCalls
    sumTokensTo(totals.tokens, session.tokens)
    // 模型 / 工具排行：再扫一遍窗口内的天行（活跃天数很少，代价可忽略）。
    for (const key of Object.keys(fold.days)) {
      if (!windowSet.has(key)) continue
      const row = fold.days[key]
      for (const model of Object.keys(row.models)) {
        const bucket = row.models[model]
        let target = modelTotals.get(model)
        if (target === undefined) {
          target = { model, calls: 0, tokens: emptyTokens() }
          modelTotals.set(model, target)
        }
        target.calls += bucket.calls
        sumTokensTo(target.tokens, bucket.tokens)
      }
      for (const name of Object.keys(row.tools)) {
        toolTotals.set(name, (toolTotals.get(name) ?? 0) + row.tools[name])
      }
    }

    sessions.push(session)
  }

  // 小时分布（窗口内）
  for (const row of windowDays.values()) {
    for (let hour = 0; hour < 24; hour += 1) {
      const count = row.hours[hour]
      if (count === 0) continue
      hourTotals[hour].calls += count
      // 把当天的 token 按「当天该小时占比」摊到小时上：日志里没有逐条小时级 token
      // （usage 只按消息给），这样摊是唯一不重不漏的口径。
      if (row.calls > 0) {
        const share = count / row.calls
        hourTotals[hour].tokens.total += row.tokens.total * share
        hourTotals[hour].tokens.hit += row.tokens.hit * share
        hourTotals[hour].tokens.miss += row.tokens.miss * share
        hourTotals[hour].tokens.output += row.tokens.output * share
      }
    }
  }

  const inputSide = totals.tokens.hit + totals.tokens.miss
  totals.cacheHitRate = inputSide > 0 ? totals.tokens.hit / inputSide : 0
  totals.models = modelTotals.size
  totals.tools = toolTotals.size
  totals.activeDays = [...windowDays.values()].filter((row) => row.calls > 0 || row.toolCalls > 0).length
  totals.avgTokensPerCall = totals.calls > 0 ? Math.round(totals.tokens.total / totals.calls) : 0
  totals.avgCallsPerActiveDay = totals.activeDays > 0 ? Math.round(totals.calls / totals.activeDays) : 0

  const dayRows = windowKeys.map((key) => {
    const row = windowDays.get(key)
    const side = row.tokens.hit + row.tokens.miss
    return {
      day: key,
      dow: weekdayOf(key),
      calls: row.calls,
      toolCalls: row.toolCalls,
      tokens: row.tokens,
      cacheHitRate: side > 0 ? row.tokens.hit / side : 0,
      models: row.models.size,
    }
  })

  const peak = dayRows.reduce((best, row) => (row.tokens.total > (best?.tokens.total ?? 0) ? row : best), null)
  totals.peakDay = peak !== null && peak.tokens.total > 0 ? { day: peak.day, tokens: peak.tokens.total } : null

  const year = yearKeys.map((key) => {
    const row = yearDays.get(key)
    return { day: key, dow: weekdayOf(key), calls: row.calls, tokens: row.tokens }
  })

  const cmpTokens = (a, b) => b.tokens.total - a.tokens.total
  const models = [...modelTotals.values()]
    .sort((a, b) => cmpTokens(a, b) || (b.calls - a.calls))
    .slice(0, topN)
    .map((row) => ({
      model: row.model,
      calls: row.calls,
      tokens: row.tokens.total,
      hit: row.tokens.hit,
      miss: row.tokens.miss,
      output: row.tokens.output,
      share: totals.tokens.total > 0 ? row.tokens.total / totals.tokens.total : 0,
    }))

  const tools = [...toolTotals.entries()]
    .map(([name, calls]) => ({ name, calls, share: totals.toolCalls > 0 ? calls / totals.toolCalls : 0 }))
    .sort((a, b) => (b.calls - a.calls) || a.name.localeCompare(b.name))
    .slice(0, topN)

  const hours = hourTotals.map((row, hour) => ({
    hour,
    calls: row.calls,
    tokens: Math.round(row.tokens.total),
  }))

  const sessionRows = sessions
    .sort((a, b) => cmpTokens(a, b) || String(b.lastDay ?? '').localeCompare(String(a.lastDay ?? '')))
    .slice(0, topN)

  return {
    ok: true,
    generatedAt: Number.isFinite(options.generatedAt) ? options.generatedAt : Date.now(),
    computeMs: Number.isFinite(options.computeMs) ? options.computeMs : 0,
    timeZone,
    windowDays: days,
    totals,
    days: dayRows,
    year,
    hours,
    models,
    tools,
    sessions: sessionRows,
    sessionCount: totals.sessions,
    errors,
  }
}
