---
name: graphgen-bootstrap
description: When the project contains an opencode-graphgen/ package folder (or legacy graphgen-dist/) but the graphgen+doclint toolchain is not installed yet, auto-install it by reading the package INSTALL.md and running its install.py; also use when asked to install graphgen/doclint or the doc graph.
---

# graphgen 自安装引导技能

> 目的：当项目里出现 `opencode-graphgen/`（graphgen+doclint 全家桶包，或 legacy `graphgen-dist/`）但尚未安装时，由你（智能体）读取该包并**自动完成安装**，生成 `tools/`、`.opencode/skills|plugins`、配置与文档图谱。
> 全局安装：本技能常驻 `~/.config/opencode/skills/graphgen-bootstrap/`，任何项目都可用。

## 何时使用

- 项目根目录存在 `opencode-graphgen/`（或 `graphgen-dist/`、`tools/` 下同名目录）文件夹，且 `tools/graphgen.py` / `.opencode/skills/graphgen/SKILL.md` 不存在（未安装）。
- 用户说「安装 graphgen」「把 opencode-graphgen 用起来」「生成文档图谱」「接防漂移」等。

## 安装步骤

1. **定位包**：优先找 `opencode-graphgen/`（内含 `install.py`），兼容 legacy `graphgen-dist/`（内含 `graphgen.py`）。记下绝对路径。
2. **判断是否已装**：`tools/graphgen.py` 与 `.opencode/skills/graphgen/SKILL.md` 任一不存在即为未装；已装则跳到第 6 步验证。
3. **读安装文档**：阅读 `<包>/INSTALL.md` 确认一键命令与前置要求（Python 3.10+，Windows 先设 `$env:PYTHONIOENCODING='utf-8'`）。
4. **一键安装**（在项目根目录执行）：

   ```powershell
   $env:PYTHONIOENCODING='utf-8'
   # 新包（全家桶：图谱 + 防漂移 doclint + 仓库管理 + 技能 + 模板；--plugin 才装监听插件）
   python <包>\install.py --target <项目根目录> [--hooks] [--plugin]
   # legacy dist 包（仅图谱）
   python <包>\graphgen.py --init <项目根目录> [--name 项目名]
   ```

   `install.py` 幂等（重复执行=同步更新）：拷贝引擎/doclint/技能/仓库适配层，缺省时生成
   `tools/graphgen.config.json`、`tools/doclint.config.json`、`tools/repo.config.json`；
   `--plugin` 才装监听插件并补 `.opencode/package.json` 依赖；
   `--hooks` 附 pre-commit/commit-msg 硬闸，无 `--no-agents` 时创建/追加 `AGENTS.md` 工作流片段（marker 防重复）。

   **代码仓库管理（install.py 自动做，无需额外命令）**：检测 `.git/.hg/.svn`；没有仓库且本机有 git → 自动
   `git init -b main` + 播种 `.gitignore` + 生成部署快照与条目索引；在父仓库内不建嵌套库；svn 需
   `--vcs-remote <URL>`；本机没有任何 VCS 工具时只打印安装指引（`winget install --id Git.Git -e`）并继续。
   如需关闭自动建库：`--no-vcs-init`；整步跳过：`--vcs none`。
5. **首次配置**：编辑 `tools/graphgen.config.json`（`prefixes` 必须填条目前缀表）与 `tools/doclint.config.json`（按项目开关 R2-R5、配 `requireHistory`）。
6. **验证**：
   ```powershell
   python tools\graphgen.py --check   # 期望 0 errors / 0 warnings
   python tools\graphgen.py           # 生成 docs/graph.json / GRAPH.md / graph.mmd
   python tools\doclint.py            # 期望 doclint: OK
   ```
7. **提示重启**：安装后 opencode 需**重启**才能加载新的 graphgen 技能。重启后即可用 `graphgen_query`（含 `action=doclint`）；默认无文件监听，改完文档要显式 `action=generate`（需要保存即重生成再加 `--plugin`）。

## 注意事项

- 若安装因 python 不在 PATH 失败：提示用户装 Python 或用完整路径；也可退化为「方式 B 手动拷贝」（见 INSTALL.md）。
- 若安装输出 `未检测到可用的 VCS 工具`：告诉用户代码仓库管理已跳过，装好 git 后重跑 `install.py` 即可；
  不要因为缺 VCS 中断安装（图谱/防漂移不依赖它）。
- 若安装输出 `位于 … 仓库 … 内，不建嵌套库`：这是防误建嵌套库的正常行为，除非用户明确要独立历史，
  否则不要加 `--allow-nested`。
- 包文件夹本身是**分发物**，安装后可留作参考或删除（工具已拷到 `tools/` 与 `.opencode/`）。
- 安装完成后，日常使用/查反链参考已安装的 `graphgen` 技能（`.opencode/skills/graphgen/SKILL.md`）。
