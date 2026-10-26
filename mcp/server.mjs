#!/usr/bin/env node
// graphgen MCP 服务端 —— 文档图谱 + 防漂移 + 仓库管理 + 项目部署
// 用法: node mcp/server.mjs
// 环境变量: GRAPHGEN_CONFIG=<config.json>  GRAPHGEN_PYTHON=<python.exe>  GRAPHGEN_AUTO_COMMIT=0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStdio } from "./stdio.mjs";
import { loadConfig } from "./config.mjs";
import { buildTools, readResource, RESOURCES } from "./tools.mjs";

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));

function readVersion() {
  const candidates = [
    process.env.GRAPHGEN_VERSION,
    fs.existsSync(path.join(HERE_DIR, "..", "VERSION"))
      ? fs.readFileSync(path.join(HERE_DIR, "..", "VERSION"), "utf8").trim()
      : null,
    path.join(HERE_DIR, "..", "engine", "package.json"),
    path.join(HERE_DIR, "..", "package.json"),
    path.join(HERE_DIR, "package.json"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === "string" && !c.endsWith(".json")) return c;
    try {
      const data = JSON.parse(fs.readFileSync(c, "utf8"));
      if (data.version) return data.version;
    } catch {
      /* ignore */
    }
  }
  return "0.3.0";
}

function autoCommitEnabled() {
  const v = (process.env.GRAPHGEN_AUTO_COMMIT ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

function instructions(cfg, version) {
  const memory = autoCommitEnabled()
    ? `
## 提交约定（常驻记忆 · 改动后自动提交）

- 完成一批改动后，**你自己提交**，不要让用户再手动 \`git commit\`；用户说“改完/继续/就这样”时同样适用。
- 提交前先 \`git status --short\`：只 \`git add\` 本次任务动过的文件，**不要**把用户其他未完成的改动、临时产物、密钥（.env 等）一起提交；分不清就先问。
- 提交信息：有对应文档条目就带条目 ID（如 \`fix(DG-009): ...\`，或正文 \`Refs: DG-009\`）；没有就用 \`chore:\`/\`docs:\` 并在正文说明改了什么。
- 提交前跑 \`gcgl_verify\`；不要 \`git push\`、不要 amend/rebase 别人的提交、不要改全局 git 配置。
- 提交后：有条目 ID 时跑 \`gcgl_repo action=links\`；发布/部署后再跑 \`gcgl_repo action=snapshot\`。
- 目标不是 git 仓库或本机没有 git 时：跳过提交并在汇报里说明。
`
    : "";
  return `# graphgen MCP（服务名 gcgl）

本服务端提供文档图谱（graphgen）+ 文档防漂移（doclint）+ 代码仓库管理（repo）+ 项目部署（deploy）。
引擎根目录: \`${cfg.engineRoot}\` · 版本 ${version} · autoDeploy=${cfg.autoDeploy ? "on" : "off"}

## 路由

- **新项目/第一次用**：先 \`gcgl_status\`。\`needsDeploy=true\` 且 \`conflicts=[]\` 时，直接调用 \`gcgl_deploy {target, confirm:true}\`；有冲突时先看 \`conflicts\`，确认后再加 \`force:true\`，不要盲覆盖。
- **自动初始化**：\`query/repo/verify\` 在项目未部署且无冲突时会先自动部署；有冲突只返回冲突列表，不写盘。空项目同样先部署再继续。首次缺 \`docs/CHANGELOG.md\` 会写入种子条目并补 \`prefixes\`/\`allowOrphanEntries\`；已有条目文件不覆盖。VCS：已记住 git 身份时按 \`deploy.vcsInit/vcsCommit\` 自动建库+首次提交；未配置身份时只部署工具/文档并返回 \`needsIdentity\`，不会偷偷 \`git init\`。
- **首次建库身份**：\`status\` 显示 \`project.identity.configured/remember\` 与 \`needsIdentity\` 建议。无身份时先问用户 \`user.name\` / \`user.email\`，再调用 \`gcgl_deploy {target, confirm:true, identity:{name,email}, rememberIdentity:true}\`；用户确认“以后都用”后写入 \`mcp/config.json\`，以后项目不再询问。只保存 name/email，**禁止把密码/PAT/token 写进配置**。
- **文档改动**：\`gcgl_query action=generate\` 重生成图谱；提交前 \`gcgl_verify\`。
- **查条目**：\`gcgl_query action=query node=DG-009\`（支持简称 g-004）。
- **仓库**：\`gcgl_repo action=status|snapshot|links|guard\`；init 需 confirm；无 VCS 返回 \`not_applicable\`，snapshot 用 \`mode=fs\`。
- **部署**：默认只出计划；\`confirm=true\` 才写盘。冲突文件需 \`force:true\`。拒绝部署到引擎目录。
- **保存即重生成**：本服务端不做文件监听；用显式 \`action=generate\`，或另装 \`--plugin\`。
${memory}
## 安全

- 不 push、不 amend 他人提交、不改全局 git 配置。
- 已记住身份时自动部署可建 VCS 仓库并首次提交；未配置身份时只补工具/文档，不偷偷建库；部署不删除用户文件，冲突时先提示。
- git 身份只保存 name/email；不保存密码/PAT/token，远程凭据交给系统凭据管理器/SSH。
- 目标必须在引擎目录之外。`;
}

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  process.stderr.write(`[gcgl] 配置加载失败: ${e?.message || e}\n`);
  process.exit(1);
}

const version = readVersion();
const { tools, callTool } = buildTools(cfg, version);

process.stderr.write(
  `[gcgl] v${version} · engine=${cfg.engineRoot} · autoDeploy=${cfg.autoDeploy} · ${tools.length} tools\n`,
);

startStdio({
  name: "gcgl",
  version,
  instructions: () => instructions(cfg, version),
  tools,
  resources: RESOURCES,
  callTool,
  readResource: (uri) => readResource(cfg, uri),
});
