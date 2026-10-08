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
   # 新包（全家桶：图谱 + 防漂移 doclint + 插件 + 技能 + 模板）
   python <包>\install.py --target <项目根目录> [--hooks]
   # legacy dist 包（仅图谱）
   python <包>\graphgen.py --init <项目根目录> [--name 项目名]
   ```

   `install.py` 幂等（重复执行=同步更新）：拷贝引擎/doclint/插件/技能，缺省时生成
   `tools/graphgen.config.json`、`tools/doclint.config.json`，补 `.opencode/package.json` 依赖，
   `--hooks` 附 pre-commit 硬闸，无 `--no-agents` 时创建/追加 `AGENTS.md` 工作流片段（marker 防重复）。
5. **首次配置**：编辑 `tools/graphgen.config.json`（`prefixes` 必须填条目前缀表）与 `tools/doclint.config.json`（按项目开关 R2-R5、配 `requireHistory`）。
6. **验证**：
   ```powershell
   python tools\graphgen.py --check   # 期望 0 errors / 0 warnings
   python tools\graphgen.py           # 生成 docs/graph.json / GRAPH.md / graph.mmd
   python tools\doclint.py            # 期望 doclint: OK
   ```
7. **提示重启**：安装后 opencode 需**重启**才能加载新的 graphgen 技能/插件。重启后即可用 `graphgen_query`（含 `action=doclint`）工具与自动重生成。

## 注意事项

- 若安装因 python 不在 PATH 失败：提示用户装 Python 或用完整路径；也可退化为「方式 B 手动拷贝」（见 INSTALL.md）。
- 包文件夹本身是**分发物**，安装后可留作参考或删除（工具已拷到 `tools/` 与 `.opencode/`）。
- 安装完成后，日常使用/查反链参考已安装的 `graphgen` 技能（`.opencode/skills/graphgen/SKILL.md`）。
