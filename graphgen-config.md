# graphgen 分发包

通用 markdown 文档知识图谱生成器（Obsidian 式正反链），可分发到任意项目。由本仓库维护发布：
源码、安装器与文档都在这里（消费方只经 `python install.py --target <项目>` 更新），
`dist/opencode-graphgen-<版本>.zip` 为整体打包的分发件。

本包**自包含**：含引擎 + 配置模板 + opencode 增强 + 安装文档，整体拷走即可在任何项目安装。
**安装步骤见 `INSTALL.md`**，本文档为概述与配置字段参考。

| 文件 | 说明 |
|------|------|
| `graphgen.py` | 引擎（纯 stdlib，无第三方依赖） |
| `graphgen.config.template.json` | 配置模板（`{{NAME}}` 占位） |
| `repo.py` / `repo.config.template.json` | 代码仓库适配层（git/hg/svn）与配置模板 |
| `INSTALL.md` | **安装文档**（一键 `--init` / 手动拷贝 / 全局自安装 / 验证 / 卸载） |
| `skill-graphgen.md` | opencode 技能（可选增强） |
| `plugin-graphgen-watch.ts` | 插件：文件事件自动重生成 + `graphgen_query` 工具（可选增强） |
| `AGENTS-snippet.md` | AGENTS.md 工作流片段（中文汇报 / 改动工作流 / 图谱同步，幂等追加，marker 防重复） |
| `bootstrap/` | **全局自安装引导器**（skill + plugin + install 脚本），装到接收机 `~/.config/opencode/` 一次 |

- **引擎**：`graphgen.py`（纯 stdlib，无第三方依赖）
- **规则**：JSON 配置驱动，不绑定任何项目
- **消费方**：opencode 智能体 / LLM（读 `docs/graph.json` 反链）、插件自动重生成、CI lint

## 安装

详见 `INSTALL.md`。两种方式：

### 方式一：一键引导（推荐）

```powershell
python <包目录>\graphgen.py --init <目标目录> [--name 项目名]
```

`--init` 会自动完成：

| 产物 | 说明 |
|------|------|
| `<目标>/tools/graphgen.py` | 引擎副本（从包内引擎复制） |
| `<目标>/tools/graphgen.config.json` | 从模板实例化（`{{NAME}}` 替换为项目名） |
| `<目标>/.opencode/skills/graphgen/SKILL.md` | opencode 技能（可选增强） |
| `<目标>/.opencode/plugins/graphgen-watch.ts` | 插件：文件事件自动重生成 + `graphgen_query` 工具（可选增强） |
| `<目标>/.opencode/package.json` | `@opencode/plugin`（V2）依赖（仅当不存在时写入；供编辑器类型检查） |
| `<目标>/AGENTS.md` | 无则自动创建；已有则幂等追加（marker 防重复）。内含中文汇报 + 改动工作流（读模块文档/错误日志防复发）+ 图谱同步三段规则 |
| `<目标>/tools/graphgen-dist/` | README + INSTALL 参考副本 |

> `--init` 可重复执行：已存在的文件一律跳过（幂等）。

### 方式二：手动拷贝

`graphgen.py` + `graphgen.config.template.json` → `<目标>/tools/`，模板改名 `graphgen.config.json` 后按需编辑；
可选增强与 AGENTS 片段步骤见 `INSTALL.md`。

## 配置字段参考（tools/graphgen.config.json）

| 字段 | 含义 | 默认 |
|------|------|------|
| `name` | 项目名（写入 graph.json 的 `project`） | 无 |
| `scan.roots` | 扫描的 markdown 目录 | `["docs"]` |
| `scan.extraFiles` | 额外单文件（如 `AGENTS.md`） | `[]` |
| `scan.ignore` | 忽略（**务必含三个产物**，防自扫描循环） | 见模板 |
| `idPattern` | 条目 id 校验正则 | `^([A-Z]+)-(\d+)$` |
| `prefixes` | 条目前缀名表（lint 校验未知前缀） | `{}` |
| `allowOrphanEntries` | 允许暂无文档引用的条目 ID（首次部署的种子条目） | `[]` |
| `entryFiles` | 条目文件（`## 标题` → 节点）：`heading` 正则 + `type` | 见模板 |
| `refSections` | ref 边节关键词（子串匹配）：命中 L2 标题，或**非标题行行首**出现（如条目内 `**相关历史条目**:` 加粗块，可切 section 至下一标题） | `["相关历史条目"]` |
| `refEntryFiles` | ref 边指向的条目文件 | `["docs/CHANGELOG.md"]` |
| `checklistHeadings` | checklist 边所在章节（子串匹配） | `["必须保证的功能","回归清单"]` |
| `checklistSourceColumn` | 回归清单「来源」列表头 | `"来源"` |
| `tableEdges` | 自定义表格→边 | `[]` |
| `repo` | 代码仓库关联：`enabled`、`linksFile`（默认 `docs/repo-links.json`）、`snapshotMarkdown`（默认 `docs/REPO.md`，自动免扫描）、`maxCommitNodes` | 见模板 |
| `output` | graph.json / GRAPH.md / graph.mmd 路径 | 见模板 |

> `install.py` / MCP `deploy` 首次接入且 `docs/CHANGELOG.md` 不存在时，会写入一条
> `DG-001`（已有前缀则沿用）种子条目，并自动补 `prefixes` 与 `allowOrphanEntries`，
> 让第一次 `graphgen.py --check` / `doclint.py` 就能通过；已有条目文件绝不覆盖或追加。

### tableEdges 示例

```json
{
  "file": "AGENTS.md",
  "headings": ["源码 → 功能文档映射"],
  "srcCol": 0, "docCol": 1,
  "kind": "owns"
},
{
  "file": "docs/README.md",
  "headings": ["子模块文档索引"],
  "linkCol": 1,
  "kind": "index"
}
```

## MCP 服务端（v0.3 推荐）

```powershell
node mcp\install.mjs --install-dir D:\tools\graphgen-mcp
node mcp\install.mjs --install-dir D:\tools\graphgen-mcp --doctor
```

- 全局注册 `mcp.graphgen`；**一份运行时**服务所有项目，新项目首次调用自动补引擎。
- 工具：`status` / `deploy` / `query` / `repo` / `verify`（详见 `mcp/README.md`）。
- 初始化 `initialize.instructions` 每轮注入：新项目先 `status`、缺引擎直接 `deploy`、
  改完文档 `generate` + `verify`、改完自己提交（不 push）。

`mcp/config.json` 关键字段：

| 字段 | 默认 | 含义 |
|------|------|------|
| `engineRoot` | `../engine` | 引擎目录（相对 config.json） |
| `python` | `auto` | `python` / `py -3` / 绝对路径 |
| `autoDeploy` | `true` | 缺引擎时先做冲突预检，无冲突自动部署（`false` 只报告） |
| `sourceRoot` | 安装时写入 | MCP 源仓库；自动部署跳过它 |
| `deploy.vcs` / `vcsInit` | `auto` / `false` | 无仓库不自动建库；需要时显式打开 |
| `deploy.vcsCommit` | `false` | 建库后不自动提交 |
| `deploy.hooks` / `plugin` | `false` | 默认不装钩子、不装监听插件 |
| `deploy.snapshot` / `agents` | `true` | 生成快照 / 追加 AGENTS 片段 |

## opencode 插件（可选，`--plugin`）

v0.3 默认不装插件；需要“保存即重生成”时用 `install.py --plugin`（或 `deploy` 的 `plugin: true`）。
手动拷贝时把 `skills/graphgen/SKILL.md`、`src/index.ts` 放入
`<目标>/.opencode/skills/graphgen/SKILL.md`、`<目标>/.opencode/plugins/graphgen-watch.ts`。
插件为 **opencode V2 插件 API**（`Plugin.define`，需 opencode ≥ 2.0）。运行时 `@opencode/plugin` 由
opencode 自行解析，`<目标>/.opencode/package.json` 的依赖声明仅供编辑器类型检查。
插件行为：

- 监听 `filesystem.changed`（兼容 `file.edited`），白名单：`docs/**`（排除 `docs/graph.*` 防自触发）、
  `AGENTS.md`、`.opencode/skills/*/SKILL.md`、`tools/graphgen.config.json`，1.5s 去抖后自动重生成。
- 注册 `graphgen_query` 工具（action=query / generate / check / doclint）。
- 注册 `repo_query` 工具（action=status / init / snapshot / links / guard）。
- `session.hook("context")` 每轮注入常驻记忆「改完自己提交」（`GRAPHGEN_AUTO_COMMIT=0` 关闭）；
  记忆要求只提交本次改动文件、不 push、不 amend。compaction 摘要也会保留该约定提示。
- compaction 摘要请求注入“graphgen_query / repo_query 保持可用”提示，卸载时中止事件流并清理定时器。

## 代码仓库管理（repo.py）

与 graphgen/doclint 平级的第三个引擎，配置 `tools/repo.config.json`（模板 `tools/repo.config.template.json`）。

| 子命令 | 作用 | 产物 |
|--------|------|------|
| `detect` | 识别 `.git/.hg/.svn`、仓库根、是否只是父仓库子目录 | — |
| `status` | 分支/HEAD/远端/工作区/上游 ahead-behind | — |
| `init` | 建库（git 优先；svn 需 `--remote`；`--dry-run` 预览） | `.git` / `.hg` |
| `snapshot` | 部署侧快照（含主机/用户/平台/目录） | `docs/repo.json`、`docs/REPO.md` |
| `links` | 扫提交，抽条目 ID（正则来自 graphgen `prefixes`） | `docs/repo-links.json` |
| `guard` | `--stage commit\|commit-msg\|push`，只读检查 | — |

- 图谱集成：`repo.enabled` 时读 `linksFile`，生成 `COMMIT:<短哈希>` 节点与 `touches` 边（条目→提交）；
  索引里已删除的条目**静默跳过**，避免历史索引把 `--check` 变成红灯。
- `docs/REPO.md` 是 AUTO-GENERATED，已自动加入 `scan.ignore` 与 `.gitignore`（本地部署记录）；doclint **R8**\n  在发布/CI 校验其 HEAD 与当前一致（提交钩子用 `DOCLINT_SKIP_R8=1` 跳过）。
- 护栏默认只警告（`entryIdMode`/`changelogMode` = `warn`），改 `error` 才阻断提交；护栏不执行
  `add/commit/push`。

## 约定（引擎默认支持的文档规范）

- **条目文件**：`## <PREFIX>-<NNN>: 标题（YYYY-MM-DD）` 形式，GitHub 式锚点。
- **回归清单**：`## 必须保证的功能（回归清单）` 表格，含「来源」列（引用条目 id）。
- **相关历史条目**：只放链接 `[X-NNN](CHANGELOG.md#...)`，不内嵌详情。
- **META 节点**：`AGENTS.md` → `META:AGENTS`，`.opencode/README.md` → `META:opencode-README`，
  skills → `SKILL:xxx`（约定项，仅当这些文件存在并加入扫描时生效）。

> 注意：`bootstrap/` 与上面几项不同——它不是 `--init` 的产物，而是**装到接收机全局层**
> `~/.config/opencode/` 的引导器（技能 `skills/graphgen-bootstrap/` + 插件 `plugins/graphgen-bootstrap.ts`），
> 通过 `bootstrap/install-bootstrap.ps1`（Windows）或 `bootstrap/install-bootstrap.sh`（Unix）安装。
> 其作用是让「项目里出现 `graphgen-dist/` 即自动安装」，由智能体/插件读取本包后自助完成 `--init`。

## 维护说明（dist 镜像同步）

- 分发资产的**源**都在本仓库：`skills/graphgen/SKILL.md`、`src/index.ts`、`tools/graphgen.py`、
  `tools/graphgen.config.template.json`、`templates/agents-snippet.md`、`bootstrap/`。
- 消费方 live 文件（`.opencode/` 下技能/插件、`tools/graphgen.py` 等）只经
  `python install.py --target <项目>` 更新，不手改。
- 各项目 `tools/graphgen-dist/` 是供 `graphgen.py --init` 自包含分发的**镜像**（仓库改完后手动同步一次，
  以仓库路径为源）：

```powershell
Copy-Item skills\graphgen\SKILL.md <项目>\tools\graphgen-dist\skill-graphgen.md
Copy-Item src\index.ts <项目>\tools\graphgen-dist\plugin-graphgen-watch.ts
Copy-Item tools\graphgen.py <项目>\tools\graphgen-dist\graphgen.py
Copy-Item tools\graphgen.config.template.json <项目>\tools\graphgen-dist\
Copy-Item templates\agents-snippet.md <项目>\tools\graphgen-dist\AGENTS-snippet.md
Copy-Item bootstrap\* <项目>\tools\graphgen-dist\bootstrap\ -Recurse -Force
```

- `--init` 从**自身**（`__file__`）复制引擎：若直接跑项目内 `tools/graphgen.py`，安装的是最新引擎；
  若从 dist 跑，则安装的是 dist 内副本——务必保持上述镜像同步。
- 仓库有改动后需重新打包 `dist/opencode-graphgen-<版本>.zip`；解压并改名为 `graphgen-dist/` 放入
  项目根，即触发全局引导器按 `install.py` 自动安装（V2 依赖）。
