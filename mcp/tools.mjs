// graphgen MCP —— 工具定义与实现
import fs from "node:fs";
import path from "node:path";
import {
  isInside,
  rememberedIdentity,
  resolvePython,
  resolveRoot,
} from "./config.mjs";
import { runEngine, runRepo } from "./bridge.mjs";
import {
  ConflictError,
  deployFlags,
  deployProject,
  ensureEngine,
  inspectProject,
  mergeDeployOptions,
  resolveDeployIdentity,
  writeFsSnapshot,
} from "./ensure.mjs";

const TOOL_DEFS = [
  {
    name: "status",
    description:
      "只读体检：本机 graphgen 引擎位置/Python、目标项目是否已装引擎（缺失/过期文件）、配置/技能/AGENTS/VCS/快照/旧插件、git 身份（identity.configured/remember），以及 docs.ready / missingEntryFiles。并给出 needsDeploy、conflicts 与 suggestedNextActions。",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "项目根目录（默认当前工作目录）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deploy",
    description:
      "把 graphgen 全家桶部署/同步到目标项目（tools、模板、技能、AGENTS、VCS、快照、可选钩子）。默认只返回计划；confirm=true 才写盘。首次部署先做冲突预检：有冲突返回 needsConfirm=true，确认后加 force=true；只做增量复制/建配置，不删除、不提交、不 push。缺 docs/CHANGELOG.md 时写入合法种子条目并补 prefixes/allowOrphanEntries；已有条目文件不覆盖。无仓库时：有已记住 git 身份则自动建库+首次提交；缺身份返回 needsIdentity 并跳过 VCS（先问用户 name/email）。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "目标项目根目录（绝对或相对当前目录）" },
        confirm: { type: "boolean", description: "true=真正写盘；缺省只出计划" },
        force: { type: "boolean", description: "true=确认覆盖/追加冲突文件（先看 conflicts）" },
        dryRun: { type: "boolean", description: "true=强制只出计划" },
        hooks: { type: "boolean", description: "安装 pre-commit/commit-msg 并启用 core.hooksPath" },
        vcs: { type: "string", enum: ["auto", "git", "hg", "svn", "none"] },
        vcsInit: {
          type: "boolean",
          description:
            "无仓库时是否自动建库（默认 true；但没有已记住的 git 身份时会跳过并返回 needsIdentity）",
        },
        vcsRemote: { type: "string" },
        vcsBranch: { type: "string" },
        vcsCommit: {
          type: "boolean",
          description: "建库后首次提交（默认 true；需要 identity.name/email）",
        },
        identity: {
          type: "object",
          description:
            "首次部署时由 agent 询问后传入的 git 提交身份；只含 name/email，禁止传密码/PAT",
          properties: {
            name: { type: "string", description: "git user.name" },
            email: { type: "string", description: "git user.email" },
          },
          required: ["name", "email"],
          additionalProperties: false,
        },
        rememberIdentity: {
          type: "boolean",
          description:
            "true=把 identity 写入全局 MCP 配置并打开 vcsInit/vcsCommit，以后项目不再询问",
        },
        snapshot: { type: "boolean", description: "生成 docs/repo.json + REPO.md（默认 true）" },
        agents: { type: "boolean", description: "追加 AGENTS.md 片段（默认 true）" },
        plugin: { type: "boolean", description: "同时装文件监听插件（默认 false）" },
        removePlugin: { type: "boolean", description: "删除旧的 graphgen-watch.ts" },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "query",
    description:
      "文档图谱：query=按节点 id/简称查正反链；generate=重生成 docs/graph.json|GRAPH.md|graph.mmd；check=lint（有错 exit 1）；doclint=文档漂移机械校验。缺引擎时先自动部署；entryFiles 未就绪返回 needsDocs（不抛裸 Python 错误）。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["query", "generate", "check", "doclint"],
        },
        node: { type: "string", description: "query 用：节点 id 或简称，如 BUG:XX-001 / G-004 / DOC:xxx" },
        root: { type: "string", description: "项目根目录（默认当前工作目录）" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "repo",
    description:
      "代码仓库管理（git/hg/svn 统一）：detect/status/init/snapshot/links/guard。init 需 confirm=true；guard 只读，不执行 add/commit/push。缺引擎时先做冲突预检，无冲突才自动部署；无 VCS 时 status/links/guard 返回 not_applicable，snapshot 用文件系统模式。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["detect", "status", "init", "snapshot", "links", "guard"],
        },
        root: { type: "string", description: "项目根目录（默认当前工作目录）" },
        confirm: { type: "boolean", description: "init 写操作确认" },
        vcs: { type: "string", enum: ["auto", "git", "hg", "svn"] },
        remote: { type: "string", description: "init 用：远端地址（svn 必需）" },
        branch: { type: "string", description: "init 用：git 初始分支" },
        commit: { type: "boolean", description: "init 用：建库后首次提交" },
        gitName: { type: "string", description: "init 用：写入当前仓库 local user.name" },
        gitEmail: { type: "string", description: "init 用：写入当前仓库 local user.email" },
        allowNested: { type: "boolean", description: "init 用：允许在父仓库内建嵌套库" },
        stage: { type: "string", enum: ["commit", "commit-msg", "push"] },
        messageFile: { type: "string", description: "guard --stage=commit-msg 用" },
        maxCommits: { type: "number", description: "links 用：最多扫描提交数" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "verify",
    description:
      "一次跑完 graphgen --check + doclint + repo status --json，返回聚合结果；只读（缺引擎时会先自动部署）。提交前/改完文档后用。",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "项目根目录（默认当前工作目录）" },
      },
      additionalProperties: false,
    },
  },
];

function lookupNode(graph, input) {
  const q = String(input || "").trim();
  if (!q) return null;
  const upper = q.toUpperCase();
  if (graph.nodes[upper]) return graph.nodes[upper].id;
  for (const id of Object.keys(graph.nodes || {})) {
    if (id.toUpperCase() === upper) return id;
  }
  const colon = upper.includes(":") ? upper.split(":").pop() : upper;
  const bySuffix = Object.keys(graph.nodes || {}).filter((id) =>
    id.toUpperCase().endsWith(":" + colon),
  );
  if (bySuffix.length === 1) return bySuffix[0];
  if (bySuffix.length > 1) {
    return bySuffix.find((id) => id.toUpperCase() === `BUG:${upper}`) ?? null;
  }
  return null;
}

function output(result) {
  return {
    code: result.code,
    timedOut: result.timedOut,
    output: ((result.stdout || "") + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")).trim(),
  };
}

async function prepare(cfg, rootArg) {
  const root = resolveRoot(cfg, rootArg);
  if (root === cfg.engineRoot || isInside(root, cfg.engineRoot)) {
    throw new Error(`拒绝在引擎目录内操作: ${root}`);
  }
  const bootstrap = await ensureEngine(cfg, root);
  if (bootstrap.info?.needsDeploy && !bootstrap.deployed) {
    if (bootstrap.reason === "source-root") {
      throw new Error(
        `${root} 是 graphgen MCP 源仓库，自动部署已跳过。` +
          `如确实要把它当消费项目安装，显式调用 graphgen_deploy {target:"${root}", confirm:true}`,
      );
    }
    if (bootstrap.reason === "conflict") {
      const list = (bootstrap.conflicts || [])
        .map((c) => `- ${c.path} [${c.kind}] ${c.detail}`)
        .join("\n");
      throw new Error(
        `项目 ${root} 未部署 graphgen，但部署会改动已有文件：\n${list}\n` +
          `确认覆盖/追加后执行 graphgen_deploy {target:"${root}", confirm:true, force:true}；` +
          `或先备份/合并冲突文件。`,
      );
    }
    throw new Error(
      `项目 ${root} 缺少/过期 graphgen 引擎（原因: ${bootstrap.reason}）。` +
        `请调用 graphgen_deploy {target:"${root}", confirm:true}，或在 mcp/config.json 打开 autoDeploy`,
    );
  }
  return { root, bootstrap };
}

export function buildTools(cfg, version) {
  const tools = TOOL_DEFS;

  async function callTool(name, args = {}) {
    switch (name) {
      case "status": {
        const root = resolveRoot(cfg, args.root);
        const info = inspectProject(cfg, root);
        let python = null;
        try {
          python = resolvePython(cfg).version;
        } catch (e) {
          python = `不可用: ${e.message}`;
        }
        let vcs = null;
        if (fs.existsSync(path.join(root, "tools/repo.py"))) {
          try {
            const r = await runRepo(cfg, root, ["detect"]);
            vcs = r.data;
          } catch (e) {
            vcs = { error: String(e) };
          }
        }
        const protectedRoots = [cfg.sourceRoot, ...(cfg.protectedRoots || [])]
          .filter(Boolean)
          .map((p) => path.resolve(cfg.configDir || process.cwd(), String(p)));
        const suggestedNextActions = [];
        const hasVcsMarker = [".git", ".hg", ".svn"].some((name) =>
          fs.existsSync(path.join(root, name)),
        );
        const needsIdentity =
          !hasVcsMarker &&
          cfg.deploy.vcsInit === true &&
          !info.identity?.configured;
        const needsRemember =
          !hasVcsMarker &&
          cfg.deploy.vcsInit === true &&
          info.identity?.configured === true &&
          info.identity?.remember !== true;

        if (!info.engineReady) {
          suggestedNextActions.push(
            "graphgen MCP 引擎缺失：先运行 node mcp/install.mjs 或检查 mcp/config.json 的 engineRoot",
          );
        } else if (info.needsDeploy) {
          if (info.conflicts.length) {
            suggestedNextActions.push(
              `graphgen_deploy {target:${JSON.stringify(root)}, confirm:true, force:true}  ` +
                `# 先确认 ${info.conflicts.length} 处冲突`,
            );
          } else {
            suggestedNextActions.push(
              `graphgen_deploy {target:${JSON.stringify(root)}, confirm:true}`,
            );
          }
        }
        if (info.needsDeploy && !info.deployed) {
          suggestedNextActions.push(
            `graphgen_query {action:"generate", root:${JSON.stringify(root)}}  # 部署后生成图谱`,
          );
        }
        if (!info.docs?.ready) {
          const missing = info.docs?.missingEntryFiles || [];
          const invalid = info.docs?.invalidEntryFiles || [];
          const nonDefaultMissing = missing.filter(
            (rel) => rel !== "docs/CHANGELOG.md",
          );
          if (nonDefaultMissing.length) {
            suggestedNextActions.push(
              `手动创建 entryFiles: ${nonDefaultMissing.join(", ")}（或修改 tools/graphgen.config.json）后再 generate`,
            );
          }
          if (invalid.length) {
            suggestedNextActions.push(
              `entryFiles 无合法条目: ${invalid.join(", ")}；手工补 ## ID: 标题（YYYY-MM-DD）后再 generate`,
            );
          }
        }
        if (info.docs?.ready && !info.docs?.graph && !info.needsDeploy) {
          suggestedNextActions.push(
            `graphgen_query {action:"generate", root:${JSON.stringify(root)}}  # 生成图谱`,
          );
        }
        if ((!vcs || (typeof vcs === "object" && !vcs.vcs)) && !hasVcsMarker) {
          if (cfg.deploy.vcsInit && !info.identity?.configured) {
            suggestedNextActions.push(
              "无 VCS 且未配置 git 身份：先询问用户 user.name/user.email，再 " +
                `graphgen_deploy {target:${JSON.stringify(root)}, confirm:true, identity:{name,email}, rememberIdentity:true}`,
            );
          } else if (cfg.deploy.vcsInit && !info.identity?.remember) {
            suggestedNextActions.push(
              "无 VCS：已有 git 身份但未确认“以后都用”；询问用户后可传 rememberIdentity:true 一次写入配置",
            );
          } else if (cfg.deploy.vcsInit) {
            suggestedNextActions.push(
              "无 VCS：已记住 git 身份，deploy 会自动建库并按配置首次提交",
            );
          } else {
            suggestedNextActions.push(
              "无 VCS：repo status 返回 not_applicable；需要文件快照时用 graphgen_deploy（snapshot=true）",
            );
          }
        }
        return {
          server: {
            name: "graphgen",
            version,
            engineRoot: cfg.engineRoot,
            configPath: cfg.configPath,
            python,
            autoDeploy: !!cfg.autoDeploy,
            sourceRoot: cfg.sourceRoot || null,
          },
          project: {
            ...info,
            vcs,
            needsIdentity,
            needsRemember,
            suggestedNextActions,
            autoDeploySkipped: protectedRoots.includes(root)
              ? "source-root"
              : null,
          },
        };
      }

      case "deploy": {
        if (!args.target) throw new Error("缺少 target");
        const root = resolveRoot(cfg, args.target);
        if (root === cfg.engineRoot || isInside(root, cfg.engineRoot)) {
          throw new Error(`拒绝部署到引擎目录或其子目录: ${root}`);
        }
        const overrides = {};
        for (const key of [
          "hooks",
          "vcs",
          "vcsInit",
          "vcsRemote",
          "vcsBranch",
          "vcsCommit",
          "snapshot",
          "agents",
          "plugin",
          "removePlugin",
        ]) {
          if (args[key] !== undefined) overrides[key] = args[key];
        }
        if (args.identity !== undefined) overrides.identity = args.identity;
        if (args.rememberIdentity !== undefined) {
          overrides.rememberIdentity = args.rememberIdentity === true;
        }
        const opts = mergeDeployOptions(cfg, overrides);
        const identity = resolveDeployIdentity(cfg, overrides);
        const wantsIdentity =
          opts.vcs !== "none" &&
          (opts.vcsInit === true || overrides.rememberIdentity === true);
        const needsIdentity = wantsIdentity && !identity.configured;
        const force = args.force === true;
        const write = args.confirm === true && args.dryRun !== true;
        if (!write) {
          const info = inspectProject(cfg, root);
          const planOpts = { ...opts };
          if (needsIdentity) {
            planOpts.vcsInit = false;
            planOpts.vcsCommit = false;
          }
          if (identity.configured) {
            planOpts.gitName = identity.name;
            planOpts.gitEmail = identity.email;
          }
          return {
            ok: true,
            planned: true,
            target: root,
            engineRoot: cfg.engineRoot,
            options: planOpts,
            flags: deployFlags(planOpts),
            identity,
            needsIdentity,
            info,
            conflicts: info.conflicts,
            needsConfirm: info.conflicts.length > 0,
            safeToAutoDeploy: info.conflicts.length === 0,
            note: needsIdentity
              ? "缺少 git 身份：先询问用户 user.name/user.email；本次不会建库。"
              : info.conflicts.length > 0
                ? "检测到冲突：确认覆盖/追加后传 confirm=true, force=true。"
                : "只出计划，未写盘；确认后传 confirm=true。",
          };
        }
        try {
          const result = await deployProject(cfg, root, overrides, { force });
          return {
            ...result,
            info: inspectProject(cfg, root),
          };
        } catch (e) {
          if (e instanceof ConflictError || e?.code === "GRAPHGEN_CONFLICT") {
            const info = inspectProject(cfg, root);
            return {
              ok: false,
              needsConfirm: true,
              target: root,
              conflicts: e.conflicts || info.conflicts,
              info,
              message:
                "部署会改动已有文件，未写盘。确认后调用 graphgen_deploy {target, confirm:true, force:true}，或先备份/合并冲突文件。",
            };
          }
          throw e;
        }
      }

      case "query": {
        const { root, bootstrap } = await prepare(cfg, args.root);
        const action = args.action;
        if (["generate", "check", "doclint"].includes(action)) {
          const project = inspectProject(cfg, root);
          if (!project.docs?.ready) {
            const missing = project.docs?.missingEntryFiles || [];
            const invalid = project.docs?.invalidEntryFiles || [];
            return {
              ok: false,
              action,
              root,
              bootstrap,
              needsDocs: true,
              docs: project.docs,
              message:
                `entryFiles 未就绪（缺失: ${missing.join(", ") || "无"}；` +
                `无合法条目: ${invalid.join(", ") || "无"}）。` +
                `先 graphgen_deploy {target:${JSON.stringify(root)}, confirm:true} 生成种子条目，` +
                `或手工补 docs/CHANGELOG.md 后重试。`,
            };
          }
        }
        if (action === "doclint") {
          const r = await runEngine(cfg, root, path.join("tools", "doclint.py"), []);
          return { ok: r.code === 0, action, root, bootstrap, ...output(r) };
        }
        if (action === "generate" || action === "check") {
          const argv = action === "check" ? ["--check"] : [];
          const r = await runEngine(cfg, root, path.join("tools", "graphgen.py"), argv);
          if (action === "generate" && !fs.existsSync(path.join(root, "docs/graph.json"))) {
            throw new Error(`generate 后未发现 docs/graph.json:\n${output(r).output}`);
          }
          return { ok: r.code === 0, action, root, bootstrap, ...output(r) };
        }
        if (action !== "query") throw new Error(`未知 action: ${action}`);
        const graphPath = path.join(root, "docs/graph.json");
        if (!fs.existsSync(graphPath)) {
          return {
            ok: false,
            action,
            root,
            bootstrap,
            needsGenerate: true,
            message: "缺少 docs/graph.json，请先 action=generate 或 python tools/graphgen.py",
          };
        }
        const graph = JSON.parse(
          fs.readFileSync(graphPath, "utf8").replace(/^\uFEFF/, ""),
        );
        const wanted = args.node || "BUG:G-001";
        const nid = lookupNode(graph, wanted);
        if (!nid) {
          return {
            ok: false,
            action,
            root,
            message: `未找到节点「${wanted}」。可用前缀：BUG:/DOC:/SKILL:/META:/SRC:。`,
          };
        }
        const node = graph.nodes[nid];
        const backlinks = graph.backlinks?.[nid] ?? [];
        const outlinks = (graph.edges ?? []).filter((e) => e.from === nid);
        return {
          ok: true,
          action,
          root,
          bootstrap,
          node: {
            id: nid,
            label: node?.label,
            path: node?.path,
            anchor: node?.anchor ?? null,
          },
          backlinks,
          outlinks,
        };
      }

      case "repo": {
        const { root, bootstrap } = await prepare(cfg, args.root);
        const action = args.action;
        const argv = [action];
        if (action === "init") {
          if (args.confirm !== true) {
            return {
              ok: false,
              needsConfirm: true,
              root,
              message: "init 会创建仓库；确认后传 confirm=true。",
            };
          }
          argv.push("--vcs", args.vcs || "auto");
          if (args.remote) argv.push("--remote", args.remote);
          if (args.branch) argv.push("--branch", args.branch);
          const remembered = rememberedIdentity(cfg);
          const gitName = args.gitName || remembered?.name || "";
          const gitEmail = args.gitEmail || remembered?.email || "";
          if (gitName) argv.push("--git-name", gitName);
          if (gitEmail) argv.push("--git-email", gitEmail);
          if (args.commit) argv.push("--commit");
          if (args.allowNested) argv.push("--allow-nested");
        } else if (action === "links") {
          if (args.maxCommits) argv.push("--max", String(args.maxCommits));
        } else if (action === "guard") {
          argv.push("--stage", args.stage || "commit");
          if (args.messageFile) argv.push("--message-file", args.messageFile);
        }
        const r = await runRepo(cfg, root, argv);
        const noVcs =
          r.data &&
          (r.data.result === "no-repo" ||
            r.data.result === "no-vcs" ||
            (Array.isArray(r.data.messages) &&
              r.data.messages.some((m) => /未检测到代码仓库/.test(m))));
        if (noVcs && action === "snapshot") {
          const snap = writeFsSnapshot(cfg, root);
          return {
            ok: true,
            action,
            root,
            bootstrap,
            mode: "fs",
            result: {
              action,
              result: "ok",
              reason: "no_vcs",
              mode: "fs",
              snapshot: snap,
              messages: ["warn  未检测到代码仓库，已改用文件系统快照（path/mtime/sha256）"],
            },
            stdout: r.stdout.trim(),
            stderr: r.stderr.trim(),
          };
        }
        if (noVcs && ["status", "links", "guard"].includes(action)) {
          return {
            ok: true,
            action,
            root,
            bootstrap,
            mode: "fs",
            result: {
              action,
              result: "not_applicable",
              reason: "no_vcs",
              mode: "fs",
              messages: [
                "warn  未检测到代码仓库：该操作不适用（not_applicable）",
                ...(action === "links"
                  ? [
                      "建议 1：git init 后安装 commit-msg 钩子，提交信息写 DG-### 等项目 ID",
                      "建议 2：保持无 VCS，改用 docs/CHANGELOG.md 手工维护条目",
                    ]
                  : []),
              ],
            },
            stdout: r.stdout.trim(),
            stderr: r.stderr.trim(),
          };
        }
        return {
          ok: r.ok,
          action,
          root,
          bootstrap,
          code: r.code,
          timedOut: r.timedOut,
          result: r.data,
          stdout: r.stdout.trim(),
          stderr: r.stderr.trim(),
        };
      }

      case "verify": {
        const { root, bootstrap } = await prepare(cfg, args.root);
        const gg = await runEngine(cfg, root, path.join("tools", "graphgen.py"), ["--check"]);
        const dl = await runEngine(cfg, root, path.join("tools", "doclint.py"), []);
        const repo = await runRepo(cfg, root, ["status"]);
        const noVcs =
          repo.data &&
          (repo.data.result === "no-repo" || repo.data.result === "no-vcs");
        return {
          ok: gg.code === 0 && dl.code === 0,
          root,
          bootstrap,
          graphgen: output(gg),
          doclint: output(dl),
          repo: {
            ok: repo.ok || noVcs,
            code: repo.code,
            result: noVcs
              ? {
                  ...repo.data,
                  result: "not_applicable",
                  reason: "no_vcs",
                  mode: "fs",
                }
              : repo.data,
          },
        };
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }
  }

  return { tools, callTool };
}

export const RESOURCES = [
  {
    uri: "graphgen://config",
    name: "graphgen 配置",
    description: "当前 MCP 服务端生效的配置（含 engineRoot / deploy 默认值）",
    mimeType: "application/json",
  },
  {
    uri: "graphgen://contract",
    name: "graphgen 使用契约",
    description: "部署/自动提交/验证/仓库管理约定",
    mimeType: "text/markdown",
  },
];

export function readResource(cfg, uri) {
  if (uri === "graphgen://config") {
    return {
      mimeType: "application/json",
      text: JSON.stringify(cfg, null, 2),
    };
  }
  if (uri === "graphgen://contract") {
    const agents = path.join(cfg.engineRoot, "templates", "agents-snippet.md");
    let extra = "";
    if (fs.existsSync(agents)) {
      extra = fs.readFileSync(agents, "utf8");
    }
    return {
      mimeType: "text/markdown",
      text: [
        "# graphgen MCP 使用契约",
        "",
        "## 工具",
        "- `graphgen_status`：只读体检；新项目先看这个。",
        "- `graphgen_deploy`：部署/同步；默认只出计划，`confirm=true` 才写。",
        "- `graphgen_query`：query/generate/check/doclint。",
        "- `graphgen_repo`：detect/status/init/snapshot/links/guard。",
        "- `graphgen_verify`：graphgen --check + doclint + repo status。",
        "",
        "## 硬性规则",
        "- 新项目缺引擎：直接 `graphgen_deploy {target, confirm:true}`，不要回源仓库手拷。",
        "- 无 git 身份时先问用户 name/email；确认以后都用后传 `identity` + `rememberIdentity:true`，只存 name/email，不存密码。",
        "- 改完文档：`graphgen_query action=generate`，提交前 `graphgen_verify`。",
        "- 改完一批文件由 agent 自己 commit；只 add 本次改动，不 push、不 amend、不改全局 git config。",
        "- 部署/init 写盘前先出计划；目标不能是引擎目录。",
        "",
        "## 项目侧工作流片段",
        "",
        extra,
      ].join("\n"),
    };
  }
  return null;
}
