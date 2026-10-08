# opencode-graphgen

opencode 文档图谱（graphgen）+ 文档防漂移（doclint）**全家桶**——本仓库是两套工具的唯一事实源，经 `install.py` 分发到各消费项目。

## 组成

| 组件 | 路径 | 作用 |
|------|------|------|
| 图谱引擎 | `tools/graphgen.py` | 扫描 markdown → `docs/graph.json` / `docs/GRAPH.md` / `docs/graph.mmd`，带 lint（`--check`） |
| 防漂移校验 | `tools/doclint.py` | 文档与事实源机械比对：R1 章节编号 / R2 菜单 / R3 清单 / R4 路由 / R5 白名单 / R6 凭据 / R7 条目文件 / markers 生成块 |
| 生成块工具 | `tools/gen_doc_slice.py` | 按 `tools/doc-slices.json` 把事实源生成结果写回 `<!-- gen:name -->` 块 |
| opencode 插件 | `src/index.ts` | 文件事件自动重生成 + `graphgen_query` 工具（query/generate/check/**doclint**）+ compaction 后工具提示 |
| 技能 | `skills/graphgen/SKILL.md` | 教智能体查反链/跑生成器/跑防漂移 |
| 安装器 | `install.py` | 一键把全家桶幂等装进目标项目（`--hooks` 附 pre-commit 硬闸） |
| 模板 | `templates/` | doclint 示例配置、pre-commit 钩子、AGENTS 工作流片段 |
| 全局引导器 | `bootstrap/` | 装到 `~/.config/opencode/` 一次，之后任意项目拷包自动安装 |

## 快速开始

```powershell
# 安装到目标项目（含 pre-commit 硬闸）
python install.py --target <目标项目> --hooks

# 在目标项目验证
cd <目标项目>
$env:PYTHONIOENCODING='utf-8'
python tools/graphgen.py --check    # 图谱 lint
python tools/doclint.py             # 文档防漂移
```

详细安装方式（安装器 / 手动 / 全局引导器）见 [INSTALL.md](INSTALL.md)；图谱引擎配置字段见 [graphgen-config.md](graphgen-config.md)。

## 消费项目速查

装完后在消费项目里：

- `python tools/graphgen.py` 生成/重生成图谱；`--check` 只 lint。
- `python tools/doclint.py` 文档防漂移（配置 `tools/doclint.config.json`）。
- `python tools/gen_doc_slice.py --write` 回写生成块。
- opencode 内：`graphgen_query` 工具的 `action=query|generate|check|doclint`；改 `docs/**` 自动重生成。
- `git commit` 自动跑 doclint + graphgen `--check`（`--hooks` 安装时）。

## 维护约定（本仓库）

- **唯一事实源**：插件/技能/引擎/doclint/模板只在这里改；消费项目（openfbx、code_grbk 等）一律用 `install.py` 更新，禁止在消费方手改拷贝。
- 改完本仓库工具后：在各消费项目重跑 `install.py`，并跑 `python tools/graphgen.py --check` 与 `python tools/doclint.py` 验证（消费项目内）。
- 引擎同步历史：`tools/graphgen.py` 自 openfbx 仓库迁入；openfbx 现为其消费方。
- 汇报/文档用**中文**。

## 消费项目一览

| 项目 | 路径 | 说明 |
|------|------|------|
| openfbx | `F:\shiyan\CLion\openfbx` | graphgen 上游历史仓库，已迁为消费方（`DG-009`） |
| 3道山商城 code_grbk | `F:\phpstudy_pro\WWW\code_grbk` | ThinkPHP 商城，doclint R1-R7 全开 |
