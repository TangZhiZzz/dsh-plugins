/**
 * dsh-plugin-usage-stats — Client 半。
 *
 * 两处 UI，靠**同一个 id** 配对（宿主用 sidebar 列表项的 id 去找 main 面板的 key）：
 *   1. `sidebar.panellist`：左侧面板栏的一个图标（按钮由宿主渲染，我们只提供图标）；
 *   2. `main`：中央用量统计面板本体。
 *
 * 面板结构（自上而下）：
 *   头部：标题 + 状态行（窗口 / 更新时间 / 聚合耗时 / 缓存复用）+ 时间范围 + 刷新
 *   指标卡 ×9（带语义色标记）
 *   年度热力图（固定最近一年，列宽自适应 = 占满宽度，格子随面板变宽变大方块）
 *   Token 构成 | 时段分布（24 小时按时间段上色）
 *   模型分布 | 工具使用 Top
 *   会话排行 | 会话花费
 *   逐日明细（只列有活动的天）
 *
 * 数据来自本插件的 Host 路由 `/dsh-plugin-usage-stats/metrics`：**一次请求**就带回
 * 窗口聚合 + 365 天年度序列 + 24 小时分布，所以整页只发一个数据请求（金额另算，见下）。
 *
 * 金额由 dsh-plugin-session-cost 提供，本插件只展示：钱只有一个来源，
 * 两边各写一份定价必然漂移。读不到（没装它）就不显示金额卡片。
 *
 * 约定（与 dsh-plugin-session-cost 一致）：
 *   - `window.__ModuleLoader__.load` 的 id 必须等于包名；
 *   - React 走浏览器模块表（`require('react')`），图形用 div 手绘，不引第三方图表库；
 *   - factory 只做懒加载、无副作用；注册与样式全放 `apply` 并挂 `ctx` 上；
 *   - 颜色只用主题 token（`--dsw-alias-*`），可见文案走 Client locale 服务。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-usage-stats',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const NS = 'dsh-plugin-usage-stats'
    const ENDPOINT = '/dsh-plugin-usage-stats/metrics'
    const COST_ENDPOINT = '/dsh-session-cost/summary'
    const PANEL_ID = 'usage-stats'
    /** 时间范围选项（天）。365 = 一年。 */
    const RANGES = [7, 14, 30, 90, 365]
    const DEFAULT_RANGE = 30
    const REFRESH_MS = 10000
    /** 热力图格子间距（px）。格子宽度由网格 1fr 自适应，所以不需要固定边长。 */
    const GAP = 3

    /** 语义色板：图形一律从这里取色，避免出现一片中性灰。 */
    const COLORS = {
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }
    /**
     * 热力图配色：**GitHub 贡献图那种绿色渐变**（5 档）。
     * 绿色取自主题的 success token，所以亮/暗主题自动跟随；深浅用透明度分档。
     * 0 档（当天没有用量）是最淡的一档 —— 不用中性灰，因为一年里大部分格子是空的，
     * 灰色会让整块面板发沉。
     */
    const HEAT_COLOR = COLORS.success
    const HEAT_OPACITY = [0.12, 0.32, 0.55, 0.78, 1]
    /** 星期刻度列的宽度（px）：中文「周一」两字要放得下，且要留白，别贴住第一列格子。 */
    const GUTTER = 44

    // ── 文案 ────────────────────────────────────────────────────────────────

    const ZH = {
      panelLabel: '用量',
      panelTitle: '用量统计',
      rangeTitle: '时间范围',
      rangeStale: 'Host 未重载：服务端仍是',
      mCalls: '模型调用',
      mTokens: '总 Token',
      mCacheHit: '缓存命中率',
      mTools: '工具调用',
      mSessions: '会话',
      mActiveDays: '活跃天',
      mAvgPerCall: '平均每次调用',
      mAvgPerDay: '日均调用',
      peakDay: '峰值日',
      tokenMixTitle: 'Token 构成',
      legendHit: '缓存命中',
      legendMiss: '未命中',
      legendOutput: '输出',
      heatYear: '年度热力图',
      heatLess: '少',
      heatMore: '多',
      dowMon: '周一',
      dowWed: '周三',
      dowFri: '周五',
      hoursTitle: '时段分布',
      hoursSubtitle: '窗口内按小时',
      bandNight: '深夜',
      bandMorning: '上午',
      bandAfternoon: '下午',
      bandEvening: '晚上',
      modelsTitle: '模型分布',
      toolsTitle: '工具使用 Top',
      sessionsTitle: '会话排行',
      costTitle: '会话花费',
      costUnavailable: '未检测到 dsh-plugin-session-cost，金额不显示',
      costAllTime: '全部会话，不随时间范围变化',
      detailTitle: '逐日明细',
      detailSubtitle: '只列有活动的天',
      colDay: '日期',
      colDow: '星期',
      colCalls: '调用',
      colTools: '工具',
      colTokens: 'Token',
      colHitRate: '命中率',
      updatedAt: '更新于',
      perfAggregate: '聚合',
      perfReused: '复用',
      perfDisk: '磁盘',
      refresh: '刷新',
      loading: '正在统计…',
      failed: '读取失败',
      noData: '窗口内没有数据',
      live: '活跃',
      daysUnit: '天',
      tipCalls: '次调用',
      activeDaysUnit: '天活动',
      partial: '个会话读取失败，已跳过',
    }

    const EN = {
      panelLabel: 'Usage',
      panelTitle: 'Usage stats',
      rangeTitle: 'Range',
      rangeStale: 'host not reloaded: server still on',
      mCalls: 'Model calls',
      mTokens: 'Total tokens',
      mCacheHit: 'Cache hit rate',
      mTools: 'Tool calls',
      mSessions: 'Sessions',
      mActiveDays: 'Active days',
      mAvgPerCall: 'Avg / call',
      mAvgPerDay: 'Calls / day',
      peakDay: 'Peak day',
      tokenMixTitle: 'Token mix',
      legendHit: 'cache hit',
      legendMiss: 'miss',
      legendOutput: 'output',
      heatYear: 'Year heatmap',
      heatLess: 'less',
      heatMore: 'more',
      dowMon: 'Mon',
      dowWed: 'Wed',
      dowFri: 'Fri',
      hoursTitle: 'Hour of day',
      hoursSubtitle: 'within the range',
      bandNight: 'night',
      bandMorning: 'morning',
      bandAfternoon: 'afternoon',
      bandEvening: 'evening',
      modelsTitle: 'Models',
      toolsTitle: 'Top tools',
      sessionsTitle: 'Top sessions',
      costTitle: 'Session cost',
      costUnavailable: 'dsh-plugin-session-cost not detected; cost hidden',
      costAllTime: 'all sessions, not affected by the range',
      detailTitle: 'Daily detail',
      detailSubtitle: 'days with activity only',
      colDay: 'Day',
      colDow: 'Weekday',
      colCalls: 'Calls',
      colTools: 'Tools',
      colTokens: 'Tokens',
      colHitRate: 'Hit rate',
      updatedAt: 'Updated',
      perfAggregate: 'aggregate',
      perfReused: 'reused',
      perfDisk: 'disk',
      refresh: 'Refresh',
      loading: 'Crunching…',
      failed: 'Failed to load',
      noData: 'No data in this range',
      live: 'live',
      daysUnit: 'd',
      tipCalls: 'calls',
      activeDaysUnit: 'active days',
      partial: 'sessions unreadable, skipped',
    }

    // ── 样式 ────────────────────────────────────────────────────────────────

    const CSS = `
.dsh-us__scroll{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dsh-us__scroll::-webkit-scrollbar{width:8px;height:8px}
.dsh-us__scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.dsh-us__scroll::-webkit-scrollbar-track{background:transparent}
.dsh-us__cell{transition:opacity .12s ease}
.dsh-us__bar{transition:width .25s ease}
.dsh-us__tip{animation:dsh-us-fade .1s ease-out}
@keyframes dsh-us-fade{from{opacity:0}to{opacity:1}}
.dsh-us__btn{cursor:pointer;transition:background .12s ease}
.dsh-us__btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-us__btn:active{opacity:.7}
.dsh-us__row{transition:background .12s ease}
.dsh-us__row:hover{background:var(--dsw-alias-bg-layer-2)}
`

    const SEG = {
      hit: COLORS.success,
      miss: COLORS.brand,
      output: COLORS.warn,
    }
    const SEG_KEYS = [['hit', 'legendHit'], ['miss', 'legendMiss'], ['output', 'legendOutput']]

    const sectionStyle = {
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 10,
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      minWidth: 0,
    }
    const sectionTitleStyle = { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
    const mutedStyle = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }
    const numStyle = { fontVariantNumeric: 'tabular-nums' }

    /** 统一的区块外壳：彩色标记 + 标题 + 可选备注 + 可选右对齐附加内容。 */
    function Section(props) {
      return h('div', { style: sectionStyle },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', {
            'aria-hidden': true,
            style: {
              flex: 'none', width: 6, height: 6, borderRadius: 2,
              background: props.accent ?? COLORS.brand,
            },
          }),
          h('div', { style: sectionTitleStyle }, props.title),
          props.note !== undefined
            ? h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, props.note)
            : null,
          props.extra !== undefined ? h('div', { style: { marginLeft: 'auto' } }, props.extra) : null),
        props.children)
    }

    // ── 格式化 ──────────────────────────────────────────────────────────────

    function compact(value) {
      const n = Number.isFinite(value) ? value : 0
      if (Math.abs(n) < 1000) return String(Math.round(n))
      if (Math.abs(n) < 1e6) return `${Math.round(n / 100) / 10}K`
      if (Math.abs(n) < 1e9) return `${Math.round(n / 1e5) / 10}M`
      return `${Math.round(n / 1e8) / 10}B`
    }

    function percent(rate) {
      const value = Number.isFinite(rate) ? rate * 100 : 0
      return `${value.toFixed(1)}%`
    }

    function timeLabel(ms) {
      if (!Number.isFinite(ms)) return '—'
      const date = new Date(ms)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /** 只用日期串取星期几：Date.UTC + getUTCDay，不受本机时区影响。 */
    function weekdayOf(day) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day))
      if (match === null) return 0
      return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
    }

    /** 'YYYY-MM-DD' → Date（UTC 日历日），给 Intl 做星期/月份名用。 */
    function dateOf(day) {
      return new Date(Date.UTC(
        Number(String(day).slice(0, 4)),
        Number(String(day).slice(5, 7)) - 1,
        Number(String(day).slice(8, 10)),
      ))
    }

    // ── 取数 ────────────────────────────────────────────────────────────────

    async function fetchJson(url, signal) {
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
      if (response.ok !== true) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (payload?.ok !== true) throw new Error(String(payload?.error ?? 'bad payload'))
      return payload
    }

    /**
     * 一次请求拿回整个面板需要的数据（窗口聚合 + 年度序列 + 小时分布）。
     * 金额单独尽力而为地取，读不到不算错误。
     */
    function useMetrics(days) {
      // forDays 记录「产出当前 payload 的那个窗口」，用来判断服务端有没有跟上选择；
      // 不能拿它跟刚点下的 range 比，否则请求在飞的那一两秒会误报。
      const [state, setState] = useState({
        payload: null, cost: null, error: null, loading: true, forDays: null,
      })
      const url = days === null || days === undefined ? ENDPOINT : `${ENDPOINT}?days=${encodeURIComponent(days)}`

      const load = useCallback(async (signal) => {
        // 两条请求**并行**发，而且**不等金额**：看板数据一到就先渲染，
        // 金额（来自 session-cost，冷的时候要 ~750ms）到了再补上。
        // 之前是串行 await 两条 —— 等于每次首屏都白等最慢的那条。
        const metricsDone = fetchJson(url, signal)
          .then((payload) => {
            if (signal?.aborted === true) return
            setState((prev) => ({
              payload,
              cost: prev.cost,
              error: null,
              loading: false,
              forDays: days === undefined ? null : days,
            }))
          })
          .catch((error) => {
            if (signal?.aborted === true) return
            setState((prev) => ({
              ...prev,
              error: error instanceof Error ? error.message : String(error),
              loading: false,
            }))
          })

        const costDone = fetchJson(COST_ENDPOINT, signal)
          .then((cost) => {
            if (signal?.aborted === true) return
            setState((prev) => ({ ...prev, cost }))
          })
          .catch(() => {
            // 金额是尽力而为：读不到就保持原样（没装 session-cost 时也走这里）。
          })

        await Promise.allSettled([metricsDone, costDone])
      }, [url, days])

      useEffect(() => {
        const controller = new AbortController()
        load(controller.signal)
        const timer = setInterval(() => load(controller.signal), REFRESH_MS)
        return () => {
          clearInterval(timer)
          controller.abort()
        }
      }, [load])

      const reload = useCallback(() => { load(undefined) }, [load])
      return { ...state, reload }
    }

    // ── 通用小件 ────────────────────────────────────────────────────────────

    function Stat(props) {
      const accent = props.accent ?? COLORS.brand
      return h('div', {
        style: {
          background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 10,
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          minWidth: 0,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
        h('span', {
          'aria-hidden': true,
          style: { flex: 'none', width: 6, height: 6, borderRadius: '50%', background: accent },
        }),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, props.label)),
      h('div', {
        // 数值用语义色：整排卡片因此有颜色，而不是一片灰。
        style: { fontSize: 19, fontWeight: 600, lineHeight: 1.25, color: accent, ...numStyle },
      }, props.value),
      props.hint !== undefined
        ? h('div', {
          title: props.hintTitle,
          // 允许换行：宁可多占一行，也不要被静默裁掉
          // （踩过：总 Token 的三段拆分只显示到「输」）。
          style: { fontSize: 10, lineHeight: 1.35, color: 'var(--dsw-alias-label-secondary)' },
        }, props.hint)
        : null)
    }

    /** 一行「标签 + 横条 + 数值」，用于模型 / 工具 / 会话排行。 */
    function BarRow(props) {
      const ratio = Number.isFinite(props.ratio) ? Math.max(0, Math.min(1, props.ratio)) : 0
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11, minWidth: 0 } },
          props.dot === true
            ? h('span', {
              'aria-hidden': true,
              style: {
                flex: 'none', width: 5, height: 5, borderRadius: '50%',
                background: COLORS.success,
              },
            })
            : null,
          h('span', {
            title: props.label,
            style: {
              color: 'var(--dsw-alias-label-primary)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
            },
          }, props.label),
          props.hint !== undefined ? h('span', { style: { flex: 'none', ...mutedStyle } }, props.hint) : null,
          h('span', { style: { marginLeft: 'auto', flex: 'none', ...mutedStyle, ...numStyle } }, props.value)),
        h('div', {
          style: { height: 4, borderRadius: 2, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' },
        }, h('div', {
          className: 'dsh-us__bar',
          style: {
            width: `${Math.round(ratio * 100)}%`,
            height: '100%',
            borderRadius: 2,
            background: props.color ?? COLORS.brand,
          },
        })))
    }

    /** 悬停明细卡片（热力图 / 时段图共用）：放在被悬停的那一格内部，天然跟着它走。 */
    function TrendTip(props) {
      const row = props.row
      return h('div', {
        className: 'dsh-us__tip',
        style: {
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          left: props.left,
          transform: `translateX(${props.shift})`,
          pointerEvents: 'none',
          zIndex: 30,
          minWidth: 176,
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-overlay)',
          boxShadow: 'var(--dsw-elevation-prominent)',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontSize: 11,
          color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('div', { style: { fontWeight: 600 } }, props.title),
      h('div', { style: { ...mutedStyle, ...numStyle } },
        `${compact(row.tokens?.total ?? 0)} · ${row.calls ?? 0} ${props.t('tipCalls')}`),
      props.showSegments === true
        ? h('div', { style: { marginTop: 2 } }, ...SEG_KEYS.map(([key, dictKey]) =>
          h('div', {
            key,
            style: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-label-secondary)' },
          },
          h('span', { 'aria-hidden': true, style: { flex: 'none', width: 7, height: 7, borderRadius: 2, background: SEG[key] } }),
          h('span', null, props.t(dictKey)),
          h('span', {
            style: { marginLeft: 'auto', ...numStyle, color: 'var(--dsw-alias-label-primary)' },
          }, compact(row.tokens?.[key] ?? 0)))))
        : null)
    }

    // ── Token 构成 ──────────────────────────────────────────────────────────

    /** 命中 / 未命中 / 输出：比例条 + 三段数值 + 各自占比。 */
    function TokenMix(props) {
      const t = props.t
      const tokens = props.tokens ?? {}
      const total = tokens.total ?? 0
      if (!(total > 0)) return h('div', { style: mutedStyle }, t('noData'))

      const rows = SEG_KEYS.map(([key, dictKey]) => ({ key, label: t(dictKey), value: tokens[key] ?? 0 }))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', {
          style: {
            display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
        }, rows.map((row) => (row.value <= 0 ? null : h('div', {
          key: row.key,
          title: `${row.label} ${compact(row.value)}`,
          style: { width: `${(row.value / total) * 100}%`, background: SEG[row.key] },
        })))),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          ...rows.map((row) => h('div', {
            key: row.key,
            style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, minWidth: 0 },
          },
          h('span', {
            'aria-hidden': true,
            style: { flex: 'none', width: 7, height: 7, borderRadius: 2, background: SEG[row.key] },
          }),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, row.label),
          h('span', {
            style: { marginLeft: 'auto', ...numStyle, color: 'var(--dsw-alias-label-primary)' },
          }, compact(row.value)),
          h('span', {
            style: { flex: 'none', width: 52, textAlign: 'right', ...mutedStyle, ...numStyle },
          }, percent(row.value / total))))))
    }

    // ── 年度热力图 ──────────────────────────────────────────────────────────

    function YearHeatmap(props) {
      const t = props.t
      const localeId = props.localeId
      const days = Array.isArray(props.days) ? props.days : []
      const [hover, setHover] = useState(null)
      const max = days.reduce((acc, day) => Math.max(acc, day.tokens?.total ?? 0), 0)

      if (days.length === 0 || max === 0) {
        return h('div', { style: { ...mutedStyle, padding: '18px 0' } }, t('noData'))
      }

      // 按周分列、行是星期几；首列按第一天补空格，让每一行都落在同一个星期几上。
      const columns = []
      let column = new Array(weekdayOf(days[0].day)).fill(null)
      days.forEach((day, index) => {
        column.push({ day, index })
        if (column.length === 7) {
          columns.push(column)
          column = []
        }
      })
      if (column.length > 0) {
        while (column.length < 7) column.push(null)
        columns.push(column)
      }

      const levelOf = (total) => {
        if (!(total > 0)) return 0
        const ratio = total / max
        if (ratio <= 0.25) return 1
        if (ratio <= 0.5) return 2
        if (ratio <= 0.75) return 3
        return 4
      }

      // 月份刻度：只在「该月第一次出现」的那一列打标。
      const monthFormat = new Intl.DateTimeFormat(localeId, { month: 'short' })
      let lastMonth = -1
      const monthLabels = columns.map((cells) => {
        const first = cells.find((cell) => cell !== null)
        if (first === undefined) return ''
        const month = Number(String(first.day.day).slice(5, 7))
        if (month === lastMonth) return ''
        lastMonth = month
        return monthFormat.format(new Date(Date.UTC(2026, month - 1, 1)))
      })

      // 列模板：第一列专门留给星期刻度（GUTTER），其余用 1fr 均分容器宽度 —— 所以热力图
      // **始终占满宽度**，面板越宽格子越大；高度由 aspect-ratio 跟着宽度走（正方形）。
      const template = `${GUTTER}px repeat(${columns.length}, minmax(5px, 1fr))`

      // 提示层放在被悬停的那一格**内部**，天然跟着格子走；靠边时往内收，免得顶出容器。
      const shiftFor = (columnIndex) => {
        if (columnIndex <= 1) return '0%'
        if (columnIndex >= columns.length - 2) return '-100%'
        return '-50%'
      }

      const cells = columns.flatMap((columnCells, columnIndex) => columnCells.map((cell, rowIndex) => {
        if (cell === null) return h('div', { key: `pad-${columnIndex}-${rowIndex}` })
        const total = cell.day.tokens?.total ?? 0
        const level = levelOf(total)
        const active = hover !== null && hover.index === cell.index
        return h('div', {
          key: cell.day.day,
          className: 'dsh-us__cell',
          onMouseEnter: () => setHover({ index: cell.index, column: columnIndex, row: rowIndex }),
          onMouseLeave: () => setHover((current) => (current !== null && current.index === cell.index ? null : current)),
          'aria-label': `${cell.day.day} ${compact(total)}`,
          style: {
            position: 'relative',
            aspectRatio: '1',
            borderRadius: 3,
            background: HEAT_COLOR,
            opacity: active ? 1 : HEAT_OPACITY[level],
            boxShadow: active ? '0 0 0 1px var(--dsw-alias-label-primary)' : 'none',
          },
        }, active
          ? h(TrendTip, {
            t,
            row: cell.day,
            title: cell.day.day,
            left: '50%',
            shift: shiftFor(columnIndex),
            showSegments: true,
          })
          : null)
      }))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
        // 月份刻度与网格共用同一套列模板，天然对齐。
        h('div', {
          style: {
            display: 'grid',
            gridAutoFlow: 'column',
            gridTemplateColumns: template,
            gap: GAP,
            fontSize: 9,
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
        h('div', null, ''),
        ...monthLabels.map((label, index) => h('div', {
          key: index,
          style: { whiteSpace: 'nowrap', overflow: 'visible' },
        }, label))),
        h('div', {
          style: {
            display: 'grid',
            gridAutoFlow: 'column',
            gridTemplateColumns: template,
            gridTemplateRows: 'repeat(7, auto)',
            gap: GAP,
            fontSize: 9,
            lineHeight: 1,
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
        // 第一列：星期刻度（只标一/三/五，免得把小网格塞满）
        ...[0, 1, 2, 3, 4, 5, 6].map((row) => h('div', {
          key: `dow-${row}`,
          // 左对齐列里右对齐贴住网格：固定宽度 + 右侧留白，文字不会挤到第一列格子上。
          style: {
            alignSelf: 'center',
            textAlign: 'right',
            paddingRight: 6,
            fontSize: 10,
            // 不换行：标签一旦换行会把整行撑高，热力图行距就乱了。
            whiteSpace: 'nowrap',
          },
        }, row === 1 ? t('dowMon') : row === 3 ? t('dowWed') : row === 5 ? t('dowFri') : '')),
        ...cells),
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            fontSize: 10, color: 'var(--dsw-alias-label-secondary)',
          },
        },
        h('span', null, `${days[0].day} → ${days[days.length - 1].day}`),
        h('span', { style: { marginLeft: 'auto' } }, t('heatLess')),
        ...[0, 1, 2, 3, 4].map((level) => h('span', {
          key: level,
          'aria-hidden': true,
          style: {
            width: 10,
            height: 10,
            borderRadius: 2,
            display: 'inline-block',
            background: HEAT_COLOR,
            opacity: HEAT_OPACITY[level],
          },
        })),
        h('span', null, t('heatMore'))))
    }

    // ── 时段分布 ────────────────────────────────────────────────────────────

    /** 按时间段取色：深夜/上午/下午/晚上各一色，一眼能读出作息。 */
    const HOUR_BANDS = [
      { until: 6, color: COLORS.idle, dictKey: 'bandNight' },
      { until: 12, color: COLORS.success, dictKey: 'bandMorning' },
      { until: 18, color: COLORS.brand, dictKey: 'bandAfternoon' },
      { until: 24, color: COLORS.warn, dictKey: 'bandEvening' },
    ]
    const bandOfHour = (hour) => HOUR_BANDS.find((band) => hour < band.until) ?? HOUR_BANDS[HOUR_BANDS.length - 1]

    function HourChart(props) {
      const t = props.t
      const hours = Array.isArray(props.hours) ? props.hours : []
      const [hover, setHover] = useState(null)
      const max = hours.reduce((acc, row) => Math.max(acc, row.calls ?? 0), 0)
      if (hours.length === 0 || max === 0) {
        return h('div', { style: { ...mutedStyle, padding: '14px 0' } }, t('noData'))
      }

      const height = 96
      const showLabel = (hour) => hour % 6 === 0 || hour === 23

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', {
          style: {
            display: 'flex', alignItems: 'flex-end', gap: 3, height,
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
          },
        }, hours.map((entry, index) => {
          const band = bandOfHour(entry.hour)
          const barHeight = entry.calls > 0 ? Math.max(2, Math.round(((entry.calls ?? 0) / max) * (height - 2))) : 0
          const active = hover === index
          return h('div', {
            key: entry.hour,
            className: 'dsh-us__cell',
            onMouseEnter: () => setHover(index),
            onMouseLeave: () => setHover((current) => (current === index ? null : current)),
            'aria-label': `${String(entry.hour).padStart(2, '0')}:00 ${entry.calls ?? 0}`,
            style: {
              position: 'relative', flex: 1, minWidth: 2, height: '100%',
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', cursor: 'default',
            },
          },
          entry.calls > 0
            ? h('div', {
              style: {
                height: barHeight,
                borderRadius: 2,
                background: band.color,
                opacity: active ? 1 : 0.8,
                boxShadow: active ? '0 0 0 1px var(--dsw-alias-label-primary)' : 'none',
              },
            })
            : h('div', { style: { height: 2, borderRadius: 1, background: 'var(--dsw-alias-border-l1)' } }),
          active
            ? h(TrendTip, {
              t,
              row: entry,
              title: `${String(entry.hour).padStart(2, '0')}:00`,
              left: '50%',
              shift: index <= 1 ? '0%' : index >= hours.length - 2 ? '-100%' : '-50%',
              showSegments: false,
            })
            : null)
        })),
        h('div', {
          style: { display: 'flex', gap: 3, fontSize: 9, color: 'var(--dsw-alias-label-secondary)', ...numStyle },
        }, hours.map((entry) => h('div', {
          key: entry.hour,
          style: { flex: 1, minWidth: 2, textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' },
        }, showLabel(entry.hour) ? String(entry.hour) : ''))),
        h('div', {
          style: {
            display: 'flex', gap: 10, flexWrap: 'wrap',
            fontSize: 10, color: 'var(--dsw-alias-label-secondary)',
          },
        }, ...HOUR_BANDS.map((band) => h('span', {
          key: band.dictKey,
          style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
        },
        h('span', {
          'aria-hidden': true,
          style: { flex: 'none', width: 7, height: 7, borderRadius: 2, background: band.color },
        }),
        t(band.dictKey)))))
    }

    // ── 逐日明细 ────────────────────────────────────────────────────────────

    function DailyTable(props) {
      const t = props.t
      const localeId = props.localeId
      const rows = (Array.isArray(props.days) ? props.days : [])
        .filter((row) => (row.calls ?? 0) > 0 || (row.tokens?.total ?? 0) > 0)
      if (rows.length === 0) return h('div', { style: mutedStyle }, t('noData'))

      const dowFormat = new Intl.DateTimeFormat(localeId, { weekday: 'short' })
      const cell = { padding: '3px 8px', fontSize: 11, ...numStyle, whiteSpace: 'nowrap' }
      const head = { ...cell, color: 'var(--dsw-alias-label-secondary)', fontWeight: 400, textAlign: 'right' }
      const body = { ...cell, textAlign: 'right', color: 'var(--dsw-alias-label-primary)' }

      // 新的在上：最近发生的事先看到。
      const ordered = [...rows].reverse()

      return h('div', { className: 'dsh-us__scroll', style: { maxHeight: 260, overflowY: 'auto', minWidth: 0 } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
          h('thead', null, h('tr', null,
            h('th', { style: { ...head, textAlign: 'left' } }, t('colDay')),
            h('th', { style: { ...head, textAlign: 'left' } }, t('colDow')),
            h('th', { style: head }, t('colCalls')),
            h('th', { style: head }, t('colTools')),
            h('th', { style: head }, t('colTokens')),
            h('th', { style: head }, t('colHitRate')))),
          h('tbody', null, ordered.map((row) => h('tr', {
            key: row.day,
            className: 'dsh-us__row',
            style: { borderTop: '1px solid var(--dsw-alias-border-l1)' },
          },
          h('td', { style: { ...body, textAlign: 'left' } }, row.day),
          h('td', {
            style: { ...body, textAlign: 'left', color: 'var(--dsw-alias-label-secondary)' },
          }, dowFormat.format(dateOf(row.day))),
          h('td', { style: body }, compact(row.calls ?? 0)),
          h('td', { style: body }, compact(row.toolCalls ?? 0)),
          h('td', { style: body }, compact(row.tokens?.total ?? 0)),
          h('td', { style: body }, percent(row.cacheHitRate ?? 0)))))))
    }

    // ── 面板本体 ────────────────────────────────────────────────────────────

    function Panel(props) {
      const t = props.t
      const localeId = props.localeId
      const [range, setRange] = useState(DEFAULT_RANGE)
      const { payload, cost, error, loading, reload, forDays } = useMetrics(range)

      const totals = payload?.totals ?? {}
      const tokens = totals.tokens ?? {}
      const hours = Array.isArray(payload?.hours) ? payload.hours : []
      const year = Array.isArray(payload?.year) ? payload.year : []
      const days = Array.isArray(payload?.days) ? payload.days : []
      const models = Array.isArray(payload?.models) ? payload.models : []
      const tools = Array.isArray(payload?.tools) ? payload.tools : []
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : []
      const errors = Array.isArray(payload?.errors) ? payload.errors : []

      const maxTool = tools.reduce((acc, row) => Math.max(acc, row.calls ?? 0), 0) || 1
      const maxSession = sessions.reduce((acc, row) => Math.max(acc, row.tokens?.total ?? 0), 0) || 1

      const costSessions = Array.isArray(cost?.sessions) ? cost.sessions.slice(0, 6) : []
      const maxCost = costSessions.reduce((acc, row) => Math.max(acc, row.cost ?? 0), 0) || 1
      const money = (amount) => `${cost?.symbol ?? '¥'}${Number(amount ?? 0).toFixed(Math.min(4, Number.isFinite(cost?.decimals) ? cost.decimals : 4))}`

      if (loading === true && payload === null) {
        return h('div', {
          style: {
            height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
          },
        }, t('loading'))
      }

      // 状态行：把「快」直接显示出来，而不是让人猜。
      const status = []
      if (payload !== null) {
        status.push(`${payload.windowDays ?? 0} ${t('daysUnit')}`)
        status.push(`${t('updatedAt')} ${timeLabel(payload.generatedAt)}`)
        if (Number.isFinite(payload.computeMs)) status.push(`${t('perfAggregate')} ${payload.computeMs}ms`)
        if (payload.perf !== undefined) {
          status.push(`${t('perfReused')} ${payload.perf.reused}/${payload.perf.sessions}`)
          // 还在用磁盘缓存、尚未后台校验的条目数（会逐步收敛到 0）。
          if (Number(payload.perf.unverified) > 0) status.push(`${t('perfDisk')} ${payload.perf.unverified}`)
        }
      }

      // 选了范围但服务端窗口没跟上 → 通常是 Host 半改了没重启。显式说出来，别做死控件。
      const stale = forDays !== null && Number.isFinite(payload?.windowDays) && payload.windowDays !== forDays

      return h('div', {
        className: 'dsh-us__scroll',
        style: {
          height: '100%', overflowY: 'auto',
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px 20px' } },

      // 头部
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('panelTitle')),
          h('div', {
            // 允许换行：状态行宁可占两行，也不要被裁掉。
            style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
          }, status.length > 0 ? status.join(' · ') : t('hoursSubtitle'))),
        h('div', {
          role: 'group',
          'aria-label': t('rangeTitle'),
          style: { marginLeft: 'auto', flex: 'none', display: 'flex', gap: 4 },
        }, RANGES.map((value) => h('button', {
          key: value,
          type: 'button',
          className: 'dsh-us__btn',
          'aria-pressed': value === payload?.windowDays,
          onClick: () => setRange(value),
          style: {
            font: 'inherit',
            fontSize: 11,
            lineHeight: 1.7,
            padding: '2px 9px',
            borderRadius: 999,
            cursor: 'pointer',
            border: `1px solid ${value === payload?.windowDays ? COLORS.brand : 'var(--dsw-alias-border-l1)'}`,
            background: 'transparent',
            color: value === payload?.windowDays ? COLORS.brand : 'var(--dsw-alias-label-secondary)',
          },
        }, `${value}${t('daysUnit')}`))),
        stale
          ? h('div', {
            style: {
              flex: 'none', fontSize: 10, whiteSpace: 'nowrap',
              color: 'var(--dsw-alias-state-warn-primary)',
            },
          }, `${t('rangeStale')} ${payload.windowDays} ${t('daysUnit')}`)
          : null,
        h('button', {
          type: 'button',
          className: 'dsh-us__btn',
          onClick: reload,
          style: {
            flex: 'none', font: 'inherit', fontSize: 12, padding: '4px 10px', borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
          },
        }, t('refresh'))),

      // 提示
      error !== null
        ? h('div', {
          style: {
            padding: '6px 10px', borderRadius: 6, fontSize: 12,
            border: '1px solid var(--dsw-alias-state-error-primary)',
          },
        }, `${t('failed')}：${error}`)
        : null,
      errors.length > 0 ? h('div', { style: mutedStyle }, `${errors.length} ${t('partial')}`) : null,

      // 指标卡。注意：**卡片里不放长文本** —— 多列布局下再长的提示都会被裁掉
      // （踩过：总 Token 的三段拆分只显示到「输」）。长内容一律挪到独立区块。
      h('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 10 },
      },
      h(Stat, { label: t('mCalls'), value: compact(totals.calls ?? 0), accent: COLORS.brand }),
      h(Stat, { label: t('mTokens'), value: compact(tokens.total ?? 0), accent: COLORS.brand }),
      h(Stat, { label: t('mCacheHit'), value: percent(totals.cacheHitRate ?? 0), accent: COLORS.success }),
      h(Stat, { label: t('mTools'), value: compact(totals.toolCalls ?? 0), accent: COLORS.warn }),
      h(Stat, {
        label: t('mSessions'),
        value: compact(totals.sessions ?? 0),
        accent: COLORS.brand,
        hint: Number(totals.liveSessions ?? 0) > 0 ? `${totals.liveSessions} ${t('live')}` : undefined,
      }),
      h(Stat, { label: t('mActiveDays'), value: compact(totals.activeDays ?? 0), accent: COLORS.success }),
      h(Stat, { label: t('mAvgPerCall'), value: compact(totals.avgTokensPerCall ?? 0), accent: COLORS.brand }),
      h(Stat, { label: t('mAvgPerDay'), value: compact(totals.avgCallsPerActiveDay ?? 0), accent: COLORS.brand }),
      h(Stat, {
        label: t('peakDay'),
        value: totals.peakDay === null || totals.peakDay === undefined ? '—' : compact(totals.peakDay.tokens),
        accent: COLORS.warn,
        hint: totals.peakDay === null || totals.peakDay === undefined ? undefined : totals.peakDay.day,
      })),

      // 年度热力图
      h(Section, {
        title: t('heatYear'),
        accent: COLORS.success,
        note: year.length > 0 ? `${year.length} ${t('daysUnit')}` : undefined,
      }, h(YearHeatmap, { t, localeId, days: year })),

      // Token 构成 + 时段分布
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 } },
        h(Section, { title: t('tokenMixTitle'), note: t('mTokens') }, h(TokenMix, { t, tokens })),
        h(Section, {
          title: t('hoursTitle'),
          note: t('hoursSubtitle'),
          accent: COLORS.warn,
        }, h(HourChart, { t, hours }))),

      // 模型 / 工具
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 } },
        h(Section, { title: t('modelsTitle'), note: `${models.length}` },
          models.length === 0
            ? h('div', { style: mutedStyle }, t('noData'))
            : models.map((row) => h(BarRow, {
              key: row.model,
              label: row.model,
              hint: percent(row.share ?? 0),
              value: `${compact(row.tokens)} · ${compact(row.calls)}`,
              ratio: row.share ?? 0,
            }))),
        h(Section, { title: t('toolsTitle'), note: `${tools.length}`, accent: COLORS.warn },
          tools.length === 0
            ? h('div', { style: mutedStyle }, t('noData'))
            : tools.map((row) => h(BarRow, {
              key: row.name,
              label: row.name,
              hint: percent(row.share ?? 0),
              value: compact(row.calls),
              ratio: (row.calls ?? 0) / maxTool,
              color: COLORS.warn,
            })))),

      // 会话排行 / 花费
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 } },
        h(Section, { title: t('sessionsTitle'), note: `${totals.sessions ?? 0}` },
          sessions.length === 0
            ? h('div', { style: mutedStyle }, t('noData'))
            : sessions.map((row) => h(BarRow, {
              key: row.id,
              label: row.title !== '' ? row.title : row.id,
              hint: `${row.activeDays ?? 0} ${t('activeDaysUnit')} · ${compact(row.calls ?? 0)}`,
              value: compact(row.tokens?.total ?? 0),
              ratio: (row.tokens?.total ?? 0) / maxSession,
              dot: row.live === true,
            }))),
        h(Section, {
          title: t('costTitle'),
          accent: COLORS.warn,
          note: cost === null ? undefined : t('costAllTime'),
        },
        cost === null
          ? h('div', { style: { ...mutedStyle, lineHeight: 1.6 } }, t('costUnavailable'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h('div', { style: { fontSize: 19, fontWeight: 600, color: COLORS.warn, ...numStyle } }, money(cost?.totals?.cost)),
            costSessions.map((row) => h(BarRow, {
              key: row.id,
              label: row.title !== undefined && row.title !== '' ? row.title : row.id,
              value: money(row.cost),
              ratio: (row.cost ?? 0) / maxCost,
              color: COLORS.warn,
            }))))),

      // 逐日明细
      h(Section, { title: t('detailTitle'), note: t('detailSubtitle') },
        h(DailyTable, { t, localeId, days }))))
    }

    // ── 面板图标 ────────────────────────────────────────────────────────────

    function PanelIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 16
      const color = props?.active === true ? COLORS.brand : 'var(--dsw-alias-label-secondary)'
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('rect', { x: 2, y: 9.5, width: 2.6, height: 4.5, rx: 0.8, fill: color, opacity: 0.5 }),
        h('rect', { x: 6.7, y: 6, width: 2.6, height: 8, rx: 0.8, fill: color, opacity: 0.8 }),
        h('rect', { x: 11.4, y: 2.5, width: 2.6, height: 11.5, rx: 0.8, fill: color, opacity: 1 }))
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-plugin-usage-stats: locale dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-plugin-usage-stats: component styles')

        // 左侧面板栏图标。按钮由宿主渲染并负责选中态；这里的 id 必须与
        // 下面 main 面板的 key 一致，宿主才把两者对上。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 15,
          label: () => t('panelLabel'),
          locale: NS,
        }, PanelIcon))

        // 中央面板。key 与上面 id 一致；该槽不绑 Session，所以统计是全局的。
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t, localeId: ctx.locale.getLocale().active }),
        }, Panel))
      },
    }
  },
})
