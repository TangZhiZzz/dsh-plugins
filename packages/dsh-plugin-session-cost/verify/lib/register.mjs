/** 注册上面的 resolve hook（用法：node --import ./verify/lib/register.mjs verify/fold.test.mjs）。 */
import { register } from 'node:module'

register('./schemastery-hook.mjs', import.meta.url)
