# opencode-graphgen 仓库规范

文档图谱（graphgen）+ 文档防漂移（doclint）全家桶的**唯一事实源**仓库。改动本仓库工具后，需在各消费项目重跑 `install.py` 同步。

## 目录

- `src/index.ts` — opencode 插件（watch 自动重生成 + `graphgen_query` 工具 + compaction 钩子）
- `tools/graphgen.py` — 图谱引擎；`tools/doclint.py` — 防漂移校验；`tools/gen_doc_slice.py` — 生成块写回
- `skills/graphgen/SKILL.md` — 技能；`templates/` — 配置/钩子/AGENTS 片段模板
- `install.py` — 统一安装器；`bootstrap/` — 全局引导器
- `README.md` / `INSTALL.md` / `graphgen-config.md` — 对外文档

## 强制约定

1. **中文汇报**：完成后用中文汇报做了什么、验证结果、遗留问题。
2. **唯一事实源**：本仓库外不手改拷贝（消费项目的 `tools/*.py`、插件、技能都是安装产物）；同步一律 `python install.py --target <项目> [--hooks]`。
3. **改工具必验证**（在任一消费项目，如临时目录装一份）：
   - `python tools/graphgen.py --check` 0 错 0 警
   - `python tools/doclint.py` OK
   - 变异测试：故意注入一处漂移（如删路由表一行）→ doclint 必须报错 → 恢复
4. **配置驱动**：`doclint.py` 不得硬编码任何消费项目路径；项目差异一律进该项目的 `tools/doclint.config.json`。
5. **幂等**：`install.py` 重复执行安全；`AGENTS.md` 片段靠 `<!-- graphgen:installed -->` 防重复追加。
6. **提交**：仅在用户明确要求时提交；不 push；不含 `.env`、密钥、`node_modules/`。

## 消费项目

| 项目 | 路径 | doclint 配置 |
|------|------|--------------|
| openfbx | `F:\shiyan\CLion\openfbx` | R1+R6+R7（G/R/CAM/UI/M/TH/DG/B 多前缀） |
| code_grbk | `F:\phpstudy_pro\WWW\code_grbk` | R1-R7 全开 + markers |

消费方改动文档后的汇报遵循其各自 AGENTS.md（openfbx 须给 `docs/CHANGELOG.md` 追加 `DG-###` 条目并更新 `docs/docgraph.md`）。
