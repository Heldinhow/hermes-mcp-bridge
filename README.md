# hermes-mcp-bridge

A small, self-hosted Node.js server that speaks the Model Context Protocol (MCP) over
Streamable HTTP and exposes a local Hermes agent HTTP API as four MCP tools. A remote AI
agent can send tasks, follow long-running work, read durable results, and inspect artifacts.
Node.js >= 18.17, ESM, zero runtime dependencies.

## Architecture

```
+----------------------+      HTTPS       +------------------------+
| Remote AI agent      | --------------> | Tunnel / reverse proxy |
| (MCP client)         |                  | TLS termination        |
+----------------------+                  +-----------+------------+
                                                      |
                                                      v
                                  +-------------------+-------------------+
                                  | Bridge (Node.js) on 127.0.0.1:8765   |
                                  | bearer auth | rate limit | audit log |
                                  +--------+-------------------+--------+
                                           |                   |
                                           v                   v
                        +----------------------------+  +-----------------------------+
                        | Local agent HTTP API       |  | Tasks directory             |
                        | /v1/chat/completions       |  | <id>/result.json            |
                        | /v1/runs, /v1/runs/<run_id>|  | <id>/... artifact files     |
                        +----------------------------+  +-----------------------------+
```

- Synchronous tasks use `POST /v1/chat/completions`; asynchronous tasks use `POST /v1/runs`
  and are polled through `GET /v1/runs/<run_id>`.
- The listener binds to loopback only; the tunnel or proxy is the sole ingress.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `hermes_task` | `task` (string, required), `mode` (`"sync"` or `"async"`, required), `context`, `deliverable`, `constraints` (array of strings, max 20), `id` (optional) | `{id, status, summary, artifacts, next_steps, run_id?}`. `sync` waits and persists the result; `async` returns `status: "accepted"` plus a `run_id`. |
| `hermes_status` | `run_id` (string, required) | Run status with `output`, `error`, timestamps, `task_id`, and `result_updated` when available. Terminal states: `completed`, `failed`, `cancelled`, `interrupted`. |
| `hermes_result` | `id` (string, required) | Parsed `result.json`: `{id, status, summary, artifacts, next_steps, details?}`. Durable source of truth after a run leaves the agent API. |
| `hermes_files` | `id` (string, required), `path` (optional relative path) | A listing `{id, path, entries, count, truncated}` or a UTF-8 file `{id, path, size, mtime, encoding, content}` up to 200 KiB. |

Task ids match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and are generated when omitted. Prefer
`hermes_result` for final answers and `hermes_files` for artifacts.

## Protocol

- JSON-RPC 2.0 over HTTP `POST /mcp`. The server is stateless; no `Mcp-Session-Id` is
  required or issued.
- Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`, and
  `Accept: application/json, text/event-stream`. Responses use `application/json`.
- Methods: `initialize`, `tools/list`, `tools/call`, and `ping`. JSON-RPC notifications
  (requests without an `id`) are answered with `202 Accepted`.
- `initialize` negotiates the version, advertises the `tools` capability, and returns
  `serverInfo`; `ping` returns `{}`.
- `tools/call` returns content blocks and `structuredContent`. Tool failures set
  `isError: true` and return `{"error": "<code>", "message": "<text>"}`.
- Batches up to 20 are supported. JSON-RPC errors: `-32700` parse, `-32600` invalid
  request, `-32601` unknown method, `-32602` invalid params.
- `GET /health` (also `HEAD`) is unauthenticated and returns JSON such as
  `{"status":"ok","service":"hermes-mcp-bridge","version":"1.0.0","tools":4}`.
- HTTP errors: `401` bad token, `405` non-POST, `413` body too large, `415` wrong content
  type, `429` rate limited with `Retry-After`.

## Security

- Authentication is a single 64-hex-character bearer token generated from 32 random bytes,
  stored only in `.env` (mode `600`), never taken from argv or written to logs. It is SHA-256
  hashed and compared with a constant-time comparison; failures return `401` with `WWW-Authenticate`.
- Per-IP token-bucket rate limiting (default 30 requests/minute, auth failures included)
  returns `429` with `Retry-After`.
- Request bodies are capped at 256 KiB from both `Content-Length` and streamed bytes.
  Upstream responses, `result.json`, and file reads have separate caps.
- Task file access is read-only. Path traversal (`..`), absolute paths, backslashes, NUL
  bytes, and symlinks are rejected, and the resolved path must stay inside the task directory
  after `realpath`. Only regular UTF-8 text files without NUL bytes are returned.
- The audit log is JSONL with timestamp, client IP, method, path, status, duration, RPC
  method, tool, and error code. Headers, bodies, task text, tokens, and keys are never
  recorded. It is mode `600` and rotates at 5 MiB.
- The listener binds only to `127.0.0.1`; TLS ends at the tunnel or proxy. The local agent
  API key is read at runtime from `HERMES_ENV_PATH` and never copied here.
- The systemd units apply hardening flags: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
  `ProtectHome=read-only`, explicit `ReadWritePaths`, `ProtectKernelTunables`,
  `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`, and a restricted
  `RestrictAddressFamilies` list.

## Setup

Requires Node.js 18.17+ and a local Hermes agent reachable over HTTP with an API key. There
are no npm dependencies to install.

```bash
git clone https://github.com/Heldinhow/hermes-mcp-bridge.git
cd hermes-mcp-bridge
cp .env.example .env && chmod 600 .env
node scripts/gen-token.mjs
```

`gen-token.mjs` writes 64 hex characters to `MCP_AUTH_TOKEN` in `.env`, atomically and with
mode `600`. It prints the path, never the value. `scripts/rotate-token.sh` rotates the token,
rewrites `.env`, and restarts the bridge.

Edit `.env` for your environment:

```dotenv
MCP_PORT=8765
MCP_AUTH_TOKEN=<generated>
HERMES_ENV_PATH=/path/to/agent/.env
HERMES_CONTRACT_PATH=/path/to/contract.md
TASKS_DIR=/path/to/tasks
```

- `HERMES_ENV_PATH` points at the file holding the local agent's `API_SERVER_KEY`.
  Optional `API_SERVER_HOST` and `API_SERVER_PORT` values are read from it (defaults:
  `127.0.0.1:8642`). The key is held in memory only and is exposed by no tool or log.
- `HERMES_CONTRACT_PATH` points at a Markdown contract injected as system instructions on
  every `hermes_task`. Use it to define the agent's role, response JSON, allowed actions,
  escalation rules, and language.
- `TASKS_DIR` holds one subdirectory per task id, created on demand; files are only
  reachable through `hermes_result` and `hermes_files`. Use absolute or `$HOME` paths
  (`~` is not expanded).

Run the server and check health:

```bash
node src/server.js
curl -s http://127.0.0.1:8765/health
```

Install the user units and start both services:

```bash
./scripts/install-systemd.sh
systemctl --user status hermes-mcp-bridge.service
systemctl --user status hermes-mcp-tunnel.service
```

The installer renders `systemd/*.service` into
`${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user` and starts both services. Run
`loginctl enable-linger "$USER"` once to survive logout; optional settings are documented
in `.env.example`.

## Exposing it over HTTPS

Keep the bridge on loopback and let a tunnel or proxy terminate TLS. Pick one of the
options below; the MCP endpoint is always the public HTTPS URL plus `/mcp`.

### Tailscale Funnel (recommended)

If the host is already on a tailnet, Funnel is the shortest path: no extra daemon, no
DNS records, and a stable hostname that survives restarts.

1. Enable HTTPS certificates and Funnel for your tailnet in the Tailscale admin console
   (DNS page). Both are off by default.
2. Expose the local port through Tailscale:

   ```bash
   tailscale funnel --bg --https=443 http://127.0.0.1:8765
   ```

   Port `443` gives the bare hostname; other ports also work, e.g.
   `--https=8443` serves on `:8443` instead. `--bg` persists the configuration across
   reboots and is not tied to your shell.
3. Read the URL Tailscale prints and check it:

   ```bash
   tailscale funnel status
   curl -s https://<machine>.<tailnet-domain>/health
   ```

   If you chose a non-443 port, append it to the host before `/health` and `/mcp`.

The MCP URL is `https://<machine>.<tailnet-domain>/mcp` (or `...:<port>/mcp`). Write it to
`PUBLIC_URL` if you script clients against that file. To revoke the public endpoint:

```bash
tailscale funnel reset
```

Note that Funnel makes the bridge reachable from the entire internet, not only from your
tailnet; the bearer token is the only gate, so keep `.env` at mode `600` and rotate the
token if it leaks.

`scripts/run-tunnel.sh` and `systemd/hermes-mcp-tunnel.service` implement the Cloudflare
quick-tunnel alternative below. If you use Funnel, the bridge unit is enough: skip or
disable the tunnel unit.

### cloudflared quick tunnel

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8765
```

The provider prints a public `https://<tunnel-host>` URL. `scripts/run-tunnel.sh` wraps this
mode, writes the URL to `PUBLIC_URL`, and is what the tunnel unit runs. Quick-tunnel
hostnames change on restart, so update clients afterwards.

### cloudflared named tunnel

```bash
cloudflared tunnel create hermes-mcp-bridge
cloudflared tunnel route dns hermes-mcp-bridge mcp.example.com
cloudflared tunnel run hermes-mcp-bridge
```

Route the hostname to `http://127.0.0.1:8765` in your tunnel configuration.

### nginx with certbot

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;
    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo certbot --nginx -d mcp.example.com
```

## MCP client configuration

Most clients accept an entry like the one below; exact field names vary, but the URL and
header are what matter.

```json
{
  "mcpServers": {
    "hermes": {
      "type": "http", "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${HERMES_MCP_TOKEN}" }
    }
  }
}
```

Store the token in the environment as `HERMES_MCP_TOKEN`, not in the configuration file. If
your client does not expand environment variables, launch it through a wrapper that reads
the token from the protected `.env` and sets the header. Never commit, paste, or log it.

## Testing

```bash
node test/smoke.mjs --base https://mcp.example.com
```

The smoke test reads `MCP_AUTH_TOKEN` from `.env` without printing it and checks `/health`,
`401` without auth, `initialize`, `tools/list` (four tools), a sync task, `hermes_result`,
`hermes_files`, traversal/absolute-path rejection, and the body limit (`--id` picks the id).

## License

MIT.
