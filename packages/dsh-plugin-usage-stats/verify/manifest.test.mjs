/**
 * manifest / 一致性校验：这台机器上的 DSH 会直接读这些文件，字段写错就是
 * 「插件列表显示成包名」或「插槽注册不上」。运行：node verify/manifest.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (name) => readFileSync(new URL(name, root), 'utf8')
const exists = (name) => existsSync(new URL(name, root))

const pkg = JSON.parse(read('package.json'))

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

test('包名与 Host 半的 name 一致', () => {
  assert.equal(pkg.name, 'dsh-plugin-usage-stats')
  assert.match(read('index.js'), /export const name = 'dsh-plugin-usage-stats'/)
})

test('版本号是合法 semver', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
})

test('exports 暴露 . / ./client / ./package.json / ./locale/*.json', () => {
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
})

test('声明了 dsh.bundle.patch 且补丁文件存在', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(exists('cordis.patch.yml'), true)
})

test('声明了 web 平台的 Client 半', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(exists('client.js'), true)
})

test('files 白名单里的非通配项都存在（且带上 metrics.js）', () => {
  for (const entry of pkg.files) {
    if (entry.includes('*')) continue
    assert.equal(exists(entry), true, `files 里声明的 ${entry} 不存在`)
  }
  assert.ok(pkg.files.includes('metrics.js'), 'files 必须包含 metrics.js')
})

test('locale 目录恰好有 zh/en 两份，且都带 meta.title 与 meta.description', () => {
  const files = readdirSync(new URL('locale/', root)).filter((name) => name.endsWith('.json')).sort()
  assert.deepEqual(files, ['en.json', 'zh.json'])
  for (const file of files) {
    const parsed = JSON.parse(read(`locale/${file}`))
    // 必须是嵌套一层 meta：写成顶层 title 会让宿主回落成包名（踩过的坑）。
    assert.equal(typeof parsed.meta?.title, 'string', `${file} 缺少 meta.title`)
    assert.equal(typeof parsed.meta?.description, 'string', `${file} 缺少 meta.description`)
    assert.notEqual(parsed.meta.title, pkg.name, `${file} 的 meta.title 不能是包名`)
  }
})

test('cordis.patch.yml 插入了与包名一致的一行', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /id: usage-stats-plugin/)
  assert.match(patch, /name: dsh-plugin-usage-stats/)
})

test('Client 半的 loader id 等于包名', () => {
  const client = read('client.js')
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(client, /id: 'dsh-plugin-usage-stats'/)
})

test('Client 半注册到 sidebar.panellist 与 main，且两处 id/key 同源', () => {
  const client = read('client.js')
  assert.match(client, /ctx\.slots\.inject\('sidebar\.panellist'/)
  assert.match(client, /ctx\.slots\.inject\('main'/)
  // 面板图标（id）与面板本体（key）必须取同一个常量，否则宿主对不上。
  assert.match(client, /const PANEL_ID = 'usage-stats'/)
  assert.match(client, /id: PANEL_ID/)
  assert.match(client, /key: PANEL_ID/)
})

test('两半的自有路由路径一致', () => {
  const route = /const ROUTE_PATH = '([^']+)'/.exec(read('index.js'))
  assert.ok(route !== null, 'index.js 必须导出 ROUTE_PATH')
  const endpoint = /const ENDPOINT = '([^']+)'/.exec(read('client.js'))
  assert.ok(endpoint !== null, 'client.js 必须定义 ENDPOINT')
  assert.equal(endpoint[1], route[1])
  assert.equal(route[1], '/dsh-plugin-usage-stats/metrics')
})

test('金额取自 session-cost 的路由，两半路径一致（不重复实现定价）', () => {
  const costRoute = /const COST_ROUTE_PATH = '([^']+)'/.exec(read('index.js'))
  assert.ok(costRoute !== null, 'index.js 必须声明 COST_ROUTE_PATH')
  const costEndpoint = /const COST_ENDPOINT = '([^']+)'/.exec(read('client.js'))
  assert.ok(costEndpoint !== null, 'client.js 必须定义 COST_ENDPOINT')
  assert.equal(costEndpoint[1], costRoute[1])
  assert.equal(costRoute[1], '/dsh-session-cost/summary')
  // Host 半不该自带价目表：定价只有 session-cost 一份。
  // 判据收窄成「价格表的键」`cacheHit:` / `cacheMiss:`：先剥注释（散文里会提到这些词），
  // 且要求后面真的跟着冒号 —— 这样 totals.cacheHitRate 这类统计字段不会误伤。
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  const pricingKey = /\b(cacheHit|cacheMiss)\b\s*:/
  assert.equal(pricingKey.test(stripComments(read('index.js'))), false, 'index.js 不应出现价目表字段')
  assert.equal(pricingKey.test(stripComments(read('metrics.js'))), false, 'metrics.js 不应出现价目表字段')
})

test('Host 半没有静态裸导入 @deepseek-ai/*（profile 路径解析不到，必须动态导入）', () => {
  for (const file of ['index.js', 'metrics.js']) {
    const source = read(file)
    const staticImport = /^\s*import\s[^\n]*from\s+['"]@deepseek-ai\//m
    assert.equal(staticImport.test(source), false, `${file} 出现了静态裸导入 @deepseek-ai/*`)
  }
})

test('Client 半不 import 任何 Harness Client 包', () => {
  const client = read('client.js')
  assert.equal(/require\(\s*['"]@deepseek-ai\//.test(client), false)
  assert.equal(/from\s+['"]@deepseek-ai\//.test(client), false)
})

test('Client 半不引第三方图表库（图表用 div 手绘）', () => {
  const client = read('client.js')
  for (const banned of ['recharts', 'chart.js', 'echarts', 'd3', 'victory', 'apexcharts']) {
    assert.equal(client.includes(banned), false, `client.js 引了图表库 ${banned}`)
  }
})

test('Client 半的可见文案都在 locale 字典里（不散落字面中文）', () => {
  const client = read('client.js')
  const start = client.indexOf('const ZH = {')
  const end = client.indexOf('const CSS =')
  assert.ok(start !== -1 && end > start, '找不到 ZH/EN 字典区间')
  const dicts = client.slice(start, end)
  // 字典之外不该再出现中文字面量。先剥掉注释（含行尾注释）再查；
  // 本文件里 CSS 与代码都不含 `//` 字面量，所以按行切割是安全的。
  const body = client.slice(end)
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  const chinese = withoutComments.match(/[\u4e00-\u9fff]+/g) ?? []
  assert.deepEqual(chinese, [], `字典之外出现了中文字面量：${chinese.join(' / ')}`)
  assert.match(dicts, /panelTitle:/)
})

test('Host 半的可调参数都在 Config 里（用户能在 profile 补丁层覆盖）', () => {
  const source = read('index.js')
  for (const field of ['days', 'maxSessions', 'topN', 'timeZone', 'includeSubagents', 'refreshSeconds', 'foldCacheSeconds', 'liveFoldSeconds', 'readConcurrency', 'warmUpOnStart', 'warmUpDelaySeconds']) {
    assert.match(source, new RegExp(`${field}:`), `Config 缺少 ${field}`)
  }
})

test('时间范围：页面用 ?days= 传参，Host 读同名参数并收敛到合法区间', () => {
  const client = read('client.js')
  const host = read('index.js')
  assert.match(client, /\?days=\$\{encodeURIComponent\(days\)\}/)
  assert.match(client, /const RANGES = \[/, '页面必须提供多个时间范围选项')
  assert.match(host, /searchParams\.get\('days'\)/)
  assert.match(host, /clampDays/, 'Host 必须把外部传进来的天数收敛')
  // 选中的范围与服务端窗口不一致时必须显式提示，不能做成点了没反应的死控件；
  // 而且要比「产出当前 payload 的那个窗口」（forDays），不能比刚点下的 range ——
  // 否则请求还在飞的那一两秒会误报。
  assert.match(client, /rangeStale/)
  assert.match(client, /payload\.windowDays !== forDays/)
  // 范围选项里必须有一年（365 天），且默认落在 30 天。
  assert.match(client, /const RANGES = \[7, 14, 30, 90, 365\]/)
  assert.match(client, /const DEFAULT_RANGE = 30/)
})

test('可选脚本：图表与统计维度都齐（热力图 / 小时分布 / 排行 / 逐日明细）', () => {
  const client = read('client.js')
  for (const fn of ['function YearHeatmap', 'function HourChart', 'function DailyTable', 'function BarRow', 'function Panel']) {
    assert.ok(client.includes(fn), `缺少 ${fn}`)
  }
  // 一次请求拿回全部数据：年度序列与小时分布都来自同一个载荷。
  assert.match(client, /payload\?\.year/)
  assert.match(client, /payload\?\.hours/)
  assert.match(client, /payload\?\.days/)
})

test('年度热力图：按真实星期几对齐 + 自定义悬停提示', () => {
  const client = read('client.js')
  // 从 weekdayOf 切到 YearHeatmap 结束：星期几对齐靠 weekdayOf，不能只看热力图函数本身。
  const start = client.indexOf('function weekdayOf')
  const end = client.indexOf('function HourChart')
  assert.ok(start !== -1 && end > start, '找不到 weekdayOf / HourChart')
  const chart = client.slice(start, end)
  assert.match(chart, /function YearHeatmap/)
  assert.match(chart, /onMouseEnter/)
  assert.match(chart, /onMouseLeave/)
  assert.match(chart, /dsh-us__tip/)
  // 日历热力图必须按真实星期几对齐，所以要有「日期键 → 星期几」的换算。
  assert.match(chart, /getUTCDay\(\)/)
  // 提示层由自定义组件渲染（不是原生 title）。
  assert.match(chart, /h\(TrendTip, \{/)
  // 左侧必须给星期刻度留出固定宽度，否则标签会挤到第一列格子上。
  assert.match(chart, /paddingRight: 6/)
  // 配色走 GitHub 贡献图那种绿色渐变，绿色取主题 success token（亮/暗自动跟随）。
  // 这两个常量定义在文件上方的常量区，所以要查整份 client，而不是热力图那一段。
  assert.match(client, /const HEAT_COLOR = COLORS\.success/)
  assert.match(client, /const GUTTER = 44/)
})

test('指标卡不放长文本：Token 三段拆分布独立区块，不会被卡片裁掉', () => {
  const client = read('client.js')
  // 总 Token 卡片只有数值 + 语义色标记，**没有 hint** —— 曾经把三段拆分塞进卡片，
  // 被 nowrap+ellipsis 静默裁成「… · 输」。长内容一律不许回到卡片里。
  assert.match(client, /h\(Stat, \{ label: t\('mTokens'\), value: compact\(tokens\.total \?\? 0\), accent: COLORS\.brand \}\)/)
  // 三段拆分有自己的组件与区块标题。
  assert.match(client, /function TokenMix/)
  assert.match(client, /tokenMixTitle/)
  // Stat 的提示必须允许换行，不再用省略号裁切。
  const start = client.indexOf('function Stat')
  const end = client.indexOf('function BarRow')
  assert.ok(start !== -1 && end > start, '找不到 Stat / BarRow')
  const stat = client.slice(start, end)
  assert.match(stat, /lineHeight: 1\.35/)
  assert.equal(/textOverflow/.test(stat), false, 'Stat 里不该再用省略号裁切提示')
})

test('locale 完整性：t(...) 用到的每个键都必须在 zh/en 两份字典里', () => {
  const client = read('client.js')
  const keysOf = (name) => {
    const start = client.indexOf(`const ${name} = {`)
    const end = client.indexOf('\n    }', start)
    assert.ok(start !== -1 && end > start, `找不到 ${name} 字典`)
    return new Set(
      [...client.slice(start, end).matchAll(/^\s+([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((match) => match[1]),
    )
  }
  const zh = keysOf('ZH')
  const en = keysOf('EN')
  const used = new Set(
    [...client.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'\)/g)].map((match) => match[1]),
  )

  // 这个下限是防"正则没生效导致断言空转"的。
  assert.ok(used.size > 20, `解析到的 t() 键太少（${used.size}），正则可能失效了`)

  // 键缺失时 locale 会回落成键名本身（左侧就显示成 dowMon 这样的原始键），
  // 而且是静默的 —— 这条断言就是钉住这个坑。
  const missingZh = [...used].filter((key) => !zh.has(key)).sort()
  const missingEn = [...used].filter((key) => !en.has(key)).sort()
  assert.deepEqual(missingZh, [], `zh 字典缺少：${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `en 字典缺少：${missingEn.join(', ')}`)

  // 两份字典的键集合必须一致，否则切换语言会露出原始键名。
  assert.deepEqual([...zh].sort(), [...en].sort(), 'zh/en 字典的键不一致')
})

test('加载速度：后台预热 + 客户端不等金额', () => {
  const host = read('index.js')
  const client = read('client.js')
  // Host：激活后在后台预热天行缓存，打开面板时不必等冷启动（实测 7.2s → 15–25ms）。
  assert.match(host, /cfg\.warmUpOnStart/)
  assert.match(host, /service\.warm\(\)/)
  assert.match(host, /warmUpDelayMs/)
  // 客户端：两条请求并发，且**不是**串行 await 金额那条。
  assert.match(client, /Promise\.allSettled\(\[metricsDone, costDone\]\)/)
  assert.match(client, /const costDone = fetchJson\(COST_ENDPOINT, signal\)/)
  // 不能再出现「先 await 看板、再 await 金额」的串行写法。
  assert.equal(/const payload = await fetchJson\(url, signal\)/.test(client), false, '看板请求不该串行等待')
})

test('服务级测试必须自封闭：每个 createDashboardService(...) 都要显式注入持久化', () => {
  // 踩过：直接 new 服务时用了默认的文件持久化，于是测试会去读写**真实临时缓存**，
  // 结果取决于这台机器上次跑过什么 —— 上一次运行的残留会让断言失败。
  const source = read('verify/service.test.mjs')
  const sites = [...source.matchAll(/createDashboardService\(/g)]
  assert.ok(sites.length >= 2, `没解析到构造点（${sites.length}），正则可能失效了`)
  for (const match of sites) {
    const window = source.slice(match.index, match.index + 400)
    assert.match(window, /noPersistence\(\)|persistence\)/, '构造服务时必须显式传入持久化实现')
  }
})

console.log(`\n${passed} 项通过（manifest）`)
