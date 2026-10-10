# dsh-plugins

[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)（DSH）插件集合。
每个插件是一个独立的 npm 包，放在 `packages/*`，可以单独安装、单独发布，互不影响。

## 插件清单

| 包名 | 显示名 | 作用 |
|---|---|---|
| [`dsh-plugin-session-cost`](packages/dsh-plugin-session-cost) | 会话消费统计 | 输入框下方显示**当前会话消费金额**（点击弹出明细浮层：缓存命中/未命中/输出三段组成条 + 金额），设置页多出一页「会话消费」，列出**每个会话**的花费（含已归档的历史会话）。金额按 DeepSeek 官方公开价估算，高峰/空闲时段自动区分，价目表可在 Config 里整体替换。 |

## 安装

**方式一 · 图形界面 / Agent 工具**（推荐，profile 由 dsh 管理）：

```
plugin_manager { action: "install_bundle", target: "dsh-plugin-session-cost" }
```

**方式二 · 命令行**：

```bash
dsh plugin --profile <profile 名> install dsh-plugin-session-cost
```

安装后若显示为未启用，用 `plugin_manager { action: "set_bundle", target: "dsh-plugin-session-cost", enabled: true }`
或在「设置 → 插件」里打开。`target` 也可以直接给本仓库某个包的**绝对路径**（本地开发调试用）。

## 开发

```bash
# 需要 Node >= 22、pnpm 11
pnpm install                # 本仓库无第三方依赖，只会建工作区链接
pnpm -r test                # 跑每个包自带的校验
pnpm -r pack:check          # 用 npm pack --dry-run 检查将要发布的文件清单
```

每个插件的约定（详见各包 README）：

- `package.json` 里 `dsh.bundle.patch` 指向 bundle 补丁（把插件行插进 profile）；
- 有 UI 的插件再加 `dsh.client`（`platform: 'web'`）与 `./client` 导出；
- 显示名放 `locale/en.json`、`locale/zh.json`，**必须是 `{ "meta": { "title": …, "description": … } }`**，
  且 `exports` 要暴露 `./locale/*.json`；写成顶层 `title` 会让宿主回落成包名（踩过的坑，见
  [`packages/dsh-plugin-session-cost/README.md`](packages/dsh-plugin-session-cost/README.md#5-插件列表里的显示名中文)）。

> 本地以绝对路径装进 profile 时，profile 用 pnpm 的 `link:` 协议，插件运行时的真实路径仍在仓库里，
> 因此插件**不应该有静态裸导入**（`@deepseek-ai/*` 在 profile 里、从仓库路径解析不到）。
> 需要 schema 之类的包时用 best-effort 动态导入，解析不到也要能工作。

## 发布到 npm

```bash
npm login                                   # 首次
pnpm -C packages/dsh-plugin-session-cost publish --access public
# 或一次发布所有版本号尚未发布过的包：
pnpm -r publish --access public
```

打 tag 走 CI（`.github/workflows/release.yml`）：仓库需要配置 secret `NPM_TOKEN`（npmjs 的 Automation token）。

```bash
git tag v1.0.0 && git push origin v1.0.0
```

同一版本号不能重复发布：改包内 `package.json` 的 `version` 后再发。

## 隐私与产物

- `verify/summary.json` 是本机抓取的端点快照，包含**真实会话标题与金额**：已被 `.gitignore` 排除，
  也不在 npm 包的 `files` 白名单里。
- 仓库内的 `verify/summary.sample.json` 是匿名样例，供渲染测试在无本机数据时使用。

## License

[MIT](LICENSE)
