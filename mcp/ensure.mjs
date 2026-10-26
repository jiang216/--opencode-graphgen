// graphgen MCP —— 部署判定、自动补引擎、并发锁
import fs from "node:fs";
import path from "node:path";
import { isInside } from "./config.mjs";
import { runInstall, sha256File } from "./bridge.mjs";

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
  return {
    root,
    engineRoot: cfg.engineRoot,
    engineReady,
    installed: engineReady && missing.length === 0,
    missing,
    stale,
    missingConfigs,
    needsDeploy:
      !engineReady ||
      missing.length > 0 ||
      stale.length > 0 ||
      missingConfigs.length > 0,
    snapshot,
    plugin,
    skill: fs.existsSync(
      path.join(root, ".opencode/skills/graphgen/SKILL.md"),
    ),
    agents: fs.existsSync(path.join(root, "AGENTS.md")),
  };
}

export function deployFlags(options) {
  const flags = ["--vcs", options.vcs || "auto"];
  if (!options.vcsInit) flags.push("--no-vcs-init");
  if (options.vcsRemote) flags.push("--vcs-remote", options.vcsRemote);
  if (options.vcsBranch) flags.push("--vcs-branch", options.vcsBranch);
  if (options.vcsCommit) flags.push("--vcs-commit");
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

export async function deployProject(cfg, root, options = {}) {
  const opts = mergeDeployOptions(cfg, options);
  if (root === cfg.engineRoot || isInside(root, cfg.engineRoot)) {
    throw new Error(`拒绝部署到引擎目录或其子目录: ${root}`);
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
    return {
      ok: true,
      target: root,
      options: opts,
      report,
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
  const result = await deployProject(cfg, root, cfg.deploy);
  return {
    deployed: true,
    reason: "deployed",
    info: inspectProject(cfg, root),
    report: result.report,
  };
}
