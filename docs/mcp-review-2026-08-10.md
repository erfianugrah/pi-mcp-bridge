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

14 servers are configured, but only the 6 ENABLED STDIO ones are bridged
into pi (`serversFromConfig` skips remotes and `enabled: false` entries):
supabase-demo + memledger (global), whisper/comfyui/lora-train/research
(python). mermaid/terraform/shadcn (npx) are disabled in opencode.json. The 5 opencode `remote` entries
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
   for-loop. 6 enabled stdio servers x (spawn + initialize + tools/list) sums to the
   20-50s cold start. LIST_TIMEOUT_MS=15s bounds each, not the total.
   CORRECTED 2026-08-10 evening: mermaid/terraform/shadcn are `"enabled":
   false` in opencode.json and are correctly skipped - the "6 of 9 cached"
   observation was the full enabled set, not discovery failures. There is
   no per-start retry tax. The original cold-cache absence of these three
   was their cold npx downloads exceeding the 15s LIST_TIMEOUT on first
   ever discovery.
   Fix (SHIPPED 058e9da): `Promise.allSettled` over servers - cold start
   became ~max(per-server) ~= 19s (the memledger edge handshake is the
   floor), warm start ~3-6s.

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
6. ~~Fix-or-disable the 3 npx servers~~ NOT NEEDED - they are
   `enabled: false` by the user's own choice and are skipped.
7. Optional: memledger via router-local URL (it's the parallel floor -
   its ~10s edge handshake dominates cold discovery).

## Resolution (2026-08-10 evening)

Items 1-3 shipped via a self-correcting loop (058e9da): parallel
discoverAll (Promise.allSettled, config-order results, failure-tolerant),
sha256 cache keys, 0600 cache file. Item 5 done on the live box: wrapper
script ~/.pi/agent/bin/memledger-mcp.sh (token from env file, mcp-remote
stderr dropped because it echoes the header); mcp-bridge.json points at
it; poisoned cache entry deleted; both files now 0600. Item 4 folded into
the wrapper (npx with persistent ~/.npm/_npx instead of bunx /tmp).
Measured after: cold 19.2s (was 20.5s serial with warm npm, 52.8s fully
cold), warm 6.5s (was 3.3-5s; residual is LLM-call variance, not bridge).
RESIDUAL accepted risk: the expanded --header value is visible in the
mcp-remote process's argv while it runs (single-user box; the full fix is
a native pi extension replacing the mcp-remote shim, deferred).
