# graphgen MCP

把文档图谱（graphgen）、文档防漂移（doclint）、仓库管理（repo）和**项目部署**封装成一个 MCP 服务端。
装一次（全局注册），之后任意项目里由 agent 直接调用；不用再把插件/工具复制到每个项目。

## 为什么

- 旧模式：每个项目一份 `.opencode/plugins/graphgen-watch.ts` + 一套 `tools/*.py`，还得回本仓库执行 `install.py`。
- MCP 模式：**一份运行时** + 全局注册；新项目首次调用 `graphgen_repo` / `graphgen_query` 时自动补齐引擎。
- 不再有文件监听常驻；生成改为显式 `graphgen_query action=generate`（想保留监听可用 `install.py --plugin`）。

## 安装（一次）

```powershell
# 1) 装到用户指定目录并注册到全局 opencode 配置
node mcp/install.mjs --install-dir D:\tools\graphgen-mcp

# 2) 体检
node mcp/install.mjs --install-dir D:\tools\graphgen-mcp --doctor

# 开发本仓库时：不复制，直接引用
node mcp/install.mjs --link
```

默认安装目录：`%USERPROFILE%\.config\opencode\graphgen-mcp`。
安装器会：

1. 复制 `mcp/ + engine/{install.py,tools,templates,skills,src}` 到目标目录；
2. 生成 `<install-dir>/mcp/config.json`；
3. 在全局 `~/.config/opencode/opencode.json` 写入 `mcp.graphgen`（先备份、原子写）；
4. 起服务做 `initialize` / `tools/list` 自检；失败则不注册 opencode（运行时文件保留，便于排查）。

> **重启 opencode** 后工具才可见。项目级注册：`--scope project --target <项目>`（写 `<项目>/opencode.json`）。

## 工具

| 工具 | 作用 | 写盘 |
|---|---|---|
| `status` | 服务端/引擎/Python + 目标项目体检（缺失/过期/配置/VCS/快照/旧插件） | 否 |
| `deploy` | 部署/同步全家桶；默认只出计划，`confirm=true` 才写 | 是 |
| `query` | `query/generate/check/doclint` | `generate` 写产物 |
| `repo` | `detect/status/init/snapshot/links/guard`；`init` 需 `confirm=true` | 按动作 |
| `verify` | `graphgen --check` + `doclint` + `repo status` 聚合 | 否 |

> 工具在 opencode 中通常显示为 `graphgen_status` / `graphgen_deploy` …；若宿主用 `graphgen.status`
> 形式，以实际工具列表为准。

缺引擎时，`query` / `repo` / `verify` 会**先自动部署**再执行（`autoDeploy: true` 时）。
`status` 永远只读，用来先看计划。

## 配置

`<install-dir>/mcp/config.json`（由 `config.example.json` 生成）：

```json
{
  "engineRoot": "../engine",
  "python": "auto",
  "defaultRoot": ".",
  "timeoutSec": 180,
  "autoDeploy": true,
  "sourceRoot": "F:\\shiyan\\CLion\\opencode-graphgen",
  "deploy": {
    "vcs": "auto", "vcsInit": true, "vcsCommit": false,
    "snapshot": true, "agents": true, "hooks": false,
    "plugin": false, "removePlugin": false
  },
  "memory": { "autoCommit": true },
  "guard": { "allowPush": false }
}
```

- `autoDeploy=false`：任何工具都不自动写盘，只返回 `needsDeploy` / 计划。
- `sourceRoot`：MCP 源仓库，自动部署会跳过它，避免把工具仓库本身当消费项目改写。
- `deploy.hooks`：默认关；要 pre-commit 硬闸时打开。
- `deploy.plugin`：默认关；需要“保存即重生成”时打开。
- 环境变量：`GRAPHGEN_CONFIG`（配置路径）、`GRAPHGEN_PYTHON`（解释器）、`GRAPHGEN_AUTO_COMMIT=0`（关闭提交记忆）。

## 自动提交记忆

`initialize.instructions` 每轮会话注入（不依赖插件）：

- 改完一批文件由 agent 自己 `git commit`，不让用户手动提交；
- 只 `git add` 本次改动文件，不碰用户其他脏文件/密钥；
- 带条目 ID（`DG-009` / `Refs: DG-009`），不 push、不 amend、不改全局 git config；
- 提交前 `graphgen_verify`，提交后 `graphgen_repo action=links`。

## 卸载

```powershell
node mcp/install.mjs --install-dir D:\tools\graphgen-mcp --uninstall          # 只删配置项
node mcp/install.mjs --install-dir D:\tools\graphgen-mcp --uninstall --purge  # 连运行时一起删
```

已有的项目侧文件（`tools/*.py`、插件、快照）不会被删；需要时在各项目里手动清理或 `deploy --remove-plugin`。

## 边界

- 不监听文件变化、不常驻 watcher；`query generate` 是显式动作。
- 不自动 push、不 amend 他人提交、不改全局 git 配置。
- `deploy`/`init` 默认先出计划；要写盘必须 `confirm=true`。
- 目标必须在引擎目录之外；拒绝把引擎装进自身。
- 合并到其他 MCP 工具箱（含 `libs` 单进程）留到下一版，本期独立运行。
