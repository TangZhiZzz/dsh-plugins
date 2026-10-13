/**
 * dsh-plugin-usage-stats — Host 半。
 *
 * 目标：把「Token 用量、用量热力图、模型分布、工具使用、小时分布、会话花费」交给页面。
 *
 * **快在哪（v0.2 的核心）**：每个会话只折叠一次，而且折成**与窗口无关的「天行」**
 * （`foldSessionDaily`）；任何时间范围都只是在那些天行上聚合（`aggregate`），不碰日志。
 * 于是切换 7/30/90/365 天几乎不花时间，年度热力图与逐日明细也不用再读一遍日志。
 * v0.1 把折叠结果按「窗口 + 会话」缓存，换一次窗口就把所有会话重折一遍（实测 7s），已废弃。
 *
 * 事实来源：**已提交的会话日志**，本插件不自己存任何状态：
 *   - `ctx.sessionQuery.listSessions()` 列出全部逻辑会话（活跃 + 已归档，newest-first）；
 *   - `ctx.sessionQuery.readSession(id)` 读回完整事件日志；
 *   - `assistant/message.usage`（provider 真实上报）与 `tool/call` 是唯一依据。
 *   折叠与汇总规则在 ./metrics.js（纯函数，有单测）。
 *
 * **不含计价**：金额由 dsh-plugin-session-cost 自己算（它持有价目表）。两个插件各写一份
 * 定价必然漂移，所以 Client 半直接去读它的路由，读不到就不显示金额卡片。
 *
 * 暴露给 UI 的唯一入口：`GET /dsh-plugin-usage-stats/metrics`（同源、仅 loopback / 受信 Host 可读）。
 *
 * 关于依赖：`plugin_manager` 对「目录 target」用 pnpm 的 `link:` 协议，插件运行时的真实
 * 路径仍在工作区，Node 会从**真实路径**向上找 node_modules —— 因此 profile 里的
 * `@deepseek-ai/*` 解析不到。本文件不写任何静态裸导入：Config 的 schema 走 best-effort
 * 动态导入，解析不到时插件照常工作，配置改走 cordis.patch.yml 的原始 config。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregate, foldSessionDaily, safeTimeZone } from './metrics.js'

/** schemastery 的 best-effort 加载结果；undefined 表示当前组合里解析不到（不影响功能）。 */
const SchemaModule = await (async () => {
  try {
    return (await import('@deepseek-ai/schemastery')).default
  } catch {
    return undefined
  }
})()

/** Plugin identity（必须与 package.json 的 name 一致）。 */
export const name = 'dsh-plugin-usage-stats'

/** 硬依赖：读会话日志 + 注册取数路由。缺任一则本插件保持 pending 而不是抛错。 */
export const inject = ['sessionQuery', 'webServer']

/** 供 Client 半与验证脚本复用的路由路径。 */
export const ROUTE_PATH = '/dsh-plugin-usage-stats/metrics'

/** dsh-plugin-session-cost 的取数路由；金额从那来，避免重复定价。 */
export const COST_ROUTE_PATH = '/dsh-session-cost/summary'

/** 可调参数一律放 Config：用户能在 cordis.patch.yml 里整体覆盖。 */
export const Config = SchemaModule === undefined ? undefined : SchemaModule.object({
  days: SchemaModule.natural().default(14)
    .description('默认时间范围天数（含今天）；页面用 ?days= 覆盖，收敛到 1–365。'),
  maxSessions: SchemaModule.natural().default(100)
    .description('最多统计多少个会话（newest-first）。'),
  topN: SchemaModule.natural().default(8)
    .description('模型 / 工具 / 会话排行各列前几名。'),
  timeZone: SchemaModule.string().default('Asia/Shanghai')
    .description('把事件落到「天」「小时」时使用的时区。'),
  includeSubagents: SchemaModule.boolean().default(false)
    .description('是否把子会话（origin=subagent）也算进来。'),
  refreshSeconds: SchemaModule.natural().default(10)
    .description('载荷缓存与页面轮询频率（秒）。'),
  foldCacheSeconds: SchemaModule.natural().default(21600)
    .description('归档会话「天行」的缓存秒数（默认 6 小时）。归档日志不会再变，可长期复用；这一项直接决定「冷启动要不要重读全部日志」。'),
  liveFoldSeconds: SchemaModule.natural().default(5)
    .description('活跃会话天行的缓存秒数。实测重折只要 13–20ms，所以可以放宽，不必每个轮询都重折。'),
  readConcurrency: SchemaModule.natural().default(8)
    .description('读会话日志的并发上限。冷启动时「读 31 个会话」是主要瓶颈。'),
  warmUpOnStart: SchemaModule.boolean().default(true)
    .description('插件激活后在后台预热「天行」缓存，这样打开面板时就不必等冷启动那几秒。'),
  warmUpDelaySeconds: SchemaModule.natural().default(3)
    .description('预热延后多少秒开始（避开应用自身的启动高峰）。'),
  persistFolds: SchemaModule.boolean().default(true)
    .description('把「非活跃会话」的天行缓存到磁盘，进程重启后第一次打开面板也是秒开。缓存写在系统临时目录，不碰工作区。'),
  revalidateSeconds: SchemaModule.natural().default(30)
    .description('后台轮转校验磁盘缓存的间隔（秒）：每次重折一个条目，把数字逐步收敛到最新。0 = 关闭校验。'),
})

// ── 配置规范化 ──────────────────────────────────────────────────────────────

/** 把 Config 规范化成内部结构；缺失字段回落默认值，非法值收敛到合法区间。 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  const int = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }
  return {
    days: int(raw.days, 14, 1, 365),
    maxSessions: int(raw.maxSessions, 100, 1, 1000),
    topN: int(raw.topN, 8, 1, 50),
    timeZone: safeTimeZone(typeof raw.timeZone === 'string' ? raw.timeZone : 'Asia/Shanghai'),
    includeSubagents: raw.includeSubagents === true,
    refreshMs: int(raw.refreshSeconds, 10, 1, 600) * 1000,
    foldCacheMs: int(raw.foldCacheSeconds, 21600, 0, 604800) * 1000,
    liveFoldMs: int(raw.liveFoldSeconds, 5, 0, 3600) * 1000,
    readConcurrency: int(raw.readConcurrency, 8, 1, 16),
    warmUpOnStart: raw.warmUpOnStart !== false,
    warmUpDelayMs: int(raw.warmUpDelaySeconds, 3, 0, 300) * 1000,
    persistFolds: raw.persistFolds !== false,
    revalidateMs: int(raw.revalidateSeconds, 30, 0, 86400) * 1000,
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 有并发上限的 map，避免一次性对所有会话发起磁盘读取。 */
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
 * 取数服务。
 *
 * 两级缓存，分工不同：
 *   - **会话天行**（`folds`）：与窗口无关，归档会话长期复用（foldCacheMs）、活跃会话短 TTL（liveFoldMs）；
 *   - **载荷**（`payloadCache`）：按窗口分，同一窗口的重复轮询直接命中（refreshMs）+ 单飞。
 */
// ── 磁盘缓存（只存「非活跃会话」的天行） ────────────────────────────────────
//
// 为什么可以缓存：`SessionRecord` 带 `live` 标记，而**非 live 的会话只在磁盘上、
// 没有进程在追加写** —— 它的日志不再变化，所以天行可以跨进程复用。真正在变的那个
// （活跃会话）照旧每次重折，实测只要 13–20ms。
//
// 边界情况：会话可能「被恢复」后继续写入。恢复时会变成 live，那份缓存自然失效重折；
// 万一进程在「已恢复但还没落盘」之间被杀，磁盘上会留一份旧天行 —— 所以再加一层
// **后台轮转校验**（每次校验一个条目），把数字逐步收敛到最新。
//
// 落点：系统临时目录里的一个纯缓存文件。不写工作区、不污染仓库，系统也会自己清。

const FOLD_CACHE_VERSION = 1

/** 缓存文件路径；取不到就返回 undefined（此时持久化自动关闭，行为与没有它一致）。 */
export function foldCachePath() {
  try {
    const profile = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : ''
    const tag = profile === '' ? '' : `-${profile.replace(/[^A-Za-z0-9_-]/g, '')}`
    return join(tmpdir(), `dsh-plugin-usage-stats${tag}-folds.json`)
  } catch {
    return undefined
  }
}

/** 真正落盘的实现。任何一步失败都退回「没有缓存」的行为，不影响功能。 */
export function filePersistence() {
  return {
    async load() {
      const file = foldCachePath()
      if (file === undefined) return {}
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        if (parsed === null || typeof parsed !== 'object') return {}
        if (parsed.version !== FOLD_CACHE_VERSION) return {}
        const sessions = parsed.sessions
        if (sessions === null || typeof sessions !== 'object') return {}
        const out = {}
        for (const id of Object.keys(sessions)) {
          const entry = sessions[id]
          if (entry === null || typeof entry !== 'object') continue
          const fold = entry.fold
          if (fold === null || typeof fold !== 'object') continue
          if (fold.days === null || typeof fold.days !== 'object') continue
          out[id] = { title: typeof entry.title === 'string' ? entry.title : id, fold }
        }
        return out
      } catch {
        // 文件不存在 / 损坏 / 无权限：静默当作没有缓存。
        return {}
      }
    },
    async save(sessions) {
      const file = foldCachePath()
      if (file === undefined) return
      try {
        await writeFile(file, JSON.stringify({ version: FOLD_CACHE_VERSION, savedAt: Date.now(), sessions }), 'utf8')
      } catch {
        // 写失败只是下次冷启动慢一点，不影响任何功能。
      }
    },
  }
}

/** 关闭持久化时用的空实现（测试也用它注入假的读写）。 */
export function noPersistence() {
  return {
    async load() { return {} },
    async save() {},
  }
}

/**
 * 磁盘缓存是**不受信任的输入**：文件可能是旧版本写的、被改坏的、或写了一半的。
 * 而 `aggregate` 信任天行的形状（例如每个模型的桶必须是 `{ calls, tokens }`），
 * 所以装载前必须验到「aggregate 不会在它身上炸掉」——验不过就丢弃这条，退回读日志。
 *
 * 代价与「活跃天数」成正比（每个会话十来天），可以忽略。
 */
export function isUsableFold(fold) {
  if (fold === null || typeof fold !== 'object') return false
  if (fold.days === null || typeof fold.days !== 'object') return false
  for (const key of Object.keys(fold.days)) {
    const row = fold.days[key]
    if (row === null || typeof row !== 'object') return false
    if (typeof row.calls !== 'number' || typeof row.toolCalls !== 'number') return false
    if (row.tokens === null || typeof row.tokens !== 'object') return false
    if (!Array.isArray(row.hours)) return false
    const models = row.models
    if (models === null || typeof models !== 'object') return false
    for (const model of Object.keys(models)) {
      const bucket = models[model]
      if (bucket === null || typeof bucket !== 'object') return false
      if (typeof bucket.calls !== 'number') return false
      if (bucket.tokens === null || typeof bucket.tokens !== 'object') return false
    }
    if (row.tools === null || typeof row.tools !== 'object') return false
  }
  return true
}

export function createDashboardService(ctx, cfg, persistence = null) {
  const io = persistence ?? (cfg.persistFolds ? filePersistence() : noPersistence())

  /**
   * 会话天行缓存：**与时间窗口无关**，所以任何窗口都能复用。
   * 这是「切窗口很快」的关键 —— v0.1 把它按「窗口 + 会话」分了键，等于每换一次窗口全部重折。
   */
  const folds = new Map()
  /**
   * 同一会话「正在折叠中」的 promise：并发请求（后台预热与面板请求常常同时发生）
   * 共享同一次读 + 折叠，不重复做功。
   */
  const folding = new Map()
  /** 载荷缓存：按窗口分（同一窗口的重复轮询直接命中）。 */
  const payloadCache = new Map()
  const inflight = new Map()
  /** 还在用磁盘缓存、等着后台校验的会话 id（FIFO，校验完就出队）。 */
  const pendingVerify = []
  let restorePromise
  let saveTimer
  let dirty = false
  let revalidateAt = 0

  /**
   * 把外部传进来的天数收敛到 1–365；参数缺席或非法时回落默认窗口。
   *
   * 注意 `Number(null) === 0`、`Number('') === 0`：HTTP 查询串里取不到参数时
   * `searchParams.get()` 返回的是 `null`，若直接 `Number()` 就会被当成 0，
   * 再被 `Math.max(1, …)` 抬成「1 天」。参数缺席必须走默认值，不能当 0。
   */
  const clampDays = (value) => {
    if (value === null || value === undefined || value === '') return cfg.days
    const n = Number(value)
    if (!Number.isFinite(n)) return cfg.days
    return Math.min(365, Math.max(1, Math.trunc(n)))
  }

  /**
   * 装载磁盘缓存（只做一次，可重复调用）。
   * 装进来的条目标记 `fromDisk`、`at: 0` —— 内存 TTL 永远不命中，能不能用只由
   * 「fromDisk + 会话非 live」决定。
   */
  function restore() {
    if (restorePromise === undefined) {
      restorePromise = (async () => {
        if (cfg.persistFolds !== true) return 0
        const stored = await io.load()
        let loaded = 0
        for (const id of Object.keys(stored ?? {})) {
          if (folds.has(id)) continue
          const entry = stored[id]
          if (entry === null || typeof entry !== 'object') continue
          // 验到 aggregate 不会炸：坏数据（旧版本 / 写坏的文件）一律丢弃，退回读日志。
          if (!isUsableFold(entry.fold)) continue
          folds.set(id, { at: 0, title: entry.title, fold: entry.fold, live: false, fromDisk: true })
          pendingVerify.push(id)
          loaded += 1
        }
        // 校验从「装载之后」才开始计时。否则第一轮取数就会立刻触发后台重折，
        // 刚装上的条目马上被删掉重读 —— 磁盘缓存等于白装。
        if (loaded > 0) revalidateAt = Date.now()
        return loaded
      })().catch(() => 0)
    }
    return restorePromise
  }

  /** 待落盘的条目：只含非活跃会话（活跃会话的日志还在长，不写盘）。 */
  function snapshotForDisk() {
    const sessions = {}
    let count = 0
    for (const [id, entry] of folds) {
      if (entry.live === true) continue
      if (count >= 2000) break
      sessions[id] = { title: entry.title, fold: entry.fold }
      count += 1
    }
    return sessions
  }

  /** 标脏并做防抖落盘：折叠是高频的，不能每折一个就写一次盘。 */
  function markDirty() {
    // 关掉持久化就一个字节都不写（不只是换个空实现）——单一入口，避免以后接了别的 io 漏判。
    if (cfg.persistFolds !== true) return
    dirty = true
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      if (!dirty) return
      dirty = false
      Promise.resolve(io.save(snapshotForDisk())).catch(() => {})
    }, 2000)
  }

  /** 卸载时清定时器并把待保存的缓存落盘。 */
  function dispose() {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    if (!dirty) return
    dirty = false
    Promise.resolve(io.save(snapshotForDisk())).catch(() => {})
  }

  /** 取一个会话的天行；缓存有效就不读日志。 */
  function foldOf(record) {
    const id = String(record?.header?.id ?? '')
    if (id === '') return Promise.resolve(null)
    const live = record.live === true
    const ttl = live ? cfg.liveFoldMs : cfg.foldCacheMs
    const cached = folds.get(id)

    // 1) 磁盘缓存 + 会话非 live → 日志不再被追加写，可直接复用（不受内存 TTL 限制）。
    if (cached !== undefined && !live && cached.fromDisk === true) {
      return Promise.resolve({ sessionId: id, title: cached.title, live, fold: cached.fold, reused: true })
    }
    // 2) 内存缓存未过期 → 复用。
    if (cached !== undefined && ttl > 0 && Date.now() - cached.at < ttl) {
      return Promise.resolve({ sessionId: id, title: cached.title, live, fold: cached.fold, reused: true })
    }

    // 并发折叠去重：预热与面板请求撞在一起时，同一个会话只读一次、只折一次。
    let pending = folding.get(id)
    if (pending !== undefined) return pending
    pending = (async () => {
      try {
        const snapshot = await ctx.sessionQuery.readSession(id)
        const fold = foldSessionDaily(snapshot, { timeZone: cfg.timeZone })
        const title = fold.title ?? id
        folds.set(id, { at: Date.now(), title, fold, live })
        if (!live) markDirty()
        return { sessionId: id, title, live, fold, reused: false }
      } catch (error) {
        return { error: { sessionId: id, message: error instanceof Error ? error.message : String(error) } }
      } finally {
        folding.delete(id)
      }
    })()
    folding.set(id, pending)
    return pending
  }

  /**
   * 后台轮转校验磁盘缓存：每次挑一个还在用磁盘缓存的会话重折一遍。
   * 非 live 的日志理论上不变，但「会话被恢复过」这类边界情况无法用 listSessions 廉价
   * 识别出来，所以用轮转校验把数字逐步收敛到最新 —— 代价是每隔 revalidateMs 折一个会话。
   */
  function scheduleRevalidation() {
    if (cfg.revalidateMs <= 0 || pendingVerify.length === 0) return
    const now = Date.now()
    if (now - revalidateAt < cfg.revalidateMs) return
    revalidateAt = now
    const id = pendingVerify.shift()
    if (typeof id !== 'string' || !folds.has(id)) return
    // 摘掉 fromDisk 标记 → 紧接着的重折会写回一个「已校验」的条目。
    folds.delete(id)
    foldOf({ header: { id }, live: false }).catch(() => {})
  }

  /** 列会话 + 取天行。共用于「建载荷」与「后台预热」。 */
  async function loadEntries() {
    await restore()
    const records = await ctx.sessionQuery.listSessions()
    const wanted = records
      .filter((record) => cfg.includeSubagents || record?.header?.origin !== 'subagent')
      .slice(0, cfg.maxSessions)

    const results = await mapLimited(wanted, cfg.readConcurrency, foldOf)

    const entries = []
    const errors = []
    let folded = 0
    let reused = 0
    for (const result of results) {
      if (result === null || result === undefined) continue
      if (result.error !== undefined) {
        errors.push(result.error)
        continue
      }
      entries.push(result)
      if (result.reused === true) reused += 1
      else folded += 1
    }

    // 清掉已经不在语料里的会话缓存，避免长期驻留。
    const liveIds = new Set(wanted.map((record) => String(record?.header?.id ?? '')))
    for (const key of [...folds.keys()]) if (!liveIds.has(key)) folds.delete(key)

    scheduleRevalidation()
    return { entries, errors, folded, reused }
  }

  async function collect(days) {
    const { entries, errors, folded, reused } = await loadEntries()
    const startedAt = Date.now()
    const payload = aggregate(entries, {
      days,
      topN: cfg.topN,
      timeZone: cfg.timeZone,
      errors,
      generatedAt: startedAt,
    })
    // 聚合有多快：只与「活跃天数」有关，与日志长度无关 —— 这是切窗口快的直接原因。
    payload.computeMs = Date.now() - startedAt
    payload.perf = { sessions: entries.length, folded, reused, unverified: pendingVerify.length }
    return payload
  }

  /**
   * 后台预热：先把磁盘缓存装回来，再把缺的天行补上，不建载荷。
   * 目的是让「打开面板」不必等冷启动 —— 实测冷启动 7.2s，热了 15–25ms。
   */
  async function warm() {
    const restored = await restore()
    const { entries, folded, reused } = await loadEntries()
    return { restored, sessions: entries.length, folded, reused }
  }

  /**
   * 统一出口。载荷按窗口缓存 + 单飞；缓存结果是共享给所有调用者的，
   * 所以不为单个调用者做取消。
   */
  async function metrics(options = {}) {
    const days = clampDays(options.days)
    const now = Date.now()
    const cached = payloadCache.get(days)
    if (cached !== undefined && now - cached.generatedAt < cfg.refreshMs) return cached
    const running = inflight.get(days)
    if (running !== undefined) return running

    const started = collect(days)
      .then((payload) => {
        payloadCache.set(days, payload)
        // 正常只会用到几个选项，但还是给个上界，免得有人狂刷 ?days=。
        if (payloadCache.size > 12) payloadCache.delete(payloadCache.keys().next().value)
        return payload
      })
      .finally(() => { inflight.delete(days) })
    inflight.set(days, started)
    return started
  }

  return { metrics, warm, restore, dispose, refreshMs: cfg.refreshMs }
}
// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const service = createDashboardService(ctx, cfg)

  // 后台预热天行缓存。面板是「打开时才发请求」的，不预热的话打开面板就等于撞冷启动
  // （实测冷启动 7.2s、热了 15–25ms）。
  //
  // **顺序很重要**：先 restore() 把磁盘缓存装回去，再 warm() 补缺 —— 反过来的话预热会把
  // 所有会话都重折一遍，磁盘缓存就白做了。预热失败只记一条 warning，不影响任何功能。
  if (cfg.warmUpOnStart) {
    ctx.effect(() => {
      let cancelled = false
      const timer = setTimeout(() => {
        service.restore()
          .then((restored) => {
            if (cancelled) return undefined
            if (restored > 0) ctx.logger?.info?.(`dsh-plugin-usage-stats: 磁盘缓存已装载 ${restored} 个会话`)
            return service.warm()
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger?.warn?.(`dsh-plugin-usage-stats: 预热天行缓存失败（不影响面板）: ${message}`)
          })
      }, cfg.warmUpDelayMs)
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }, 'dsh-plugin-usage-stats: warm up fold cache')
  }

  // 卸载时把待保存的缓存落盘、清掉定时器。
  ctx.effect(() => () => service.dispose(), 'dsh-plugin-usage-stats: persist fold cache')

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
        // 时间范围由页面传入（`?days=`），Host 负责收敛到合法区间。
        const url = new URL(request.url ?? ROUTE_PATH, 'http://dsh.internal')
        const payload = await service.metrics({ days: url.searchParams.get('days') })
        const body = Buffer.from(JSON.stringify({ ...payload, refreshMs: service.refreshMs }), 'utf8')
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
        response.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.byteLength),
        })
        response.end(body)
      }
    },
  }), 'dsh-plugin-usage-stats: /dsh-plugin-usage-stats/metrics route')
}
