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
| `entryFiles` | 条目文件（`## 标题` → 节点）：`heading` 正则 + `type` | 见模板 |
| `refSections` | ref 边节关键词（子串匹配）：命中 L2 标题，或**非标题行行首**出现（如条目内 `**相关历史条目**:` 加粗块，可切 section 至下一标题） | `["相关历史条目"]` |
| `refEntryFiles` | ref 边指向的条目文件 | `["docs/CHANGELOG.md"]` |
| `checklistHeadings` | checklist 边所在章节（子串匹配） | `["必须保证的功能","回归清单"]` |
| `checklistSourceColumn` | 回归清单「来源」列表头 | `"来源"` |
| `tableEdges` | 自定义表格→边 | `[]` |
| `output` | graph.json / GRAPH.md / graph.mmd 路径 | 见模板 |

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

## opencode 增强（可选）

`--init` 已自动接入。若手动拷贝，只需把 `skill-graphgen.md`、`plugin-graphgen-watch.ts` 放入
`<目标>/.opencode/skills/graphgen/SKILL.md`、`<目标>/.opencode/plugins/graphgen-watch.ts`。
插件为 **opencode V2 插件 API**（`Plugin.define`，需 opencode ≥ 2.0）。运行时 `@opencode/plugin` 由
opencode 自行解析，`<目标>/.opencode/package.json` 的 `@opencode/plugin` 依赖声明仅供编辑器
类型检查（V2 不会自动 `bun install`）。插件行为：

- 监听 `filesystem.changed`（兼容 `file.edited`），白名单：`docs/**`（排除 `docs/graph.*` 防自触发）、
  `AGENTS.md`、`.opencode/skills/*/SKILL.md`、`tools/graphgen.config.json`，1.5s 去抖后自动重生成。
- 注册 `graphgen_query` 工具（action=query / generate / check / doclint）。
- compaction 摘要请求注入“graphgen_query 保持可用”提示，卸载时中止事件流并清理定时器。

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
