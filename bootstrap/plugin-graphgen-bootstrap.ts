import { existsSync } from "node:fs"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Plugin } from "@opencode/plugin"

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

export default Plugin.define({
  id: "graphgen-bootstrap",
  async setup(ctx) {
    const root = ctx.location.directory
    if (!root || isInstalled(root)) return

    const pkg = findPackage(root)
    if (!pkg) return

    const py = await findPython()
    const hint =
      pkg.kind === "install"
        ? `python ${path.join(pkg.dir, "install.py")} --target ${root}`
        : `python ${path.join(pkg.dir, "graphgen.py")} --init ${root}`
    if (!py) {
      console.warn(
        `[graphgen-bootstrap] 发现 ${pkg.dir} 但找不到 python（尝试 py/python/python3），请手动运行: ${hint}`,
      )
      return
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
      const output = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "")
      console.log(
        `[graphgen-bootstrap] graphgen 全家桶已自动安装到 ${root}，请重启 opencode 使技能生效（默认无文件监听；需要时用 install.py --plugin）`,
        output,
      )
      if (output.includes("未检测到可用的 VCS 工具")) {
        console.warn(
          "[graphgen-bootstrap] 本机没有 git/svn/hg：代码仓库管理已跳过。" +
            "装好 git 后重跑 install.py 即可（Windows: winget install --id Git.Git -e）",
        )
      } else if (/git\s+git init\b|git\s+\[dry-run\] git init/.test(output)) {
        console.log("[graphgen-bootstrap] 已为项目创建 git 仓库（git init），并生成部署快照与条目索引")
      } else if (output.includes("位于") && output.includes("仓库") && output.includes("不建嵌套库")) {
        console.warn(
          "[graphgen-bootstrap] 项目位于父仓库内，未建嵌套库；确需独立历史请运行 " +
            "python tools/repo.py init --allow-nested",
        )
      }
    } catch (err) {
      console.error(`[graphgen-bootstrap] graphgen 自动安装失败: ${String(err)}`)
    }
  },
})
