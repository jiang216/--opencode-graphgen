# opencode-graphgen 仓库规范

文档图谱（graphgen）+ 文档防漂移（doclint）+ 仓库管理（repo）全家桶的**唯一事实源**仓库。
v0.3 起以 `mcp/` 服务端为主；改动本仓库工具后，用 MCP `gcgl_deploy` 或 `install.py` 同步消费项目。

## 目录

- `mcp/` — MCP 服务端（`server.mjs`）+ 安装器（`install.mjs`）+ 自检（`mcp-test.mjs`）
- `src/index.ts` — 旧 opencode 插件（仅 `--plugin` 安装；watch 自动重生成 + `graphgen_query`/`repo_query`）
- `tools/graphgen.py` — 图谱引擎；`tools/doclint.py` — 防漂移校验；`tools/gen_doc_slice.py` — 生成块写回
- `tools/repo.py` — 仓库适配层；`tools/repo.config.template.json` — 仓库配置模板
- `skills/graphgen/SKILL.md` — 技能；`templates/` — 配置/钩子/AGENTS 片段模板
- `install.py` — 统一安装器（可调用 + `--json`）；`bootstrap/` — 旧全局引导器
- `scripts/release.mjs` — 一键发布（升版本 → 自检 → 打包 → tag → push；有 `gh` 时建 Release）
- `README.md` / `INSTALL.md` / `graphgen-config.md` / `mcp/README.md` — 对外文档

## 强制约定

1. **中文汇报**：完成后用中文汇报做了什么、验证结果、遗留问题。
2. **唯一事实源**：本仓库外不手改拷贝（消费项目的 `tools/*.py`、插件、技能都是安装产物）；同步用 MCP `gcgl_deploy` 或 `python install.py --target <项目> [--hooks] [--plugin]`。
3. **改工具必验证**：
   - `node mcp/mcp-test.mjs` 0 失败
   - `node mcp/install.mjs --doctor`（已装运行时）或临时目录装一份后 `graphgen --check` 0 错 0 警 + `doclint` OK
   - 变异测试：故意注入一处漂移（如删路由表一行）→ doclint 必须报错 → 恢复
4. **配置驱动**：`doclint.py` 不得硬编码任何消费项目路径；项目差异一律进该项目的 `tools/doclint.config.json`。
5. **幂等**：`install.py` / `mcp/install.mjs` 重复执行安全；`AGENTS.md` 片段靠 `<!-- graphgen:installed -->` 防重复追加。
6. **提交**：完成一批改动后由 agent **自己提交**，不要让用户手动 `git commit`；只 `git add` 本次任务动过的文件，不 push、不 amend 他人提交、不改全局 git 配置；不含 `.env`、密钥、`node_modules/`、`dist/`。
7. **发布**：发版统一走 `node scripts/release.mjs`（`--bump`/`--dry-run`/`--zip-only`），不要手工打包或手打 tag；
   它是唯一允许 push 的入口，且只在用户明确要求发版时执行。发版前工作区必须干净。

## 消费项目

| 项目 | 路径 | doclint 配置 |
|------|------|--------------|
| openfbx | `F:\shiyan\CLion\openfbx` | R1+R6+R7（G/R/CAM/UI/M/TH/DG/B 多前缀） |
| code_grbk | `F:\phpstudy_pro\WWW\code_grbk` | R1-R7 全开 + markers |

消费方改动文档后的汇报遵循其各自 AGENTS.md（openfbx 须给 `docs/CHANGELOG.md` 追加 `DG-###` 条目并更新 `docs/docgraph.md`）。
