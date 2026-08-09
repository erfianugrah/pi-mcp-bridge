# MCP integration review - 2026-08-10

Triggered by: "new pi session took a while to start". Measured, then traced.
This covers the whole MCP surface: pi-mcp-bridge, both config files, the
bridged servers, and the memledger embedder's MCP server.

## Topology

```
pi session
├── 66 local extensions (.ts, in-process) - no startup network cost
├── pi-mcp-bridge (package) - bridges stdio MCP servers into pi tools
│   config sources (first-wins by name):
│     $MCP_BRIDGE_CONFIG
│     <cwd>/.pi/mcp-bridge.json
│     ~/.pi/agent/mcp-bridge.json      (global: supabase-demo, memledger)
│     ~/.config/opencode/opencode.json (12 servers, shared with opencode)
└── memledger.ts extension - direct REST fetch (memledger_search), NOT MCP
```

14 bridged servers: 5 remote via `mcp-remote` shim (cloudflare-docs,
context7, gh_grep, supabase, vercel), 3 `npx -y` (mermaid, terraform,
shadcn), 4 python stdio (whisper, comfyui, lora-train, research), 2 global
(supabase-demo via npx mcp-remote, memledger via bunx mcp-remote).

## Startup measurements (pi -p "say ok", 2026-08-10 07:4x)

| Condition | Wall |
|---|---|
| fully cold (no bridge cache, cold npm/bun caches) | 52.8s |
| bridge cache cleared, npm/bun warm | 20.5s |
| warm (steady state) | 3.3s |
| --no-extensions --no-skills | 2.3s |

Process-watch during a cache-miss start (serial order visible):
supabase mcp-remote spawned +0s, memledger mcp-remote spawned +2s and held
the handshake for ~9-10s, a python server +12s. Discovery is strictly
serial, so every server's latency adds.

## Findings (by impact)

1. **Serial discovery on cache miss.** `discover()` awaits each server in a
   for-loop. 14 servers x (spawn + initialize + tools/list) sums to the
   20-50s cold start. LIST_TIMEOUT_MS=15s bounds each, not the total.
   Fix: `Promise.allSettled` over servers - cold start becomes ~max(per-
   server) ~= 15s worst case, ~10s typical.

2. **`bunx` caches into /tmp, which is tmpfs here.** The memledger entry's
   `bunx -y mcp-remote@latest` resolves to /tmp/bunx-1000-*/ - wiped every
   reboot, so the first pi session after every boot re-downloads mcp-remote
   mid-discovery. Guaranteed recurring cold start. npx servers use
   ~/.npm/_npx (persistent) and don't have this problem.
   Fix: pin mcp-remote as a real dependency, or use npx, or point
   BUN_INSTALL cache at ~/.cache.

3. **Bearer token in argv.** The memledger entry passes
   `--header "Authorization: Bearer <token>"` - the token sits in the
   spawned process's argv, visible in `ps` to any local process, and it
   leaked into an agent session log via a process listing during this
   review. mcp-bridge.json itself is 0600 (good); argv exposure defeats it.
   Fix: wrapper script that reads the token from ~/.config/memledger/env
   and execs mcp-remote, config points at the wrapper.

4. **Cache key ignores args.** `cacheKey = JSON.stringify([cfg.command,
   cfg.env])` - editing a server's args (URL, headers) does NOT invalidate
   its cached tool list. Stale tools until manual /mcp-refresh.
   Fix: include args in the key - but only after finding 3, or the token
   lands in the 0644 cache file. Also `chmod 600` the cache on write.

5. **Duplicate Supabase servers.** `supabase` (opencode remote) and
   `supabase-demo` (global, npx mcp-remote, pinned project_ref) both
   register; the bridge renames collisions with a server prefix. Two
   handshakes at discovery for the same upstream.
   Fix: keep one.

6. **memledger MCP handshake ~10s.** Through edge Caddy + WAF + bearer
   check + FastMCP session init - and right now inflated further: the 6
   seed backfill workers share the embedder process/GIL with uvicorn
   (subsides after the seed + documented scale-down). Since discovery is
   cached this is rare, but a router-local URL would skip the edge
   entirely for LAN sessions.

7. **Prune candidates.** 5 remote servers all cost discovery handshakes;
   several overlap with native pi extensions (gh_grep vs gh-search skill,
   context7 vs context7 extension). Every unused entry is pure cold-start
   tax.

## Non-issues verified

- Per-call respawn: no - processes are spawned lazily on first callTool
  and kept for the session (stopped only on shutdown/re-discover).
- CALL_TIMEOUT_MS=900s generous on purpose (async job pattern).
- memledger.ts extension does no startup work (fetch only at call time,
  10-15s AbortSignal timeouts).
- Embedder MCP server side is healthy post-lifespan-fix.

## Recommended order

1. Parallelize discover() (bridge code, small diff).
2. Persistent mcp-remote (kill the bunx-/tmp path).
3. Token out of argv (wrapper script).
4. cacheKey += args + chmod 600 cache (after 3).
5. Dedupe supabase; prune unused remotes.
6. Optional: memledger via router-local URL.
