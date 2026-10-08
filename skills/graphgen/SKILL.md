---
name: graphgen
description: Run the graphgen knowledge-graph generator/linter and the doclint anti-drift checker for the project's markdown docs (regenerate docs/graph.json / docs/GRAPH.md / docs/graph.mmd, run --check lint gate, query backlinks, run python tools/doclint.py for doc-drift R1-R7)
---

# graphgen 技能

> 教你使用本项目的文档图谱生成器与防漂移校验器，以及如何查反链、如何跑 lint。
> 引擎：`tools/graphgen.py`（通用、stdlib、配置驱动），配置：`tools/graphgen.config.json`。
> 防漂移：`tools/doclint.py`（配置驱动），配置：`tools/doclint.config.json`。

## 何时使用

- 需要查某个条目（如 `BUG:XX-###`）被哪些文档引用、某份文档的回归清单覆盖哪些条目、某个源文件归哪份文档管。
- 改完文档/条目文件/AGENTS 后，需要确认图谱没有失同步。
- 需要重新生成 `docs/graph.json` / `docs/GRAPH.md` / `docs/graph.mmd`。
- 改完文档后需要确认没有引入**文档漂移**（编号/菜单/清单/路由/白名单/凭据/条目格式/生成块）。

## 核心命令

```powershell
# 生成全部产物（graph.json / GRAPH.md / graph.mmd）
$env:PYTHONIOENCODING='utf-8'   # Windows 上防中文乱码
python tools/graphgen.py

# 只做 lint 校验（不写文件），有错则 exit 1
python tools/graphgen.py --check
```

- 引擎本身不依赖任何第三方库（stdlib 即可）。
- 产物的 `docs/graph.json` 才是规范数据源：每个节点自带 `backlinks[]`（from/kind/context）。
  查反链优先读它，**不要**对 `docs/` 全库 grep。
- `docs/GRAPH.md` 与 `docs/graph.mmd` 由生成器产出，**禁手改**。

## 文档防漂移 doclint

```powershell
$env:PYTHONIOENCODING='utf-8'
python tools/doclint.py                    # 全量校验，期望 doclint: OK（有错 exit 1）
python tools/gen_doc_slice.py --write      # 生成块回写（tools/doc-slices.json 驱动）
python tools/gen_doc_slice.py --check      # 只校验生成块
```

- 规则（`tools/doclint.config.json` 逐条开关/配参）：
  `R1` 章节编号唯一/层级/连续；`R2` 菜单源 vs 文档菜单块；`R3` 目录清单 vs 文档清单；
  `R4` 应用目录 vs 路由表；`R5` 静态白名单例外；`R6` 凭据/散列；`R7` 条目文件编号连续/日期/「相关历史条目」；`markers` 生成块一致性。
- 改**事实源**（菜单 HTML、种子目录、路由、白名单、条目文件）后：先改对应文档，再跑 doclint 验证。
- 生成块 `<!-- gen:name -->` 禁手改：改 `tools/doc-slices.json` 或事实源后 `gen_doc_slice.py --write`。
- 装了 `--hooks` 的仓库，`git commit` 会自动跑 doclint + `graphgen.py --check`，不过即拦。

## 节点与边速查

| 前缀 | 含义 | 例子（节点 id 视项目配置而定） |
|------|------|------|
| `BUG:` | 条目文件条目（如 CHANGELOG） | `BUG:G-004` |
| `DOC:` | 功能文档（docs/*.md） | `DOC:gizmo` |
| `SKILL:` | opencode 技能（.opencode/skills/*/SKILL.md） | `SKILL:graphgen` |
| `META:` | AGENTS / 条目文件本体 等 | `META:AGENTS` |
| `SRC:` | 源码文件（映射表「源码」列） | `SRC:src/Viewer.cpp` |

| kind | 含义 |
|------|------|
| `ref` | 「相关历史条目」引用（指向条目文件的带锚点链接） |
| `checklist` | 回归清单保证项（context 带原文） |
| `mention` | 普通正文链接/反引号路径 |
| `index` | 索引表（README / AGENTS 子模块表） |
| `owns` | 源码→功能文档归属（映射表） |

## 常用查询示例（读 graph.json）

```python
import json
g = json.load(open("docs/graph.json", encoding="utf-8"))
print(g["nodes"]["BUG:G-004"])              # 节点元数据（label/path/anchor）
print(g["backlinks"]["BUG:G-004"])          # 反链：[{from, kind, context}]
print(g["outlinks"]["BUG:G-004"])           # 出链（如有）
```

## 配置字段速查（tools/graphgen.config.json）

| 字段 | 含义 |
|------|------|
| `scan.roots` / `scan.extraFiles` / `scan.ignore` | 扫描目录 / 单文件 / 忽略（产物三文件必忽略） |
| `entryFiles` | 条目文件：`## 标题` 匹配 `heading` 正则 → `type` 节点（如 BUG） |
| `prefixes` | 条目前缀名，lint 校验未知前缀 |
| `refSections` / `refEntryFiles` | ref 边：相关历史条目节内（L2 标题或行首 `**相关历史条目**:` 加粗块）、指向条目文件的带锚点链接 |
| `checklistHeadings` / `checklistSourceColumn` | checklist 边：回归清单表格 + 来源列 |
| `tableEdges` | 自定义表格→边（AGENTS 映射 owns、README 索引 index 等） |
| `output` | 三个产物路径 |

## 注意事项

- 改动 `docs/`、`AGENTS.md`、`.opencode/skills/*/SKILL.md`、`.claude/skills/`、`tools/graphgen.config.json` 后，
  若插件（graphgen-watch）未自动重生成，请手动跑 `python tools/graphgen.py` 并确认 `--check` 通过。
- 改完文档随手跑 `python tools/doclint.py`；条目文件改动尤其看 R7 提示。
- 新增条目/文档引用后，跑 `--check` 确认无「孤儿条目」警告。
- 出现 lint 错误时按提示修复文档（多为锚点写错/引用缺失条目），不要手改产物文件。
- 引擎文件改动不影响本 skill 的命令。
