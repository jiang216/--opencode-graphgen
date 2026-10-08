## 文档图谱 graphgen + 防漂移 doclint（已安装）

> 由 `python install.py --target <本项目>` 安装（或旧路 `python tools/graphgen.py --init`）。产物 `docs/graph.json` / `docs/GRAPH.md` / `docs/graph.mmd` 为 **AUTO-GENERATED，禁手改**。

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
- 查反链优先读 `docs/graph.json`（每节点自带 `backlinks[]`），勿对 docs/ 全库 grep。
- 节点 id：`BUG:xx-###`（条目文件，如 CHANGELOG）/ `DOC:xxx`（docs/*.md）/ `SKILL:xxx`（技能）/ `META:xxx`（AGENTS、条目文件本体）/ `SRC:xxx`（源码映射表）。
- 边 kind：`ref`（相关历史条目引用）/ `checklist`（回归清单保证项，context 带原文）/ `mention`（正文链接）/ `index`（索引表）/ `owns`（源码归属）。
- 配置字段说明见本插件包 `graphgen-config.md`（模板：`tools/graphgen.config.json`）。

### 文档防漂移 doclint（强制）

- 改完文档后跑 `python tools/doclint.py`，必须 0 错误；`docs/CHANGELOG.md` 新增条目需满足 R7（编号连续、日期、起始条目含「相关历史条目」）。
- 配置在 `tools/doclint.config.json`（规则 R1-R7 逐条开关/配参，生成块 markers 也在其中）。
- 文档出现**生成块**时（`<!-- gen:name -->`）：事实源改完后跑 `python tools/gen_doc_slice.py --write` 回写，禁手改块内内容。
- 已装钩子则 `git commit` 自动跑 doclint + `graphgen.py --check`，不过即拦（绕过 `--no-verify`，不建议）。

### 文档同步配对表（防漂移，按本项目事实源裁剪）

| 改动 | 必须同步 | 规则 |
|------|----------|------|
| （在此登记：菜单/种子/路由/白名单等事实源 ↔ 文档） | 对应文档小节或清单 | R2-R5 |
| 文档出现密钥/散列 | 移除；真实值只放 `.env`/环境变量 | R6 |
| `docs/CHANGELOG.md` 新增条目 | 编号连续、标题带（YYYY-MM-DD）、起始条目含「相关历史条目」 | R7 |
| 插入/删除文档章节 | 同级编号顺延重排 | R1 |

<!-- graphgen:installed -->
