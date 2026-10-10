/**
 * 复刻宿主 `readPluginMeta`（在 Desktop 的 app.asar / `@deepseek-ai/dsh-app-boot` 里）的语言文件规则，
 * 校验本插件的显示名在「设置 → 插件」里会解析成中文。
 *
 * 宿主规则（原文照抄自 app.asar）：
 *   const englishPath = optionalResourcePath(`${specifier}/locale/en.json`, parentURL)
 *   // 遍历 dirname(englishPath) 下所有 *.json，文件名必须是语言 id
 *   const meta = parsed.meta === undefined ? undefined : objectOf(parsed.meta, `${file}: meta`)
 *   dictionaries.set(id, { title: textOf(meta?.title), description: textOf(meta?.description) })
 *   // 字段缺失 → 回落 manifest.name / manifest.description；有字典则 { en: fallback, ...entries }
 *
 * 运行：node verify/plugin-meta.test.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const PACKAGE = 'dsh-plugin-session-cost'
const profileDir = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const packageDir = join(here, '..')
/**
 * 宿主有两条读取路径，都要覆盖：
 *  1) plugin-manager 列 bundle：parentURL = <bundle 目录>/package.json（link: 安装时是符号链接）
 *  2) dsh-host-plugin-inventory（插件页用）：parentURL = loader base（profile 目录）+ 裸包名
 * 在没有 dsh profile 的环境（CI）里，退回「包自身目录」——Node 的 package 自引用同样要求
 * `exports` 暴露 `./locale/*.json`，所以形状错误照样会被这三条基准里的任意一条抓到。
 */
const BASE_CANDIDATES = [
  { label: 'bundle 目录基准（plugin-manager）', url: pathToFileURL(join(profileDir, 'node_modules', PACKAGE, 'package.json')).href },
  { label: 'loader base 基准（plugin-inventory）', url: pathToFileURL(join(profileDir, 'package.json')).href },
  { label: '包自身目录（无 profile 时的自引用）', url: pathToFileURL(join(packageDir, 'package.json')).href },
]

const objectOf = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value
}
const textOf = (value, path) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`)
  return value
}
const fallbackText = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined)
const LANGUAGE_ID = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u

/** 宿主 readPluginMeta 的本地复刻（只保留文字部分）。 */
function readPluginMeta(specifier, parentURL) {
  const requireFromBase = createRequire(parentURL)
  let englishPath
  try {
    englishPath = requireFromBase.resolve(`${specifier}/locale/en.json`)
  } catch {
    englishPath = undefined
  }
  const dictionaries = new Map()
  if (englishPath !== undefined) {
    for (const entry of readdirSync(dirname(englishPath), { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue
      const language = entry.name.slice(0, -5)
      assert.ok(LANGUAGE_ID.test(language), `${entry.name} 必须是语言 id 作为文件名`)
      const file = requireFromBase.resolve(`${specifier}/locale/${entry.name}`)
      assert.equal(dirname(file), dirname(englishPath), '所有语言文件必须与 en.json 同目录')
      const parsed = objectOf(JSON.parse(readFileSync(file, 'utf8')), file)
      const meta = parsed.meta === undefined ? undefined : objectOf(parsed.meta, `${file}: meta`)
      dictionaries.set(language.toLowerCase(), {
        title: textOf(meta?.title, `${file}: meta.title`),
        description: textOf(meta?.description, `${file}: meta.description`),
      })
    }
  }
  const manifest = JSON.parse(readFileSync(requireFromBase.resolve(`${specifier}/package.json`), 'utf8'))
  const localizedText = (field, fallback, finalFallback) => {
    const entries = [...dictionaries].flatMap(([language, fields]) => {
      const value = fields[field]
      return value === undefined ? [] : [[language, value]]
    })
    if (entries.length === 0) return fallback
    return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
  }
  const title = localizedText('title', fallbackText(manifest?.name), specifier)
  const description = localizedText('description', fallbackText(manifest?.description), '')
  const text = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
  if (title === undefined && description === undefined) return undefined
  return text
}

/** 选一个能真正解析出本包的基准：有 dsh profile 时优先 profile 那两条，CI 上退到包自身。 */
function pickBase() {
  for (const candidate of BASE_CANDIDATES) {
    try {
      const resolved = createRequire(candidate.url).resolve(`${PACKAGE}/locale/en.json`)
      return { ...candidate, englishPath: resolved, meta: readPluginMeta(PACKAGE, candidate.url) }
    } catch {
      // 该基准解析不到（例如 CI 上没有 dsh profile），试下一个
    }
  }
  throw new Error(`所有解析基准都失败：${BASE_CANDIDATES.map((b) => b.label).join(' / ')}`)
}

const primary = pickBase()
const meta = primary.meta
const resolvedBases = BASE_CANDIDATES.map((candidate) => ({
  ...candidate,
  ok: (() => {
    try {
      createRequire(candidate.url).resolve(`${PACKAGE}/locale/en.json`)
      return true
    } catch {
      return false
    }
  })(),
}))

check('宿主能从读取基准解析 `<包名>/locale/en.json` 与 package.json（exports 必须暴露）', () => {
  assert.ok(/[\\/]locale[\\/]en\.json$/.test(primary.englishPath), primary.englishPath)
  assert.ok(createRequire(primary.url).resolve(`${PACKAGE}/package.json`).endsWith('package.json'))
  console.log(`#   命中基准：${primary.label}；可用基准 ${resolvedBases.filter((b) => b.ok).length}/${resolvedBases.length}`)
})

check('语言文件形状正确：每个 *.json 都是 { meta: { title, description } }', () => {
  const dir = dirname(primary.englishPath)
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.ok(files.length >= 2, '至少要 en.json 与 zh.json')
  for (const name of files) {
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    assert.ok(parsed.meta && typeof parsed.meta.title === 'string' && parsed.meta.title.trim() !== '', `${name} 缺 meta.title`)
    assert.ok(typeof parsed.meta.description === 'string' && parsed.meta.description.trim() !== '', `${name} 缺 meta.description`)
  }
})

check('解析结果：中文显示名来自 locale/zh.json，英文来自 locale/en.json', () => {
  assert.ok(meta !== undefined, 'readPluginMeta 不应返回 undefined（否则列表里只能显示包名）')
  assert.equal(meta.title.zh, '会话消费统计')
  assert.equal(meta.title.en, 'Session Cost')
  assert.notEqual(meta.title.zh, PACKAGE, '中文名不能回落到包名')
  assert.ok(typeof meta.description.zh === 'string' && meta.description.zh.includes('会话'))
})

check('每一条可用基准都得到同样的中文名（plugin-manager 与插件页两条路径）', () => {
  for (const candidate of resolvedBases) {
    if (!candidate.ok) {
      console.log(`#   跳过不可用基准：${candidate.label}`)
      continue
    }
    const resolved = readPluginMeta(PACKAGE, candidate.url)
    assert.equal(resolved?.title?.zh, '会话消费统计', `${candidate.label} 未得到中文名`)
    assert.equal(resolved?.title?.en, 'Session Cost', `${candidate.label} 未得到英文名`)
  }
})

check('中文名不含 ASCII 包名残影，且描述中文可用', () => {
  assert.ok(!/[a-z]{4,}/i.test(meta.title.zh), `中文名应无英文残留：${meta.title.zh}`)
  assert.ok(meta.description.zh.length >= 8, meta.description.zh)
})

console.log(`\n${passed} checks passed`)
