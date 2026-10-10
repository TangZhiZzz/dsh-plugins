/**
 * dsh-plugin-session-cost — Client 半。
 *
 * 两处 UI：
 *   1. `conversation.composer.dock`：当前会话的实时消费金额（点击展开 token 明细）；
 *   2. `settings.section`：全部会话消费面板（含已归档的历史会话）。
 *
 * 约定：
 *   - `window.__ModuleLoader__.load` 的 id 必须等于包名；
 *   - React 走浏览器模块表（`require('react')`），不自己装、不引 CDN；
 *   - factory 只做懒加载、无副作用；注册与样式全放 `apply` 并挂 `ctx` 上；
 *   - 颜色只用主题 token（--dsw-alias-*），可见文案走 Client locale 服务。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-cost',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-plugin-session-cost'
    const ENDPOINT = '/dsh-session-cost/summary'
    const BADGE_REFRESH_MS = 5000
    const PANEL_REFRESH_MS = 15000

    // ── 文案 ────────────────────────────────────────────────────────────────
    const ZH = {
      dockLabel: '本次会话',
      section: '会话消费',
      allSessions: '全部会话',
      refresh: '刷新',
      updatedAt: '更新于',
      sortCost: '按金额',
      sortTime: '按最近',
      filterPlaceholder: '过滤标题 / 目录',
      colSession: '会话',
      colCalls: '调用',
      colHit: '缓存命中',
      colMiss: '未命中',
      colOut: '输出',
      colCost: '金额',
      calls: '次调用',
      unpriced: '未定价',
      live: '活跃',
      empty: '还没有可统计的会话。',
      loading: '读取中…',
      failed: '读取失败',
      tokens: 'tokens',
      detailHit: '输入·缓存命中',
      detailMiss: '输入·未命中',
      detailOut: '输出',
      detailModel: '模型',
      popoverTitle: '本次会话消费',
      noteShort: '按 DeepSeek 官方公开价估算，高峰/空闲自动区分。',
      note: '金额按 DeepSeek 官方公开价估算：高峰 = 周一至周五 09:00-12:00、14:00-18:00，其余时段按空闲价（×0.5）；可在插件 Config 里改价。',
      noteAux: '另有 {n} 次标题 / 联网搜索辅路调用，日志中没有 token 用量，未计入金额。',
      noteUnpriced: '有 {n} 次调用命中的模型不在价目表里，金额未计入。',
      noteConfig: '配置问题：',
      errorPrefix: '读取消费数据失败：',
    }
    const EN = {
      dockLabel: 'This session',
      section: 'Session Cost',
      allSessions: 'All sessions',
      refresh: 'Refresh',
      updatedAt: 'Updated',
      sortCost: 'By cost',
      sortTime: 'By recent',
      filterPlaceholder: 'Filter title / folder',
      colSession: 'Session',
      colCalls: 'Calls',
      colHit: 'Cache hit',
      colMiss: 'Cache miss',
      colOut: 'Output',
      colCost: 'Cost',
      calls: 'calls',
      unpriced: 'unpriced',
      live: 'live',
      empty: 'No sessions to report yet.',
      loading: 'Loading…',
      failed: 'Failed to load',
      tokens: 'tokens',
      detailHit: 'Input · cache hit',
      detailMiss: 'Input · cache miss',
      detailOut: 'Output',
      detailModel: 'Model',
      popoverTitle: 'This session',
      noteShort: 'Estimated from DeepSeek public pricing; peak/off-peak auto-detected.',
      note: 'Estimated from DeepSeek public pricing: peak = Mon–Fri 09:00-12:00 and 14:00-18:00 (Asia/Shanghai), everything else at the off-peak price (×0.5). Change the rates in the plugin Config.',
      noteAux: '{n} title / web-search side calls carry no token usage in the log and are not priced.',
      noteUnpriced: '{n} calls used a model missing from the price table and are not priced.',
      noteConfig: 'Config problem: ',
      errorPrefix: 'Failed to read cost data: ',
    }

    const fallbackT = (key, vars) => {
      let text = EN[key] ?? key
      if (vars !== undefined) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v))
      return text
    }

    // ── 样式：只用主题 token ────────────────────────────────────────────────
    // ── 样式：与宿主 composer dock 的 token 用量表（ContextMeter）逐条对齐 ────
    // 常量取自 @deepseek-ai/dsh-client-ui-conversation 的 ContextMeter.module.css：
    // 触发按钮 13px / label-tertiary / padding 1px 8px / hover 与 aria-expanded 同底色；
    // 面板 min(264px,100vw-24px) / radius-lg / specific-menu / elevation-prominent / 12px 12px；
    // 组成条 4px 轨道 + --meter-tint 分段；行 dt/dd 两端对齐、tabular-nums。
    const CSS = [
      '.dsh-sc__root{flex:none;display:inline-flex}',
      '.dsh-sc__trigger{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.dsh-sc__trigger:hover,.dsh-sc__trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dsh-sc__trigger.is-error{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sc__backdrop{position:fixed;inset:0;z-index:1099;background:transparent}',
      '.dsh-sc__panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(264px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px;position:fixed}',
      '.dsh-sc__phead{align-items:center;gap:6px;display:flex}',
      '.dsh-sc__pfig{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}',
      '.dsh-sc__pheadline{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-sc__bar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:4px;margin:10px 0 12px;display:flex;overflow:hidden}',
      '.dsh-sc__seg{background:var(--meter-tint,var(--dsw-alias-label-tertiary));border-radius:1px;flex:none;min-width:2px;height:100%}',
      '.dsh-sc__swatch{background:var(--meter-tint);vertical-align:baseline;border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}',
      '.dsh-sc__tint1{--meter-tint:var(--dsw-static-neutral-bluish-400)}',
      '.dsh-sc__tint2{--meter-tint:#a78bfa}',
      '.dsh-sc__tint3{--meter-tint:var(--dsw-static-blue-450)}',
      '.dsh-sc__plist{margin:6px 0 0;padding:0;border:0}',
      '.dsh-sc__prow{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}',
      '.dsh-sc__prow dt{color:var(--dsw-alias-label-secondary)}',
      '.dsh-sc__prow dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0}',
      '.dsh-sc__pfoot{margin-top:8px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-sc__pnote{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}',
      '.dsh-sc__pmeta{color:var(--dsw-alias-label-tertiary)}',
      // 设置页面板（表格）
      '.dsh-sc__row{transition:background-color .12s ease}',
      '.dsh-sc__row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-sc__num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}',
      '.dsh-sc__ellipsis{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-sc__scroll{overflow-y:auto;scrollbar-width:thin}',
    ].join('\n')

    const GRID = 'minmax(0,1fr) 56px 82px 78px 78px 96px'

    const S = {
      wrap: { boxSizing: 'border-box', width: '100%', font: 'inherit' },
      amount: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
      },
      head: {
        display: 'grid',
        gridTemplateColumns: GRID,
        gap: 8,
        padding: '7px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-tertiary)',
      },
      row: {
        display: 'grid',
        gridTemplateColumns: GRID,
        gap: 8,
        alignItems: 'center',
        padding: '8px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
      },
      tag: {
        display: 'inline-block',
        marginLeft: 6,
        padding: '0 5px',
        borderRadius: 4,
        fontSize: 11,
        lineHeight: '16px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      liveDot: {
        display: 'inline-block',
        width: 6,
        height: 6,
        marginRight: 6,
        borderRadius: '50%',
        background: 'var(--dsw-alias-state-success-primary)',
        verticalAlign: 'middle',
      },
      toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '2px 10px',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      buttonActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '3px 8px',
        font: 'inherit',
        fontSize: 12,
        minWidth: 180,
      },
      muted: { color: 'var(--dsw-alias-label-secondary)' },
      tertiary: { color: 'var(--dsw-alias-label-tertiary)' },
      totalRow: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      total: { fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)' },
      note: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
    }

    // ── 工具 ────────────────────────────────────────────────────────────────
    function money(value, symbol, decimals) {
      const n = Number.isFinite(value) ? value : 0
      return `${symbol ?? '¥'}${n.toFixed(decimals ?? 4)}`
    }

    /** 与宿主 token 用量表同款紧凑数字：<1000 原样；<1e6 用 K；否则用 M。 */
    function tokens(n) {
      const value = Number.isFinite(n) ? n : 0
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
      if (value < 1e3) return String(value)
      if (value < 1e6) return `${scaled(value / 1e3)}K`
      return `${scaled(value / 1e6)}M`
    }

    function timeText(ms) {
      if (!Number.isFinite(ms)) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return '—'
      }
    }

    function folderOf(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return ''
      const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
      return parts[parts.length - 1] ?? ''
    }

    async function fetchSummary(sessionId, signal) {
      const url = typeof sessionId === 'string' && sessionId !== ''
        ? `${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`
        : ENDPOINT
      const response = await fetch(url, { signal, headers: { accept: 'application/json' }, credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad payload')
      return payload
    }

    /** 定时取数：失败保留上一次成功结果，只把错误挂出来；nonce 变化立即重取。 */
    function useSummary(sessionId, enabled, intervalMs, nonce) {
      const [state, setState] = React.useState({ data: null, error: null })
      const sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
      React.useEffect(() => {
        if (!enabled) return undefined
        let alive = true
        const controller = new AbortController()
        const load = async () => {
          try {
            const data = await fetchSummary(sid, controller.signal)
            if (alive) setState({ data, error: null })
          } catch (error) {
            if (!alive || error?.name === 'AbortError') return
            const message = error instanceof Error ? error.message : String(error)
            setState((prev) => ({ ...prev, error: message }))
          }
        }
        void load()
        const timer = setInterval(load, intervalMs)
        return () => {
          alive = false
          controller.abort()
          clearInterval(timer)
        }
      }, [sid, enabled, intervalMs, nonce])
      return state
    }

    // ── 输入框下方：当前会话实时金额（窄徽标）+ 点击弹出的浮层 ─────────────
    let warnedNoSessionId = false

    /**
     * 徽标与浮层是两个槽位（dock 在输入框下、overlay 在全局浮层），用一份模块级状态通信：
     * 徽标只负责「显示金额 + 开合」，浮层负责明细，点外部/按 Esc 关闭。
     */
    const popover = {
      state: { open: false, sessionId: null, anchor: null },
      listeners: new Set(),
      set(patch) {
        popover.state = { ...popover.state, ...patch }
        for (const listener of [...popover.listeners]) listener()
      },
      close() {
        popover.set({ open: false, sessionId: null, anchor: null })
      },
      subscribe(listener) {
        popover.listeners.add(listener)
        return () => popover.listeners.delete(listener)
      },
    }

    function usePopover() {
      const [state, setState] = React.useState(popover.state)
      React.useEffect(() => popover.subscribe(() => setState(popover.state)), [])
      return state
    }

    function CostBadge(props) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const t = props?.t ?? fallbackT
      const anchorRef = React.useRef(null)
      const state = usePopover()
      const opened = state.open === true && state.sessionId === sessionId
      const { data, error } = useSummary(sessionId, typeof sessionId === 'string' && sessionId !== '', BADGE_REFRESH_MS, 0)

      if (typeof sessionId !== 'string' || sessionId === '') {
        if (!warnedNoSessionId && typeof console !== 'undefined') {
          warnedNoSessionId = true
          console.warn('[dsh-plugin-session-cost] composer.dock 未拿到 sessionId，徽标不渲染')
        }
        return null
      }

      const row = data?.session ?? (Array.isArray(data?.sessions) ? data.sessions[0] : null) ?? null
      const symbol = data?.symbol ?? '¥'
      const decimals = data?.decimals ?? 4
      const amountLabel = row === null
        ? (error !== null ? '!' : '…')
        : (row.priced ? money(row.cost, symbol, decimals) : t('unpriced'))

      const toggle = () => {
        if (opened) {
          popover.close()
          return
        }
        const node = anchorRef.current
        const rect = node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function'
          ? node.getBoundingClientRect()
          : null
        popover.set({
          open: true,
          sessionId,
          anchor: rect === null ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        })
      }

      const label = row === null
        ? t('dockLabel')
        : `${t('dockLabel')} ${amountLabel} · ${row.calls} ${t('calls')} · ${tokens(row.tokens?.total ?? 0)} ${t('tokens')}`

      return h('span', { className: 'dsh-sc__root' },
        h('button', {
          type: 'button',
          ref: anchorRef,
          className: `dsh-sc__trigger${error !== null ? ' is-error' : ''}`,
          'aria-haspopup': 'dialog',
          'aria-expanded': opened,
          'aria-label': label,
          title: error === null ? label : `${t('errorPrefix')}${error}`,
          onClick: toggle,
        },
        amountLabel,
        ),
      )
    }

    /** 当前会话明细浮层：挂在 shell.overlay（宿主自带的全局浮层，不受输入框容器裁剪）。 */
    function CostPopover(props) {
      const t = props?.t ?? fallbackT
      const state = usePopover()
      const open = state.open === true && typeof state.sessionId === 'string' && state.sessionId !== ''
      const { data, error } = useSummary(state.sessionId, open, BADGE_REFRESH_MS, 0)

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event?.key === 'Escape') popover.close()
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }
        return undefined
      }, [open])

      if (!open) return null

      const row = data?.session ?? (Array.isArray(data?.sessions) ? data.sessions[0] : null) ?? null
      const symbol = data?.symbol ?? '¥'
      const decimals = data?.decimals ?? 4
      const tok = row?.tokens ?? null
      const costs = row?.costs ?? null
      const anchor = state.anchor
      const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024
      const viewportHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768
      // 与宿主 ContextMeter 面板同规格：min(264px, 100vw - 24px)，贴顶留 8px、离边留 12px
      const width = Math.min(264, viewportWidth - 24)
      const center = anchor === null ? viewportWidth / 2 : (anchor.left + anchor.right) / 2
      const left = Math.max(12, Math.min(center - width / 2, viewportWidth - width - 12))
      const bottom = anchor === null ? 120 : Math.max(12, viewportHeight - anchor.top + 8)

      // 组成条：按三桶金额占比分段，颜色沿用宿主 token 用量表的同一组 --meter-tint
      const shares = (() => {
        const parts = [
          { key: 'cacheHit', tint: 'dsh-sc__tint1', cost: costs?.cacheHit ?? 0 },
          { key: 'cacheMiss', tint: 'dsh-sc__tint2', cost: costs?.cacheMiss ?? 0 },
          { key: 'output', tint: 'dsh-sc__tint3', cost: costs?.output ?? 0 },
        ]
        const total = parts.reduce((sum, part) => sum + (part.cost > 0 ? part.cost : 0), 0)
        return total > 0 ? parts.filter((part) => part.cost > 0).map((part) => ({ ...part, percent: (part.cost / total) * 100 })) : null
      })()

      const rowOf = (tint, label, value, amount) => h('div', { className: 'dsh-sc__prow', key: label },
        h('dt', null, h('span', { className: `dsh-sc__swatch ${tint}`, 'aria-hidden': true }), label),
        h('dd', null, `${value} · ${amount}`),
      )

      return h('div', {
        className: 'dsh-sc__backdrop',
        onMouseDown: () => popover.close(),
      },
      h('div', {
        role: 'dialog',
        'aria-label': t('popoverTitle'),
        className: 'dsh-sc__panel',
        style: { width, left, bottom },
        onMouseDown: (event) => event.stopPropagation(),
      },
      h('div', { className: 'dsh-sc__phead' },
        h('span', { className: 'dsh-sc__pheadline' }, t('popoverTitle')),
        h('span', { className: 'dsh-sc__pfig', 'aria-live': 'polite' },
          row === null ? (error !== null ? t('failed') : t('loading')) : (row.priced ? money(row.cost, symbol, decimals) : t('unpriced'))),
      ),
      h('div', { className: 'dsh-sc__bar', role: 'presentation' },
        shares === null
          ? h('span', { className: 'dsh-sc__seg', style: { width: '100%' } })
          : shares.map((part) => h('span', { key: part.key, className: `dsh-sc__seg ${part.tint}`, style: { width: `${part.percent}%` } })),
      ),
      h('dl', { className: 'dsh-sc__plist' },
        rowOf('dsh-sc__tint1', t('detailHit'), tokens(tok?.cacheHit ?? 0), costs === null ? '—' : money(costs.cacheHit, symbol, decimals)),
        rowOf('dsh-sc__tint2', t('detailMiss'), tokens(tok?.cacheMiss ?? 0), costs === null ? '—' : money(costs.cacheMiss, symbol, decimals)),
        rowOf('dsh-sc__tint3', t('detailOut'), tokens(tok?.output ?? 0), costs === null ? '—' : money(costs.output, symbol, decimals)),
      ),
      h('div', { className: 'dsh-sc__pfoot' },
        h('div', null, row === null
          ? '—'
          : `${row.calls} ${t('calls')} · ${tokens(tok?.total ?? 0)} ${t('tokens')}`),
        h('div', { className: 'dsh-sc__pmeta' }, `${t('detailModel')}：${Object.keys(row?.byModel ?? {}).join(', ') || '—'}`),
      ),
      (row?.unpricedCalls > 0 ? h('div', { className: 'dsh-sc__pmeta' }, t('noteUnpriced', { n: row.unpricedCalls })) : null),
      (error !== null ? h('div', { style: S.error }, `${t('errorPrefix')}${error}`) : null),
      h('div', { className: 'dsh-sc__pnote' }, t('noteShort')),
      ))
    }


    // ── 设置页：全部会话消费面板 ────────────────────────────────────────────
    function CostPanel(props) {
      const t = props?.t ?? fallbackT
      const [sort, setSort] = React.useState('cost')
      const [filter, setFilter] = React.useState('')
      const [nonce, setNonce] = React.useState(0)
      const { data, error } = useSummary(null, true, PANEL_REFRESH_MS, nonce)

      const symbol = data?.symbol ?? '¥'
      const decimals = data?.decimals ?? 4
      const all = Array.isArray(data?.sessions) ? data.sessions : []
      const needle = filter.trim().toLowerCase()
      const rows = all
        .filter((row) => needle === ''
          || String(row.title ?? '').toLowerCase().includes(needle)
          || String(row.cwd ?? '').toLowerCase().includes(needle))
        .slice()
        .sort(sort === 'cost'
          ? (a, b) => (b.cost - a.cost) || ((b.lastActive ?? 0) - (a.lastActive ?? 0))
          : (a, b) => ((b.lastActive ?? 0) - (a.lastActive ?? 0)) || (b.cost - a.cost))

      const toolbar = h('div', { style: S.toolbar },
        h('input', {
          style: S.input,
          value: filter,
          placeholder: t('filterPlaceholder'),
          'aria-label': t('filterPlaceholder'),
          onChange: (event) => setFilter(event.target.value),
        }),
        h('button', {
          type: 'button',
          style: sort === 'cost' ? { ...S.button, ...S.buttonActive } : S.button,
          onClick: () => setSort('cost'),
        }, t('sortCost')),
        h('button', {
          type: 'button',
          style: sort === 'time' ? { ...S.button, ...S.buttonActive } : S.button,
          onClick: () => setSort('time'),
        }, t('sortTime')),
        h('span', { style: { flex: 1 } }),
        data !== null ? h('span', { style: S.tertiary }, `${t('updatedAt')} ${timeText(data.generatedAt)}`) : null,
        h('button', { type: 'button', style: S.button, onClick: () => setNonce((n) => n + 1) }, t('refresh')),
      )

      const head = h('div', { style: S.head },
        h('span', null, t('colSession')),
        h('span', { className: 'dsh-sc__num' }, t('colCalls')),
        h('span', { className: 'dsh-sc__num' }, t('colHit')),
        h('span', { className: 'dsh-sc__num' }, t('colMiss')),
        h('span', { className: 'dsh-sc__num' }, t('colOut')),
        h('span', { className: 'dsh-sc__num' }, t('colCost')),
      )

      const body = rows.length === 0
        ? h('div', { style: { padding: '18px 12px', ...S.tertiary } }, data === null ? t('loading') : t('empty'))
        : rows.map((row) => {
          const tok = row.tokens ?? {}
          return h('div', { key: row.id, className: 'dsh-sc__row', style: S.row },
            h('div', { className: 'dsh-sc__ellipsis', title: `${row.title}\n${row.cwd ?? ''}\n${row.id}` },
              row.live ? h('span', { style: S.liveDot, title: t('live') }) : null,
              h('span', null, row.title),
              row.unpricedCalls > 0 ? h('span', { style: S.tag }, t('unpriced')) : null,
              h('div', { className: 'dsh-sc__ellipsis', style: { ...S.tertiary, fontSize: 11 } },
                [folderOf(row.cwd), timeText(row.lastActive)].filter(Boolean).join(' · ')),
            ),
            h('span', { className: 'dsh-sc__num', style: S.muted }, String(row.calls)),
            h('span', { className: 'dsh-sc__num', style: S.muted }, tokens(tok.cacheHit)),
            h('span', { className: 'dsh-sc__num', style: S.muted }, tokens(tok.cacheMiss)),
            h('span', { className: 'dsh-sc__num', style: S.muted }, tokens(tok.output)),
            h('span', { className: 'dsh-sc__num', style: row.priced ? S.amount : S.warn },
              row.priced ? money(row.cost, symbol, decimals) : t('unpriced')),
          )
        })

      const totals = data?.totals ?? null
      const auxCount = totals === null ? 0 : (totals.aux.title + totals.aux.search + totals.aux.other)
      const configWarnings = Array.isArray(data?.configWarnings) ? data.configWarnings : []
      const notes = [
        t('note'),
        auxCount > 0 ? t('noteAux', { n: auxCount }) : null,
        totals !== null && totals.unpricedCalls > 0 ? t('noteUnpriced', { n: totals.unpricedCalls }) : null,
        ...configWarnings.map((line) => `${t('noteConfig')}${line}`),
        error !== null ? `${t('errorPrefix')}${error}` : null,
      ].filter(Boolean)

      return h('div', { style: { ...S.wrap, display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 0 24px' } },
        h('div', { style: S.totalRow },
          h('span', { style: S.total }, totals === null ? '—' : money(totals.cost, symbol, decimals)),
          h('span', { style: S.muted }, `${t('allSessions')} · ${totals === null ? 0 : totals.sessions}`),
          h('span', { style: S.muted }, `${totals === null ? 0 : totals.calls} ${t('calls')}`),
          totals !== null && totals.liveSessions > 0 ? h('span', { style: S.muted }, `${totals.liveSessions} ${t('live')}`) : null,
        ),
        toolbar,
        h('div', { style: S.card },
          head,
          h('div', { className: 'dsh-sc__scroll', style: { maxHeight: '58vh' } }, body),
        ),
        h('div', { style: S.note }, notes.map((line, index) => h('div', { key: index }, line))),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-plugin-session-cost: locale dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-plugin-session-cost: component styles')

        // 当前会话实时金额：session 作用域槽，inject 的第一个参数就是 sessionId。
        // 徽标本身只有金额；点开后的明细走 shell.overlay，不会被输入框容器裁剪。
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'session-cost-badge',
          order: 60,
          label: () => t('dockLabel'),
          locale: NS,
          inject: (sessionId) => ({ sessionId, t }),
        }, CostBadge))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-cost-popover',
          order: 90,
          label: () => t('popoverTitle'),
          locale: NS,
          inject: () => ({ t }),
        }, CostPopover))

        // 全部会话消费面板：设置页的一整节。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'session-cost',
          order: 60,
          label: () => t('section'),
          locale: NS,
          inject: () => ({ t }),
        }, CostPanel))
      },
    }
  },
})
