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
const REPO_REL = path.join("tools", "repo.py")

// 常驻记忆：由 context 钩子每轮注入，压缩后依然生效。
// 关掉：环境变量 GRAPHGEN_AUTO_COMMIT=0
const AUTO_COMMIT_MEMORY = `## 提交约定（常驻记忆 · 改动后自动提交）

- 完成一批改动后，**你自己提交**，不要让用户再手动 \`git commit\`；用户说“改完/继续/就这样”时同样适用。
- 提交前先 \`git status --short\`：只 \`git add\` 本次任务动过的文件，**不要**把用户其他未完成的改动、临时产物、密钥（.env 等）一起提交；分不清就先问。
- 提交信息：有对应文档条目就带条目 ID（如 \`fix(DG-009): ...\`，或正文 \`Refs: DG-009\`）；没有就用 \`chore:\`/\`docs:\` 并在正文说明改了什么。
- 提交前可跑 \`python tools/repo.py guard --stage commit\`（只读检查）；不要 \`git push\`、不要 amend/rebase 别人的提交、不要改全局 git 配置。
- 提交后：有条目 ID 时跑 \`python tools/repo.py links\` 刷新条目↔提交索引；发布/部署后再跑 \`python tools/repo.py snapshot\`。
- 目标不是 git 仓库或本机没有 git 时：跳过提交并在汇报里说明（不要擅自 \`git init\`，除非用户要求）。`

function autoCommitEnabled(): boolean {
  const v = (process.env.GRAPHGEN_AUTO_COMMIT ?? "1").trim().toLowerCase()
  return !(v === "0" || v === "off" || v === "false" || v === "no")
}

function normalizeRel(root: string, file: string): string | null {
  const abs = path.isAbsolute(file) ? file : path.join(root, file)
  const rel = path.relative(root, abs).replace(/\\/g, "/")
  if (rel === "" || rel.startsWith("..") || rel.startsWith("./")) return null
  return rel
}

function isWatchTarget(rel: string): boolean {
  // 部署快照是产物，写了不触发生成（否则 snapshot → 重生成 → 再 snapshot 抖）
  if (rel === "docs/REPO.md") return false
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

async function runRepo(root: string, args: string[]): Promise<string> {
  const script = path.join(root, REPO_REL)
  if (!existsSync(script)) throw new Error(`repo script not found: ${script}（先运行 install.py）`)
  try {
    const { stdout, stderr } = await exec("python", [REPO_REL, ...args, "--root", root], {
      cwd: root,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    })
    return (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "")
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    const out = (e.stdout ?? "") + (e.stderr ? `\n[stderr]\n${e.stderr}` : "")
    if (typeof e.code === "number") return out.trim() || `repo exit ${e.code}`
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

      // repo_query：代码仓库管理（git/hg/svn 统一，tools/repo.py 驱动）
      editor.add({
        name: "repo_query",
        description:
          "代码仓库管理（git/hg/svn 统一，tools/repo.py 驱动）。action=status: 体检（分支/HEAD/远端/工作区/上游）；action=init: 建库（默认 git init -b main，svn 需 remote）；action=snapshot: 生成部署快照 docs/repo.json|REPO.md（AUTO-GENERATED）；action=links: 扫描提交建立「文档条目↔提交」索引（graphgen 里表现为 COMMIT 节点 + touches 边）；action=guard: 提交/提交信息/推送护栏（只读，不执行 add/commit/push）。",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["status", "init", "snapshot", "links", "guard"],
              description: "status=体检; init=建库; snapshot=部署快照; links=条目↔提交; guard=护栏",
            },
            vcs: {
              type: "string",
              enum: ["auto", "git", "hg", "svn"],
              description: "init 用：auto 按 git>hg>svn 取可用工具（默认 auto）",
            },
            remote: { type: "string", description: "init 用：远端地址（svn 必需）" },
            branch: { type: "string", description: "init 用：git 初始分支（默认 main）" },
            commit: { type: "boolean", description: "init 用：建库后做首次提交（需已配置 git 身份，默认否）" },
            stage: {
              type: "string",
              enum: ["commit", "commit-msg", "push"],
              description: "guard 用：检查阶段（默认 commit）",
            },
            messageFile: { type: "string", description: "guard --stage=commit-msg 用：提交信息文件路径" },
            maxCommits: { type: "number", description: "links 用：最多扫描的提交数（默认取配置 300）" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const a = input as {
            action: "status" | "init" | "snapshot" | "links" | "guard"
            vcs?: "auto" | "git" | "hg" | "svn"
            remote?: string
            branch?: string
            commit?: boolean
            stage?: "commit" | "commit-msg" | "push"
            messageFile?: string
            maxCommits?: number
          }
          const args: string[] = [a.action]
          if (a.action === "init") {
            args.push("--vcs", a.vcs ?? "auto")
            if (a.remote) args.push("--remote", a.remote)
            if (a.branch) args.push("--branch", a.branch)
            if (a.commit) args.push("--commit")
          } else if (a.action === "links") {
            if (a.maxCommits) args.push("--max", String(a.maxCommits))
          } else if (a.action === "guard") {
            args.push("--stage", a.stage ?? "commit")
            if (a.messageFile) args.push("--message-file", a.messageFile)
          }
          const out = await runRepo(root, args)
          return { content: out.trim() || "repo: OK" }
        },
      })
    })

    // 常驻记忆：每轮主请求注入「改完自动提交」。
    // 放在 context 钩子而不是只放 compaction，压缩前后都生效。
    if (autoCommitEnabled()) {
      await ctx.session.hook("context", (event) => {
        const marker = "提交约定（常驻记忆"
        if (event.system.some((part) => part.type === "text" && part.text.includes(marker))) return
        event.system.push({ type: "text", text: AUTO_COMMIT_MEMORY })
      })
    }

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

- **repo_query**：代码仓库管理（git/hg/svn 统一，tools/repo.py 驱动）。
  - action=status：体检（分支/HEAD/远端/工作区/上游）
  - action=snapshot：重新生成部署快照 docs/repo.json|REPO.md（doclint R8 校验其新鲜度）
  - action=links：重建条目↔提交索引（之后 graphgen_query node=DG-009 能列出相关提交）
  - action=guard：提交/提交信息/推送护栏（只读，不执行 add/commit/push）
  - action=init：建库（默认 git init -b main；svn 需 remote）

- **skill 工具**：可加载 graphgen 技能（查反链/跑生成器/防漂移的详细指南）。
  当需要查某个条目被哪些文档引用、某份文档的回归清单覆盖哪些条目、
  或改完文档后确认图谱同步/防漂移通过时，必须使用 graphgen_query 或加载 graphgen 技能。${
    autoCommitEnabled()
      ? "\n\n- **提交约定（常驻）**：改完自己提交（见常驻记忆），不要等用户手动 commit。"
      : ""
  }`,
      })
    })

    // 插件卸载时：停事件流 + 清防抖定时器（hook/transform 注册由 opencode 自动回收）
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  },
})
