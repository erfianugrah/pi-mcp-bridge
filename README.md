# pi-mcp-bridge

Run local (stdio) [Model Context Protocol](https://modelcontextprotocol.io)
servers under the [pi coding agent](https://pi.dev).

pi has no built-in MCP client. This extension bridges any **stdio** MCP server
into pi as native tools: it discovers each server's tools via the MCP
`tools/list` call (cached to disk, so no process spawns on every session),
registers them, and spawns the server process **lazily on the first actual
tool call** — keeping it alive until the session ends.

If you already configure MCP servers for OpenCode or Claude Desktop, this
reads the same config, so it's zero-config in those setups.

## Install

```bash
pi install git:github.com/erfianugrah/pi-mcp-bridge
```

Try it for one run without installing:

```bash
pi -e git:github.com/erfianugrah/pi-mcp-bridge
```

## Configure

The bridge merges servers from these sources (first definition of a given
name wins):

1. `$MCP_BRIDGE_CONFIG` — explicit path override
2. `<cwd>/.pi/mcp-bridge.json` — project-local
3. `~/.pi/agent/mcp-bridge.json` — global
4. `~/.config/opencode/opencode.json` — OpenCode fallback (`mcp` key)

A config file may use **either** shape:

```jsonc
// standard MCP / Claude-desktop style
{
  "mcpServers": {
    "whisper": {
      "command": "python3",
      "args": ["/path/to/whisper-server.py"],
      "env": { "WHISPER_URL": "http://localhost:7860" },
      "disabled": false
    }
  }
}
```

```jsonc
// OpenCode style
{
  "mcp": {
    "whisper": {
      "type": "local",
      "command": ["python3", "/path/to/whisper-server.py"],
      "environment": { "WHISPER_URL": "http://localhost:7860" },
      "enabled": true
    }
  }
}
```

Only `stdio`/`local` servers are bridged. Remote (HTTP/SSE) MCP servers are
skipped — they use a different transport, and pi often covers those needs with
dedicated extensions.

## Commands

| Command | Effect |
|---|---|
| `/mcp-status` | List bridged servers and their registered tool names. |
| `/mcp-refresh` | Re-discover tools (spawn each server once) and rewrite the cache. Run after editing a server's tool set. |

## How it works

- **Discovery** runs on `session_start`. With a warm cache (keyed by each
  server's command + env) no process is spawned; tools register instantly.
  A cold cache spawns each server once to run `tools/list`, then stops it.
- **Tool calls** spawn the server lazily, complete the MCP
  `initialize` → `notifications/initialized` → `tools/call` handshake, and
  keep the process alive for subsequent calls until `session_shutdown`.
- **Schemas** are converted from JSON Schema to pi's parameter schema, scoped
  to the constructs MCP servers commonly emit (object / string / number /
  boolean / array / enum / oneOf). Enums fold their allowed values into the
  parameter description.
- **Name collisions** across servers are resolved by prefixing the later tool
  with its server name (e.g. a second `wait_job` becomes `<server>_wait_job`).

The tools cache lives at `~/.pi/agent/mcp-bridge.cache.json`.

## Cold-start behaviour

On a **cache miss** (first run, config change, or after `/mcp-refresh`),
all servers are discovered **concurrently** via `Promise.allSettled` -- a
cold start now completes in ~max(per-server latency) instead of the sum.
Results are assembled in **config-file order** so that server-name
collision prefixing is deterministic across sessions. If one server fails
`tools/list` (e.g. a missing local dep), the failure is reported via a
notification and discovery continues for the remaining servers -- one
broken server never blocks the others.

### Cache file security

- **Permissions**: the cache file is written with mode `0600` (chmod after
  write, even when the file already exists with wider permissions).
- **Opaque keys**: each server's cache key is a SHA-256 hex digest of
  `[command, env]`. No raw command-line arguments or environment variables
  are ever persisted to disk. Invalidation semantics are unchanged -- any
  change to a server's command, args, or env produces a different key and
  triggers re-discovery.

### Remote servers with bearer tokens

Passing a bearer token directly in `command`/`args` (e.g. `mcp-remote
--header "Authorization: Bearer <token>"`) leaks the token into `argv`
(visible in `ps`) AND into the cache key before the fix above.

Instead, use a **wrapper script** that reads the token from a restricted
env file at startup and `exec`s the real server:

```bash
#!/usr/bin/env bash
# ~/.local/bin/myapp-mcp -- 0700. The token is read from the env file and
# never stored in the bridge config. stderr is dropped: mcp-remote echoes
# its full command line (headers included) in its startup notices.
set -a; . "$HOME/.config/myapp/env"; set +a
exec npx -y mcp-remote "$MYAPP_MCP_URL" \
  --header "Authorization: Bearer ${MYAPP_TOKEN:?}" 2>/dev/null
```

Then configure the bridge to point at the wrapper (no URL, no token -
both live in the env file):

```json
{ "mcpServers": { "myapp": { "command": "/home/erfi/.local/bin/myapp-mcp" } } }
```

The wrapper's path is the only thing hashed into the cache key (no secret
present) and the env file holds the real token (already 0600). Note that
the expanded `--header` value is still visible in the mcp-remote process's
argv while it runs - on a multi-user box, replace mcp-remote with a shim
that takes the header via stdin/env instead.

## License

MIT
