// graphgen MCP —— 共享 JSON-RPC over stdio 传输层（零依赖）
// 协议：newline-delimited JSON-RPC 2.0（与 libs-mcp 保持一致）。

export const PROTOCOL = "2025-06-18";

/**
 * 启动 stdio 服务端。
 * opts: {
 *   name, version, instructions,
 *   tools, resources,
 *   callTool(name, args) -> object,
 *   readResource(uri) -> {mimeType, text} | null,
 *   log?: (line) => void,
 * }
 */
export function startStdio(opts) {
  const {
    name,
    version,
    instructions = "",
    tools = [],
    resources = [],
    callTool,
    readResource,
    log = (line) => process.stderr.write(`[${name}] ${line}\n`),
  } = opts;

  const SERVER = { name, version };
  const TOOLS = tools;
  const RESOURCES = resources;

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }
  function ok(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }
  function fail(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    try {
      switch (method) {
        case "initialize":
          return ok(id, {
            protocolVersion: params?.protocolVersion || PROTOCOL,
            capabilities: { tools: {}, resources: {} },
            serverInfo: SERVER,
            instructions:
              typeof instructions === "function" ? instructions() : instructions,
          });
        case "notifications/initialized":
        case "notifications/cancelled":
          return;
        case "ping":
          return ok(id, {});
        case "tools/list":
          return ok(id, { tools: TOOLS });
        case "tools/call": {
          const toolName = params?.name;
          const args = params?.arguments || {};
          try {
            const result = await callTool(toolName, args);
            return ok(id, {
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
              isError: false,
            });
          } catch (e) {
            return ok(id, {
              content: [{ type: "text", text: "错误: " + (e?.message || String(e)) }],
              isError: true,
            });
          }
        }
        case "resources/list":
          return ok(id, { resources: RESOURCES });
        case "resources/read": {
          const uri = params?.uri;
          const r = await readResource(uri);
          if (!r) return fail(id, -32002, "未知资源: " + uri);
          return ok(id, {
            contents: [{ uri, mimeType: r.mimeType, text: r.text }],
          });
        }
        case "prompts/list":
          return ok(id, { prompts: [] });
        default:
          if (isNotification) return;
          return fail(id, -32601, "未知方法: " + method);
      }
    } catch (e) {
      if (!isNotification) fail(id, -32603, "内部错误: " + (e?.message || String(e)));
    }
  }

  let buf = "";
  let pending = 0;
  let ended = false;

  function track(p) {
    pending++;
    Promise.resolve(p)
      .catch((e) => log(e?.stack || String(e)))
      .finally(() => {
        pending--;
        if (ended && pending === 0) process.exit(0);
      });
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
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
      track(handle(msg));
    }
  });
  process.stdin.on("end", () => {
    ended = true;
    if (pending === 0) process.exit(0);
  });
}
