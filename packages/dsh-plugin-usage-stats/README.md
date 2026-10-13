# dsh-plugin-usage-stats

> 显示名：**用量统计**；代码标识（npm 包名）：`dsh-plugin-usage-stats`
> npm 包名必须是 ASCII 小写，所以中文显示名另由 `locale/*.json` 的 `meta.title` 与面板文案决定。

把会话日志统计成一块用量面板，挂在 DSH Web UI 的左侧面板栏。

---

## 1. 面板结构

| 区块 | 内容 |
|---|---|
| **状态行** | 当前窗口 · 更新时间 · **聚合耗时** · 缓存复用数（把「快」直接显示出来，不用猜） |
| **指标卡 ×8** | 模型调用、总 Token（附命中/未命中/输出）、缓存命中率、工具调用、会话数（含活跃）、活跃天、平均每次调用 Token、日均调用（附峰值日） |
| **年度热力图** | 最近整整一年，一天一格，按**真实星期几**对齐（列＝周、行＝星期几，左侧标一/三/五），带月份刻度；悬停出当天明细与三段拆分 |
| **时段分布** | 24 小时柱状（窗口内），看惯常作息是几点 |
| **模型分布** | 按 Token 排名，带占比与调用数 |
| **工具使用 Top** | 按调用次数排名，带占比 |
| **会话排行** | 按 Token 排名，带「活跃天数 · 调用数」，活跃会话带绿点 |
| **会话花费** | 总金额 + 花费最高的几个会话（唯一不随窗口变化的区块） |
| **逐日明细** | 表格：日期 / 星期 / 调用 / 工具 / Token / 命中率，**只列有活动的天**，新的在上 |

时间范围按钮（`7 / 14 / 30 / 90 / 365 天`）在面板**最上方**——它决定整块面板的口径（年度热力图除外，它固定一年）。

### 年度热力图

- **列宽自适应 = 占满宽度**：`18px` 之外的列用 `minmax(5px, 1fr)` 均分容器宽度，格子高度用
  `aspect-ratio: 1` 跟着宽度走 —— 面板越宽格子越大（正方形），整块图也越高。
- **左侧留出 `26px` 给星期刻度**（一/三/五，右对齐贴住网格），不会挤到第一列格子上。
- **配色参考 GitHub 贡献图**：绿色渐变 5 档，绿色取主题的 `state-success` token，
  所以亮/暗主题自动跟随；0 档（当天没有用量）是最淡的一档，**不用中性灰** ——
  一年里大部分格子是空的，灰色会让整块面板发沉。
- 提示层渲染在**被悬停的那一格内部**，因此能精确跟随自适应后的格子；靠边自动内收。

## 2. 为什么快

这是 v0.2 重写的核心。

**v0.1 的做法**：折叠结果按「**窗口 + 会话**」缓存。于是每换一次时间范围，所有会话都要重新读日志、重新折叠（实测冷启动 7s、换窗口再 7s）。这是"慢"的根因。

**v0.2 的做法**：`foldSessionDaily()` 把每个会话**只折叠一次**，而且折成**与窗口无关的「天行」**：

```
天 → { 调用数, 工具数, token 三段, 24 小时计数, 各模型, 各工具 }
```

任何窗口（7/30/90/365 天）都只是在这些天行上做一次聚合（`aggregate()`），**不碰日志**。于是：

- **切窗口几乎不花时间**（测试直接钉住：切 7→30→90→365，`readSession` 调用次数保持 2 不变）；
- 年度热力图、逐日明细、小时分布、模型/工具排行全部来自同一份天行，**零额外读取**；
- 归档会话的日志不再变化 → 天行按 `foldCacheSeconds`（默认 **6 小时**）长期复用；活跃会话按 `liveFoldSeconds`（默认 5s，实测重折只要 13–20ms）短 TTL 重折；
- 载荷本身按 `refreshSeconds`（默认 10s）缓存 + 单飞，多页面同时轮询只算一次；
- 同一个会话的**并发折叠去重**（`folding`）：后台预热与面板请求撞在一起时只读一次、只折一次。

### 实测（本机 31 个会话）

| 场景 | 耗时 | 说明 |
|---|---|---|
| **冷缓存**（全部要读+折） | **7244ms** | 折叠 31 / 复用 0 —— 这是唯一的慢路径 |
| 热缓存（同窗口重复） | 15–25ms | 载荷缓存 |
| 切时间范围 | 57–88ms | 折叠 0 / **复用 31** |
| 活跃会话重折 | 13–20ms | 超过 `liveFoldSeconds` 后 |
| 聚合本身 | **1–2ms** | 只与活跃天数有关，与日志长度无关 |

所以「慢」只剩**冷缓存**这一条。而面板是**打开时才发请求**的 —— 打开面板就等于撞冷启动。

### 针对冷启动的三项优化

1. **后台预热**（`warmUpOnStart`，默认开）：插件激活 `warmUpDelaySeconds` 秒后在后台把天行折叠做完，
   于是你打开面板时缓存已经是热的（7.2s → 15–25ms）。预热失败只记一条 warning，不影响任何功能。
2. **归档天行缓存放宽到 6 小时**：归档日志不会再变，这一项让冷路径只在「进程重启 / 出现新会话」时才发生。
3. **并发折叠去重**：预热与面板请求同时发生时共享同一次读+折，不重复做功；预热正好没做完时，
   面板请求只需要等**剩余**部分。

客户端也修了一处：**看板数据与金额两条请求改为并行发送，且不等金额** —— 之前是串行 await 两条，
首屏每次都要等最慢的那条（session-cost 冷的时候约 750ms）。

状态行里的 `聚合 Nms · 复用 X/Y · 磁盘 N` 就是这件事的运行时证据：
**预热生效后，第一次打开面板应该看到 `复用 31/31`**。

### 磁盘缓存：连「重启后的第一次」也不用等

上面的预热是把 7 秒挪到后台，但进程刚起来那几秒打开面板仍会等。要做到**重启后第一次打开也秒开**，
就必须跨进程复用天行 —— 而这里有个前提问题：**凭什么认为缓存还没过期？**

`SessionHeader` 里**没有任何版本号/更新时间/事件数**，所以 `listSessions()` 给不出「这个日志变了没」的
廉价凭据。但 `SessionRecord` 里有 `live`：

```ts
SessionRecord = { header, live: boolean, persisted: boolean }
```

**非 live = 只在磁盘上、没有进程在追加写** —— 它的日志不再变化，所以天行跨进程复用是**正确的**，
不是「拿陈旧换速度」。真正在变的那个（活跃会话）照旧每次重折（实测 13–20ms）。

- 只缓存**非 live** 会话；活跃会话的条目从不写盘、也从不读盘；
- 会话被**恢复**时会变成 live → 那份缓存自然失效重折；
- 万一进程在「已恢复、但新天行还没落盘」之间被杀，磁盘上会留一份旧数据 —— 所以再加一层
  **后台轮转校验**（`revalidateSeconds`，默认 30 秒校验一个条目），把数字逐步收敛到最新。
  状态行里的 `磁盘 N` 就是「还剩几个条目没校验」，会自己降到 0。

**落点**：系统临时目录里的一个纯缓存文件（`foldCachePath()`），不写工作区、不污染仓库，
系统自己也会清。取不到路径就自动关闭持久化。

**磁盘缓存是不受信任的输入**（可能是旧版本写的、被改坏的、写了一半的），而 `aggregate` 信任天行的
形状，所以装载前用 `isUsableFold()` 验到「aggregate 不会炸」为止；验不过就丢弃该条、退回读日志。
这条有测试钉住：坏缓存**不能把面板搞崩**。

测试还用一件事证明缓存是无损的：把落盘内容真的过一遍 `JSON.parse(JSON.stringify(...))` 再装载，
与直接从日志折叠的载荷逐字段比对（总量 / 逐日 / 年度 / 小时 / 模型 / 工具 / 会话排行全都要一致）。

## 3. 数据从哪来

### Token / 模型 / 工具 / 天 / 小时：会话日志（本插件自算）

| 步骤 | 用什么 |
|---|---|
| 列出会话 | `ctx.sessionQuery.listSessions()`（活跃 + 已归档，newest-first） |
| 读回日志 | `ctx.sessionQuery.readSession(id)` |
| Token | `assistant/message` 事件里的 `usage`（**provider 真实上报**）与 `message.source.model` |
| 工具 | `tool/call` 事件的 `name` |
| 天 / 小时 | `Intl.DateTimeFormat` 按 `Config.timeZone` 落桶（小时用 `hourCycle: 'h23'`，午夜是 0 点不是 24 点） |

token 语义按 DeepSeek / OpenAI 报文：

```
inputTokens     = 不含缓存命中的输入（即未命中）
cacheReadTokens = 缓存命中输入
outputTokens    = 输出（reasoning 已含在内，不重复计）
```

少数 provider 把命中算进 `inputTokens`，本插件会做一次自洽纠正（`input + hit > total` 时按
`total - hit` 重算未命中），以免重复计数。

fork / 子会话承接自父会话的事件段（`inheritedEventCount` 之前）整段跳过：那些 token 花在父会话里，
重复计会让总量虚高。

**小时分布的 token 是摊分出来的**：日志里 usage 只按消息给，没有逐条小时级 token。本插件把当天的
token 按「当天该小时的调用数占比」摊到小时上 —— 这是唯一不重不漏的口径，调用次数则是精确值。

### 金额：**不自己算**，读 dsh-plugin-session-cost

金额需要一个价目表，而 dsh-plugin-session-cost 已经持有它并在维护。本插件再抄一份，两个插件显示的
钱迟早不一样 —— 那比少显示一块更糟。所以 Client 半直接 `fetch('/dsh-session-cost/summary')`：

- 装了 session-cost → 显示总金额 + 会话花费排行；
- 没装 / 请求失败 → **不显示金额卡片**，其余统计照常。

`manifest.test.mjs` 有一条断言钉住这件事：Host 半与 `metrics.js` 不得出现价目表的键
（`cacheHit:` / `cacheMiss:`）。

## 4. 安装

```
plugin_manager { action: "install_bundle", target: "<本包的绝对目录>" }
```

或：

```bash
dsh plugin --profile <profile 名> install dsh-plugin-usage-stats
```

> ⚠️ 不要手写 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录跑 pnpm。

### ⚠️ 改了 Host 半必须重启 DSH 进程

Node 的 ESM 模块按 specifier 缓存，`plugin_manager set_bundle` 只会重新 `apply`、**不会重新
`import` 同一个包名** —— 线上仍跑旧模块（实测：改完 `index.js` 后路由载荷完全没有新字段）。
换包名会强制新 import。

- 改 **Host 半**（`index.js` / `metrics.js`）→ **重启应用**才生效；
- 改 **Client 半**（`client.js`）→ 刷新页面即可。

两半的载荷契约是配套的：**先重启再刷新**，否则新客户端会读到旧 Host 的载荷（缺 `year` / `hours`
等字段，热力图和时段图会显示"无数据"）。

## 5. 配置

| 字段 | 默认 | 作用 |
|---|---|---|
| `days` | `14` | 默认时间范围天数（页面用 `?days=` 覆盖），1–365 |
| `maxSessions` | `100` | 最多统计多少个会话（newest-first），1–1000 |
| `topN` | `8` | 模型 / 工具 / 会话排行各列前几名，1–50 |
| `timeZone` | `Asia/Shanghai` | 把事件落到「天」「小时」所用时区（非法值回落 UTC，不报错） |
| `includeSubagents` | `false` | 是否把子会话（`origin=subagent`）也算进来 |
| `refreshSeconds` | `10` | 载荷缓存与页面轮询频率，1–600 |
| `foldCacheSeconds` | `21600` | 归档会话天行的缓存秒数，0–604800 |
| `liveFoldSeconds` | `5` | 活跃会话天行的缓存秒数，0–3600 |
| `readConcurrency` | `8` | 读会话日志的并发上限，1–16 |
| `warmUpOnStart` | `true` | 激活后在后台预热「天行」缓存，避免打开面板时等冷启动 |
| `warmUpDelaySeconds` | `3` | 预热延后多少秒开始（避开应用自身启动高峰），0–300 |
| `persistFolds` | `true` | 把「非活跃会话」的天行缓存到磁盘，进程重启后首次打开面板也秒开 |
| `revalidateSeconds` | `30` | 后台轮转校验磁盘缓存的间隔（秒），0–86400 |

> `config` 是**整体替换、不深合并**：覆盖时要把需要的字段都写回来。

## 6. 结构

```
dsh-plugin-usage-stats/
├── package.json          # dsh.bundle.patch + dsh.client + meta
├── cordis.patch.yml      # 把本插件插进 profile 的那一行
├── index.js              # Host 半：天行缓存（与窗口无关）+ 窗口聚合 + HTTP 路由
├── metrics.js            # 纯逻辑：token 归一化 / 按天折叠 / 窗口聚合（可单测）
├── client.js             # Client 半：面板图标 + 全部界面（图形用 div 手绘）
├── locale/{zh,en}.json   # 插件列表/卡片里的显示名（必须是嵌套 meta）
└── verify/               # node verify/*.mjs
```

**两个 id 必须一致**，宿主才把图标和面板对上：

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ id: PANEL_ID, ... }, PanelIcon))
ctx.slots.inject('main',              () => ctx.slots.register({ key: PANEL_ID, ... }, Panel))
```

**一次请求**：`GET /dsh-plugin-usage-stats/metrics?days=N` 同时返回窗口聚合、365 天年度序列、
24 小时分布、模型/工具/会话排行与逐日明细 —— 页面只发一个数据请求（金额那个另算，尽力而为）。

## 7. 开发与验证

```bash
node verify/metrics.test.mjs     # 纯逻辑：token 归一化 / 按天折叠 / 窗口聚合
node verify/service.test.mjs     # 服务级：缓存策略与「切窗口不重读日志」
node verify/manifest.test.mjs    # manifest / 一致性
pnpm test                        # 上面三条
```

`manifest.test.mjs` 钉住的真实约束（都是会踩的坑）：

- 两半的路由路径必须一致；金额路由同理；
- **Host 半不得出现价目表的键**（定价只有 session-cost 一份）；
- Host 半不许有**静态**裸导入 `@deepseek-ai/*`（profile 用 `link:` 装插件，真实路径在工作区，从那里解析不到 → 必须 best-effort 动态导入）；
- Client 半不许 import 任何 Harness Client 包，也不许引第三方图表库；
- **可见文案必须走 locale 字典**：测试会剥掉注释后在字典之外搜中文字面量；
- `locale/*.json` 必须是**嵌套一层 `meta`** 的 `{ meta: { title, description } }`；
- 可调参数必须落在 `Config` 里，否则用户升级时会丢。

`service.test.mjs` 用「`readSession` 调用次数」而不是计时来证明快 —— 计时在 CI 会飘，调用次数是确定的。

安装后的实测：

```bash
curl -s http://127.0.0.1:<端口>/dsh-plugin-usage-stats/metrics?days=30 | head -c 400
curl -s http://127.0.0.1:<端口>/dsh-session-cost/summary           | head -c 200
```

```
cordis_inspect_query { platform: "client", provider: "Slots", method: "listSubTree", input: { root: "sidebar.panellist" } }
```

`occupants` 里应出现 `{ id: "usage-stats", order: 15, active: true }`；`main` 同理出现 `{ key: "usage-stats" }`。

## 8. 已知边界

- **没有浏览器控制时无法做视觉验证**：配色在亮/暗主题下是否协调、年度热力图在窄窗口下是否横向滚动正常，需要你在页面上确认。已确认的是语法、manifest、三条路由/服务行为、插桩注册处于 `active`。
- **首次加载仍是冷启动**：要读并折叠所有会话的日志；此后切窗口、看年度视图都不再读日志。
- **年度热力图在历史短的时候大部分是空的**：这是数据的真实形状（GitHub 新账号同理），会随时间自己长满。
- **月份刻度按列打点**：某月 1 日不在列首时，刻度仍打在该列，可能与相邻刻度略微错开一格。
- **小时分布的 token 是摊分值**（见第 3 节），调用次数是精确值。
- **按天分桶用「now 往前推 N×24h」**：跨夏令时切换的那一天可能偏移一格。对统计面板可接受。
- **`maxSessions` 之外的会话不扫描**：默认最近 100 个。
- **内存**：每个会话的天行常驻内存，规模与「活跃天数 × 模型/工具种类」成正比；归档会话按 TTL 复用，语料变化时会清理不在列表里的键。
