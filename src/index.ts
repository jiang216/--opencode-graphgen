import { existsSync } from "node:fs"
import * as path from "node:path"
import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Plugin } from "@opencode/plugin"

const exec = promisify(execFile)

const GRAPHGEN_REL = path.join("tools", "graphgen.py")
const OUTPUT_REL = path.join("docs", "graph.json")
const DOCLINT_REL = path.join("tools", "doclint.py")

function normalizeRel(root: string, file: string): string | null {
  const abs = path.isAbsolute(file) ? file : path.join(root, file)
  const rel = path.relative(root, abs).replace(/\\/g, "/")
  if (rel === "" || rel.startsWith("..") || rel.startsWith("./")) return null
  return rel
}

function isWatchTarget(rel: string): boolean {
  if (rel.startsWith("docs/") && !rel.startsWith("docs/graph")) return true
  if (rel === "AGENTS.md") return true
  if (rel.startsWith(".opencode/skills/") && rel.endsWith("/SKILL.md")) return true
  if (rel === path.join("tools", "graphgen.config.json").replace(/\\/g, "/")) return true
  if (rel.startsWith(".claude/skills/") && rel.endsWith(".md")) return true
  if (rel === "tools/doclint.config.json") return true
  if (rel === "tools/doc-slices.json") return true
  return false
}

async function runGraphgen(root: string, checkOnly: boolean): Promise<string> {
  const script = path.join(root, GRAPHGEN_REL)
  if (!existsSync(script)) throw new Error(`graphgen script not found: ${script}`)
  const args = [GRAPHGEN_REL]
  if (checkOnly) args.push("--check")
  const { stdout, stderr } = await exec("python", args, {
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
  })
  return (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "")
}

async function runDoclint(root: string): Promise<string> {
  const script = path.join(root, DOCLINT_REL)
  if (!existsSync(script)) throw new Error(`doclint script not found: ${script}`)
  try {
    const { stdout, stderr } = await exec("python", [DOCLINT_REL], {
      cwd: root,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    })
    return (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "")
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    const out = (e.stdout ?? "") + (e.stderr ? `\n[stderr]\n${e.stderr}` : "")
    if (typeof e.code === "number") return out.trim() || `doclint exit ${e.code}`
    throw err
  }
}

function lookupNode(
  graph: { nodes: Record<string, { id: string; label: string; path: string; anchor?: string }> },
  input: string,
): string | null {
  const q = input.trim()
  if (!q) return null
  const exact = graph.nodes[q.toUpperCase()]
  if (exact) return exact.id
  const upper = q.toUpperCase()
  for (const id of Object.keys(graph.nodes)) {
    if (id.toUpperCase() === upper) return id
  }
  const colon = upper.includes(":") ? upper.split(":").pop() : upper
  const bySuffix = Object.keys(graph.nodes).filter((id) => id.toUpperCase().endsWith(":" + colon))
  if (bySuffix.length === 1) return bySuffix[0]
  if (bySuffix.length > 1) {
    return bySuffix.find((id) => id.toUpperCase() === `BUG:${upper}`) ?? null
  }
  return null
}

export default Plugin.define({
  id: "graphgen-watch",
  async setup(ctx) {
    // 插件实例所在位置（worktree 场景下即 worktree 根）
    const root = ctx.location.directory

    let timer: ReturnType<typeof setTimeout> | null = null
    let running = false
    let pending = false

    const regen = async () => {
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        const out = await runGraphgen(root, false)
        console.log(`[graphgen-watch] docs graph regenerated\n${out.slice(0, 400)}`)
      } catch (err) {
        console.warn(`[graphgen-watch] graphgen failed: ${String(err)}`)
      } finally {
        running = false
        if (pending) {
          pending = false
          void regen()
        }
      }
    }

    const scheduleRegen = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void regen()
      }, 1500)
    }

    // 文件变更 → 防抖重建图谱。
    // V2 公开事件为 filesystem.changed（data: {file, event}）；file.edited 仍存在于
    // 服务端事件清单（data: {file}）但客户端类型未导出，这里做防御性兼容。
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const event = raw as unknown as { type: string; data?: { file?: unknown } }
          if (event.type !== "filesystem.changed" && event.type !== "file.edited") continue
          const file = event.data?.file
          if (typeof file !== "string") continue
          const rel = normalizeRel(root, file)
          if (!rel || !isWatchTarget(rel)) continue
          scheduleRegen()
        }
      } catch (err) {
        console.warn(`[graphgen-watch] event stream ended: ${String(err)}`)
      }
    })()

    // graphgen_query 工具（query/generate/check/doclint）
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "graphgen_query",
        description:
          "文档图谱查询/生成（graphgen）+ 文档漂移校验（doclint）。action=query: 按节点 id（如 BUG:XX-###、DOC:xxx、SKILL:xxx、META:AGENTS）读 docs/graph.json 的正反链；action=generate: 重新生成 docs/graph.json|GRAPH.md|graph.mmd；action=check: 只做 lint 校验（有错 exit 1）；action=doclint: 跑 tools/doclint.py 文档漂移机械校验（R1-R7+生成块，有错 exit 1）。图谱由 tools/graphgen.py 生成，GRAPH.md 禁手改。",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["query", "generate", "check", "doclint"],
              description:
                "query=查正反链; generate=重新生成图谱; check=lint 校验; doclint=文档漂移机械校验",
            },
            node: {
              type: "string",
              description: "query 用：节点 id 或简称，如 G-004",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { action: "query" | "generate" | "check" | "doclint"; node?: string }
          const graphPath = path.join(root, OUTPUT_REL)
          if (args.action === "doclint") {
            const out = await runDoclint(root)
            const failed = /error\(s\)/.test(out) || /^doclint: 找不到配置/m.test(out)
            if (failed) throw new Error(out.trim())
            return { content: out.trim() }
          }
          if (args.action === "generate" || args.action === "check") {
            const out = await runGraphgen(root, args.action === "check")
            if (args.action === "generate" && !existsSync(graphPath)) {
              throw new Error(`generate 后未发现 ${graphPath}，输出:\n${out}`)
            }
            return { content: out.trim() }
          }
          if (!existsSync(graphPath)) {
            return {
              content: `缺少 ${OUTPUT_REL}，请先运行生成（action=generate 或 python tools/graphgen.py）。`,
            }
          }
          const graph = JSON.parse(await readFile(graphPath, "utf-8"))
          const wanted = args.node || "BUG:G-001"
          const nid = lookupNode(graph, wanted)
          if (!nid) {
            return {
              content: `未找到节点「${wanted}」。可用前缀：BUG:/DOC:/SKILL:/META:/SRC:。`,
            }
          }
          const node = graph.nodes[nid]
          const backlinks = graph.backlinks?.[nid] ?? []
          const outlinks = (graph.edges ?? []).filter((e: { from: string }) => e.from === nid)
          const fmt = (list: Array<{ from?: string; to?: string; kind?: string; context?: string }>, dir: "in" | "out") =>
            list.map((x) => {
              const peer = dir === "in" ? x.from : x.to
              const ctx = x.context ? ` — ${x.context}` : ""
              return `  ${peer} [${x.kind}]${ctx}`
            })
          const lines = [
            `${nid} · ${node.label}`,
            `  路径: ${node.path}${node.anchor ? "#" + node.anchor : ""}`,
            `反链(${backlinks.length}):`,
            ...(backlinks.length ? fmt(backlinks, "in") : ["  (无)"]),
            `出链(${outlinks.length}):`,
            ...(outlinks.length ? fmt(outlinks, "out") : ["  (无)"]),
          ]
          return { content: lines.join("\n") }
        },
      })
    })

    // compaction 摘要请求注入“graphgen_query 必须保持可用”提示
    await ctx.session.hook("compaction", (event) => {
      event.system.push({
        type: "text",
        text: `## 可用工具（compaction 后必须保持可用）

- **graphgen_query**：文档图谱查询/生成 + 文档漂移校验工具。
  - action=query, node=BUG:X-NNN：查某条目的正反链（支持简称如 g-004）
  - action=generate：重新生成 docs/graph.json | GRAPH.md | graph.mmd
  - action=check：lint 校验（有错 exit 1）
  - action=doclint：文档漂移机械校验（tools/doclint.py，有错 exit 1）
  图谱由 tools/graphgen.py 生成，GRAPH.md 禁手改。

- **skill 工具**：可加载 graphgen 技能（查反链/跑生成器/防漂移的详细指南）。
  当需要查某个条目被哪些文档引用、某份文档的回归清单覆盖哪些条目、
  或改完文档后确认图谱同步/防漂移通过时，必须使用 graphgen_query 或加载 graphgen 技能。`,
      })
    })

    // 插件卸载时：停事件流 + 清防抖定时器（hook/transform 注册由 opencode 自动回收）
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  },
})
