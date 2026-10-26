#!/usr/bin/env node
// graphgen MCP 自检：initialize / tools.list / status / deploy(plan+confirm) /
// 自动补引擎 / query / repo / verify / 边界。
// 用法: node mcp/mcp-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, "..");
const SERVER = path.join(HERE, "server.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "graphgen-mcp-test-"));
const PROJ = path.join(TMP, "proj");
const AUTO = path.join(TMP, "auto");
const CONFIG = path.join(TMP, "config.json");
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(AUTO, { recursive: true });
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
        vcsCommit: false,
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

  const q = body(
    await call("tools/call", {
      name: "query",
      arguments: { action: "check", root: PROJ },
    }),
  );
  check("query check 返回退出码", typeof q.json?.code === "number", `code=${q.json?.code}`);

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
