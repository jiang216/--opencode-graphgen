import { existsSync } from "node:fs"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { type Plugin } from "@opencode-ai/plugin"

const exec = promisify(execFile)

const PY_CANDIDATES = ["py", "python", "python3"]

async function findPython(): Promise<string | null> {
  for (const cmd of PY_CANDIDATES) {
    try {
      await exec(cmd, ["--version"], { windowsHide: true })
      return cmd
    } catch {
      // try next candidate
    }
  }
  return null
}

type Package = { dir: string; kind: "install" | "legacy" }

function findPackage(root: string): Package | null {
  for (const rel of [
    "opencode-graphgen",
    path.join("tools", "opencode-graphgen"),
    "graphgen-dist",
    path.join("tools", "graphgen-dist"),
  ]) {
    const dir = path.join(root, rel)
    if (existsSync(path.join(dir, "install.py"))) return { dir, kind: "install" }
    if (existsSync(path.join(dir, "graphgen.py"))) return { dir, kind: "legacy" }
  }
  return null
}

function isInstalled(root: string): boolean {
  return (
    existsSync(path.join(root, "tools", "graphgen.py")) &&
    existsSync(path.join(root, ".opencode", "skills", "graphgen", "SKILL.md"))
  )
}

export const GraphgenBootstrapPlugin: Plugin = async ({ directory, worktree, client }) => {
  const root = worktree ?? directory
  if (!root || isInstalled(root)) return {}

  const pkg = findPackage(root)
  if (!pkg) return {}

  const py = await findPython()
  const hint =
    pkg.kind === "install"
      ? `python ${path.join(pkg.dir, "install.py")} --target ${root}`
      : `python ${path.join(pkg.dir, "graphgen.py")} --init ${root}`
  if (!py) {
    await client.app.log({
      body: {
        service: "graphgen-bootstrap",
        level: "warn",
        message: `发现 ${pkg.dir} 但找不到 python（尝试 py/python/python3），请手动运行: ${hint}`,
      },
    })
    return {}
  }

  try {
    const args =
      pkg.kind === "install"
        ? [path.join(pkg.dir, "install.py"), "--target", root]
        : [path.join(pkg.dir, "graphgen.py"), "--init", root]
    const { stdout, stderr } = await exec(py, args, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    })
    await client.app.log({
      body: {
        service: "graphgen-bootstrap",
        level: "info",
        message: `graphgen 全家桶已自动安装到 ${root}，请重启 opencode 使技能/插件生效（此后由 graphgen 技能管理）`,
        extra: { output: (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "") },
      },
    })
  } catch (err) {
    await client.app.log({
      body: {
        service: "graphgen-bootstrap",
        level: "error",
        message: `graphgen 自动安装失败: ${String(err)}`,
      },
    })
  }
  return {}
}

export default GraphgenBootstrapPlugin
