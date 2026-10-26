## 文档图谱 graphgen + 防漂移 doclint（已安装）

> 由全局 `graphgen` MCP 自动部署，或 `python install.py --target <本项目>` 安装（旧路 `python tools/graphgen.py --init`）。产物 `docs/graph.json` / `docs/GRAPH.md` / `docs/graph.mmd` 为 **AUTO-GENERATED，禁手改**。

### MCP 优先（推荐）

- 已注册 `graphgen` MCP 时优先用：`graphgen_status`（体检）→ `graphgen_deploy {target, confirm:true}`（部署/同步）
  → `graphgen_query`（query/generate/check/doclint）→ `graphgen_repo`（status/init/snapshot/links/guard）
  → `graphgen_verify`（提交前聚合校验）。
- 新项目缺引擎时，`query/repo/verify` 先做冲突预检：无冲突自动部署；已有 AGENTS/工具/图谱等冲突只提示，确认后 `confirm:true, force:true`。
- 首次部署若缺 `docs/CHANGELOG.md`，会写入合法种子条目（默认 `DG-001`）并补 `prefixes`/`allowOrphanEntries`；
  已有条目文件不覆盖。`docs.ready=false` 时不要写 AGENTS，先补条目。
- 自动部署不建 VCS；无 VCS 时 `repo status` 返回 `not_applicable`，快照用 `mode=fs`。
- MCP 不做文件监听：改完文档显式 `graphgen_query action=generate`，再 `graphgen_verify`。
- 没有 MCP 时，用下面 CLI 命令，效果相同。

### 汇报语言

- 开发 / 改动 / 排查工作完成后，用**中文**汇报：做了什么、验证结果、遗留问题。

### 改动工作流（强制，防错误复发）

- **改动前必读**：先读与改动相关的 `docs/*.md` 功能文档 + `docs/CHANGELOG.md`（条目文件）相关条目及其「必须保证的功能（回归清单）」，逐项核对不得破坏。
- **改动后必更**：
  - 涉及已有功能 → 核对回归清单项是否仍成立；新增保证项 → 加入对应文档回归清单。
  - 修 Bug / 加功能 → 在 `docs/CHANGELOG.md` **追加**条目（严重度 / 根因 / 修复 / 验证），**防止错误重复出现**；功能文档只放引用 `[xx-###](CHANGELOG.md#...)`，不得内嵌详情。

### 图谱同步（强制）

- 涉及 `docs/`、`AGENTS.md`、`.opencode/skills/*/SKILL.md`、`.claude/skills/`、`tools/graphgen.config.json` 的改动完成后：
  1. `$env:PYTHONIOENCODING='utf-8'`（Windows 防中文乱码）
  2. `python tools/graphgen.py` 重新生成图谱
  3. `python tools/graphgen.py --check` 必须 0 错误 0 警告
- 查反链优先读 `docs/graph.json` 的 `backlinks`（按节点 id 索引），勿对 docs/ 全库 grep。
- 节点 id：`BUG:xx-###`（条目文件，如 CHANGELOG）/ `DOC:xxx`（docs/*.md）/ `SKILL:xxx`（技能）/ `META:xxx`（AGENTS、条目文件本体）/ `SRC:xxx`（源码映射表）。
- 边 kind：`ref`（相关历史条目引用）/ `checklist`（回归清单保证项，context 带原文）/ `mention`（正文链接）/ `index`（索引表）/ `owns`（源码归属）。
- 配置字段说明见本插件包 `graphgen-config.md`（模板：`tools/graphgen.config.json`）。

### 文档防漂移 doclint（强制）

- 改完文档后跑 `python tools/doclint.py`，必须 0 错误；`docs/CHANGELOG.md` 新增条目需满足 R7（编号连续、日期、起始条目含「相关历史条目」）。
- 配置在 `tools/doclint.config.json`（规则 R1-R8 逐条开关/配参，生成块 markers 也在其中）。
- 文档出现**生成块**时（`<!-- gen:name -->`）：事实源改完后跑 `python tools/gen_doc_slice.py --write` 回写，禁手改块内内容。
- 已装钩子则 `git commit` 自动跑 doclint + `graphgen.py --check`，不过即拦（绕过 `--no-verify`，不建议）。

### 代码仓库管理（强制）

- **自动提交（常驻记忆）**：改完一批文件由 agent 自己 `git commit`，不要让用户手动提交；只 add 本次改动文件、
  带条目 ID、禁止 push / amend / 改全局 git 配置（`GRAPHGEN_AUTO_COMMIT=0` 可关）。
- **部署/接入**：MCP `graphgen_deploy` 或 `install.py` 自动检测 `.git/.hg/.svn`。没有仓库且本机有 git → 自动 `git init -b main` 并播种 `.gitignore`；
  本机没有任何 VCS 工具 → 只打印安装指引（Windows `winget install --id Git.Git -e`），不阻断安装。
- **体检**：`python tools/repo.py status`（VCS/分支/HEAD/远端/工作区/上游）。
- **部署快照**：发布/部署后跑 `python tools/repo.py snapshot`，生成 `docs/repo.json` + `docs/REPO.md`
  （AUTO-GENERATED，**禁手改**；本地部署记录，已 gitignore）。doclint R8 在发布/CI 校验快照 HEAD 与当前一致；
  提交钩子用 `DOCLINT_SKIP_R8=1` 跳过 R8（提交本身会让快照变旧）。
- **条目 ↔ 提交**：提交信息带条目 ID（`DG-009`、`Refs: AG-733`）；`python tools/repo.py links` 生成
  `docs/repo-links.json`，graphgen 侧表现为 `COMMIT:<短哈希>` 节点 + `touches` 边 →
  `graphgen_query node=DG-009` 直接看「这条需求改过哪些提交」。
- **护栏**：`pre-commit` 调 `repo.py guard --stage commit`（文档改动未带 CHANGELOG、暂存大文件只警告）；
  `commit-msg` 检查条目 ID（默认警告；`tools/repo.config.json` 改 `entryIdMode=error` 才阻断）。
  护栏只读，**不执行** `add/commit/push`。

### 文档同步配对表（防漂移，按本项目事实源裁剪）

| 改动 | 必须同步 | 规则 |
|------|----------|------|
| （在此登记：菜单/种子/路由/白名单等事实源 ↔ 文档） | 对应文档小节或清单 | R2-R5 |
| 文档出现密钥/散列 | 移除；真实值只放 `.env`/环境变量 | R6 |
| `docs/CHANGELOG.md` 新增条目 | 编号连续、标题带（YYYY-MM-DD）、起始条目含「相关历史条目」 | R7 |
| 代码发布/部署 | 重跑 `python tools/repo.py snapshot`（快照 HEAD 必须等于当前 HEAD） | R8 |
| 插入/删除文档章节 | 同级编号顺延重排 | R1 |

<!-- graphgen:installed -->
