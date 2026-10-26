// graphgen MCP —— 部署判定、自动补引擎、并发锁
import fs from "node:fs";
import path from "node:path";
import {
  inspectIdentity,
  isInside,
  normalizeIdentity,
  rememberedIdentity,
} from "./config.mjs";
import { runInstall, runRepo, sha256File } from "./bridge.mjs";

// install.py 默认会复制到目标项目的文件（hooks 是可选步骤，不参与“是否已安装”判断）
// [引擎内源路径, 目标项目内路径]
export const ENGINE_FILES = [
  ["tools/graphgen.py", "tools/graphgen.py"],
  ["tools/graphgen.config.template.json", "tools/graphgen.config.template.json"],
  ["tools/doclint.py", "tools/doclint.py"],
  ["tools/gen_doc_slice.py", "tools/gen_doc_slice.py"],
  ["tools/repo.py", "tools/repo.py"],
  ["tools/repo.config.template.json", "tools/repo.config.template.json"],
  ["skills/graphgen/SKILL.md", ".opencode/skills/graphgen/SKILL.md"],
];

export const CONFIG_FILES = [
  "tools/graphgen.config.json",
  "tools/doclint.config.json",
  "tools/repo.config.json",
];

const LOCK_NAME = ".graphgen-deploy.lock";
const LOCK_STALE_MS = 10 * 60 * 1000;
const AGENTS_MARKER = "<!-- graphgen:installed -->";
const GENERATED_DOCS = ["docs/graph.json", "docs/GRAPH.md", "docs/graph.mmd"];
const SNAPSHOT_DOCS = ["docs/repo.json", "docs/REPO.md", "docs/repo-links.json"];
const SNAPSHOT_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "out",
  "build",
  "dist",
  ".vs",
  "__pycache__",
  ".cache",
]);
const MAX_HASH_BYTES = 5 * 1024 * 1024;

export class ConflictError extends Error {
  constructor(conflicts) {
    super(
      `部署冲突（${conflicts.length} 处）: ${conflicts
        .map((c) => c.path)
        .join(", ")}`,
    );
    this.name = "ConflictError";
    this.code = "GRAPHGEN_CONFLICT";
    this.conflicts = conflicts;
  }
}

function listFiles(root) {
  const out = [];
  function walk(dir, rel = "") {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  walk(root);
  return out;
}

function inspectConflicts(cfg, root, info) {
  const conflicts = [];
  const seen = new Set();
  const add = (rel, kind, detail) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    conflicts.push({ path: rel, kind, detail });
  };

  // 首次部署：目标已有同路径文件但内容不是当前引擎版本，覆盖会丢用户改动。
  // 已部署项目视为受管副本，允许升级/补齐；AGENTS 仍单独判断。
  if (!info.deployed) {
    for (const rel of info.stale) {
      add(rel, "modified", "目标文件与引擎版本不同");
    }
  }

  // AGENTS.md 不是纯生成物：有内容且没有安装标记时，部署会追加片段。
  const agents = path.join(root, "AGENTS.md");
  if (fs.existsSync(agents) && fs.statSync(agents).isFile()) {
    const text = fs.readFileSync(agents, "utf8");
    if (text.trim() && !text.includes(AGENTS_MARKER)) {
      add("AGENTS.md", "append", "已有 AGENTS.md，部署会追加 graphgen 片段");
    }
  }

  // skills 目录是整体覆盖；额外文件或已修改文件都算冲突。
  const srcSkills = path.join(cfg.engineRoot, "skills/graphgen");
  const dstSkills = path.join(root, ".opencode/skills/graphgen");
  if (fs.existsSync(dstSkills) && fs.statSync(dstSkills).isDirectory()) {
    const srcSet = new Set(listFiles(srcSkills));
    const dstSet = new Set(listFiles(dstSkills));
    const extra = [...dstSet].filter((rel) => !srcSet.has(rel));
    const changed = info.deployed
      ? []
      : [...dstSet].filter(
          (rel) =>
            srcSet.has(rel) &&
            sha256File(path.join(srcSkills, rel)) !==
              sha256File(path.join(dstSkills, rel)),
        );
    if (extra.length || changed.length) {
      add(
        ".opencode/skills/graphgen",
        "directory",
        `目录含额外/修改文件: ${[...extra, ...changed].slice(0, 5).join(", ")}`,
      );
    }
  }

  // 首次部署/补文件时，已有生成物或快照会被后续 generate/snapshot 覆盖。
  // 已部署过的项目允许修复/同步，不把自身生成物当冲突。
  if (info.needsDeploy && !info.deployed) {
    for (const rel of [...GENERATED_DOCS, ...SNAPSHOT_DOCS]) {
      if (fs.existsSync(path.join(root, rel))) {
        add(rel, "generated", "已有生成/快照文件，部署或生成会覆盖");
      }
    }
  }

  return conflicts;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/**
 * entryFiles 是否已落地：文件存在且至少有一个 `##` 标题匹配 heading。
 * 首次部署的种子条目让 generate 从第一次就能通过；已有空文件不做静默追加。
 */
function inspectDocs(root) {
  const out = {
    ready: false,
    entryFiles: [],
    missingEntryFiles: [],
    invalidEntryFiles: [],
    graph: false,
    markdown: false,
  };
  const cfg = readJsonSafe(path.join(root, "tools/graphgen.config.json"));
  if (!cfg || typeof cfg !== "object") return out;
  const entryFiles =
    cfg.entryFiles && typeof cfg.entryFiles === "object" && !Array.isArray(cfg.entryFiles)
      ? Object.keys(cfg.entryFiles)
      : [];
  out.entryFiles = entryFiles;
  out.missingEntryFiles = entryFiles.filter(
    (rel) => !fs.existsSync(path.join(root, rel)),
  );
  for (const rel of entryFiles) {
    if (out.missingEntryFiles.includes(rel)) continue;
    const entry = cfg.entryFiles[rel] || {};
    const heading =
      entry.heading || "^([A-Z]+-\\d+)\\s*[:：]?\\s*(.+)$";
    let re;
    try {
      re = new RegExp(heading);
    } catch {
      out.invalidEntryFiles.push(rel);
      continue;
    }
    let text = "";
    try {
      text = fs.readFileSync(path.join(root, rel), "utf8").replace(/^\uFEFF/, "");
    } catch {
      out.invalidEntryFiles.push(rel);
      continue;
    }
    const ok = text
      .split(/\r?\n/)
      .map((line) => /^##\s+(.+)$/.exec(line.trim()))
      .some((m) => m && re.test(m[1]));
    if (!ok) out.invalidEntryFiles.push(rel);
  }
  out.ready =
    out.missingEntryFiles.length === 0 && out.invalidEntryFiles.length === 0;
  out.graph = fs.existsSync(path.join(root, "docs/graph.json"));
  out.markdown = fs.existsSync(path.join(root, "docs/GRAPH.md"));
  return out;
}

/**
 * 无 VCS 项目的文件系统快照：path + mtime + sha256，供文档漂移/部署核对。
 * 返回 null 表示未写入。
 */
export function writeFsSnapshot(cfg, root) {
  const files = [];
  let bytes = 0;
  for (const rel of listFiles(root)) {
    const top = rel.split("/")[0];
    if (SNAPSHOT_IGNORE_DIRS.has(top)) continue;
    if (rel === LOCK_NAME) continue;
    if (SNAPSHOT_DOCS.includes(rel)) continue;
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    const sha256 =
      st.size <= MAX_HASH_BYTES ? sha256File(abs) : null;
    files.push({
      path: rel,
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      sha256,
    });
    bytes += st.size;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const generatedAt = new Date().toISOString();
  const data = {
    mode: "fs",
    target: root,
    generatedAt,
    summary: { files: files.length, bytes },
    files,
  };
  const docs = path.join(root, "docs");
  writeJson(path.join(docs, "repo.json"), data);

  const rows = files
    .map(
      (f) =>
        `| \`${f.path.replace(/\|/g, "\\|")}\` | ${f.size} | ${f.mtime} | \`${f.sha256 || "(跳过，文件过大)"}\` |`,
    )
    .join("\n");
  const md = `# 项目文件快照（AUTO-GENERATED）

> 该文件由 graphgen MCP 在无 VCS 项目中生成；\`mode=fs\`，记录 path / mtime / sha256。
> 重新生成：\`gcgl_repo { action: "snapshot" }\`。

- 目标：\`${root}\`
- 生成时间：${generatedAt}
- 文件数：${files.length}
- 总字节：${bytes}

| 文件 | 字节 | 修改时间 | SHA256 |
|------|------|----------|--------|
${rows || "| (空) | 0 | - | - |"}
`;
  fs.writeFileSync(path.join(docs, "REPO.md"), md, "utf8");
  writeJson(path.join(docs, "repo-links.json"), {
    mode: "fs",
    generatedAt,
    links: [],
  });
  return {
    mode: "fs",
    json: "docs/repo.json",
    markdown: "docs/REPO.md",
    links: "docs/repo-links.json",
    files: files.length,
    bytes,
  };
}

export function inspectProject(cfg, root) {
  const missing = [];
  const stale = [];
  for (const [srcRel, dstRel] of ENGINE_FILES) {
    const src = path.join(cfg.engineRoot, srcRel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(root, dstRel);
    if (!fs.existsSync(dst)) {
      missing.push(dstRel);
      continue;
    }
    if (sha256File(src) !== sha256File(dst)) stale.push(dstRel);
  }
  const missingConfigs = CONFIG_FILES.filter(
    (rel) => !fs.existsSync(path.join(root, rel)),
  );
  const snapshot = {
    json: fs.existsSync(path.join(root, "docs/repo.json")),
    markdown: fs.existsSync(path.join(root, "docs/REPO.md")),
  };
  const plugin = fs.existsSync(
    path.join(root, ".opencode/plugins/graphgen-watch.ts"),
  );
  const engineReady = fs.existsSync(path.join(cfg.engineRoot, "install.py"));
  const deployed =
    fs.existsSync(path.join(root, "tools/graphgen.config.json")) ||
    fs.existsSync(path.join(root, ".opencode/skills/graphgen/SKILL.md"));
  const docs = inspectDocs(root);
  const info = {
    root,
    engineRoot: cfg.engineRoot,
    engineReady,
    installed: engineReady && missing.length === 0,
    deployed,
    missing,
    stale,
    missingConfigs,
    needsDeploy:
      !engineReady ||
      missing.length > 0 ||
      stale.length > 0 ||
      missingConfigs.length > 0 ||
      docs.missingEntryFiles.includes("docs/CHANGELOG.md"),
    docs,
    snapshot,
    plugin,
    skill: fs.existsSync(
      path.join(root, ".opencode/skills/graphgen/SKILL.md"),
    ),
    agents: fs.existsSync(path.join(root, "AGENTS.md")),
    identity: inspectIdentity(cfg),
  };
  info.conflicts = inspectConflicts(cfg, root, info);
  return info;
}

export function deployFlags(options) {
  const flags = ["--vcs", options.vcs || "auto"];
  if (!options.vcsInit) flags.push("--no-vcs-init");
  if (options.vcsRemote) flags.push("--vcs-remote", options.vcsRemote);
  if (options.vcsBranch) flags.push("--vcs-branch", options.vcsBranch);
  if (options.vcsCommit) flags.push("--vcs-commit");
  if (options.gitName) flags.push("--git-name", options.gitName);
  if (options.gitEmail) flags.push("--git-email", options.gitEmail);
  if (!options.snapshot) flags.push("--no-snapshot");
  if (!options.agents) flags.push("--no-agents");
  if (options.hooks) flags.push("--hooks");
  if (options.plugin) flags.push("--plugin");
  if (options.removePlugin) flags.push("--remove-plugin");
  return flags;
}

function acquireLock(root) {
  const lock = path.join(root, LOCK_NAME);
  try {
    const fd = fs.openSync(lock, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return {
      path: lock,
      release() {
        try {
          fs.rmSync(lock, { force: true });
        } catch {
          /* ignore */
        }
      },
    };
  } catch (e) {
    if (e.code === "EEXIST") {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          return acquireLock(root);
        }
      } catch {
        /* ignore */
      }
      throw new Error(
        `目标正在被另一个进程部署（锁: ${lock}）；如确认无进程，可删除该文件后重试`,
      );
    }
    throw e;
  }
}

export function mergeDeployOptions(cfg, overrides = {}) {
  return { ...cfg.deploy, ...overrides };
}

/** 写入全局 MCP 配置：只保存 name/email/remember；remember 同时打开自动建库+首次提交。 */
function persistIdentity(cfg, identity) {
  if (!cfg.configPath) throw new Error("配置缺少 configPath，无法保存 git 身份");
  const raw = readJsonSafe(cfg.configPath) || {};
  raw.identity = {
    name: identity.name,
    email: identity.email,
    remember: true,
  };
  raw.deploy = {
    ...(raw.deploy && typeof raw.deploy === "object" ? raw.deploy : {}),
    vcsInit: true,
    vcsCommit: true,
  };
  writeJson(cfg.configPath, raw);
  cfg.identity = { ...raw.identity };
  cfg.deploy = { ...cfg.deploy, vcsInit: true, vcsCommit: true };
}

/** 本次部署使用的身份：显式参数优先；否则只复用用户已确认 remember 的身份。 */
export function resolveDeployIdentity(cfg, options = {}) {
  const raw = options.identity;
  if (raw && typeof raw === "object") {
    const identity = normalizeIdentity(raw);
    if (identity.name || identity.email) {
      if (!identity.name || !identity.email) {
        throw new Error("git 身份不完整：name 和 email 必须同时提供");
      }
      return { ...identity, configured: true, configPath: cfg.configPath || null };
    }
  }
  const remembered = rememberedIdentity(cfg);
  if (remembered) return remembered;
  return { ...inspectIdentity(cfg), configured: false };
}

export async function deployProject(cfg, root, options = {}, { force = false } = {}) {
  const opts = mergeDeployOptions(cfg, options);
  const identity = resolveDeployIdentity(cfg, options);
  const remember = options.rememberIdentity === true;
  let needsIdentity = false;
  if (remember && !identity.configured) {
    throw new Error(
      "rememberIdentity=true 但缺少 git 身份：请同时提供 identity.name 和 identity.email",
    );
  }
  // 没有身份时不偷偷建库；先部署工具/文档，再让 agent 询问用户。
  if (opts.vcs !== "none" && opts.vcsInit && !identity.configured) {
    opts.vcsInit = false;
    opts.vcsCommit = false;
    needsIdentity = true;
  }
  if (identity.configured) {
    opts.gitName = identity.name;
    opts.gitEmail = identity.email;
  }
  if (root === cfg.engineRoot || isInside(root, cfg.engineRoot)) {
    throw new Error(`拒绝部署到引擎目录或其子目录: ${root}`);
  }
  const before = inspectProject(cfg, root);
  if (!force && before.conflicts.length) {
    throw new ConflictError(before.conflicts);
  }
  const lock = acquireLock(root);
  try {
    const result = await runInstall(cfg, root, deployFlags(opts));
    const report = result.report;
    if (!report.ok) {
      throw new Error(
        `部署失败（install.py exit ${result.code}）:\n${(report.logs || []).join("\n")}`,
      );
    }

    // install.py 对无 VCS 项目会跳过 snapshot；这里补文件系统快照。
    let fsSnapshot = null;
    if (opts.snapshot && !opts.dry_run) {
      let vcs = null;
      if (opts.vcs !== "none") {
        try {
          const detected = await runRepo(cfg, root, ["detect"]);
          vcs = detected.data?.vcs || null;
        } catch {
          vcs = null;
        }
      }
      if (!vcs) {
        fsSnapshot = writeFsSnapshot(cfg, root);
        report.logs = report.logs || [];
        report.logs.push(
          `snapshot  fs 模式写入 ${fsSnapshot.json} / ${fsSnapshot.markdown}`,
          `links     fs 模式写入 ${fsSnapshot.links}（无提交）`,
        );
        report.summary = {
          ...(report.summary || {}),
          snapshot_fs: 2,
          total: (report.summary?.total || 0) + 2,
        };
      }
    }

    if (remember && identity.configured) persistIdentity(cfg, identity);

    return {
      ok: true,
      target: root,
      options: opts,
      identity,
      needsIdentity,
      report,
      docs: report.docs,
      fsSnapshot,
    };
  } finally {
    lock.release();
  }
}

/**
 * 自动补齐引擎：只做增量复制/建配置，不删除文件、不提交、不 push。
 * 返回 { deployed, reason?, info, report? }
 */
export async function ensureEngine(cfg, root, { force = false } = {}) {
  if (root === cfg.engineRoot || isInside(root, cfg.engineRoot)) {
    return { deployed: false, reason: "engine-root", info: null };
  }
  const before = inspectProject(cfg, root);
  if (!before.needsDeploy && !force) {
    return { deployed: false, reason: "fresh", info: before };
  }
  const protectedRoots = [cfg.sourceRoot, ...(cfg.protectedRoots || [])]
    .filter(Boolean)
    .map((p) => path.resolve(cfg.configDir || process.cwd(), String(p)));
  if (!force && protectedRoots.some((p) => p === root)) {
    return { deployed: false, reason: "source-root", info: before };
  }
  if (!cfg.autoDeploy && !force) {
    return { deployed: false, reason: "autoDeploy=false", info: before };
  }
  // 已记住身份时才自动建库/首次提交；否则只补工具/文档，避免无身份时建半个仓库。
  const identity = rememberedIdentity(cfg);
  const autoOptions = { ...cfg.deploy };
  if (!identity) {
    autoOptions.vcsInit = false;
    autoOptions.vcsCommit = false;
  }
  try {
    const result = await deployProject(cfg, root, autoOptions, { force });
    return {
      deployed: true,
      reason: "deployed",
      info: inspectProject(cfg, root),
      report: result.report,
      identity: result.identity,
      needsIdentity:
        result.needsIdentity || (!identity && cfg.deploy.vcsInit === true),
    };
  } catch (e) {
    if (e?.code === "GRAPHGEN_CONFLICT") {
      return {
        deployed: false,
        reason: "conflict",
        info: { ...before, conflicts: e.conflicts },
        conflicts: e.conflicts,
      };
    }
    throw e;
  }
}
