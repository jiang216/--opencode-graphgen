#!/usr/bin/env node
/**
 * scripts/release.mjs —— 一键发布（本地校验 → 打包 → 打 tag → 推送到远端）
 *
 * 用法：
 *   node scripts/release.mjs                      # 用 package.json 当前版本发布
 *   node scripts/release.mjs --bump patch         # 升版本（patch|minor|major）→ 提交 → 打包 → tag → push
 *   node scripts/release.mjs --set-version 0.5.0  # 指定版本号
 *   node scripts/release.mjs --dry-run            # 只打印计划，不写盘、不提交、不推送
 *   node scripts/release.mjs --zip-only           # 只重打 dist zip
 *
 * 选项：
 *   --notes <file>       用该文件内容作为 tag / Release 说明（默认按提交历史自动生成）
 *   --no-test            跳过 node mcp/mcp-test.mjs
 *   --no-push            只在本地提交 + 打 tag，不推送
 *   --no-github-release  即使本机有 gh 也不建 GitHub Release
 *   --force              同名 tag 已存在时删除重建（远程同名 tag 一并更新）
 *   --allow-branch       允许在 main/master 以外的分支发布
 *
 * 打包范围 = `git ls-files` 去掉 reports/、scripts/、.github/、dist/、node_modules/，
 * 解压后是单层目录 opencode-graphgen-<version>/，与历史 dist 包结构一致。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PKG_NAME = "opencode-graphgen";
const EXCLUDE_PREFIXES = ["reports/", "scripts/", ".github/", "dist/", "node_modules/"];
const REQUIRED_FILES = ["package.json", "install.py", "mcp/server.mjs", "tools/graphgen.py", "tools/doclint.py"];

/* ------------------------------------------------------------------ 基础工具 */

class ReleaseError extends Error {}

function fail(msg) {
  throw new ReleaseError(msg);
}

function sh(cmd, args, { inherit = false, allowFail = false, cwd = ROOT } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (r.error) fail(`无法执行 ${cmd}：${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    const detail = inherit ? "" : (r.stderr || r.stdout || "").trim();
    fail(`${cmd} ${args.join(" ")} 退出码 ${r.status}${detail ? `\n${detail}` : ""}`);
  }
  return {
    ok: r.status === 0,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
  };
}

function hasCommand(cmd) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function step(msg) {
  process.stdout.write(`\n==> ${msg}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/* --------------------------------------------------------------- 参数与前置检查 */

function parseArgs(argv) {
  const opts = {
    bump: "",
    setVersion: "",
    dryRun: false,
    zipOnly: false,
    test: true,
    push: true,
    githubRelease: true,
    notes: "",
    force: false,
    allowBranch: false,
    help: false,
  };
  const takeValue = (i) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) fail(`${argv[i]} 缺少参数值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--zip-only") opts.zipOnly = true;
    else if (a === "--no-test") opts.test = false;
    else if (a === "--no-push") opts.push = false;
    else if (a === "--no-github-release") opts.githubRelease = false;
    else if (a === "--force") opts.force = true;
    else if (a === "--allow-branch") opts.allowBranch = true;
    else if (a === "--bump") opts.bump = takeValue(i++);
    else if (a.startsWith("--bump=")) opts.bump = a.slice("--bump=".length);
    else if (a === "--set-version") opts.setVersion = takeValue(i++);
    else if (a.startsWith("--set-version=")) opts.setVersion = a.slice("--set-version=".length);
    else if (a === "--notes") opts.notes = takeValue(i++);
    else if (a.startsWith("--notes=")) opts.notes = a.slice("--notes=".length);
    else fail(`未知参数：${a}（--help 看用法）`);
  }
  if (opts.bump && !["patch", "minor", "major"].includes(opts.bump)) {
    fail(`--bump 只接受 patch|minor|major，收到：${opts.bump}`);
  }
  if (opts.bump && opts.setVersion) fail("--bump 与 --set-version 不能同时使用");
  if (opts.notes && !fs.existsSync(path.resolve(ROOT, opts.notes))) {
    fail(`--notes 文件不存在：${opts.notes}`);
  }
  return opts;
}

function usage() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === "/**");
  const end = lines.findIndex((l, i) => i > start && l.trim().startsWith("*/"));
  const doc = lines.slice(start + 1, end).map((l) => l.replace(/^\s*\* ?/, "")).join("\n");
  log(doc);
}

function ensureRepoState(opts) {
  if (!fs.existsSync(path.join(ROOT, ".git"))) fail(`不是 git 仓库：${ROOT}`);
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (branch === "HEAD") fail("当前处于游离 HEAD，请先切回分支");
  if (!["main", "master"].includes(branch) && !opts.allowBranch) {
    fail(`当前分支是 ${branch}，发布通常应在 main/master；确认无误加 --allow-branch`);
  }
  const dirty = sh("git", ["status", "--porcelain"]).out;
  if (dirty) {
    fail(`工作区有未提交改动，先提交或 stash：\n${dirty}`);
  }
  return branch;
}

/* ------------------------------------------------------------------ 版本号 */

function bumpVersion(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) fail(`无法解析当前版本号：${current}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function applyVersion(version) {
  const pkgFile = path.join(ROOT, "package.json");
  const pkg = readJson(pkgFile);
  pkg.version = version;
  writeJson(pkgFile, pkg);

  const lockFile = path.join(ROOT, "package-lock.json");
  if (fs.existsSync(lockFile)) {
    const lock = readJson(lockFile);
    lock.version = version;
    if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
    writeJson(lockFile, lock);
  }
}

/* ------------------------------------------------------------------ 打包 */

function packageFiles() {
  const out = sh("git", ["ls-files", "-z"]).out;
  const files = out.split("\0").filter(Boolean).filter(
    (f) => !EXCLUDE_PREFIXES.some((p) => f === p.slice(0, -1) || f.startsWith(p)),
  );
  for (const need of REQUIRED_FILES) {
    if (!files.includes(need)) fail(`打包缺文件：${need}（是否被 .gitignore 或 EXCLUDE 误伤？）`);
  }
  return files;
}

function buildZip(version, files) {
  const distDir = path.join(ROOT, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const zipFile = path.join(distDir, `${PKG_NAME}-${version}.zip`);
  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), "graphgen-release-"));
  const stageRoot = path.join(stageParent, `${PKG_NAME}-${version}`);

  try {
    for (const rel of files) {
      const dst = path.join(stageRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), dst);
    }
    fs.rmSync(zipFile, { force: true });

    if (process.platform === "win32") {
      const ps = [
        "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
        `[System.IO.Compression.ZipFile]::CreateFromDirectory('${stageParent.replace(/'/g, "''")}',`,
        ` '${zipFile.replace(/'/g, "''")}',`,
        " [System.IO.Compression.CompressionLevel]::Optimal, $true)",
      ].join("");
      sh(process.env.SystemRoot ? "powershell.exe" : "powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        cwd: stageParent,
      });
    } else {
      sh("zip", ["-r", "-q", zipFile, `${PKG_NAME}-${version}`], { cwd: stageParent });
    }

    if (!fs.existsSync(zipFile) || fs.statSync(zipFile).size === 0) fail(`打包失败：${zipFile} 未生成或为空`);
    return zipFile;
  } finally {
    fs.rmSync(stageParent, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ 发布说明 */

function lastTag() {
  const r = sh("git", ["describe", "--tags", "--abbrev=0"], { allowFail: true });
  return r.ok ? r.out : "";
}

function buildNotes(version, tag, zipFile) {
  const prev = lastTag();
  const range = prev ? `${prev}..HEAD` : "HEAD";
  const commits = sh("git", ["log", "--no-merges", "--pretty=format:- %h %s", range], { allowFail: true })
    .out.split("\n")
    .filter(Boolean);
  const size = humanSize(fs.statSync(zipFile).size);
  const digest = sha256(zipFile);
  return [
    `## ${PKG_NAME} ${tag}`,
    "",
    "### 变更",
    commits.length ? commits.join("\n") : "- （本次无新提交，仅重打产物）",
    "",
    "### 产物",
    `- \`dist/${path.basename(zipFile)}\`（${size}）`,
    `- sha256: \`${digest}\``,
    "",
    "### 安装",
    "```powershell",
    `node mcp\\install.mjs --install-dir <安装目录> --doctor`,
    "```",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const branch = ensureRepoState(opts);
  const pkg = readJson(path.join(ROOT, "package.json"));
  let version = pkg.version;
  if (opts.setVersion) version = opts.setVersion;
  else if (opts.bump) version = bumpVersion(pkg.version, opts.bump);

  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) fail(`版本号格式不合法：${version}`);
  const tag = `v${version}`;

  log(`仓库：${ROOT}`);
  log(`分支：${branch}`);
  log(`版本：${pkg.version} → ${version}${opts.setVersion || opts.bump ? "（将写入 package.json / package-lock.json）" : ""}`);

  const tagExists = sh("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { allowFail: true }).ok;
  if (tagExists && !opts.force) fail(`tag ${tag} 已存在；确需重建加 --force`);

  if (opts.zipOnly) {
    step(`打包 dist/${PKG_NAME}-${version}.zip`);
    const files = packageFiles();
    if (opts.dryRun) {
      log(`[dry-run] 会打包 ${files.length} 个文件`);
      return;
    }
    const zipFile = buildZip(version, files);
    log(`完成：${zipFile}（${humanSize(fs.statSync(zipFile).size)}，${files.length} 个文件）`);
    log(`sha256: ${sha256(zipFile)}`);
    return;
  }

  if (opts.dryRun) {
    step("计划（dry-run，不写盘、不提交、不推送）");
    if (opts.test) log(`1. 运行 node mcp/mcp-test.mjs`);
    if (version !== pkg.version) log(`2. 写版本号 ${version} 并提交 chore(release): v${version}`);
    else log(`2. 版本号不变，无提交`);
    log(`3. 打包 dist/${PKG_NAME}-${version}.zip`);
    log(`4. 打 annotated tag ${tag}`);
    log(opts.push ? `5. git push origin ${branch} + ${tag}` : `5. 不推送（--no-push）`);
    log(opts.githubRelease && hasCommand("gh") ? `6. gh release create ${tag}` : `6. 不建 GitHub Release`);
    return;
  }

  if (opts.test) {
    step("运行自检 node mcp/mcp-test.mjs");
    sh(process.execPath, ["mcp/mcp-test.mjs"], { inherit: true });
  }

  if (version !== pkg.version) {
    step(`更新版本号到 ${version}`);
    applyVersion(version);
    sh("git", ["add", "package.json", "package-lock.json"], { allowFail: true });
    sh("git", ["commit", "-m", `chore(release): v${version}`], { inherit: true });
  }

  step(`打包 dist/${PKG_NAME}-${version}.zip`);
  const files = packageFiles();
  const zipFile = buildZip(version, files);
  const size = humanSize(fs.statSync(zipFile).size);
  const digest = sha256(zipFile);
  log(`完成：${path.relative(ROOT, zipFile)}（${size}，${files.length} 个文件）`);
  log(`sha256: ${digest}`);
  fs.writeFileSync(`${zipFile}.sha256`, `${digest}  ${path.basename(zipFile)}\n`, "utf8");

  const notesFile = path.join(os.tmpdir(), `${PKG_NAME}-${version}-notes.md`);
  const notes = opts.notes
    ? fs.readFileSync(path.resolve(ROOT, opts.notes), "utf8")
    : buildNotes(version, tag, zipFile);
  fs.writeFileSync(notesFile, notes.endsWith("\n") ? notes : `${notes}\n`, "utf8");

  step(`打 tag ${tag}`);
  if (tagExists) {
    sh("git", ["tag", "-d", tag], { allowFail: true });
    if (opts.push) sh("git", ["push", "origin", `:refs/tags/${tag}`], { allowFail: true });
  }
  sh("git", ["tag", "-a", tag, "-F", notesFile], { inherit: true });
  log(`tag 已创建：${tag}`);

  if (opts.push) {
    step(`推送到 origin`);
    sh("git", ["push", "origin", branch], { inherit: true });
    sh("git", ["push", "origin", `refs/tags/${tag}`], { inherit: true });
    log("已推送分支与 tag");
  } else {
    log("跳过推送（--no-push）");
  }

  const ghReady = opts.githubRelease && hasCommand("gh") && sh("gh", ["auth", "status"], { allowFail: true }).ok;
  if (ghReady && opts.push) {
    step(`创建 GitHub Release ${tag}`);
    sh(
      "gh",
      ["release", "create", tag, zipFile, "--title", `${PKG_NAME} ${tag}`, "--notes-file", notesFile],
      { inherit: true },
    );
    log("GitHub Release 已创建");
  } else if (opts.githubRelease) {
    log("\n未检测到可用的 gh（或未登录），GitHub Release 需手动创建：");
    log(`  https://github.com/<owner>/<repo>/releases/new?tag=${tag}`);
    log(`  附件：dist/${path.basename(zipFile)}`);
  }

  log(`\n发布完成：${tag}（${size}）`);
}

try {
  main();
} catch (err) {
  if (err instanceof ReleaseError) {
    process.stderr.write(`\n[release] 失败：${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
