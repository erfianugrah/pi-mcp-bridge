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

14 servers are configured, but only the 9 STDIO ones are bridged into pi
(`serversFromConfig` skips anything without a `command`): supabase-demo +
memledger (global), mermaid/terraform/shadcn (npx), whisper/comfyui/
lora-train/research (python). The 5 opencode `remote` entries
(cloudflare-docs, context7, gh_grep, supabase, vercel) are never spawned by
the bridge - they are opencode-only. CORRECTED 2026-08-10: an earlier draft
of this review counted all 14 as discovery cost.

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
   for-loop. 9 stdio servers x (spawn + initialize + tools/list) sums to the
   20-50s cold start. LIST_TIMEOUT_MS=15s bounds each, not the total. NOTE:
   discovery FAILURES are not cached either (notify + continue), so a
   server that consistently fails is re-spawned on EVERY session start -
   the last cache holds only 6 of 9 (mermaid/terraform/shadcn absent), a
   recurring warm-start tax, currently small because they fail fast.
   Fix: `Promise.allSettled` over servers - cold start becomes ~max(per-
   server) ~= 15s worst case, ~10s typical, and the per-start failure
   retries stop being serial too.

2. **`bunx` caches into /tmp, which is tmpfs here.** The memledger entry's
   `bunx -y mcp-remote@latest` resolves to /tmp/bunx-1000-*/ - wiped every
   reboot, so the first pi session after every boot re-downloads mcp-remote
   mid-discovery. Guaranteed recurring cold start. npx servers use
   ~/.npm/_npx (persistent) and don't have this problem.
   Fix: pin mcp-remote as a real dependency, or use npx, or point
   BUN_INSTALL cache at ~/.cache.

3. **Bearer token in argv AND in the plaintext cache file.** The memledger
   entry passes `--header "Authorization: Bearer <token>"`. The token sits
   in the spawned process's argv (visible in `ps` - it leaked into an agent
   session log via a process listing during this review) AND in
   ~/.pi/agent/mcp-bridge.cache.json (mode 0644): `serversFromConfig`
   flattens args into `cfg.command`, so the cache key contains the full
   argv, Bearer included (verified live: `.memledger.key` holds the token).
   mcp-bridge.json itself is 0600; both exposures defeat it.
   Fix: wrapper script that reads the token from ~/.config/memledger/env
   and execs mcp-remote, config points at the wrapper; hash the cache key
   (below); write the cache 0600.

4. ~~Cache key ignores args~~ WITHDRAWN on re-read: args ARE in the key
   (flattened into cfg.command), so invalidation on config change works.
   The real defect is the inverse of what an earlier draft claimed: the RAW
   argv (and env) is persisted into the cache key, which is how the token
   landed in the 0644 cache file. Fix: `cacheKey = sha256hex(JSON([command,
   env]))` - same invalidation semantics, nothing recoverable on disk.

5. ~~Duplicate Supabase servers double-handshake~~ WITHDRAWN for pi: the
   opencode `supabase` entry is type:remote and the bridge skips remotes,
   so only `supabase-demo` is ever spawned. (Both still appear in `pi mcp
   list` output, which reads both configs - cosmetic only.)

6. **memledger MCP handshake ~10s.** Through edge Caddy + WAF + bearer
   check + FastMCP session init - and right now inflated further: the 6
   seed backfill workers share the embedder process/GIL with uvicorn
   (subsides after the seed + documented scale-down). Since discovery is
   cached this is rare, but a router-local URL would skip the edge
   entirely for LAN sessions.

7. ~~Remote servers cost pi discovery handshakes~~ WITHDRAWN (remotes are
   skipped by the bridge). Pruning unused entries is still worthwhile for
   opencode's own startup, and mermaid/terraform/shadcn should be fixed or
   disabled in the pi context - they fail discovery and are retried every
   session start (finding 1).

## Non-issues verified

- Per-call respawn: no - processes are spawned lazily on first callTool
  and kept for the session (stopped only on shutdown/re-discover).
- CALL_TIMEOUT_MS=900s generous on purpose (async job pattern).
- memledger.ts extension does no startup work (fetch only at call time,
  10-15s AbortSignal timeouts).
- Embedder MCP server side is healthy post-lifespan-fix.

## Recommended order

1. Parallelize discover() (bridge code, small diff).
2. Hash the cache key (sha256) - kills the token-in-cache leak.
3. Write the cache 0600.
4. Persistent mcp-remote (kill the bunx-/tmp path).
5. Token out of argv (wrapper script on the live box).
6. Fix-or-disable the 3 npx servers that fail discovery.
7. Optional: memledger via router-local URL.
