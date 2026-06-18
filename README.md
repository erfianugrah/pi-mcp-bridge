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

## License

MIT
