# graphgen MCP

把文档图谱（graphgen）、文档防漂移（doclint）、仓库管理（repo）和**项目部署**封装成一个 MCP 服务端。
装一次（全局注册），之后任意项目里由 agent 直接调用；不用再把插件/工具复制到每个项目。

## 为什么

- 旧模式：每个项目一份 `.opencode/plugins/graphgen-watch.ts` + 一套 `tools/*.py`，还得回本仓库执行 `install.py`。
- MCP 模式：**一份运行时** + 全局注册；新项目首次调用 `graphgen_repo` / `graphgen_query` 时先做冲突预检，无冲突自动补齐引擎。
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

> 安装/改配置后执行 `opencode reload`（或重启 opencode）让工具生效。**只重启 IDE 窗口不一定够**：
> opencode 后台服务可能仍在复用旧连接；用 `opencode mcp list` 确认 `graphgen connected`。
> 项目级注册：`--scope project --target <项目>`（写 `<项目>/opencode.json`）。

## 工具

| 工具 | 作用 | 写盘 |
|---|---|---|
| `status` | 服务端/引擎/Python + 目标项目体检（缺失/过期/配置/VCS/快照/旧插件/冲突/下一步建议） | 否 |
| `deploy` | 部署/同步全家桶；默认只出计划，`confirm=true` 才写；冲突需 `force=true` | 是 |
| `query` | `query/generate/check/doclint` | `generate` 写产物 |
| `repo` | `detect/status/init/snapshot/links/guard`；`init` 需 `confirm=true`；无 VCS 自动降级 | 按动作 |
| `verify` | `graphgen --check` + `doclint` + `repo status` 聚合 | 否 |

> 工具在 opencode 中通常显示为 `graphgen_status` / `graphgen_deploy` …；若宿主用 `graphgen.status`
> 形式，以实际工具列表为准。

## 排错

- `opencode mcp list` 显示 `graphgen failed: MCP server process exited with code 255`，且错误里只有启动横幅：
  常见原因是旧的 MCP 子进程被手工结束后，后台服务缓存了失败连接。执行 `opencode reload`，再跑
  `opencode mcp list`；仍失败时完全退出 opencode 后台服务后重开。
- 不要按进程名批量杀 `node.exe`；需要重载时优先用 `opencode reload`，避免误伤其他会话或其他 MCP 服务。
- 服务端自检：`node <install-dir>/mcp/install.mjs --doctor`。stdout 只输出 JSON-RPC；启动横幅和诊断信息走 stderr。
- 改配置后若工具列表没变，同样是 `opencode reload`；只重启 IDE 窗口可能仍连着旧后台服务。

缺引擎时，`query` / `repo` / `verify` 会先做**部署预检**，再决定是否自动部署（`autoDeploy: true` 时）：

- 项目为空或只有普通业务文件：无冲突，先部署，再继续当前操作；
- 已有 `AGENTS.md`、被改过的 `tools/graphgen.py`、已有 `docs/graph.json`/快照等：返回 `conflicts`，**不写盘**；确认后 `graphgen_deploy {target, confirm:true, force:true}`；
- 首次部署若 `docs/CHANGELOG.md` 不存在：自动写一条合法种子条目（默认 `DG-001`，已有前缀则沿用），并补 `prefixes` / `allowOrphanEntries`，让第一次 `generate` 就是 0 errors / 0 warnings；
- 已有 `docs/CHANGELOG.md` 绝不覆盖/追加；文件存在但没有合法条目时，`docs.ready=false`，不写 `AGENTS.md`，`query generate/check/doclint` 返回 `needsDocs` 提示，而不是裸 Python 错误；
- `status` 永远只读，返回 `conflicts`、`docs.ready` / `missingEntryFiles` 和 `suggestedNextActions`。

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
    "vcs": "auto", "vcsInit": false, "vcsCommit": false,
    "snapshot": true, "agents": true, "hooks": false,
    "plugin": false, "removePlugin": false
  },
  "memory": { "autoCommit": true },
  "guard": { "allowPush": false }
}
```

- `autoDeploy=false`：任何工具都不自动写盘，只返回 `needsDeploy` / 计划。
- `sourceRoot`：MCP 源仓库，自动部署会跳过它，避免把工具仓库本身当消费项目改写。
- 首次自动部署**不建 VCS**（不会意外 `git init`）；需要仓库时显式 `deploy {vcsInit:true}` 或 `repo init`。
- 首次部署前会检查冲突：已有 AGENTS、被修改的工具文件、已有图谱/快照等只提示，确认后加 `force=true`。
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

已有的项目侧文件（`tools/*.py`、插件、快照）默认不删；冲突文件默认不覆盖，确认后加 `force=true` 才写。

## 边界

- 不监听文件变化、不常驻 watcher；`query generate` 是显式动作。
- 不自动 push、不 amend 他人提交、不改全局 git 配置。
- `deploy`/`init` 默认先出计划；要写盘必须 `confirm=true`，有冲突再加 `force=true`。
- 目标必须在引擎目录之外；拒绝把引擎装进自身。
- 合并到其他 MCP 工具箱（含 `libs` 单进程）留到下一版，本期独立运行。
