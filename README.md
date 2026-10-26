# opencode-graphgen

opencode 文档图谱（graphgen）+ 文档防漂移（doclint）+ 代码仓库管理（repo）**全家桶**——本仓库是唯一事实源。
v0.3 起以 **MCP 服务端**为主：全局装一次，任意项目自动部署/调用；旧的文件监听插件退为可选（`--plugin`）。

## 组成

| 组件 | 路径 | 作用 |
|------|------|------|
| 图谱引擎 | `tools/graphgen.py` | 扫描 markdown → `docs/graph.json` / `docs/GRAPH.md` / `docs/graph.mmd`，带 lint（`--check`） |
| 防漂移校验 | `tools/doclint.py` | 文档与事实源机械比对：R1 章节编号 / R2 菜单 / R3 清单 / R4 路由 / R5 白名单 / R6 凭据 / R7 条目文件 / R8 部署快照 / markers 生成块 |
| 仓库适配层 | `tools/repo.py` | git/hg/svn 统一：检测/体检/建库/部署快照/条目↔提交索引/提交护栏 |
| 生成块工具 | `tools/gen_doc_slice.py` | 按 `tools/doc-slices.json` 把事实源生成结果写回 `<!-- gen:name -->` 块 |
| **MCP 服务端** | `mcp/` | 全局一份：`status/deploy/query/repo/verify`；新项目自动部署；注入提交记忆 |
| opencode 插件（可选） | `src/index.ts` | 文件事件自动重生成 + `graphgen_query`/`repo_query`；仅在 `--plugin` 时安装 |
| 技能 | `skills/graphgen/SKILL.md` | 教智能体查反链/跑生成器/跑防漂移 |
| 安装器 | `install.py` | 一键把全家桶幂等装进目标项目（`--hooks` 附 pre-commit 硬闸） |
| 模板 | `templates/` | doclint 示例配置、pre-commit 钩子、AGENTS 工作流片段 |
| 全局引导器 | `bootstrap/` | 装到 `~/.config/opencode/` 一次，之后任意项目拷包自动安装 |

## 快速开始（MCP，推荐）

```powershell
# 1) 全局装一次（目录可自定义）
node mcp\install.mjs --install-dir D:\tools\graphgen-mcp
node mcp\install.mjs --install-dir D:\tools\graphgen-mcp --doctor

# 2) 重启 opencode；之后任意项目里：
#    graphgen_status                       # 看项目缺什么
#    graphgen_deploy {target, confirm:true}
#    graphgen_query action=generate
#    graphgen_verify
```

新项目第一次调用 `graphgen_query` / `graphgen_repo` / `graphgen_verify` 时会先做**冲突预检**：
无冲突自动补齐引擎（`autoDeploy: true`），有冲突只返回 `conflicts`，确认后 `graphgen_deploy {target, confirm:true, force:true}`。
也可先 `graphgen_status` 看 `suggestedNextActions`。详见 [mcp/README.md](mcp/README.md)。

## 传统安装（无 MCP / 需要文件监听）

```powershell
# 安装到目标项目（默认不装插件；--plugin 保留保存即重生成）
python install.py --target <目标项目> [--hooks] [--plugin]

# 在目标项目验证
cd <目标项目>
$env:PYTHONIOENCODING='utf-8'
python tools/graphgen.py --check    # 图谱 lint
python tools/doclint.py             # 文档防漂移
```

详细安装方式（MCP / 安装器 / 手动 / 全局引导器）见 [INSTALL.md](INSTALL.md)；图谱引擎配置字段见 [graphgen-config.md](graphgen-config.md)。

## 消费项目速查

装完后在消费项目里：

- `python tools/graphgen.py` 生成/重生成图谱；`--check` 只 lint。
- `python tools/doclint.py` 文档防漂移（配置 `tools/doclint.config.json`）。
- `python tools/gen_doc_slice.py --write` 回写生成块。
- `python tools/repo.py status|snapshot|links|guard` 代码仓库体检/部署快照/条目↔提交/护栏。
- opencode 内（MCP）：`graphgen_query`（query/generate/check/doclint）、`graphgen_repo`（status/init/snapshot/links/guard）、
  `graphgen_verify`、`graphgen_deploy`、`graphgen_status`。
- 旧插件路径：`graphgen_query` / `repo_query`（`--plugin` 安装时）；`docs/**` 改动自动重生成。
- `git commit` 自动跑 doclint + graphgen `--check` + `repo.py guard`（`--hooks` 安装时）。

## 代码仓库管理（部署即生效）

`install.py` 在安装时顺带管代码仓库，让「需求/文档迭代」和「代码迭代」能对齐：

1. **检测**：`.git`（优先）/`.hg`/`.svn`；多标记并存时全部报告；仅位于父仓库子目录时不建嵌套库。
2. **建库**：没有仓库且本机有 git → 自动 `git init -b main` + 播种 `.gitignore`（默认不提交、不设远端）；
   svn 需 `--vcs-remote <URL>`；本机没有任何 VCS 工具 → 打印安装指引，安装继续。
3. **部署快照**：`repo.py snapshot` → `docs/repo.json` + `docs/REPO.md`（AUTO-GENERATED，本地部署记录，已 gitignore），doclint **R8** 在发布/CI 检查其新鲜度（提交钩子用 `DOCLINT_SKIP_R8=1` 跳过，避免「提交后快照必然过期」死循环）。
4. **条目 ↔ 提交**：提交信息带 `DG-009` 这类条目 ID，`repo.py links` → `docs/repo-links.json`；
   graphgen 生成 `COMMIT:<短哈希>` 节点与 `touches` 边（`graphgen_query node=DG-009` 可查）。
5. **护栏**：pre-commit / commit-msg 调 `repo.py guard`（只读，默认只警告，不执行 add/commit/push）。
6. **自动提交记忆**：MCP `initialize.instructions` 每轮注入约定——改完由 agent 自己 `git commit`
   （只提交本次改动文件、带条目 ID、禁止 push），不需要用户每次手动提交；`GRAPHGEN_AUTO_COMMIT=0` 可关闭。
7. **自动部署**：全局 MCP 对新项目首次调用 `graphgen_query/repo/verify` 时先做冲突预检；
   空项目或普通业务文件无冲突时自动补齐上述全部能力，已有 AGENTS/工具/图谱等冲突则只提示
   （默认不装插件、不建 VCS、不提交、不 push）。首次缺 `docs/CHANGELOG.md` 时写入种子条目
   `DG-001` 并补 `prefixes`/`allowOrphanEntries`，已有条目文件不覆盖。

| 开关 | 作用 |
|------|------|
| `--vcs auto\|git\|hg\|svn\|none` | 建库类型；`none` 整步跳过 |
| `--no-vcs-init` | 没有仓库时只提示、不建库 |
| `--vcs-remote URL` / `--vcs-branch NAME` | 建库时设远端 / 初始分支 |
| `--vcs-commit` | 建库后首次提交（需已配置 git 身份，默认关） |
| `--vcs-strict` | 缺 VCS 工具时以非 0 退出 |
| `--no-snapshot` / `--dry-run` | 不生成快照 / 只打印建库计划 |

## 维护约定（本仓库）

- **唯一事实源**：MCP/插件/技能/引擎/doclint/模板只在这里改；消费项目（openfbx、code_grbk 等）一律用
  `graphgen_deploy` 或 `install.py` 更新，禁止在消费方手改拷贝。
- 改完本仓库工具后：`node mcp/mcp-test.mjs` + `node mcp/install.mjs --doctor`；需要同步已装运行时时重跑安装器；
  消费项目可用 MCP `graphgen_deploy` 同步，或照旧跑 `install.py`，并跑 `graphgen --check` / `doclint` 验证。
- 引擎同步历史：`tools/graphgen.py` 自 openfbx 仓库迁入；openfbx 现为其消费方。
- 汇报/文档用**中文**。

## 消费项目一览

| 项目 | 路径 | 说明 |
|------|------|------|
| openfbx | `F:\shiyan\CLion\openfbx` | graphgen 上游历史仓库，已迁为消费方（`DG-009`） |
| 3道山商城 code_grbk | `F:\phpstudy_pro\WWW\code_grbk` | ThinkPHP 商城，doclint R1-R7 全开 |
