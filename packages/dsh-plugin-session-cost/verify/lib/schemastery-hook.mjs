/**
 * 仅用于离线测试：把 `@deepseek-ai/schemastery` 指到本机已安装的实现。
 *
 * 插件本身对它是 best-effort 动态导入（解析不到就没有 Config schema，功能不受影响），
 * 这里只是让「Config 能解析出默认值」这条断言在本机跑得起来：
 *   - 优先用安装到仓库 node_modules 的那份（pnpm 装 peer 时会有）；
 *   - 否则用 dsh profile 里那份；
 *   - 都没有就交回 Node，由 index.js 的 try/catch 兜住（测试里跳过该条断言）。
 */
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const CANDIDATES = [
  process.env.DSH_SCHEMASTERY,
  join(here, '..', '..', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
  join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
  join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
].filter((value) => typeof value === 'string' && value !== '')

const target = CANDIDATES.find((candidate) => existsSync(candidate))

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery') {
    // 找不到实现时交回 Node：import 会以 ERR_MODULE_NOT_FOUND 失败，被 index.js 的
    // try/catch 吞掉 → Config 为 undefined → 测试里跳过该条断言（CI 上就是这个路径）
    if (target === undefined) return nextResolve(specifier, context)
    return { url: pathToFileURL(target).href, shortCircuit: true, format: 'module' }
  }
  return nextResolve(specifier, context)
}
