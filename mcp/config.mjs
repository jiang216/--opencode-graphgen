// graphgen MCP —— 配置加载、路径解析、Python 发现
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(HERE, "config.json");

// 仓库内开发时（mcp/../tools 存在）默认直接用仓库当引擎；安装布局则是 ../engine
const DEV_ENGINE = fs.existsSync(path.join(HERE, "..", "tools", "graphgen.py"))
  ? path.resolve(HERE, "..")
  : path.resolve(HERE, "..", "engine");

export const DEFAULT_CONFIG = {
  engineRoot: DEV_ENGINE,
  python: "auto",
  defaultRoot: ".",
  timeoutSec: 180,
  autoDeploy: true,
  // 安装器写入：MCP 源仓库路径。自动部署会跳过它，避免把工具仓库本身当消费项目改写。
  sourceRoot: "",
  protectedRoots: [],
  deploy: {
    vcs: "auto",
    vcsInit: false,
    vcsCommit: false,
    snapshot: true,
    agents: true,
    hooks: false,
    plugin: false,
    removePlugin: false,
    vcsRemote: "",
    vcsBranch: "",
  },
  memory: { autoCommit: true },
  guard: { allowPush: false },
};

function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override : base;
  if (base && typeof base === "object") {
    const out = { ...base };
    if (override && typeof override === "object" && !Array.isArray(override)) {
      for (const [k, v] of Object.entries(override)) {
        out[k] = k in base ? deepMerge(base[k], v) : v;
      }
    }
    return out;
  }
  return override === undefined ? base : override;
}

export function loadConfig(explicitPath) {
  const file =
    explicitPath || process.env.GRAPHGEN_CONFIG || DEFAULT_CONFIG_PATH;
  let user = {};
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      user = JSON.parse(raw);
    } catch (e) {
      throw new Error(`配置文件解析失败: ${file}: ${e.message}`);
    }
  }
  const cfg = deepMerge(DEFAULT_CONFIG, user);
  cfg.configPath = file;
  cfg.configDir = path.dirname(file);
  // engineRoot 相对配置文件所在目录解析（安装布局: <install>/mcp/config.json -> ../engine）
  cfg.engineRoot = path.resolve(cfg.configDir, cfg.engineRoot);
  if (cfg.defaultRoot === "." || cfg.defaultRoot === "") {
    cfg.defaultRoot = process.cwd();
  } else {
    cfg.defaultRoot = path.resolve(process.cwd(), cfg.defaultRoot);
  }
  return cfg;
}

let pythonCache = null;

/**
 * 返回 { command, prefix: string[], version }。
 * 顺序：config.python（非 auto）> GRAPHGEN_PYTHON > python > python3 > py -3
 */
export function resolvePython(cfg) {
  if (pythonCache) return pythonCache;
  const candidates = [];
  const configured = (cfg?.python || "auto").trim();
  if (configured && configured.toLowerCase() !== "auto") candidates.push(configured);
  if (process.env.GRAPHGEN_PYTHON) candidates.push(process.env.GRAPHGEN_PYTHON);
  candidates.push("python", "python3");
  if (process.platform === "win32") candidates.push("py");

  const tried = [];
  for (const command of candidates) {
    const prefix = command === "py" ? ["-3"] : [];
    const r = spawnSync(command, [...prefix, "--version"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
    });
    const text = `${r.stdout || ""} ${r.stderr || ""}`.trim();
    if (r.status === 0 && /Python\s+\d/i.test(text)) {
      pythonCache = { command, prefix, version: text.replace(/\s+/g, " ") };
      return pythonCache;
    }
    tried.push(`${command}${prefix.length ? " " + prefix.join(" ") : ""}`);
  }
  throw new Error(
    `找不到可用的 Python（已尝试: ${tried.join(", ")}）。请安装 Python 3 或在 mcp/config.json 里设置 "python": "C:/.../python.exe"`,
  );
}

export function resolveRoot(cfg, root) {
  const raw = root || cfg.defaultRoot || process.cwd();
  const abs = path.resolve(process.cwd(), raw);
  if (!fs.existsSync(abs)) throw new Error(`目标目录不存在: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`目标不是目录: ${abs}`);
  return abs;
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
