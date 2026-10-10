/**
 * 仅用于本机离线测试：把 `@deepseek-ai/schemastery` 指到已安装 profile 的真实实现。
 *
 * Host 插件被装进 profile 后，这个裸包由 profile 的 node_modules 解析；但工作区里的
 * 独立测试脚本从插件目录向上找不到它，所以在测试时用一个 resolve hook 兜住。
 * 生产路径（profile 内加载）完全不受影响。
 */
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CANDIDATES = [
  process.env.DSH_SCHEMASTERY,
  join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
  join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
].filter((value) => typeof value === 'string' && value !== '')

const target = CANDIDATES.find((candidate) => existsSync(candidate))

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery') {
    if (target === undefined) {
      throw new Error('找不到 @deepseek-ai/schemastery 的真实实现：请设置 DSH_SCHEMASTERY 环境变量')
    }
    return { url: pathToFileURL(target).href, shortCircuit: true, format: 'module' }
  }
  return nextResolve(specifier, context)
}
