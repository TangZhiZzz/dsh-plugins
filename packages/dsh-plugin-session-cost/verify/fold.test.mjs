/**
 * 纯逻辑单测：token 归一化、价目匹配、高峰/空闲判定、会话折叠与金额。
 *
 * 运行（在包目录内）：node verify/fold.test.mjs
 * 或经 workspace：pnpm -C packages/dsh-plugin-session-cost test
 */

import assert from 'node:assert/strict'
import {
  Config,
  normalizeConfig,
  tokensOf,
  rateFor,
  tierOf,
  computeCost,
  foldSession,
} from '../index.js'

let passed = 0
let skipped = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}
function skip(name, why) {
  skipped += 1
  console.log(`skip - ${name}（${why}）`)
}

const cfg = normalizeConfig(undefined)

// 由 PowerShell 核对过的北京时间基准点（epoch ms）
const PEAK_FRI_10 = 1791511200000 // 2026-10-09(周五) 10:00 +08 → 高峰
const OFF_FRI_22 = 1791554400000 // 2026-10-09(周五) 22:00 +08 → 空闲
const OFF_SAT_10 = 1791597600000 // 2026-10-10(周六) 10:00 +08 → 空闲

// Config 的 schema 只在能解析到 @deepseek-ai/schemastery 时才构造（插件本身是 best-effort：
// 解析不到就没有 schema，配置走原始对象 + normalizeConfig 收敛）。CI 上没有 dsh profile，跳过。
if (typeof Config === 'function') {
  check('Config 断言可解析出完整默认值', () => {
    const resolved = Config({})
    assert.equal(resolved.currency, 'CNY')
    assert.equal(resolved.decimals, 4)
    assert.equal(resolved.rates['deepseek-flash'].cacheMiss, 2)
    assert.deepEqual(resolved.peakWeekdays, [1, 2, 3, 4, 5])
  })
} else {
  skip('Config 断言可解析出完整默认值', '当前环境没有 @deepseek-ai/schemastery，Config 为 undefined（插件按原始 config 工作）')
}

check('normalizeConfig 回落默认值', () => {
  assert.equal(cfg.currency, 'CNY')
  assert.equal(cfg.offPeakFactor, 0.5)
  assert.deepEqual(cfg.peakWeekdays, [1, 2, 3, 4, 5])
  assert.equal(cfg.rates['deepseek-flash'].cacheMiss, 2)
  assert.equal(cfg.refreshMs, 5000)
})

check('tokensOf：DeepSeek 语义（input 不含缓存命中）', () => {
  const t = tokensOf({ inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100, totalTokens: 10100 })
  assert.deepEqual(t, { cacheHit: 9000, cacheMiss: 1000, cacheWrite: 0, output: 100, total: 10100 })
})

check('tokensOf：其它 provider 语义（input 已含缓存命中）自洽纠正', () => {
  const t = tokensOf({ inputTokens: 10000, cacheReadTokens: 9000, outputTokens: 100, totalTokens: 10100 })
  assert.equal(t.cacheMiss, 1000)
  assert.equal(t.cacheHit, 9000)
})

check('tokensOf：缺失字段按 0 处理', () => {
  const t = tokensOf({ inputTokens: 5 })
  assert.deepEqual(t, { cacheHit: 0, cacheMiss: 5, cacheWrite: 0, output: 0, total: 5 })
})

check('tierOf：高峰 / 工作日夜间 / 周末', () => {
  assert.equal(tierOf(PEAK_FRI_10, cfg), 'peak')
  assert.equal(tierOf(OFF_FRI_22, cfg), 'offPeak')
  assert.equal(tierOf(OFF_SAT_10, cfg), 'offPeak')
})

check('tierOf：holidays 里的日期整天按空闲', () => {
  const holidayCfg = normalizeConfig({ holidays: ['2026-10-09'] })
  assert.equal(tierOf(PEAK_FRI_10, holidayCfg), 'offPeak')
})

check('tierOf：12:00-14:00 午休按空闲', () => {
  const lunch = Date.parse('2026-10-09T13:00:00+08:00')
  assert.equal(tierOf(lunch, cfg), 'offPeak')
})

check('rateFor：精确 → 前缀 → 未定价', () => {
  assert.equal(rateFor('deepseek-flash', cfg.rates).pattern, 'deepseek-flash')
  assert.equal(rateFor('deepseek-v4.1-flash-expires-on-0910', cfg.rates).pattern, 'deepseek-v4.1-flash*')
  assert.equal(rateFor('deepseek-v4-pro', cfg.rates).rate.output, 27)
  assert.equal(rateFor('some-unknown-model', cfg.rates), undefined)
})

check('rateFor：`*` 兜底', () => {
  const rates = { '*': { cacheHit: 1, cacheMiss: 1, output: 1 } }
  assert.equal(rateFor('anything', rates).pattern, '*')
})

check('computeCost：高峰价（deepseek-flash 官方价）', () => {
  // 9000 命中 × 0.04 + 1000 未命中 × 2 + 100 输出 × 8 = 0.00316 元
  const cost = computeCost({ cacheHit: 9000, cacheMiss: 1000, cacheWrite: 0, output: 100 }, cfg.rates['deepseek-flash'], 1)
  assert.equal(Number(cost.toFixed(8)), 0.00316)
})

check('computeCost：空闲价 = 高峰 × 0.5', () => {
  const cost = computeCost({ cacheHit: 9000, cacheMiss: 1000, cacheWrite: 0, output: 100 }, cfg.rates['deepseek-flash'], 0.5)
  assert.equal(Number(cost.toFixed(8)), 0.00158)
})

check('foldSession：跳过 inherited 事件、按模型/时段计价、未定价单独计数', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100, totalTokens: 10100 }
  const assistant = (time, model, u = usage) => ({
    type: 'assistant/message',
    seq: 1,
    time,
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model } }, usage: u, stream: [] },
  })
  const snapshot = {
    // 第一条是承接自父会话的种子事件：必须完全不计入
    inheritedEventCount: 1,
    events: [
      assistant(PEAK_FRI_10, 'deepseek-flash'),
      { type: 'session/title', seq: 2, time: PEAK_FRI_10, data: { title: '标题来自日志', messageSeqs: [1], source: { kind: 'fallback' } } },
      assistant(PEAK_FRI_10, 'deepseek-flash'),
      assistant(OFF_FRI_22, 'deepseek-v4.1-flash-expires-on-0910'),
      assistant(PEAK_FRI_10, 'some-unknown-model'),
      { type: 'web/deepseek-search-llm-request', seq: 3, time: PEAK_FRI_10, data: {} },
      { type: 'user/message', seq: 4, time: PEAK_FRI_10, data: { message: { role: 'user', content: [{ type: 'text', text: '  你好   世界 ' }] } } },
    ],
  }
  const acc = foldSession(snapshot, cfg)

  assert.equal(acc.calls, 3, '两次计价调用 + 一次未定价调用')
  assert.equal(acc.pricedCalls, 2)
  assert.equal(acc.unpricedCalls, 1)
  assert.deepEqual(acc.unpricedModels, ['some-unknown-model'])
  assert.equal(acc.usageMissingCalls, 0)
  // 0.00316（高峰）+ 0.00158（空闲，前缀匹配同一张 flash 价）
  assert.equal(Number(acc.cost.toFixed(8)), 0.00474)
  // 金额按 token 桶拆开
  assert.equal(Number(acc.costs.cacheHit.toFixed(8)), Number(((9000 * 0.04) / 1e6 * 1 + (9000 * 0.04) / 1e6 * 0.5).toFixed(8)))
  assert.equal(Number(acc.costs.output.toFixed(8)), Number(((100 * 8) / 1e6 * 1 + (100 * 8) / 1e6 * 0.5).toFixed(8)))
  // token 汇总包含未定价那次（token 是真的，只是没价）
  assert.equal(acc.tokens.cacheHit, 27000)
  assert.equal(acc.tokens.cacheMiss, 3000)
  assert.equal(acc.tokens.output, 300)
  assert.equal(acc.tokens.total, 30300)
  // 标题与首条用户消息
  assert.equal(acc.titleFromLog, '标题来自日志')
  assert.equal(acc.firstUserText, '你好 世界')
  // 辅路调用计数
  assert.equal(acc.aux.search, 1)
  // 时间边界只从被处理的事件里取
  assert.equal(acc.firstTime, PEAK_FRI_10)
  assert.equal(acc.lastTime, PEAK_FRI_10)
  // 分模型明细
  assert.equal(acc.byModel['deepseek-flash'].priced, true)
  assert.equal(acc.byModel['deepseek-flash'].tiers.peak, 1)
  assert.equal(acc.byModel['deepseek-v4.1-flash-expires-on-0910'].tiers.offPeak, 1)
  assert.equal(acc.byModel['some-unknown-model'].unpricedCalls, 1)
})

check('foldSession：usage 缺失时只计数、不猜价', () => {
  const snapshot = {
    inheritedEventCount: 0,
    events: [{
      type: 'assistant/message',
      seq: 1,
      time: PEAK_FRI_10,
      data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'deepseek-flash' } }, stream: [] },
    }],
  }
  const acc = foldSession(snapshot, cfg)
  assert.equal(acc.calls, 1)
  assert.equal(acc.usageMissingCalls, 1)
  assert.equal(acc.pricedCalls, 0)
  assert.equal(acc.cost, 0)
})

check('foldSession：usage 藏在 stream 末尾 chunk 里也能取到', () => {
  const snapshot = {
    inheritedEventCount: 0,
    events: [{
      type: 'assistant/message',
      seq: 1,
      time: PEAK_FRI_10,
      data: {
        message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'deepseek-flash' } },
        stream: [
          { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, totalTokens: 2 } } },
          { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100, totalTokens: 10100 } } },
        ],
      },
    }],
  }
  const acc = foldSession(snapshot, cfg)
  assert.equal(acc.tokens.cacheMiss, 1000)
  assert.equal(Number(acc.cost.toFixed(8)), 0.00316)
})

check('normalizeConfig：非法价目条目被丢弃并告警，不静默按 0 计价', () => {
  const bad = normalizeConfig({
    rates: {
      good: { cacheHit: 1, cacheMiss: 2, output: 3 },
      bad: { cacheHit: 'x', cacheMiss: 2, output: 3 },
      worse: 5,
    },
  })
  assert.deepEqual(Object.keys(bad.rates), ['good'])
  assert.equal(bad.warnings.length, 2)
  assert.equal(rateFor('bad', bad.rates), undefined)
})

check('normalizeConfig：全部条目非法时价目表为空且告警', () => {
  const bad = normalizeConfig({ rates: { only: { cacheHit: 1 } } })
  assert.deepEqual(Object.keys(bad.rates), [])
  assert.equal(bad.warnings.length, 2)
  assert.equal(bad.warnings[1], '价目表为空：所有模型都会记为「未定价」')
})

check('normalizeConfig：非法时区回落并告警', () => {
  const bad = normalizeConfig({ timeZone: 'Not/AZone' })
  assert.equal(bad.timeZone, 'Asia/Shanghai')
  assert.equal(bad.warnings.length, 1)
})

console.log(`\n${passed} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''}`)
