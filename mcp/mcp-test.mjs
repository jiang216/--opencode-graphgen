#!/usr/bin/env node
// graphgen MCP 自检：initialize / tools.list / status / deploy(plan+confirm) /
// 自动补引擎 / query / repo / verify / 边界。
// 用法: node mcp/mcp-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, "..");
const SERVER = path.join(HERE, "server.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "graphgen-mcp-test-"));
const PROJ = path.join(TMP, "proj");
const AUTO = path.join(TMP, "auto");
const EMPTY = path.join(TMP, "empty");
const CONFLICT = path.join(TMP, "conflict");
const DOCS = path.join(TMP, "docs-conflict");
const EXISTING = path.join(TMP, "existing-entry");
const INVALID = path.join(TMP, "invalid-entry");
const GITPROJ = path.join(TMP, "git-proj");
const GITONE = path.join(TMP, "git-one-shot");
const GITPROJ2 = path.join(TMP, "git-proj-remembered");
const CONFIG = path.join(TMP, "config.json");
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(AUTO, { recursive: true });
fs.mkdirSync(EMPTY, { recursive: true });
fs.mkdirSync(CONFLICT, { recursive: true });
fs.mkdirSync(path.join(DOCS, "docs"), { recursive: true });
fs.mkdirSync(path.join(EXISTING, "docs"), { recursive: true });
fs.mkdirSync(path.join(INVALID, "docs"), { recursive: true });
fs.mkdirSync(GITPROJ, { recursive: true });
fs.mkdirSync(GITONE, { recursive: true });
fs.mkdirSync(GITPROJ2, { recursive: true });
fs.writeFileSync(path.join(AUTO, "README.md"), "# auto project\n");
fs.writeFileSync(path.join(GITPROJ, "README.md"), "# git project\n");
fs.writeFileSync(path.join(GITONE, "README.md"), "# one shot\n");
fs.writeFileSync(path.join(GITPROJ2, "README.md"), "# remembered\n");
fs.writeFileSync(
  path.join(CONFLICT, "AGENTS.md"),
  "# 项目自有约定\n\n不要覆盖这一行。\n",
);
fs.writeFileSync(
  path.join(EXISTING, "docs/CHANGELOG.md"),
  "# 已有变更日志\n\n## DG-001: 已有条目（2026-01-01）\n\n- 人工维护，不应被部署器覆盖。\n",
);
fs.writeFileSync(path.join(INVALID, "docs/CHANGELOG.md"), "# 变更日志\n\n暂无条目。\n");
fs.writeFileSync(
  path.join(DOCS, "docs/graph.json"),
  JSON.stringify({ nodes: {}, edges: [] }, null, 2),
);
fs.writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      engineRoot: SOURCE,
      defaultRoot: PROJ,
      autoDeploy: true,
      deploy: {
        vcs: "auto",
        vcsInit: true,
        vcsCommit: true,
        snapshot: true,
        agents: true,
        hooks: false,
        plugin: false,
      },
    },
    null,
    2,
  ),
);

const p = spawn(process.execPath, [SERVER], {
  windowsHide: true,
  env: { ...process.env, GRAPHGEN_CONFIG: CONFIG, GRAPHGEN_AUTO_COMMIT: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
let id = 0;
let pass = 0;
let fail = 0;

p.stderr.setEncoding("utf8");
p.stderr.on("data", (d) => process.stderr.write("[server] " + d));
p.stdout.setEncoding("utf8");
p.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const r = pending.get(msg.id);
    if (r) {
      pending.delete(msg.id);
      r(msg);
    }
  }
});

function call(method, params, ms = 120000) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, resolve);
    p.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n",
    );
    setTimeout(() => {
      if (pending.has(myId)) {
        pending.delete(myId);
        reject(new Error("超时: " + method + " " + JSON.stringify(params ?? {})));
      }
    }, ms);
  });
}

function body(res) {
  const text = res?.result?.content?.[0]?.text ?? "";
  try {
    return { json: JSON.parse(text), text, isError: !!res?.result?.isError };
  } catch {
    return { json: null, text, isError: !!res?.result?.isError };
  }
}

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

try {
  console.log("== graphgen MCP 自检 ==");
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "graphgen-mcp-test", version: "1" },
  });
  check("initialize name=graphgen", init.result?.serverInfo?.name === "graphgen");
  const ins = init.result?.instructions ?? "";
  check("instructions 注入部署/提交约定", /graphgen_deploy/.test(ins) && /自动提交/.test(ins), `${ins.length} 字符`);

  const list = await call("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  check("tools/list = 5 工具", names.length === 5, names.join(","));
  check(
    "工具齐全",
    ["deploy", "query", "repo", "status", "verify"].every((n) => names.includes(n)),
    names.join(","),
  );

  const st = body(
    await call("tools/call", { name: "status", arguments: { root: SOURCE } }),
  );
  check("status(仓库自身)", st.json?.server?.name === "graphgen", `installed=${st.json?.project?.installed}`);

  const plan = body(
    await call("tools/call", {
      name: "deploy",
      arguments: { target: PROJ },
    }),
  );
  check("deploy 默认只出计划", plan.json?.planned === true);
  check("计划未写盘", !fs.existsSync(path.join(PROJ, "tools/graphgen.py")));

  const dep = body(
    await call("tools/call", {
      name: "deploy",
      arguments: { target: PROJ, confirm: true, hooks: false },
    }),
  );
  check("deploy confirm 成功", dep.json?.ok === true, dep.text.slice(0, 120));
  check("引擎已复制", fs.existsSync(path.join(PROJ, "tools/graphgen.py")));
  check("默认不装插件", !fs.existsSync(path.join(PROJ, ".opencode/plugins/graphgen-watch.ts")));
  check("AGENTS 片段", fs.existsSync(path.join(PROJ, "AGENTS.md")));
  check("部署快照", fs.existsSync(path.join(PROJ, "docs/repo.json")));
  check(
    "首次部署写入 CHANGELOG 种子",
    fs.existsSync(path.join(PROJ, "docs/CHANGELOG.md")) &&
      /## DG-001: .*（\d{4}-\d{2}-\d{2}）/.test(
        fs.readFileSync(path.join(PROJ, "docs/CHANGELOG.md"), "utf8"),
      ),
  );
  const seedCfg = JSON.parse(
    fs.readFileSync(path.join(PROJ, "tools/graphgen.config.json"), "utf8"),
  );
  check(
    "种子前缀与孤儿豁免已补",
    seedCfg.prefixes?.DG &&
      (seedCfg.allowOrphanEntries || []).includes("DG-001"),
    JSON.stringify({
      prefixes: seedCfg.prefixes,
      allow: seedCfg.allowOrphanEntries,
    }),
  );

  const info = body(
    await call("tools/call", { name: "status", arguments: { root: PROJ } }),
  );
  const infoDetail = JSON.stringify({
    missing: info.json?.project?.missing,
    stale: info.json?.project?.stale,
    configs: info.json?.project?.missingConfigs,
  });
  check("status 显示已安装", info.json?.project?.installed === true, infoDetail);
  check("status 无待部署", info.json?.project?.needsDeploy === false, infoDetail);
  check(
    "status docs.ready=true",
    info.json?.project?.docs?.ready === true,
    JSON.stringify(info.json?.project?.docs),
  );

  // 缺技能/文件必须被识别为待部署（引擎源路径与目标路径不同）
  fs.rmSync(path.join(PROJ, ".opencode/skills/graphgen/SKILL.md"));
  const broken = body(
    await call("tools/call", { name: "status", arguments: { root: PROJ } }),
  );
  check(
    "缺技能触发 needsDeploy",
    broken.json?.project?.needsDeploy === true &&
      (broken.json?.project?.missing || []).includes(
        ".opencode/skills/graphgen/SKILL.md",
      ),
    JSON.stringify(broken.json?.project?.missing),
  );
  const repaired = body(
    await call("tools/call", {
      name: "deploy",
      arguments: { target: PROJ, confirm: true },
    }),
  );
  check(
    "deploy 可补齐技能",
    repaired.json?.ok === true &&
      fs.existsSync(path.join(PROJ, ".opencode/skills/graphgen/SKILL.md")),
  );

  const autoStatus = body(
    await call("tools/call", { name: "repo", arguments: { action: "status", root: AUTO } }),
  );
  check(
    "新项目首次 repo 调用自动部署",
    autoStatus.json?.bootstrap?.deployed === true,
    String(autoStatus.json?.bootstrap?.reason),
  );
  check("自动部署后有引擎", fs.existsSync(path.join(AUTO, "tools/repo.py")));
  check(
    "自动部署同时写 CHANGELOG 种子",
    fs.existsSync(path.join(AUTO, "docs/CHANGELOG.md")),
  );
  check(
    "有文件但无冲突时自动部署",
    autoStatus.json?.result?.result === "not_applicable" &&
      autoStatus.json?.result?.mode === "fs",
    JSON.stringify(autoStatus.json?.result),
  );
  check(
    "无 VCS 自动生成文件系统快照",
    fs.existsSync(path.join(AUTO, "docs/repo.json")) &&
      fs.existsSync(path.join(AUTO, "docs/REPO.md")),
  );

  const emptyStatus = body(
    await call("tools/call", {
      name: "repo",
      arguments: { action: "status", root: EMPTY },
    }),
  );
  check(
    "空项目首次调用先自动部署",
    emptyStatus.json?.bootstrap?.deployed === true &&
      fs.existsSync(path.join(EMPTY, "tools/graphgen.py")),
    String(emptyStatus.json?.bootstrap?.reason),
  );
  check(
    "空项目自动部署不建 git",
    !fs.existsSync(path.join(EMPTY, ".git")),
  );
  check(
    "空项目自动部署写 CHANGELOG 种子",
    fs.existsSync(path.join(EMPTY, "docs/CHANGELOG.md")),
  );

  // 有冲突：只提示，不自动写盘；确认 force 后才追加/覆盖。
  const conflictStatus = body(
    await call("tools/call", {
      name: "status",
      arguments: { root: CONFLICT },
    }),
  );
  check(
    "status 报告冲突",
    (conflictStatus.json?.project?.conflicts || []).some(
      (c) => c.path === "AGENTS.md",
    ),
    JSON.stringify(conflictStatus.json?.project?.conflicts),
  );
  const conflictCall = body(
    await call("tools/call", {
      name: "repo",
      arguments: { action: "status", root: CONFLICT },
    }),
  );
  check("冲突时首次调用不自动部署", conflictCall.isError === true);
  check(
    "冲突时未写 tools",
    !fs.existsSync(path.join(CONFLICT, "tools/graphgen.py")),
  );
  const conflictPlan = body(
    await call("tools/call", {
      name: "deploy",
      arguments: { target: CONFLICT, confirm: true },
    }),
  );
  check(
    "deploy confirm 遇冲突返回 needsConfirm",
    conflictPlan.json?.ok === false &&
      conflictPlan.json?.needsConfirm === true &&
      (conflictPlan.json?.conflicts || []).some((c) => c.path === "AGENTS.md"),
    conflictPlan.text.slice(0, 120),
  );
  const forced = body(
    await call("tools/call", {
      name: "deploy",
      arguments: { target: CONFLICT, confirm: true, force: true },
    }),
  );
  check(
    "deploy force 追加 AGENTS 并部署",
    forced.json?.ok === true &&
      fs.existsSync(path.join(CONFLICT, "tools/graphgen.py")) &&
      fs.existsSync(path.join(CONFLICT, "docs/CHANGELOG.md")) &&
      fs
        .readFileSync(path.join(CONFLICT, "AGENTS.md"), "utf8")
        .includes("<!-- graphgen:installed -->"),
    forced.text.slice(0, 120),
  );
  const conflictRepo = body(
    await call("tools/call", {
      name: "repo",
      arguments: { action: "status", root: CONFLICT },
    }),
  );
  check(
    "无 VCS repo status=not_applicable",
    conflictRepo.json?.ok === true &&
      conflictRepo.json?.result?.result === "not_applicable" &&
      conflictRepo.json?.result?.reason === "no_vcs",
    JSON.stringify(conflictRepo.json?.result),
  );
  const conflictSnap = body(
    await call("tools/call", {
      name: "repo",
      arguments: { action: "snapshot", root: CONFLICT },
    }),
  );
  check(
    "无 VCS repo snapshot=mode fs",
    conflictSnap.json?.mode === "fs" &&
      fs.existsSync(path.join(CONFLICT, "docs/repo.json")),
    JSON.stringify(conflictSnap.json?.result),
  );
  const conflictLinks = body(
    await call("tools/call", {
      name: "repo",
      arguments: { action: "links", root: CONFLICT },
    }),
  );
  check(
    "无 VCS links 返回 not_applicable + 建议",
    conflictLinks.json?.result?.result === "not_applicable" &&
      (conflictLinks.json?.result?.messages || []).length >= 2,
    JSON.stringify(conflictLinks.json?.result?.messages),
  );

  const docsStatus = body(
    await call("tools/call", { name: "status", arguments: { root: DOCS } }),
  );
  check(
    "已有 docs/graph.json 报告冲突",
    (docsStatus.json?.project?.conflicts || []).some(
      (c) => c.path === "docs/graph.json",
    ),
    JSON.stringify(docsStatus.json?.project?.conflicts),
  );
  const docsCall = body(
    await call("tools/call", {
      name: "repo",
      arguments: { action: "status", root: DOCS },
    }),
  );
  check(
    "文档库冲突时不自动部署",
    docsCall.isError === true &&
      !fs.existsSync(path.join(DOCS, "tools/graphgen.py")),
  );

  const gen = body(
    await call("tools/call", {
      name: "query",
      arguments: { action: "generate", root: PROJ },
    }),
  );
  check(
    "种子后首次 generate 0 errors / 0 warnings",
    gen.json?.code === 0 &&
      /0 errors, 0 warnings/.test(gen.json?.output || "") &&
      fs.existsSync(path.join(PROJ, "docs/graph.json")),
    gen.text.slice(0, 180),
  );
  const doclint = body(
    await call("tools/call", {
      name: "query",
      arguments: { action: "doclint", root: PROJ },
    }),
  );
  check(
    "种子后 doclint OK",
    doclint.json?.code === 0 && /doclint: OK/.test(doclint.json?.output || ""),
    doclint.text.slice(0, 180),
  );

  const q = body(
    await call("tools/call", {
      name: "query",
      arguments: { action: "check", root: PROJ },
    }),
  );
  check(
    "query check 返回退出码",
    typeof q.json?.code === "number",
    `code=${q.json?.code}`,
  );
  check(
    "种子后 check 0 errors / 0 warnings",
    q.json?.code === 0 && /0 errors, 0 warnings/.test(q.json?.output || ""),
    q.text.slice(0, 180),
  );

  // 二次部署不重复写种子，也不覆盖用户已有条目。
  const seedText = fs.readFileSync(path.join(PROJ, "docs/CHANGELOG.md"), "utf8");
  const again = body(
    await call("tools/call", {
      name: "deploy",
      arguments: { target: PROJ, confirm: true },
    }),
  );
  const nowSeedText = fs.readFileSync(path.join(PROJ, "docs/CHANGELOG.md"), "utf8");
  check(
    "二次部署幂等（种子不重复）",
    again.json?.ok === true &&
      nowSeedText === seedText &&
      (seedText.match(/^## DG-001:/gm) || []).length === 1,
    again.text.slice(0, 160) +
      ` eq=${nowSeedText === seedText} len=${seedText.length}/${nowSeedText.length}`,
  );

  const existing = body(
    await call("tools/call", {
      name: "deploy",
      arguments: { target: EXISTING, confirm: true },
    }),
  );
  check(
    "已有 CHANGELOG 不被覆盖",
    existing.json?.ok === true &&
      fs
        .readFileSync(path.join(EXISTING, "docs/CHANGELOG.md"), "utf8")
        .includes("人工维护，不应被部署器覆盖。") &&
      existing.json?.docs?.seeded === false,
    existing.text.slice(0, 180),
  );

  const invalid = body(
    await call("tools/call", {
      name: "deploy",
      arguments: { target: INVALID, confirm: true },
    }),
  );
  check(
    "已有空 CHANGELOG 不静默追加且不写 AGENTS",
    invalid.json?.ok === true &&
      invalid.json?.docs?.ready === false &&
      !fs.existsSync(path.join(INVALID, "AGENTS.md")),
    invalid.text.slice(0, 180),
  );
  const invalidCheck = body(
    await call("tools/call", {
      name: "query",
      arguments: { action: "check", root: INVALID },
    }),
  );
  check(
    "空条目库返回 needsDocs 而非裸 Python 错误",
    invalidCheck.json?.ok === false &&
      invalidCheck.json?.needsDocs === true &&
      (invalidCheck.json?.docs?.invalidEntryFiles || []).includes(
        "docs/CHANGELOG.md",
      ),
    invalidCheck.text.slice(0, 180),
  );

  const noId = body(
    await call("tools/call", {
      name: "deploy",
      arguments: {
        target: GITPROJ,
        confirm: true,
        vcsInit: true,
        vcsCommit: true,
      },
    }),
  );
  check(
    "缺 git 身份时 needsIdentity 且不建库",
    noId.json?.ok === true &&
      noId.json?.needsIdentity === true &&
      !fs.existsSync(path.join(GITPROJ, ".git")),
    noId.text.slice(0, 180),
  );
  const noIdStatus = body(
    await call("tools/call", { name: "status", arguments: { root: GITPROJ } }),
  );
  check(
    "status 暴露 identity=未配置 / needsIdentity",
    noIdStatus.json?.project?.identity?.configured === false &&
      noIdStatus.json?.project?.needsIdentity === true &&
      typeof noIdStatus.json?.project?.identity?.configPath === "string",
    JSON.stringify(noIdStatus.json?.project?.identity),
  );

  const oneShot = body(
    await call("tools/call", {
      name: "deploy",
      arguments: {
        target: GITONE,
        confirm: true,
        vcsInit: true,
        vcsCommit: true,
        identity: { name: "One Shot", email: "one@example.invalid" },
      },
    }),
  );
  const oneEmail = spawnSync(
    "git",
    ["-C", GITONE, "config", "--local", "--get", "user.email"],
    { encoding: "utf8", windowsHide: true },
  );
  check(
    "一次性身份可建库+首次提交",
    oneShot.json?.ok === true &&
      fs.existsSync(path.join(GITONE, ".git")) &&
      oneEmail.status === 0 &&
      oneEmail.stdout.trim() === "one@example.invalid",
    oneShot.text.slice(0, 180) + ` email=${oneEmail.stdout?.trim()}`,
  );
  const afterOne = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  check(
    "一次性身份不写入全局配置",
    !afterOne.identity?.remember && !afterOne.identity?.name,
    JSON.stringify(afterOne.identity),
  );

  const remembered = body(
    await call("tools/call", {
      name: "deploy",
      arguments: {
        target: GITPROJ,
        confirm: true,
        vcsInit: true,
        vcsCommit: true,
        identity: { name: "Remembered User", email: "remember@example.invalid" },
        rememberIdentity: true,
      },
    }),
  );
  const saved = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const head = spawnSync("git", ["-C", GITPROJ, "log", "-1", "--format=%s"], {
    encoding: "utf8",
    windowsHide: true,
  });
  check(
    "rememberIdentity 保存配置并建库+首次提交",
    remembered.json?.ok === true &&
      fs.existsSync(path.join(GITPROJ, ".git")) &&
      head.status === 0 &&
      head.stdout.trim().length > 0,
    remembered.text.slice(0, 180) + ` head=${head.stdout?.trim()}`,
  );
  check(
    "remember 同时打开 vcsInit/vcsCommit",
    saved.identity?.remember === true &&
      saved.identity?.name === "Remembered User" &&
      saved.deploy?.vcsInit === true &&
      saved.deploy?.vcsCommit === true,
    JSON.stringify({ identity: saved.identity, deploy: saved.deploy }),
  );
  check(
    "配置里没有密码/PAT/token",
    !/password|passwd|pat|token|secret/i.test(JSON.stringify(saved.identity)),
    JSON.stringify(saved.identity),
  );

  const autoGit = body(
    await call("tools/call", {
      name: "repo",
      arguments: { action: "status", root: GITPROJ2 },
    }),
  );
  check(
    "已记住身份后新项目自动建库",
    autoGit.json?.bootstrap?.deployed === true &&
      fs.existsSync(path.join(GITPROJ2, ".git")) &&
      autoGit.json?.result?.result === "ok",
    autoGit.text.slice(0, 220),
  );

  const repo = body(
    await call("tools/call", { name: "repo", arguments: { action: "status", root: PROJ } }),
  );
  check("repo status JSON", typeof repo.json?.result === "object", String(repo.json?.result?.result));

  const guard = body(
    await call("tools/call", {
      name: "repo",
      arguments: { action: "guard", root: PROJ, stage: "commit" },
    }),
  );
  check("repo guard 只读可调用", typeof guard.json?.ok === "boolean");

  const ver = body(
    await call("tools/call", { name: "verify", arguments: { root: PROJ } }),
  );
  check(
    "verify 聚合三段",
    !!ver.json?.graphgen && !!ver.json?.doclint && !!ver.json?.repo,
  );

  const nested = body(
    await call("tools/call", {
      name: "deploy",
      arguments: { target: path.join(SOURCE, "tools"), confirm: true },
    }),
  );
  check("拒绝部署到引擎目录内", nested.isError === true, nested.text.slice(0, 80));

  const unknown = body(
    await call("tools/call", { name: "nope", arguments: {} }),
  );
  check("未知工具 isError", unknown.isError === true);

  console.log(`\ngraphgen MCP 自检: PASS=${pass} FAIL=${fail}`);
} finally {
  p.stdin.end();
  fs.rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}
