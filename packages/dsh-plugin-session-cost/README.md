# dsh-plugin-session-cost

按**会话**统计 token 用量与消费金额的 DSH 插件：输入框下方一行实时徽标显示当前会话花了多少，
设置页多出一页「会话消费」，把**每个会话**（含已归档的历史会话）的花费列成一张表。

- 数据来自已提交的会话日志（`ctx.sessionQuery`），不是内存估算，可重放、可核对；
- 金额按 DeepSeek 官方公开价目表估算，**高峰/空闲时段自动区分**，价目表可在 Config 里整体替换；
- 官方日志里没有 token 用量的辅路调用（标题生成、联网搜索）只计数不计价，并在界面上说明。

```
输入框下方：  ¥0.0571          （与宿主 token 用量表同款的窄触发按钮：13px / 三级文字色 / 悬停与展开同底色）
浮层（点空白处或 Esc 关闭）：本次会话消费            ¥0.0571    ← 表头：标题左、数字右（tabular-nums，weight 500）
                            ▂▂▂▂▂▂▂▂▂▂▂▂▂        ← 4px 组成条：命中/未命中/输出三段
                            输入·缓存命中  141K · ¥0.0057
                            输入·未命中    14.1K · ¥0.0282
                            输出           2.7K · ¥0.0218
                            23 次调用 · 1.58M tokens
                            模型：deepseek-v4-flash
设置 → 会话消费：总额 + 每个会话一行（标题 / 目录 / 调用 / 命中 / 未命中 / 输出 / 金额，可按金额或时间排序、可过滤）
```

**观感刻意与宿主 composer dock 的 token 用量表（`@deepseek-ai/dsh-client-ui-conversation` 的 `ContextMeter`）对齐**，
规格逐条取自它的 `ContextMeter.module.css`：

| 部位 | 对齐做法 |
|---|---|
| 触发按钮 | `--dsh-content-font-size-secondary,13px`、`--dsh-content-font-delta-secondary` 行高、`--dsw-radius-sm`、`--dsw-alias-label-tertiary`、`padding:1px 8px`、`gap:6px`、tabular-nums；`:hover` 与 `[aria-expanded=true]` 都用 `--dsw-alias-interactive-bg-hover` |
| 面板 | `width:min(264px,100vw - 24px)`、`--dsw-radius-lg`、`--dsw-specific-menu`、`--dsw-menu-backdrop-filter`、`--dsw-elevation-prominent`、`z-index:1100`、`padding:12px`、`12px/20px` 字 |
| 组成条 | 宿主同款 4px 轨道（`--dsw-alias-interactive-bg-hover`、`border-radius:999px`、`gap:1px`）+ 沿用它的 `--meter-tint` 分段约定与同一组静态色 |
| 行 | `dt` 二级文字色、`dd` 一级文字色 + tabular-nums，`justify-content:space-between`、`gap:12px`、`padding:2px 0` |
| 数字 | 宿主同款紧凑格式：`<1000` 原样、`<1e6` 用 **K**、否则 **M**，且 ≥100 时取整、否则一位小数 |

弹框挂在宿主自带的 `shell.overlay`（"Frame-wide floating layer … the layer itself is click-through — entries opt back into pointer events"），
所以既不会被输入框容器裁剪，也不会挡住页面其它交互；面板**没有关闭按钮**，只靠「点面板外」或 **Esc** 关闭（透明背板负责接住外部点击，面板内部点击被吞掉），定位规则与宿主一致（贴顶 8px、离边 12px）。

---

## 5. 插件列表里的显示名（中文）

「设置 → 插件」里的名字来自包内语言文件，宿主实现是 `readPluginMeta(specifier, parentURL)`
（`@deepseek-ai/dsh-app-boot`；Desktop 的 app.asar 里那份规则完全相同）：

```js
const englishPath = resolve(`${specifier}/locale/en.json`)        // 需要 exports 暴露 ./locale/*.json
// 遍历同目录全部 *.json（文件名必须是语言 id），读的是 parsed.meta 这一层
const meta = parsed.meta;  dictionaries.set(lang, { title: meta?.title, description: meta?.description })
// 字段缺失才回落 package.json 的 name / description
```

所以 `locale/zh.json` 必须是：

```json
{ "meta": { "title": "会话消费统计", "description": "…" } }
```

顶层写 `title` 会让字典取不到值 → 回落成**包名** `dsh-plugin-session-cost`（这就是之前列表里显示英文名的原因）。
现在的文件形状与已发布的第三方插件（如 `dsh-plugin-whale-pet`）一致。
`verify/plugin-meta.test.mjs` 会复刻上面两条读取路径（bundle 目录基准 + 插件页 `plugin-inventory` 的 loader base 基准）
各跑一遍，确认中文名与英文名都能解析出来 —— `plugin_manager list_bundles` 返回的是裁剪字段、看不到 `meta`，不能拿它验证。

改完刷新页面即可（插件页的 inventory 每次调用都重新读元数据，不用重启 Harness）。

---

## 6. 金额怎么算出来的

| 口径 | 取值 |
|---|---|
| 计价事件 | `assistant/message` 的 `usage`（provider 真实上报）；缺失时取该消息 `stream` 里最后一个 `usage` chunk |
| 输入·缓存命中 | `usage.cacheReadTokens` |
| 输入·未命中 | `usage.inputTokens`（DeepSeek 语义：不含缓存命中。若某 provider 的 `inputTokens` 已含命中，插件用 `inputTokens+cacheReadTokens+outputTokens > totalTokens` 自洽纠正） |
| 输出 | `usage.outputTokens`（reasoning 已含在内，不重复计） |
| 模型 | `assistant/message.message.source.model`（价格按模型 id 匹配，支持 `前缀*` 与 `*` 兜底） |
| 时间段 | 按调用事件自带的 `time` + `timeZone`（默认 `Asia/Shanghai`）判定：周一至周五 `09:00-12:00`、`14:00-18:00` 为高峰，其余（含周末与 `holidays` 列出的法定节假日）按空闲计价，空闲价 = 高峰价 × `offPeakFactor`（官方为 0.5） |
| 不计价 | 模型不在价目表里 → 记「未定价」，token 照常统计但金额不累加（**不猜价、不按 0 静默计入**） |
| 不计入 | `inheritedEventCount` 之前的承接事件（fork/subagent 日志里从父会话复制的前缀）——token 花在父会话，避免重复计价 |

默认价目表（人民币 / 百万 tokens，**高峰时段价**，来源：DeepSeek 官方《模型 & 价格》）：

| 模型键 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.04 | 2 | 8 |
| `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` | 0.04 | 2 | 8 |
| `deepseek-v4.1-flash*`（含内测名 `deepseek-v4.1-flash-expires-on-0910`） | 0.04 | 2 | 8 |
| `deepseek-v4-pro` | 0.30 | 9 | 27 |
| `deepseek-chat` | 0.5 | 2 | 8 |
| `deepseek-reasoner` | 1 | 4 | 16 |

> 价格会变，也可能你走的是订阅/计划价而不是按量计费 —— 这张表是**默认值**，改它就在
> `cordis.patch.yml` 里按 `session-cost-plugin` 这个 id 覆盖 `config.rates`（见第 4 节）。

---

## 2. 安装（本机已经装好并生效）

```powershell
# 在本包目录（monorepo 里是 packages/dsh-plugin-session-cost）内
node --check index.js; node --check client.js
node -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8')); console.log('manifest ok')"

# 单元测试 / 显示名 / 渲染冒烟（等价于 pnpm test）
node verify/fold.test.mjs
node verify/plugin-meta.test.mjs
node verify/client.render.test.mjs

# 端到端对账（需要 Harness 在跑，端点可达）
python verify/verify_costs.py
```

安装（从 npm，或本目录的绝对路径）：

```
plugin_manager { action: "install_bundle", target: "dsh-plugin-session-cost" }          # npm
plugin_manager { action: "install_bundle", target: "<本包绝对路径>" }                     # 本地开发
```
看返回的 `application`：`applied` = 已生效（本机实测）；`restart-required` = 需重启 Harness；
`failed` = 看 `error.diagnostic`。

启停/卸载：

```
plugin_manager { action: "set_bundle",   target: "dsh-plugin-session-cost", enabled: false }
plugin_manager { action: "set_bundle",   target: "dsh-plugin-session-cost", enabled: true  }
plugin_manager { action: "remove_bundle", target: "dsh-plugin-session-cost" }
```

**注意本机的一个坑（已实测）**：`plugin_manager` 对「目录 target」用 pnpm 的 `link:` 协议，
插件运行时的真实路径仍在仓库里，Node 会从真实路径向上找 `node_modules` —— 于是
`profile` 里的 `@deepseek-ai/*` 解析不到。所以：

- 本插件**没有任何静态裸导入**，`@deepseek-ai/schemastery` 只在能解析到时才用于构造 Config 的
  schema（best-effort 动态导入）。解析不到时插件照常工作，配置走原始 `config` 对象，
  由 `normalizeConfig` 做默认值与收敛（非法价目条目会被丢弃并告警，不会静默按 0 计价）。
- 这也意味着本机 `cordis_inspect_query → Config.listConfigs` 里本条目的 `status` 是 `absent`
  （没有可投影的 schema），属于预期，不影响功能。
- 该插件当前生效的 profile 是 **desktop**（`~/.dsh/profiles/desktop`），不是 `web`。

---

## 3. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `currency` / `symbol` / `decimals` | `CNY` / `¥` / `4` | 展示用 |
| `timeZone` | `Asia/Shanghai` | 峰谷判定时区（非法值会回落并告警） |
| `peakWeekdays` | `[1,2,3,4,5]` | 高峰星期（1=周一） |
| `peakWindows` | `['09:00-12:00','14:00-18:00']` | 高峰窗口 |
| `offPeakFactor` | `0.5` | 空闲价系数 |
| `holidays` | `[]` | 法定节假日 `YYYY-MM-DD`，整天按空闲 |
| `rates` | 见上表 | 模型 → 高峰单价；键以 `*` 结尾表示前缀匹配，`*` 为兜底 |
| `refreshSeconds` | `5` | 服务端重算与页面轮询间隔 |
| `persistedCacheSeconds` | `600` | 已归档会话折叠结果缓存（归档日志不再变，避免反复解压） |
| `includeSubagents` | `true` | 是否统计 `origin=subagent` 的子会话 |

## 4. 改价

`cordis.patch.yml` 里按 id 覆盖（**`config` 是整体替换、不深合并**，覆盖 `rates` 就要写全整张表）：

```yaml
- id: session-cost-plugin
  config:
    symbol: '¥'
    offPeakFactor: 0.5
    holidays: ['2026-10-01', '2026-10-02']
    rates:
      deepseek-flash: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
      deepseek-v4-pro: { cacheHit: 0.3, cacheMiss: 9, output: 27 }
      '*': { cacheHit: 0.04, cacheMiss: 2, output: 8 }   # 兜底：不再出现「未定价」
```

---

## 5. 验证（本机实测证据）

| 验证 | 命令 | 结果 |
|---|---|---|
| Host/Client 语法 | `node --check index.js && node --check client.js` | 通过 |
| 纯逻辑单测（归一化、价目匹配、峰谷、折叠、金额拆分、非法配置） | `node verify/fold.test.mjs` | **18/18 通过**（没有安装 peer `@deepseek-ai/schemastery` 时最后 1 条会 skip，插件本身照常工作） |
| 显示名解析（复刻宿主 `readPluginMeta`，两条读取路径） | `node verify/plugin-meta.test.mjs` | **5/5 通过** —— 中文名 `会话消费统计` / 英文 `Session Cost`，不再回落包名 |
| 客户端渲染冒烟（真实 React 语义的迷你渲染器 + 真实端点数据） | `node verify/client.render.test.mjs` | **17/17 通过**（含窄徽标、点击弹框、无关闭按钮 + 点外部/Esc 关闭、**与宿主 token 用量表逐条同款的样式断言**、K/M 紧凑数字） |
| 端到端金额交叉验证（独立 Python 实现直接解 `~/.dsh/sessions/**/session*.jsonl.zstd`） | `python verify/verify_costs.py` | **28/28 会话逐项一致，PASS** |
| 槽位注册（Host/Client inspect） | `cordis_inspect_query` → client `Slots.listSubTree` | `conversation.composer.dock` 有 `session-cost-badge`、`shell.overlay` 有 `session-cost-popover`、`settings.section` 有 `session-cost`，均 `active: true` |
| 取数路由 | `GET /dsh-session-cost/summary` | HTTP 200，28 会话，`errors: []` |

交叉验证的口径差异说明：插件先把每个会话金额四舍五入到 6 位再求和，脚本不 round，
28 个会话累计差 `3.3e-06` 元（远小于 1e-4 容差）；除此之外 calls / cacheHit / cacheMiss /
output / 每个会话的 cost 全部逐项相等 —— 说明金额不是实现自说自话。

独立实现同时印证了一个日志事实：`session/end-seed` 只是日志里的区块标记，本机这些会话的
`inheritedEventCount` 都是 0，所以「全文件求和」与「插件按 inheritedEventCount 折叠」结果一致；
真正承接父会话前缀的 fork/subagent 会话由插件按 `inheritedEventCount` 排除（脚本会对这类行标注）。

**视觉验证不可用**：本会话没有浏览器控制能力，只验证了注册、数据与渲染语义；
输入框下方的样式间距、亮/暗主题、设置页滚动这些需要你刷新页面后人眼看一次。

---

## 6. 已知边界

- **只对 provider 上报 usage 的模型调用计价**。标题生成（`session/title-llm-request`）与联网搜索
  （`web/deepseek-search-llm-request`）在日志里没有 token 用量，插件只统计次数并在面板注明；
  如果你知道每次辅路调用的固定成本，可以自己把它加进预期，插件不猜。
- **未定价不等于免费**：价目表里没有的模型会以「未定价」标出，金额不累加（这是刻意的，避免假 0）。
- **金额是估算**：按官方公开价 × token 数，不含任何折扣/赠送余额/订阅计划抵扣；对账请以官方账单为准。
- **历史会话的 token 依赖日志完整**：日志被清理/截断过的会话，读到多少算多少。
- **性能**：活跃会话每次刷新读内存日志；已归档会话折叠结果按 `persistedCacheSeconds` 缓存，
  单飞（并发请求只算一次），磁盘读取并发上限 4。

---

## 7. 文件清单

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：`sessionQuery` 折叠 + 价目表 + `GET /dsh-session-cost/summary`（loopback/受信 Host 栅栏） |
| `client.js` | Client 半：`conversation.composer.dock` 窄徽标 + `shell.overlay` 明细弹框 + `settings.section` 面板（只用 `--dsw-alias-*` 主题 token） |
| `cordis.patch.yml` | bundle 补丁行 `session-cost-plugin`，也是改价的示例位置 |
| `package.json` / `locale/*.json` | manifest、显示文案（中/英） |
| `verify/fold.test.mjs` | 18 项纯逻辑单测 |
| `verify/plugin-meta.test.mjs` | 复刻宿主 `readPluginMeta` 校验「插件列表里的中文显示名」 |
| `verify/client.render.test.mjs` | 12 项客户端渲染冒烟测试（迷你 React 渲染器） |
| `verify/verify_costs.py` | 独立 Python 交叉验证（直读 `.jsonl.zstd`） |
| `verify/summary.json` | 本机端点响应的快照（**含真实会话标题，已 gitignore，也不进 npm 包**），渲染测试与对账用 |
| `verify/summary.sample.json` | 匿名样例快照，仓库内与无本机数据时使用 |
