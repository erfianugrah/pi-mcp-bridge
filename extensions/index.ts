/**
 * pi-mcp-bridge — run local (stdio) MCP servers under pi.
 *
 * pi has no built-in MCP client. This extension bridges any `stdio` MCP
 * server into pi as native tools: it discovers each server's tools via the
 * MCP `tools/list` call (cached to disk so no process spawns on every
 * session), registers them, and spawns the server process lazily on the
 * first actual tool call — keeping it alive until session shutdown.
 *
 * ── Config sources (merged; first definition of a name wins) ───────────────
 *   1. $MCP_BRIDGE_CONFIG                      (explicit path override)
 *   2. <cwd>/.pi/mcp-bridge.json               (project)
 *   3. ~/.pi/agent/mcp-bridge.json             (global)
 *   4. ~/.config/opencode/opencode.json        (OpenCode fallback, `mcp` key)
 *
 * Each config file may use EITHER shape:
 *
 *   // standard MCP / Claude-desktop style
 *   { "mcpServers": {
 *       "whisper": { "command": "python3", "args": ["/path/server.py"],
 *                    "env": { "X": "1" }, "disabled": false } } }
 *
 *   // OpenCode style
 *   { "mcp": {
 *       "whisper": { "type": "local", "command": ["python3", "/path/server.py"],
 *                    "environment": { "X": "1" }, "enabled": true } } }
 *
 * Only `stdio`/`local` servers are bridged. Remote (HTTP/SSE) MCP servers are
 * skipped — they need a different transport and pi often covers those needs
 * with dedicated extensions.
 *
 * ── Commands ───────────────────────────────────────────────────────────────
 *   /mcp-status    list bridged servers + tool counts
 *   /mcp-refresh   re-discover tools (spawn each server once) + rewrite cache
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── constants ──────────────────────────────────────────────────────────────

const CACHE_FILE = join(homedir(), ".pi", "agent", "mcp-bridge.cache.json");
const GLOBAL_CONFIG = join(homedir(), ".pi", "agent", "mcp-bridge.json");
const OPENCODE_CONFIG = join(homedir(), ".config", "opencode", "opencode.json");
const PROTOCOL_VERSION = "2024-11-05";
const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 900_000; // many servers use an async job pattern; be generous

interface ServerConfig {
  name: string;
  command: string[];
  env: Record<string, string>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ── config discovery ─────────────────────────────────────────────────────

function readJson(path: string): any | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Extract local/stdio servers from either the `mcpServers` or `mcp` shape. */
function serversFromConfig(raw: any): ServerConfig[] {
  if (!raw || typeof raw !== "object") return [];
  const out: ServerConfig[] = [];

  // standard MCP / Claude-desktop: { mcpServers: { name: { command, args, env, disabled } } }
  const std = raw.mcpServers;
  if (std && typeof std === "object") {
    for (const [name, cfg] of Object.entries<any>(std)) {
      if (!cfg) continue;
      if (cfg.disabled === true || cfg.enabled === false) continue;
      // remote shapes carry url/type; skip anything without a command
      if (typeof cfg.command !== "string" && !Array.isArray(cfg.command)) continue;
      const command = Array.isArray(cfg.command)
        ? cfg.command
        : [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])];
      out.push({ name, command, env: cfg.env ?? cfg.environment ?? {} });
    }
  }

  // OpenCode: { mcp: { name: { type: "local", command: [...], environment, enabled } } }
  const oc = raw.mcp;
  if (oc && typeof oc === "object") {
    for (const [name, cfg] of Object.entries<any>(oc)) {
      if (!cfg || cfg.type !== "local") continue;
      if (cfg.enabled === false) continue;
      if (!Array.isArray(cfg.command) || cfg.command.length === 0) continue;
      out.push({ name, command: cfg.command, env: cfg.environment ?? cfg.env ?? {} });
    }
  }

  return out;
}

/** Merge all sources; first definition of a given name wins. */
function loadServers(cwd?: string): ServerConfig[] {
  const sources = [
    process.env.MCP_BRIDGE_CONFIG,
    cwd ? join(cwd, ".pi", "mcp-bridge.json") : undefined,
    GLOBAL_CONFIG,
    OPENCODE_CONFIG,
  ].filter(Boolean) as string[];

  const seen = new Set<string>();
  const merged: ServerConfig[] = [];
  for (const path of sources) {
    for (const s of serversFromConfig(readJson(path))) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      merged.push(s);
    }
  }
  return merged;
}

// ── JSON-Schema → pi (TypeBox) schema ─────────────────────────────────────
// Scoped to the constructs MCP servers commonly emit: object / string /
// integer / number / boolean / array / enum / oneOf / anyOf. Unknown shapes
// fall back to a permissive string (the server validates its own args).

function toSchema(js: any): any {
  if (!js || typeof js !== "object") return Type.String();
  const desc: { description?: string } = typeof js.description === "string" ? { description: js.description } : {};

  // enum: fold allowed values into the description; keep the type permissive so
  // we don't depend on StringEnum/Union being present in every Type re-export.
  if (Array.isArray(js.enum) && js.enum.length > 0) {
    const allowed = `Allowed: ${js.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}.`;
    const merged = desc.description ? `${desc.description} ${allowed}` : allowed;
    return Type.String({ description: merged });
  }

  // oneOf / anyOf: take the first concrete branch (e.g. string|bool → string).
  const variants = js.oneOf ?? js.anyOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const inner = toSchema(variants[0]);
    return desc.description ? { ...inner, description: desc.description } : inner;
  }

  switch (js.type) {
    case "string":
      return Type.String(desc);
    case "integer":
    case "number":
      return Type.Number(desc);
    case "boolean":
      return Type.Boolean(desc);
    case "array":
      return Type.Array(toSchema(js.items ?? {}), desc);
    case "object": {
      const props: Record<string, any> = {};
      const required: string[] = Array.isArray(js.required) ? js.required : [];
      for (const [k, v] of Object.entries(js.properties ?? {})) {
        const child = toSchema(v);
        props[k] = required.includes(k) ? child : Type.Optional(child);
      }
      return Type.Object(props, desc);
    }
    default:
      return Type.String(desc);
  }
}

// ── MCP stdio client (newline-delimited JSON-RPC 2.0) ──────────────────────

class McpClient {
  private proc?: ChildProcess;
  private buf = "";
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private initialized = false;

  constructor(private cfg: ServerConfig) {}

  private start(): void {
    const [cmd, ...args] = this.cfg.command;
    this.proc = spawn(cmd, args, {
      env: { ...process.env, ...this.cfg.env },
      stdio: ["pipe", "pipe", "ignore"], // drop server stderr (would corrupt the TUI)
    });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(d));
    this.proc.on("exit", () => {
      this.proc = undefined;
      this.initialized = false;
      for (const p of this.pending.values()) p.reject(new Error(`mcp server "${this.cfg.name}" exited`));
      this.pending.clear();
    });
    this.proc.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e instanceof Error ? e : new Error(String(e)));
      this.pending.clear();
    });
  }

  private onData(d: Buffer): void {
    this.buf += d.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stray non-JSON line
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
        else p.resolve(msg.result);
      }
    }
  }

  private rpc(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    if (!this.proc) this.start();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp "${this.cfg.name}" ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      this.proc!.stdin!.write(payload);
    });
  }

  private notify(method: string, params: unknown = {}): void {
    if (!this.proc) this.start();
    this.proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private async ensureInit(signal?: AbortSignal): Promise<void> {
    if (!this.proc) this.start();
    if (this.initialized) return;
    await this.rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pi-mcp-bridge", version: "1.0.0" },
      },
      LIST_TIMEOUT_MS,
      signal,
    );
    this.notify("notifications/initialized");
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureInit();
    const res = await this.rpc("tools/list", {}, LIST_TIMEOUT_MS);
    return (res?.tools ?? []) as McpTool[];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<any> {
    await this.ensureInit(signal);
    return this.rpc("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS, signal);
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = undefined;
      this.initialized = false;
    }
  }
}

// ── tools/list cache ──────────────────────────────────────────────────────

type Cache = Record<string, { key: string; tools: McpTool[] }>;

function cacheKey(cfg: ServerConfig): string {
  return JSON.stringify([cfg.command, cfg.env]);
}

function loadCache(): Cache {
  return (readJson(CACHE_FILE) as Cache) ?? {};
}

function saveCache(c: Cache): void {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
  } catch {
    /* best-effort */
  }
}

// ── extension ───────────────────────────────────────────────────────────

export default function mcpBridge(pi: ExtensionAPI) {
  const clients = new Map<string, McpClient>(); // server name → client
  const routes = new Map<string, { client: McpClient; server: string; toolName: string }>(); // pi tool name → mcp tool
  const registered = new Set<string>();
  let serverCount = 0;
  let toolCount = 0;

  function clientFor(cfg: ServerConfig): McpClient {
    let c = clients.get(cfg.name);
    if (!c) {
      c = new McpClient(cfg);
      clients.set(cfg.name, c);
    }
    return c;
  }

  function registerMcpTool(server: string, client: McpClient, tool: McpTool): void {
    // Prefix with the server name only on a genuine cross-server collision.
    let piName = tool.name;
    if (registered.has(piName) && routes.get(piName)?.client !== client) {
      piName = `${server}_${tool.name}`;
    }
    if (registered.has(piName)) return;
    registered.add(piName);
    routes.set(piName, { client, server, toolName: tool.name });
    toolCount++;

    pi.registerTool({
      name: piName,
      label: piName,
      description: tool.description ?? `${tool.name} (via ${server} MCP server)`,
      parameters: toSchema(tool.inputSchema ?? { type: "object", properties: {} }),
      async execute(_id: string, params: unknown, signal: AbortSignal | undefined) {
        const route = routes.get(piName)!;
        const result = await route.client.callTool(route.toolName, params, signal);
        const content =
          Array.isArray(result?.content) && result.content.length > 0
            ? result.content
            : [{ type: "text", text: JSON.stringify(result ?? {}) }];
        return { content, details: { server, tool: tool.name, isError: !!result?.isError } };
      },
    });
  }

  async function discover(
    refresh: boolean,
    cwd?: string,
    notify?: (m: string, l: "info" | "warning" | "error") => void,
  ) {
    const servers = loadServers(cwd);
    const cache = refresh ? {} : loadCache();
    // Stop any processes spawned by a previous discover() before dropping the
    // references (otherwise /mcp-refresh orphans running server processes).
    for (const c of clients.values()) c.stop();
    serverCount = 0;
    toolCount = 0;
    clients.clear();
    routes.clear();
    registered.clear();

    for (const cfg of servers) {
      const client = clientFor(cfg);
      const key = cacheKey(cfg);
      let tools = cache[cfg.name]?.key === key ? cache[cfg.name].tools : undefined;

      if (!tools) {
        try {
          tools = await client.listTools();
          cache[cfg.name] = { key, tools };
          client.stop(); // discovery needs no long-lived process; spawn lazily per call
        } catch (e) {
          notify?.(`mcp-bridge: ${cfg.name} discovery failed: ${(e as Error).message}`, "warning");
          continue;
        }
      }

      serverCount++;
      for (const t of tools) registerMcpTool(cfg.name, client, t);
    }

    saveCache(cache);
  }

  pi.on("session_start", async (_event, ctx) => {
    await discover(false, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
  });

  pi.on("session_shutdown", async () => {
    for (const c of clients.values()) c.stop();
  });

  pi.registerCommand("mcp-status", {
    description: "List MCP servers bridged into pi + tool counts",
    handler: async (_args, ctx) => {
      const lines = [`mcp-bridge: ${serverCount} server(s), ${toolCount} tool(s)`];
      const byServer = new Map<string, string[]>();
      for (const [piName, r] of routes) {
        if (!byServer.has(r.server)) byServer.set(r.server, []);
        byServer.get(r.server)!.push(piName);
      }
      for (const [server, names] of byServer) lines.push(`  ${server}: ${names.join(", ")}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("mcp-refresh", {
    description: "Re-discover MCP tools (spawn each server once) and rewrite the cache",
    handler: async (_args, ctx) => {
      await discover(true, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
      ctx.ui.notify(`mcp-bridge refreshed: ${serverCount} server(s), ${toolCount} tool(s)`, "info");
    },
  });
}
