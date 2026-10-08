# opencode-graphgen 安装文档

文档图谱 graphgen + 文档防漂移 doclint 的全家桶安装指南。本仓库**自包含**：插件、技能、引擎、doclint、模板、安装器都在这里，拷走即可在任何项目安装。

> graphgen 引擎配置字段参考见 `graphgen-config.md`；本文只讲安装。

## 1. 包内容（文件清单）

| 文件/目录 | 说明 | 必装 |
|------|------|------|
| `tools/graphgen.py` | 图谱引擎（纯 stdlib） | 是 |
| `tools/graphgen.config.template.json` | 图谱配置模板（`{{NAME}}` 占位由安装替换为项目名） | 是 |
| `tools/doclint.py` | 文档漂移机械校验（R1-R7 + 生成块，配置驱动） | 是 |
| `tools/gen_doc_slice.py` | 生成块写回工具（menu/filelist slice） | 与 markers 配合 |
| `src/index.ts` | opencode 插件：文件事件自动重生成 + `graphgen_query`（query/generate/check/doclint） | 可选 |
| `skills/graphgen/SKILL.md` | opencode 技能（查反链/跑生成器/防漂移指南） | 可选 |
| `templates/` | `doclint.config.example.json`、`pre-commit` 钩子、`agents-snippet.md` 片段 | — |
| `install.py` | 统一安装器（下述方式 A） | — |
| `bootstrap/` | 全局自安装引导器（装到 `~/.config/opencode/` 一次，之后任意项目拷包即自动安装） | 可选 |

## 2. 前置要求

- **Python 3.10+**（仅用标准库）
- 目标项目已有 `docs/` 目录，以及一份条目文件（默认 `docs/CHANGELOG.md`）
- opencode 增强（skill/plugin）**可选**，不装也能用命令行
- Windows 下建议先 `$env:PYTHONIOENCODING='utf-8'` 防中文乱码

## 3. 安装

### 方式 A：统一安装器（推荐）

```powershell
python <本仓库>\install.py --target <目标项目目录> [--hooks]
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
| `<目标>/.opencode/plugins/graphgen-watch.ts` | 插件 |
| `<目标>/.opencode/skills/graphgen/` | 技能（覆盖=同步更新） |
| `<目标>/.opencode/package.json` | `@opencode-ai/plugin` 依赖（仅缺时补） |
| `<目标>/tools/git-hooks/pre-commit` + `core.hooksPath` | 仅 `--hooks`：pre-commit 硬闸（doclint + graphgen --check） |
| `<目标>/AGENTS.md` | 无则创建；已有且无安装标记则追加工作流片段（含防漂移配对表） |

### 方式 B：手动拷贝

```powershell
# 1. 必需：引擎 + doclint
Copy-Item <仓库>\tools\graphgen.py, <仓库>\tools\graphgen.config.template.json, <仓库>\tools\doclint.py, <仓库>\tools\gen_doc_slice.py <目标>\tools\
# 2. 配置（缺省才拷）
Copy-Item <仓库>\tools\graphgen.config.template.json <目标>\tools\graphgen.config.json   # 编辑 name/prefixes
Copy-Item <仓库>\templates\doclint.config.example.json <目标>\tools\doclint.config.json   # 按需开关规则
# 3. 可选增强：技能 + 插件 + 依赖声明
#    <目标>\.opencode\skills\graphgen\SKILL.md            ← skills/graphgen/SKILL.md
#    <目标>\.opencode\plugins\graphgen-watch.ts          ← src/index.ts
#    <目标>\.opencode\package.json 加 {"dependencies": {"@opencode-ai/plugin": "1.18.7"}}
# 4. 可选：templates\agents-snippet.md 追加到 <目标>\AGENTS.md；templates\pre-commit → tools/git-hooks/
# 5. 首次生成（必需）
cd <目标>
$env:PYTHONIOENCODING='utf-8'
python tools\graphgen.py
```

### 方式 C：一次性全局自安装（接收方零指令）

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
2. 用 opencode 打开该项目。**插件**会在启动时自动完成安装（日志 `service=graphgen-bootstrap`）；失败则**智能体**按引导技能自助安装。
3. 安装后项目根生成/追加 `AGENTS.md`：**中文汇报**、**改动工作流**、**图谱同步**、**文档防漂移** 四段规则。
4. 首次配置 `tools/graphgen.config.json` 的 `prefixes` 与 `tools/doclint.config.json` 规则开关，跑 `--check` / `doclint` 验证。
5. 重启 opencode，技能/插件生效。

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
```

opencode 内验证（装了插件后**重启 opencode**）：

- 工具 `graphgen_query`：`action=check` / `action=query node=BUG:xxx`（支持简称 `g-004`）/ `action=generate` / `action=doclint`
- 修改任一 `docs/*.md` → 约 1.5s 后自动重生成（日志 `service=graphgen-watch`）

## 6. 卸载

删除目标项目内：`tools/graphgen.py`、`tools/graphgen.config.json`、`tools/doclint.py`、`tools/gen_doc_slice.py`、`tools/doclint.config.json`、`tools/git-hooks/`、
`.opencode/skills/graphgen/`、`.opencode/plugins/graphgen-watch.ts`、
`docs/graph.json` / `docs/GRAPH.md` / `docs/graph.mmd`；
并从 `AGENTS.md` 移除 `## 文档图谱 graphgen + 防漂移 doclint（已安装）` 片段（`git config --unset core.hooksPath` 若曾启用钩子）。

## 7. 常见问题

- **中文乱码**：先 `$env:PYTHONIOENCODING='utf-8'`。
- **`--check` 报「未知前缀」**：在 `prefixes` 补前缀，或修正 CHANGELOG 标题。
- **产物文件名冲突**：产物固定 `docs/GRAPH.md`（大写）。功能文档**勿用 `graph.md`**（Windows 大小写不敏感时与产物同文件）。
- **插件不生效**：确认 `.opencode/package.json` 含 `@opencode-ai/plugin`，并重启 opencode（自动 `bun install`）。
- **doclint 找不到配置**：`tools/doclint.config.json` 缺失，从 `templates/doclint.config.example.json` 拷贝，或用 `--config` 指定。
- **引擎版本同步**：本仓库 `tools/graphgen.py` 是唯一事实源；消费项目一律经 `install.py` 更新，勿在消费方手改。
