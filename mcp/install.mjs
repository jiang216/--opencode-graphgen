#!/usr/bin/env node
// graphgen MCP 安装器 —— 把运行时复制到用户指定目录，并注册到 opencode。
// 用法:
//   node mcp/install.mjs --doctor
//   node mcp/install.mjs --dry-run
//   node mcp/install.mjs --install-dir D:\tools\graphgen-mcp
//   node mcp/install.mjs --link                 # 直接引用本仓库（开发）
//   node mcp/install.mjs --scope project --target F:\proj
//   node mcp/install.mjs --uninstall [--purge]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, resolvePython } from "./config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, "..");
// 在仓库里运行时引擎就在 SOURCE；在已安装运行时里引擎在 SOURCE/engine。
const ENGINE_SOURCE = fs.existsSync(path.join(SOURCE, "tools", "graphgen.py"))
  ? SOURCE
  : path.join(SOURCE, "engine");
const VERSION = readVersion();

function readVersion() {
  for (const file of [
    path.join(ENGINE_SOURCE, "package.json"),
    path.join(SOURCE, "package.json"),
  ]) {
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8")).version;
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  try {
    return fs.readFileSync(path.join(SOURCE, "VERSION"), "utf8").trim();
  } catch {
    return "0.3.0";
  }
}

function parseArgs(argv) {
  const out = {
    scope: "global",
    installDir: "",
    link: false,
    target: process.cwd(),
    config: "",
    doctor: false,
    dryRun: false,
    uninstall: false,
    purge: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺少参数`);
      return v;
    };
    switch (a) {
      case "--scope":
        out.scope = next();
        if (!["global", "project"].includes(out.scope))
          throw new Error(`--scope 只支持 global|project`);
        break;
      case "--install-dir":
        out.installDir = next();
        break;
      case "--link":
        out.link = true;
        break;
      case "--target":
        out.target = path.resolve(next());
        break;
      case "--config":
        out.config = path.resolve(next());
        break;
      case "--doctor":
        out.doctor = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--uninstall":
        out.uninstall = true;
        break;
      case "--purge":
        out.purge = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  return out;
}

function defaultInstallDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "graphgen-mcp");
}

function opencodeConfigPath(args) {
  if (args.config) return args.config;
  if (args.scope === "project") return path.join(args.target, "opencode.json");
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function writeJson(file, data) {
  const text = JSON.stringify(data, null, 2) + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  const bak = `${file}.bak.${stamp}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function copyRuntime(installDir, link) {
  const logs = [];
  const mcpDir = link ? HERE : path.join(installDir, "mcp");
  const engineDir = link ? SOURCE : path.join(installDir, "engine");
  if (!link) {
    fs.mkdirSync(installDir, { recursive: true });
    // mcp/
    fs.mkdirSync(mcpDir, { recursive: true });
    for (const name of fs.readdirSync(HERE)) {
      // 保留用户配置；示例配置仍复制
      if (name === "config.json") continue;
      fs.cpSync(path.join(HERE, name), path.join(mcpDir, name), {
        recursive: true,
        force: true,
      });
    }
    // engine/
    fs.mkdirSync(engineDir, { recursive: true });
    for (const name of [
      "install.py",
      "package.json",
      "tools",
      "templates",
      "skills",
      "src",
    ]) {
      const src = path.join(ENGINE_SOURCE, name);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(engineDir, name), {
        recursive: true,
        force: true,
      });
    }
    fs.writeFileSync(path.join(installDir, "VERSION"), VERSION + "\n", "utf8");
    logs.push(`copy  ${mcpDir}`);
    logs.push(`copy  ${engineDir}`);
  } else {
    logs.push(`link  ${mcpDir}（不复制，直接引用仓库）`);
  }
  return { logs, mcpDir, engineDir };
}

function ensureConfig(configPath, engineRoot) {
  let created = false;
  let data;
  if (fs.existsSync(configPath)) {
    data = readJson(configPath);
  } else {
    data = readJson(path.join(HERE, "config.example.json"), {});
    created = true;
  }
  data.engineRoot = engineRoot;
  data.sourceRoot = SOURCE;
  if (!data.deploy) {
    data.deploy = {
      vcs: "auto",
      vcsInit: true,
      vcsCommit: false,
      snapshot: true,
      agents: true,
      hooks: false,
      plugin: false,
      removePlugin: false,
      vcsRemote: "",
      vcsBranch: "",
    };
  }
  if (data.autoDeploy === undefined) data.autoDeploy = true;
  if (!data.timeoutSec) data.timeoutSec = 180;
  if (!data.python) data.python = "auto";
  writeJson(configPath, data);
  return { created, data };
}

function buildEntry(mcpDir, configPath) {
  return {
    type: "local",
    command: [process.execPath, path.join(mcpDir, "server.mjs")],
    environment: { GRAPHGEN_CONFIG: configPath },
    enabled: true,
  };
}

function register(configPath, entry, { dryRun, uninstall }) {
  const logs = [];
  if (uninstall && !fs.existsSync(configPath)) {
    return [`skip  mcp.graphgen 不存在（${configPath}）`];
  }
  let data = readJson(configPath, {});
  if (!data || typeof data !== "object") data = {};
  data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : {};
  if (uninstall) {
    if (data.mcp.graphgen) {
      delete data.mcp.graphgen;
      logs.push(`del   mcp.graphgen（${configPath}）`);
    } else {
      logs.push(`skip  mcp.graphgen 不存在（${configPath}）`);
    }
  } else {
    data.mcp.graphgen = entry;
    logs.push(`set   mcp.graphgen -> ${entry.command.join(" ")}`);
  }
  if (dryRun) {
    logs.push("dry-run：未写入配置文件");
    return logs;
  }
  const bak = backup(configPath);
  if (bak) logs.push(`backup ${bak}`);
  writeJson(configPath, data);
  logs.push(`write ${configPath}`);
  return logs;
}

function selfTest(serverPath, configPath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath], {
      windowsHide: true,
      env: { ...process.env, GRAPHGEN_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => finish({ ok: false, error: "自检超时" }), timeoutMs);
    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(result);
    }
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
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
        if (msg.id === 1) {
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
          );
        } else if (msg.id === 2) {
          const names = (msg.result?.tools || []).map((t) => t.name);
          finish({
            ok: names.length > 0,
            name: "graphgen",
            tools: names,
            stderr: stderr.trim(),
          });
        }
      }
    });
    child.on("error", (e) => finish({ ok: false, error: String(e) }));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "graphgen-install", version: "1" },
        },
      }) + "\n",
    );
  });
}

async function doctor(args, paths) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  add("Node >= 20", Number(process.versions.node.split(".")[0]) >= 20, process.version);
  const configPath = paths.configPath;
  add("配置文件", fs.existsSync(configPath), configPath);
  let cfg = null;
  try {
    cfg = loadConfig(configPath);
    add("配置解析", true, `engineRoot=${cfg.engineRoot}`);
  } catch (e) {
    add("配置解析", false, e.message);
  }
  if (cfg) {
    add("引擎目录", fs.existsSync(cfg.engineRoot), cfg.engineRoot);
    add("install.py", fs.existsSync(path.join(cfg.engineRoot, "install.py")));
    add("server.mjs", fs.existsSync(path.join(paths.mcpDir, "server.mjs")));
    try {
      add("Python", true, resolvePython(cfg).version);
    } catch (e) {
      add("Python", false, e.message);
    }
    if (fs.existsSync(path.join(paths.mcpDir, "server.mjs"))) {
      const st = await selfTest(
        path.join(paths.mcpDir, "server.mjs"),
        configPath,
      );
      add("MCP 自检", st.ok, st.ok ? `tools=${st.tools.join(",")}` : st.error || st.stderr);
    }
  }
  try {
    const data = readJson(paths.opencodeConfig, {});
    add(
      "opencode 注册",
      !!data?.mcp?.graphgen,
      paths.opencodeConfig,
    );
  } catch (e) {
    add("opencode 配置解析", false, e.message);
  }
  return checks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      `用法: node mcp/install.mjs [选项]\n` +
        `  --doctor                     只检查\n` +
        `  --dry-run                    只打印计划\n` +
        `  --install-dir <dir>          运行时目录（默认 ~/.config/opencode/graphgen-mcp）\n` +
        `  --link                       直接引用本仓库（开发）\n` +
        `  --scope global|project       注册范围（默认 global）\n` +
        `  --target <dir>               project 模式的项目根\n` +
        `  --config <file>              指定 opencode 配置路径\n` +
        `  --uninstall [--purge]        注销（--purge 同时删运行时）\n` +
        `  --json                       机器可读输出\n`,
    );
    return 0;
  }

  const installDir = args.link ? SOURCE : path.resolve(args.installDir || defaultInstallDir());
  if (!args.link && !args.uninstall && !args.doctor) {
    const rel = path.relative(SOURCE, installDir);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      throw new Error(`--install-dir 不能是仓库或仓库子目录: ${installDir}（开发用 --link）`);
    }
  }
  const mcpDir = args.link ? HERE : path.join(installDir, "mcp");
  const configPath = path.join(mcpDir, "config.json");
  const opencodeConfig = opencodeConfigPath(args);
  const paths = { installDir, mcpDir, configPath, opencodeConfig };

  const report = {
    version: VERSION,
    scope: args.scope,
    installDir,
    mcpDir,
    configPath,
    opencodeConfig,
    logs: [],
    checks: [],
    ok: true,
  };

  try {
    if (args.doctor) {
      report.checks = await doctor(args, paths);
      report.ok = report.checks.every((c) => c.ok);
    } else if (args.uninstall) {
      report.logs.push(
        ...register(opencodeConfig, null, {
          dryRun: args.dryRun,
          uninstall: true,
        }),
      );
      const sourceIsRepo = fs.existsSync(path.join(SOURCE, "tools", "graphgen.py"));
      const canPurge =
        args.purge && !args.link && !(installDir === SOURCE && sourceIsRepo);
      if (canPurge) {
        if (args.dryRun) {
          report.logs.push(`dry-run：将删除 ${installDir}`);
        } else {
          fs.rmSync(installDir, { recursive: true, force: true });
          report.logs.push(`del   ${installDir}`);
        }
      } else if (args.purge) {
        report.logs.push(`skip  --purge：拒绝删除源码仓库 ${installDir}`);
      }
    } else {
      const engineRoot = args.link ? ".." : "../engine";
      if (args.dryRun) {
        if (args.link) {
          report.logs.push(`dry-run：link 到 ${mcpDir}（不复制）`);
        } else {
          report.logs.push(`dry-run：将复制 ${HERE} -> ${mcpDir}`);
          report.logs.push(`dry-run：将复制引擎 -> ${path.join(installDir, "engine")}`);
        }
        report.logs.push(`dry-run：将写配置 ${configPath}（engineRoot=${engineRoot}）`);
      } else {
        const copied = copyRuntime(installDir, args.link);
        report.logs.push(...copied.logs);
        const conf = ensureConfig(configPath, engineRoot);
        report.logs.push(
          `${conf.created ? "new  " : "upd  "} ${configPath}（engineRoot=${engineRoot}）`,
        );
      }
      if (!args.dryRun) {
        const st = await selfTest(path.join(mcpDir, "server.mjs"), configPath);
        report.checks.push({
          name: "MCP 自检",
          ok: st.ok,
          detail: st.ok ? `tools=${st.tools.join(",")}` : st.error || st.stderr,
        });
        if (!st.ok) report.ok = false;
      }
      // 自检失败时不注册，避免把坏运行时写进 opencode 配置
      if (args.dryRun || report.ok) {
        report.logs.push(
          ...register(opencodeConfig, buildEntry(mcpDir, configPath), {
            dryRun: args.dryRun,
            uninstall: false,
          }),
        );
      }
    }
  } catch (e) {
    report.ok = false;
    report.error = e?.message || String(e);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`graphgen MCP v${VERSION}\n`);
    for (const line of report.logs) process.stdout.write(`  ${line}\n`);
    for (const c of report.checks) {
      process.stdout.write(
        `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  " + c.detail : ""}\n`,
      );
    }
    if (report.error) process.stdout.write(`  ERROR ${report.error}\n`);
    process.stdout.write(report.ok ? "install: OK\n" : "install: FAIL\n");
  }
  return report.ok ? 0 : 1;
}

main().then((code) => process.exit(code));
