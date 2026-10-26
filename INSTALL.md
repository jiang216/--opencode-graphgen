# opencode-graphgen 安装文档

文档图谱 graphgen + 文档防漂移 doclint + 仓库管理的全家桶安装指南。本仓库**自包含**：MCP 服务端、可选插件、技能、引擎、doclint、模板、安装器都在这里。
v0.3 起推荐 **MCP 全局安装**：装一次，任意项目自动部署；传统 `install.py` 仍可用。

> graphgen 引擎配置字段参考见 `graphgen-config.md`；本文只讲安装。

## 1. 包内容（文件清单）

| 文件/目录 | 说明 | 必装 |
|------|------|------|
| `tools/graphgen.py` | 图谱引擎（纯 stdlib） | 是 |
| `tools/graphgen.config.template.json` | 图谱配置模板（`{{NAME}}` 占位由安装替换为项目名） | 是 |
| `tools/doclint.py` | 文档漂移机械校验（R1-R8 + 生成块，配置驱动） | 是 |
| `tools/gen_doc_slice.py` | 生成块写回工具（menu/filelist slice） | 与 markers 配合 |
| `tools/repo.py` | 代码仓库适配层（git/hg/svn：检测/体检/建库/快照/条目↔提交/护栏） | 是 |
| `tools/repo.config.template.json` | 仓库配置模板（缺省生成 `tools/repo.config.json`） | 是 |
| `mcp/` | MCP 服务端（stdio，零依赖）：`status/deploy/query/repo/verify` + 自动部署 + 提交记忆 + 安装器 | 推荐 |
| `src/index.ts` | 旧 opencode 插件：文件事件自动重生成 + `graphgen_query`/`repo_query`；仅 `--plugin` 时安装 | 可选 |
| `skills/graphgen/SKILL.md` | opencode 技能（查反链/跑生成器/防漂移/仓库体检指南） | 可选 |
| `templates/` | `doclint.config.example.json`、`pre-commit`、`commit-msg`、`agents-snippet.md` 片段 | — |
| `install.py` | 统一安装器（下述方式 A） | — |
| `bootstrap/` | 全局自安装引导器（装到 `~/.config/opencode/` 一次，之后任意项目拷包即自动安装） | 可选 |

## 2. 前置要求

- **Python 3.10+**（仅用标准库）
- **Node.js 20+**（MCP 服务端 / 安装器）
- 目标项目已有 `docs/` 目录，以及一份条目文件（默认 `docs/CHANGELOG.md`）
- opencode 增强（MCP/技能/插件）：MCP 推荐；插件为旧路径，需 opencode **V2 插件 API**（`Plugin.define`，≥ 2.0）
- Windows 下建议先 `$env:PYTHONIOENCODING='utf-8'` 防中文乱码

## 3. 安装

### 方式 A：MCP 全局安装（推荐）

```powershell
# 1) 装运行时 + 注册全局 mcp.graphgen（目录可自定义）
node <本仓库>\mcp\install.mjs --install-dir D:\tools\graphgen-mcp

# 2) 体检
node <本仓库>\mcp\install.mjs --install-dir D:\tools\graphgen-mcp --doctor

# 开发本仓库：不复制，直接引用
node <本仓库>\mcp\install.mjs --link
```

- 默认目录：`%USERPROFILE%\.config\opencode\graphgen-mcp`；`--install-dir` 由用户指定。
- 安装器会复制 `mcp/ + engine/{install.py,tools,templates,skills,src}`、生成 `config.json`、
  写入全局 `~/.config/opencode/opencode.json` 的 `mcp.graphgen`（先备份、原子写），并做 MCP 自检。
- **重启 opencode** 后生效。项目级注册：`--scope project --target <项目>`。
- 之后在任意项目里：`graphgen_status` → `graphgen_deploy {target, confirm:true}`；
  首次调用 `graphgen_query/repo/verify` 会先做冲突预检，无冲突自动补引擎（`autoDeploy: true`），
  有冲突只返回 `conflicts`，确认后加 `force:true`。
- 详见 [mcp/README.md](mcp/README.md)。

### 方式 B：统一安装器（无 MCP / 需要离线拷贝）

```powershell
python <本仓库>\install.py --target <目标项目目录> [--hooks] [--plugin]
```

示例（仓库在 `F:\shiyan\CLion\opencode-graphgen`，装到 `D:\code\myapp`）：

```powershell
python F:\shiyan\CLion\opencode-graphgen\install.py --target D:\code\myapp --hooks
```

`install.py` 自动完成（全部**幂等**，重复执行=同步更新）：

| 目标产物 | 说明 |
|----------|------|
| `<目标>/tools/graphgen.py`、`graphgen.config.template.json` | 引擎与模板 |
| `<目标>/tools/graphgen.config.json` | 缺省时由模板生成（`name`=目录名），已有则跳过 |
| `<目标>/tools/doclint.py`、`gen_doc_slice.py` | 防漂移校验与生成块工具 |
| `<目标>/tools/doclint.config.json` | 缺省时由示例生成（按项目裁剪规则开关） |
| `<目标>/tools/repo.py`、`repo.config.template.json` | 代码仓库适配层与配置模板 |
| `<目标>/tools/repo.config.json` | 缺省时由模板生成（护栏默认只警告） |
| `<目标>` 的代码仓库 | 无 `.git/.hg/.svn` 且本机有 git → 自动 `git init -b main` + 播种 `.gitignore`（`--vcs none` 跳过；在父仓库内不建嵌套库；无 VCS 工具只提示） |
| `<目标>/docs/repo.json`、`docs/REPO.md`、`docs/repo-links.json` | 部署快照（本地记录，已 gitignore）与条目↔提交索引（建库/检出成功后生成；doclint R8 在发布/CI 校验） |
| `<目标>/.opencode/plugins/graphgen-watch.ts` | 旧插件；**仅 `--plugin` 时安装**（默认 MCP 模式不装） |
| `<目标>/.opencode/skills/graphgen/` | 技能（覆盖=同步更新） |
| `<目标>/.opencode/package.json` | `@opencode/plugin` 依赖声明；**仅 `--plugin` 时**补齐（并清除 V1 残留） |
| `<目标>/tools/git-hooks/pre-commit`、`commit-msg` + `core.hooksPath` | 仅 `--hooks`：pre-commit（doclint + graphgen --check + repo guard）与 commit-msg（条目 ID 检查） |
| `<目标>/AGENTS.md` | 无则创建；已有且无安装标记则追加工作流片段（含防漂移配对表 + 仓库管理） |

代码仓库相关开关（默认已按「无仓库就自动建」工作）：

| 开关 | 作用 |
|------|------|
| `--vcs auto\|git\|hg\|svn\|none` | 建库类型；`auto` 按 git>hg>svn 取可用工具；`none` 整步跳过 |
| `--no-vcs-init` | 没有仓库时只检查并提示，不建库 |
| `--vcs-remote URL` / `--vcs-branch NAME` | 建库时设远端 / git 初始分支 |
| `--vcs-commit` | 建库后首次提交（需已配置 `user.name/user.email`，默认关） |
| `--vcs-strict` | 缺 VCS 工具时退出码 1 |
| `--no-snapshot` / `--dry-run` | 不生成快照索引 / 只打印建库计划 |
| `--plugin` | 同时安装文件监听插件（默认不装） |
| `--remove-plugin` | 删除已有的 `graphgen-watch.ts`（迁移到 MCP） |
| `--json` | 输出机器可读报告（MCP 用） |

### 方式 C：手动拷贝

```powershell
# 1. 必需：引擎 + doclint
Copy-Item <仓库>\tools\graphgen.py, <仓库>\tools\graphgen.config.template.json, <仓库>\tools\doclint.py, <仓库>\tools\gen_doc_slice.py <目标>\tools\
# 2. 配置（缺省才拷）
Copy-Item <仓库>\tools\graphgen.config.template.json <目标>\tools\graphgen.config.json   # 编辑 name/prefixes
Copy-Item <仓库>\templates\doclint.config.example.json <目标>\tools\doclint.config.json   # 按需开关规则
# 3. 可选增强：技能 + 插件 + 依赖声明
#    <目标>\.opencode\skills\graphgen\SKILL.md            ← skills/graphgen/SKILL.md
#    <目标>\.opencode\plugins\graphgen-watch.ts          ← src/index.ts
#    <目标>\.opencode\package.json 加 {"dependencies": {"@opencode/plugin": "2.0.32"}}   # 编辑器类型检查用；运行时 opencode 自行解析 @opencode/plugin
# 4. 可选：templates\agents-snippet.md 追加到 <目标>\AGENTS.md；templates\pre-commit → tools/git-hooks/
# 5. 首次生成（必需）
cd <目标>
$env:PYTHONIOENCODING='utf-8'
python tools\graphgen.py
```

### 方式 D：一次性全局自安装（旧引导器）

在本机 `~/.config/opencode/` 装一次「全局引导器」，之后**任意项目**只要拷入本仓库（或其 `graphgen-dist/` 副本），用 opencode 打开即可**自动安装**：

```powershell
# Windows
pwsh -File <仓库>\bootstrap\install-bootstrap.ps1
# macOS / Linux
sh <仓库>/bootstrap/install-bootstrap.sh
```

引导器 = 全局技能（教智能体发现包后按 INSTALL 自助安装）+ 全局插件（启动时检测「有包且未安装」→ 自动执行 `--init`，幂等）。

装好后的使用方式：

1. 把包整个文件夹复制进目标项目（放根目录或 `tools/` 下均可）。
2. 用 opencode 打开该项目。**插件**会在启动时自动完成安装（输出出现 `[graphgen-bootstrap]`）；失败则**智能体**按引导技能自助安装。
3. 安装后项目根生成/追加 `AGENTS.md`：**中文汇报**、**改动工作流**、**图谱同步**、**文档防漂移** 四段规则。
4. 首次配置 `tools/graphgen.config.json` 的 `prefixes` 与 `tools/doclint.config.json` 规则开关，跑 `--check` / `doclint` 验证。
5. 重启 opencode，技能生效（默认不装文件监听插件；需要时用 `install.py --plugin`）。

> 全局引导器只需每台接收机装一次；它不是拷进目标项目的。

## 4. 首次配置（最小）

编辑 `<目标>/tools/graphgen.config.json`：

1. `name`：项目名
2. `prefixes`：CHANGELOG 条目前缀表（lint 校验未知前缀，**必须填**）
3. `output` 三个产物路径 + `scan.ignore` 务必包含三个产物（防自扫描循环）
4. 其它按需（`tableEdges` 等，见 `graphgen-config.md`）

编辑 `<目标>/tools/doclint.config.json`：

1. `rules.R2-R5` 按项目事实源配路径（不配即跳过）
2. `rules.R7.requireHistory` 填 `{前缀: 起始编号}`（该编号起必须含「相关历史条目」）
3. `rules.R6.scan` 改为项目实际文档范围；`ban` 填已下线的旧密钥字面量

## 5. 安装后验证

```powershell
python tools\graphgen.py --check   # 期望 0 errors / 0 warnings
python tools\graphgen.py           # 生成 docs/graph.json / GRAPH.md / graph.mmd
python tools\doclint.py            # 期望 doclint: OK
python tools\repo.py status        # 期望一行：git main @ <短哈希> · 工作区干净
python tools\repo.py snapshot      # 期望写入 docs/repo.json / docs/REPO.md
```

opencode 内验证（**重启 opencode**）：

MCP（推荐）：

- `graphgen_status`：只读体检；新项目先看这个。
- `graphgen_deploy {target, confirm:true}`：部署/同步；不传 confirm 只出计划。
- `graphgen_query`：`action=query node=DG-009` / `generate` / `check` / `doclint`。
- `graphgen_repo`：`status` / `init` / `snapshot` / `links` / `guard`。
- `graphgen_verify`：一次跑 graphgen + doclint + repo status。
- 常驻记忆：每轮注入「改完自己提交」（`GRAPHGEN_AUTO_COMMIT=0` 可关）；只提交本次改动文件，禁止 push。
- 无文件监听：文档改完显式 `graphgen_query action=generate`。

旧插件（`--plugin`，可选）：

- 工具 `graphgen_query`：`action=check` / `action=query node=BUG:xxx`（支持简称 `g-004`）/ `action=generate` / `action=doclint`
- 工具 `repo_query`：`action=status` / `init` / `snapshot` / `links` / `guard`
- 修改任一 `docs/*.md` → 约 1.5s 后自动重生成（输出出现 `[graphgen-watch]`）

## 6. 卸载

MCP：

```powershell
node mcp\install.mjs --install-dir D:\tools\graphgen-mcp --uninstall          # 只删配置项
node mcp\install.mjs --install-dir D:\tools\graphgen-mcp --uninstall --purge  # 连运行时一起删
```

项目侧（传统安装）删除：`tools/graphgen.py`、`tools/graphgen.config.json`、`tools/doclint.py`、`tools/gen_doc_slice.py`、`tools/doclint.config.json`、`tools/repo.py`、`tools/repo.config.json`、`tools/repo.config.template.json`、`tools/git-hooks/`、
`.opencode/skills/graphgen/`、`.opencode/plugins/graphgen-watch.ts`、
`docs/graph.json` / `docs/GRAPH.md` / `docs/graph.mmd` / `docs/repo.json` / `docs/REPO.md` / `docs/repo-links.json`；
并从 `AGENTS.md` 移除 `## 文档图谱 graphgen + 防漂移 doclint（已安装）` 片段（`git config --unset core.hooksPath` 若曾启用钩子）。
**代码仓库本身不会被卸载**（`.git/.hg/.svn` 与提交历史保留），需要时手动处理。

## 7. 常见问题

- **MCP 工具看不到**：确认已重启 opencode；跑 `node mcp\install.mjs --doctor` 看注册/自检；
  `opencode.json` 里应有 `mcp.graphgen`（`type=local`，`GRAPHGEN_CONFIG` 指向 `config.json`）。
- **新项目没有自动部署**：检查 `mcp/config.json` 的 `autoDeploy` 是否为 `true`；
  源仓库（`sourceRoot`）会被自动跳过。若 `graphgen_status` 返回 `conflicts`，说明部署会改动已有文件
  （AGENTS、被改过的工具、已有图谱/快照等），确认后执行
  `graphgen_deploy {target, confirm:true, force:true}`；也可先 `graphgen_status` 看 `suggestedNextActions`。
- **默认没有文件监听**：v0.3 默认只装 MCP；需要保存即重生成时用 `install.py --plugin`，或改完文档跑
  `graphgen_query action=generate`。
- **中文乱码**：先 `$env:PYTHONIOENCODING='utf-8'`。
- **`--check` 报「未知前缀」**：在 `prefixes` 补前缀，或修正 CHANGELOG 标题。
- **产物文件名冲突**：产物固定 `docs/GRAPH.md`（大写）。功能文档**勿用 `graph.md`**（Windows 大小写不敏感时与产物同文件）。
- **插件不生效**：确认 `.opencode/plugins/graphgen-watch.ts` 存在且为 V2 格式（`Plugin.define`），重启 opencode；`@opencode/plugin` 运行时由 opencode 自行解析，V2 **不会**自动 `bun install` `.opencode/package.json`（该依赖声明仅供编辑器类型检查）。
- **doclint 找不到配置**：`tools/doclint.config.json` 缺失，从 `templates/doclint.config.example.json` 拷贝，或用 `--config` 指定。
- **装完没有 `.git`**：说明本机没有任何 VCS 工具（日志有 `未检测到可用的 VCS 工具`），按提示装 git 后重跑
  `install.py`（幂等）；或目标位于父仓库内（日志有 `不建嵌套库`），确需独立历史用
  `python tools/repo.py init --allow-nested`。
- **不想自动建库**：`install.py --no-vcs-init`（只体检+提示），或 `--vcs none` 整步跳过。
- **svn 没自动建库**：svn 需要服务端仓库地址，`install.py` 不会在本地凭空造库；用
  `--vcs svn --vcs-remote <URL>` 或手动 `svn checkout <URL> .`。
- **doclint R8 报「部署快照过期」**：发布/拉取后跑了代码但没更新快照，重跑
  `python tools/repo.py snapshot` 再提交。快照是**本地部署记录**（已 gitignore），R8 只在发布/CI 检查；
  `pre-commit` 会自动设 `DOCLINT_SKIP_R8=1`，所以提交不会被它拦住。
- **条目↔提交没有关联**：提交信息里带条目 ID（`DG-009`、`Refs: AG-733`），再跑
  `python tools/repo.py links`；`graphgen.config.json` 的 `prefixes` 决定哪些前缀被识别。
- **引擎版本同步**：本仓库 `tools/graphgen.py` 是唯一事实源；消费项目一律经 `install.py` 更新，勿在消费方手改。
