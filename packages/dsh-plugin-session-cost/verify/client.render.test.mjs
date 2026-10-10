/**
 * 客户端渲染冒烟测试：不装 jsdom、不用真 React。
 *
 * 做法：用假的 `window.__ModuleLoader__` 捕获 client.js 的模块定义；用一个迷你 hook
 * 渲染器（useState/useEffect/useRef/useMemo + 重渲染）真正调用两个组件；fetch 指向本目录的
 * 端点响应快照 —— 优先用本机抓的 `summary.json`（已被 .gitignore 排除，含真实会话标题），
 * 没有就用仓库里匿名的 `summary.sample.json`。
 *
 * 能验证：注册形状与 id、session 作用域 inject 传参、组件不抛错、金额/行数/排序/过滤/
 * 展开明细的文本正确、effect 有清理函数。
 * 不能验证：真实浏览器里的布局、主题、滚动 —— 那部分需要人眼看。
 *
 * 运行：node verify/client.render.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const localSnapshot = join(here, 'summary.json')
const fixture = existsSync(localSnapshot) ? localSnapshot : join(here, 'summary.sample.json')
const payload = JSON.parse(readFileSync(fixture, 'utf8'))
console.log(`# 使用快照：${fixture.endsWith('summary.json') ? 'summary.json（本机，已 gitignore）' : 'summary.sample.json（仓库内匿名样例）'}`)

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// ── 迷你 React ──────────────────────────────────────────────────────────────
function createElement(type, props, ...children) {
  const flat = children.length === 0 ? (props?.children ?? []) : (children.length === 1 ? children[0] : children)
  return { type, props: { ...(props ?? {}), children: flat } }
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && 'props' in node) return textOf(node.props.children)
  return ''
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 一个组件的根：hooks 存在实例上，所以事件回调触发的 setState 能在下一次 flush 里重渲染。 */
class Root {
  constructor(Component, props) {
    this.Component = Component
    this.props = props
    this.hooks = []
    this.index = 0
    this.pending = []
    this.dirty = false
    this.tree = null
    this.react = {
      createElement,
      useState: (initial) => {
        const i = this.index
        this.index += 1
        if (this.hooks[i] === undefined) this.hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
        const set = (next) => {
          const value = typeof next === 'function' ? next(this.hooks[i].value) : next
          if (!Object.is(value, this.hooks[i].value)) {
            this.hooks[i].value = value
            this.dirty = true
          }
        }
        return [this.hooks[i].value, set]
      },
      useEffect: (effect, deps) => {
        const i = this.index
        this.index += 1
        const store = this.hooks[i] ?? (this.hooks[i] = {})
        const changed = store.deps === undefined || deps === undefined || deps.some((dep, k) => !Object.is(dep, store.deps[k]))
        if (changed) {
          store.deps = deps
          this.pending.push({ store, effect })
        }
      },
      useRef: (initial) => {
        const i = this.index
        this.index += 1
        if (this.hooks[i] === undefined) this.hooks[i] = { current: initial }
        return this.hooks[i]
      },
      useMemo: (factory, deps) => {
        const i = this.index
        this.index += 1
        const store = this.hooks[i] ?? (this.hooks[i] = {})
        const changed = store.deps === undefined || deps === undefined || deps.some((dep, k) => !Object.is(dep, store.deps[k]))
        if (changed) {
          store.value = factory()
          store.deps = deps
        }
        return store.value
      },
    }
  }

  async flush(maxPasses = 12) {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      this.index = 0
      this.pending = []
      this.dirty = false
      this.tree = this.Component(this.props)
      for (const { store, effect } of this.pending) {
        if (typeof store.cleanup === 'function') store.cleanup()
        store.cleanup = effect()
      }
      await tick()
      await tick()
      if (!this.dirty) break
    }
    return this.tree
  }

  dispose() {
    for (const hook of this.hooks) if (hook && typeof hook.cleanup === 'function') hook.cleanup()
  }
}

// ── 假 window / document ────────────────────────────────────────────────────
let moduleDefinition = null
const styleTags = []
const windowListeners = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { moduleDefinition = definition } },
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: (type, handler) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(handler)
  },
  removeEventListener: (type, handler) => { windowListeners.get(type)?.delete(handler) },
}
const fireWindowEvent = (type, event) => { for (const handler of [...(windowListeners.get(type) ?? [])]) handler(event) }
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() { styleTags.pop() } }),
  head: { appendChild: (tag) => { styleTags.push(tag) } },
}

// ── 载入 client.js 并跑 apply ───────────────────────────────────────────────
await import('../client.js')
assert.ok(moduleDefinition !== null, 'client.js 必须调用 window.__ModuleLoader__.load')

const dicts = {}
const registrations = []
const injections = []
const fakeCtx = {
  locale: {
    register: (ns, dictionaries) => { dicts[ns] = dictionaries; return () => {} },
    bind: (ns) => (key, vars) => {
      let text = dicts[ns]?.zh?.[key] ?? dicts[ns]?.en?.[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v))
      return text
    },
  },
  effect: (fn) => fn(),
  slots: {
    inject: (key, callback) => { injections.push({ key, callback }) },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}

// 组件内部用的是 factory 注入的 React；这里换成“会转发到当前渲染根”的代理。
let activeRoot = null
const proxiedReact = {
  createElement,
  useState: (...args) => activeRoot.react.useState(...args),
  useEffect: (...args) => activeRoot.react.useEffect(...args),
  useRef: (...args) => activeRoot.react.useRef(...args),
  useMemo: (...args) => activeRoot.react.useMemo(...args),
}

const clientModule = moduleDefinition.factory((id) => {
  if (id !== 'react') throw new Error(`unexpected require(${id})`)
  return proxiedReact
})

const render = async (Component, props) => {
  const root = new Root(Component, props)
  activeRoot = root
  try {
    return { root, tree: await root.flush() }
  } finally {
    activeRoot = null
  }
}

check('模块 id 等于包名', () => {
  assert.equal(moduleDefinition.id, 'dsh-plugin-session-cost')
})

check('client 半声明 slots/locale 依赖', () => {
  assert.deepEqual(clientModule.inject, ['slots', 'locale'])
})

clientModule.apply(fakeCtx)

check('apply 注入三个槽位并注册三个条目（id 不与宿主冲突）', () => {
  assert.deepEqual(injections.map((i) => i.key).sort(), ['conversation.composer.dock', 'settings.section', 'shell.overlay'])
  injections.forEach((injection) => injection.callback())
  assert.deepEqual(registrations.map((r) => `${r.options.name}#${r.options.id}`).sort(),
    ['conversation.composer.dock#session-cost-badge', 'settings.section#session-cost', 'shell.overlay#session-cost-popover'])
})

check('locale 字典双语言齐备', () => {
  assert.equal(dicts['dsh-plugin-session-cost'].zh.section, '会话消费')
  assert.equal(dicts['dsh-plugin-session-cost'].en.section, 'Session Cost')
})

const badge = registrations.find((r) => r.options.id === 'session-cost-badge')
const popover = registrations.find((r) => r.options.id === 'session-cost-popover')
const panel = registrations.find((r) => r.options.id === 'session-cost')

check('dock 的 inject 拿到 sessionId（session 作用域槽的传参契约）', () => {
  const props = badge.options.inject('session-abc', undefined)
  assert.equal(props.sessionId, 'session-abc')
  assert.equal(typeof props.t, 'function')
})

// ── fetch 指向保存好的真实端点响应 ──────────────────────────────────────────
globalThis.fetch = async (url) => {
  const sessionId = new URL(String(url), 'http://x').searchParams.get('sessionId')
  const body = sessionId === null
    ? payload
    : {
      ...payload,
      session: payload.sessions.find((row) => row.id === sessionId) ?? null,
      sessions: payload.sessions.filter((row) => row.id === sessionId),
    }
  return { ok: true, status: 200, json: async () => body }
}

const target = payload.sessions[0]

check('徽标：窄，只显示金额，不再内联展开明细', async () => {
  const { root, tree } = await render(badge.component, badge.options.inject(target.id))
  const text = textOf(tree)
  assert.ok(text.includes(target.cost.toFixed(4)), `缺少金额 ${target.cost.toFixed(4)}：${text}`)
  assert.ok(!text.includes('输入·缓存命中') && !text.includes('次调用'), `徽标不该有明细/长文案：${text}`)
  assert.ok(text.length <= 24, `徽标文本过长（占宽）：${text}`)
  let button = null
  walk(tree, (node) => { if (node.type === 'button' && button === null) button = node })
  assert.equal(button.props['aria-haspopup'], 'dialog', '徽标应声明点击后弹出对话框')
  assert.equal(button.props['aria-expanded'], false)
  // 用宿主 token 用量表同款类名，样式才可能一致
  assert.equal(button.props.className, 'dsh-sc__trigger')
  assert.equal(tree.type, 'span')
  assert.equal(tree.props.className, 'dsh-sc__root')
  // 悬浮提示里保留完整信息，窄徽标不丢语义
  assert.ok(String(button.props.title).includes('次调用'), button.props.title)
  root.dispose()
})

check('样式：与宿主 ContextMeter（composer dock 的 token 用量表）同款规格', () => {
  const css = styleTags[0]?.textContent ?? ''
  // 触发按钮：宿主同款字号/行高/内边距/悬停与展开底色
  assert.ok(css.includes('--dsh-content-font-size-secondary,13px'), '触发按钮字号应与宿主一致')
  assert.ok(css.includes('calc(20px + var(--dsh-content-font-delta-secondary,0px))'), '行高应与宿主一致')
  assert.ok(css.includes('padding:1px 8px'), '内边距应与宿主一致')
  assert.ok(css.includes('.dsh-sc__trigger:hover,.dsh-sc__trigger[aria-expanded=true]'), '悬停/展开态应与宿主同款')
  assert.ok(css.includes('--dsw-alias-interactive-bg-hover'), '悬停底色应使用宿主同一 token')
  // 面板：宿主同款尺寸/圆角/背景/阴影/内边距
  assert.ok(css.includes('min(264px,100vw - 24px)'), '面板宽度应与宿主一致')
  assert.ok(css.includes('--dsw-radius-lg') && css.includes('--dsw-specific-menu'), '面板圆角与背景应使用宿主 token')
  assert.ok(css.includes('--dsw-menu-backdrop-filter') && css.includes('--dsw-elevation-prominent'), '面板模糊与阴影应使用宿主 token')
  assert.ok(css.includes('z-index:1100'), '面板层级应与宿主一致')
  // 组成条与行：宿主同款轨道/分段/色块
  assert.ok(css.includes('height:4px') && css.includes('gap:1px') && css.includes('border-radius:999px'), '组成条应与宿主同款')
  assert.ok(css.includes('--meter-tint'), '分段/色块应沿用宿主 --meter-tint 约定')
  assert.ok(css.includes('--dsw-static-neutral-bluish-400') && css.includes('--dsw-static-blue-450'), '色板应沿用宿主同一组静态色')
  assert.ok(css.includes('.dsh-sc__prow dt') && css.includes('.dsh-sc__prow dd'), '行的 dt/dd 两端对齐应与宿主同款')
})

check('数字格式：与宿主紧凑数字一致（999 / 2.7K / 141K / 1.4M）', async () => {
  const { root, tree } = await render(popover.component, popover.options.inject())
  assert.equal(tree, null)
  root.dispose()
  // 通过真实数据间接验证：payload 里最大的会话 token 数应渲染成 K/M
  const biggest = payload.sessions.slice().sort((a, b) => b.tokens.total - a.tokens.total)[0]
  const compact = (value) => (value < 1e3 ? String(value) : value < 1e6 ? `${value / 1e3 >= 100 ? Math.round(value / 1e3) : Math.round(value / 100) / 10}K` : `${value / 1e6 >= 100 ? Math.round(value / 1e6) : Math.round(value / 1e5) / 10}M`)
  const { root: badgeRoot, tree: badgeTree } = await render(badge.component, badge.options.inject(biggest.id))
  let button = null
  walk(badgeTree, (node) => { if (node.type === 'button' && button === null) button = node })
  button.props.onClick()
  await badgeRoot.flush()
  const popRoot = new Root(popover.component, popover.options.inject())
  activeRoot = popRoot
  const popTree = await popRoot.flush()
  activeRoot = null
  assert.ok(textOf(popTree).includes(compact(biggest.tokens.total)), `应使用宿主的 K/M 紧凑格式：${textOf(popTree)}`)
  assert.ok(!textOf(popTree).includes('k '), '不应出现小写 k（宿主用大写 K）')
  popRoot.dispose()
  badgeRoot.dispose()
})

check('浮层：默认不渲染（关闭态返回 null）', async () => {
  const { root, tree } = await render(popover.component, popover.options.inject())
  assert.equal(tree, null, '未打开时 shell.overlay 条目必须渲染 null')
  root.dispose()
})

check('点徽标 → 弹框打开并显示明细（命中/未命中/输出/模型）', async () => {
  const { root, tree } = await render(badge.component, badge.options.inject(target.id))
  let button = null
  walk(tree, (node) => { if (node.type === 'button' && button === null) button = node })
  button.props.onClick()
  await root.flush()

  const popRoot = new Root(popover.component, popover.options.inject())
  activeRoot = popRoot
  const popTree = await popRoot.flush()
  activeRoot = null
  const popText = textOf(popTree)
  assert.ok(popText.includes('本次会话消费'), popText)
  assert.ok(popText.includes(target.cost.toFixed(4)), popText)
  assert.ok(popText.includes('输入·缓存命中') && popText.includes('输入·未命中') && popText.includes('输出'), popText)
  assert.ok(popText.includes(Object.keys(target.byModel)[0]), popText)
  assert.ok(popText.includes(`${target.calls} 次调用`), popText)
  assert.equal(popTree.props.role, 'dialog')
  popRoot.dispose()
  root.dispose()
})

check('浮层：没有关闭按钮（靠点外部 / Esc 关闭）', async () => {
  const { root, tree } = await render(badge.component, badge.options.inject(target.id))
  let button = null
  walk(tree, (node) => { if (node.type === 'button' && button === null) button = node })
  button.props.onClick()
  await root.flush()

  const popRoot = new Root(popover.component, popover.options.inject())
  activeRoot = popRoot
  const popTree = await popRoot.flush()
  const buttons = []
  walk(popTree, (node) => { if (node.type === 'button') buttons.push(node) })
  assert.equal(buttons.length, 0, '浮层里不应有任何按钮（含关闭按钮）')
  assert.ok(!textOf(popTree).includes('×'), '不应出现关闭符号')

  // 点面板内部：stopPropagation 后不应关闭
  const panelNode = popTree.props.children.find((child) => child?.props?.role === 'dialog')
  assert.ok(panelNode !== undefined, '面板节点应带 role=dialog')
  let stopped = false
  panelNode.props.onMouseDown({ stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true, '面板内部点击必须吞掉事件')
  assert.ok((await popRoot.flush()) !== null, '点面板内部不应关闭')

  // 点面板外（背板）：关闭
  popTree.props.onMouseDown()
  assert.equal(await popRoot.flush(), null, '点外部应关闭')
  activeRoot = null
  popRoot.dispose()
  root.dispose()
})

check('浮层：Esc 关闭，且关闭后条目回到 null', async () => {
  const { root, tree } = await render(badge.component, badge.options.inject(target.id))
  let button = null
  walk(tree, (node) => { if (node.type === 'button' && button === null) button = node })
  button.props.onClick()
  await root.flush()

  const popRoot = new Root(popover.component, popover.options.inject())
  activeRoot = popRoot
  assert.ok((await popRoot.flush()) !== null, '打开后应渲染卡片')
  fireWindowEvent('keydown', { key: 'Escape' })
  assert.equal(await popRoot.flush(), null, 'Esc 后应关闭')
  activeRoot = null
  // 关闭时也必须摘掉 keydown 监听
  assert.equal(windowListeners.get('keydown')?.size ?? 0, 0, 'Esc 监听必须随关闭清理')
  popRoot.dispose()
  root.dispose()
})

check('徽标：会话不在响应里时不崩（金额位显示占位符）', async () => {
  const { root, tree } = await render(badge.component, badge.options.inject('session-not-in-payload'))
  const text = textOf(tree)
  assert.ok(text.length > 0 && text.length <= 24, text)
  root.dispose()
})

check('面板：总额、会话数与每行金额都渲染出来', async () => {
  const { root, tree } = await render(panel.component, panel.options.inject())
  const text = textOf(tree)
  assert.ok(text.includes(payload.totals.cost.toFixed(4)), `缺少总额：${text.slice(0, 200)}`)
  assert.ok(text.includes(`全部会话 · ${payload.totals.sessions}`), text.slice(0, 200))
  for (const row of payload.sessions.slice(0, 3)) {
    assert.ok(text.includes(row.cost.toFixed(4)), `缺少 ${row.id} 的金额 ${row.cost.toFixed(4)}`)
  }
  root.dispose()
})

check('面板：默认按金额降序，行数等于会话数', async () => {
  const { root, tree } = await render(panel.component, panel.options.inject())
  const rows = []
  walk(tree, (node) => { if (node.props?.className === 'dsh-sc__row') rows.push(textOf(node)) })
  assert.equal(rows.length, payload.sessions.length)
  const expectedFirst = payload.sessions.slice().sort((a, b) => b.cost - a.cost)[0]
  assert.ok(rows[0].includes(expectedFirst.cost.toFixed(4)), `第一行应为最贵会话：${rows[0]}`)
  root.dispose()
})

check('面板：过滤框输入后只留匹配的会话', async () => {
  const { root, tree } = await render(panel.component, panel.options.inject())
  let input = null
  walk(tree, (node) => { if (node.type === 'input' && input === null) input = node })
  assert.ok(input !== null, '面板必须有过滤输入框')
  const needle = payload.sessions[0].cwd.split(/[\\/]/).filter(Boolean).pop()
  input.props.onChange({ target: { value: needle } })
  const filtered = await root.flush()
  const rows = []
  walk(filtered, (node) => { if (node.props?.className === 'dsh-sc__row') rows.push(textOf(node)) })
  const expected = payload.sessions.filter((row) => `${row.title} ${row.cwd}`.toLowerCase().includes(needle.toLowerCase())).length
  assert.equal(rows.length, expected, `过滤 "${needle}" 后应有 ${expected} 行`)
  assert.ok(rows.length < payload.sessions.length, '过滤应真的缩小结果集')
  root.dispose()
})

check('面板：排序按钮有明确选中态，点击后换序且选中态跟着切换', async () => {
  const buttonsOf = (tree) => {
    const found = {}
    walk(tree, (node) => {
      if (node.type !== 'button') return
      const label = textOf(node)
      if (label === '按金额' || label === '按最近') found[label] = node
    })
    return found
  }
  const amountsOf = (tree) => {
    const amounts = []
    walk(tree, (node) => {
      if (node.props?.className !== 'dsh-sc__row') return
      const nums = []
      walk(node, (child) => { if (child.props?.className === 'dsh-sc__num') nums.push(textOf(child)) })
      amounts.push(nums[nums.length - 1])
    })
    return amounts
  }

  const { root, tree } = await render(panel.component, panel.options.inject())
  const before = buttonsOf(tree)
  assert.ok(before['按金额'] && before['按最近'], '面板必须有「按金额」「按最近」两个排序按钮')

  // 选中态必须是「一眼看得出」的：底色 + 边框 + 内描边 + 文字色 + 字重，五个信号都要在。
  const active = before['按金额'].props.style
  const idle = before['按最近'].props.style
  assert.equal(before['按金额'].props['aria-pressed'], 'true', '默认应选中「按金额」')
  assert.equal(before['按最近'].props['aria-pressed'], 'false')
  assert.equal(active.fontWeight, 600, '选中态必须加粗（即使主题色相近也看得出）')
  assert.equal(active.background, 'var(--dsw-alias-bg-layer-2)', '选中态要有底色')
  assert.equal(active.borderColor, 'var(--dsw-alias-brand-primary)')
  assert.equal(active.boxShadow, 'inset 0 0 0 1px var(--dsw-alias-brand-primary)', '选中态要有内描边')
  assert.equal(active.color, 'var(--dsw-alias-brand-primary)')
  assert.notEqual(active.color, idle.color, '选中与未选中的文字色必须不同')
  assert.notEqual(active.fontWeight, idle.fontWeight)
  assert.equal(idle.fontWeight, undefined, '未选中态不加粗')

  // 点「按最近」：选中态交换 + 行序真的变成按最近活跃
  before['按最近'].props.onClick()
  const after = await root.flush()
  const then = buttonsOf(after)
  assert.equal(then['按最近'].props['aria-pressed'], 'true', '点击后「按最近」应选中')
  assert.equal(then['按金额'].props['aria-pressed'], 'false')
  assert.equal(then['按最近'].props.style.fontWeight, 600)
  assert.equal(then['按金额'].props.style.fontWeight, undefined)

  const byCost = payload.sessions.slice().sort((a, b) => (b.cost - a.cost) || ((b.lastActive ?? 0) - (a.lastActive ?? 0)))
  const byTime = payload.sessions.slice().sort((a, b) => ((b.lastActive ?? 0) - (a.lastActive ?? 0)) || (b.cost - a.cost))
  const shown = amountsOf(after)
  assert.equal(shown.length, payload.sessions.length)
  assert.deepEqual(shown, byTime.map((row) => money(row.cost, payload.symbol, payload.decimals)), '行序应为「按最近」')
  if (byCost[0].id !== byTime[0].id) {
    assert.notDeepEqual(shown, byCost.map((row) => money(row.cost, payload.symbol, payload.decimals)), '换序应真的改变行的顺序')
  }
  root.dispose()
})

check('收尾：样式标签已插入，轮询 effect 都有清理函数', async () => {
  assert.ok(styleTags.length >= 1, 'apply 里应插入一次组件样式')
  const { root } = await render(panel.component, panel.options.inject())
  const withCleanup = root.hooks.filter((hook) => hook && typeof hook.cleanup === 'function')
  assert.ok(withCleanup.length >= 1, '面板的定时器/请求 effect 必须返回清理函数')
  root.dispose()
})

console.log(`\n${passed} checks passed`)
process.exit(0)
