// graphgen MCP —— 引擎桥：调用 Python 工具、解析 JSON、计算文件哈希
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolvePython } from "./config.mjs";

export function runProcess(command, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          ...(opts.env || {}),
        },
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e), timedOut: false });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    let timer = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: String(e), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: typeof code === "number" ? code : -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
  });
}

export function pythonArgs(cfg) {
  const py = resolvePython(cfg);
  return { command: py.command, prefix: py.prefix, version: py.version };
}

export function runPython(cfg, script, args, opts = {}) {
  const py = pythonArgs(cfg);
  return runProcess(py.command, [...py.prefix, script, ...args], {
    cwd: opts.cwd || cfg.defaultRoot,
    timeoutMs: opts.timeoutMs ?? (cfg.timeoutSec || 180) * 1000,
    env: opts.env,
  });
}

export function runEngine(cfg, root, scriptRel, args, opts = {}) {
  const script = path.join(root, scriptRel);
  if (!fs.existsSync(script)) {
    throw new Error(`缺少 ${script}（先运行 gcgl_deploy 部署引擎）`);
  }
  return runPython(cfg, script, args, { ...opts, cwd: root });
}

export function parseJson(text) {
  const t = (text || "").replace(/^\uFEFF/, "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export async function runRepo(cfg, root, args) {
  const r = await runEngine(cfg, root, path.join("tools", "repo.py"), [
    ...args,
    "--root",
    root,
    "--json",
  ]);
  const json = parseJson(r.stdout);
  return {
    ok: r.code === 0,
    code: r.code,
    timedOut: r.timedOut,
    data: json,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

export async function runInstall(cfg, target, flags = []) {
  const script = path.join(cfg.engineRoot, "install.py");
  if (!fs.existsSync(script)) {
    throw new Error(
      `找不到安装器 ${script}。请先运行 node mcp/install.mjs，或检查 mcp/config.json 的 engineRoot`,
    );
  }
  const r = await runPython(
    cfg,
    script,
    ["--target", target, "--json", ...flags],
    { cwd: cfg.engineRoot },
  );
  const report = parseJson(r.stdout);
  if (!report) {
    throw new Error(
      `install.py 输出无法解析（exit ${r.code}）: ${(r.stdout || r.stderr || "").slice(0, 500)}`,
    );
  }
  return { ...r, report };
}

export function sha256File(file) {
  try {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(file));
    return hash.digest("hex");
  } catch {
    return null;
  }
}
