# Personal Compute Relay - Developer Guide

This codebase implements a relay that gives cloud AI agents access to personal compute resources.

## Components

| Directory       | Description                                           |
| --------------- | ----------------------------------------------------- |
| `rebrow/`       | Cloudflare Worker - relay server with Durable Objects |
| `extension/`    | Chrome extension - connects browser tabs to relay     |
| `local-client/` | Node.js CLI - connects local machine to relay         |

## Architecture

```
┌─────────────────────┐         ┌──────────────────────┐         ┌─────────────────┐
│  Cloud AI Agent     │◄───────►│  Cloudflare Worker   │◄───────►│  Extension      │
│                     │   MCP   │  (Durable Object)    │   WS    │  (Browser)      │
│  Tools:             │         │                      │         └─────────────────┘
│  - execute          │         │  - Passphrase auth   │
│  - read_file        │         │  - WebSocket relay   │         ┌─────────────────┐
│  - write_file       │         │  - Command routing   │◄───────►│  Local Client   │
│  - bash             │         │                      │   WS    │  (Files/Shell)  │
└─────────────────────┘         └──────────────────────┘         └─────────────────┘
```

## URL Structure

| Endpoint                        | Purpose                      | Auth                           |
| ------------------------------- | ---------------------------- | ------------------------------ |
| `/room/:roomId/mcp-server`      | MCP server for AI agents     | Bearer token or `?passphrase=` |
| `/room/:roomId/extension`       | Chrome extension WebSocket   | `?passphrase=`                 |
| `/room/:roomId/local/:clientId` | Local client WebSocket       | `?passphrase=`                 |
| `/room/:roomId/mcp/:clientId`   | Playwright sandbox WebSocket | `?passphrase=`                 |

## Key Files

| File                          | Purpose                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `rebrow/src/index.ts`         | Worker entry point, routes requests                              |
| `rebrow/src/relay.ts`         | Durable Object - manages WebSocket connections, routes commands  |
| `rebrow/src/mcp-server.ts`    | MCP server with all tools (execute, read_file, write_file, bash) |
| `extension/src/background.ts` | Service worker - chrome.debugger API, CDP forwarding             |
| `extension/src/popup.ts`      | Settings UI for room URL and passphrase                          |
| `local-client/src/index.ts`   | LocalClient class - handles file/bash commands                   |
| `local-client/src/cli.ts`     | CLI entry point                                                  |

## Authentication Flow

1. First connection to a room sets the passphrase (SHA-256 hashed, stored in DO)
2. Subsequent connections must provide matching passphrase
3. MCP server accepts: `Authorization: Bearer <passphrase>` or `?passphrase=<passphrase>`
4. WebSocket endpoints use query param: `?passphrase=<passphrase>`

## Browser Control Flow (CDP)

1. Agent calls `execute` tool with Playwright code
2. MCP server spawns Sandbox container with playwright-core
3. Sandbox connects to relay via WebSocket
4. Playwright sends CDP commands through relay to extension
5. Extension forwards to `chrome.debugger` API
6. Responses flow back through relay to Playwright
7. Result returned to agent

## Local Machine Flow

1. Agent calls `read_file`, `write_file`, or `bash` tool
2. MCP server calls relay DO method directly via RPC
3. Relay sends command to local client via WebSocket
4. Local client executes and returns result
5. Result returned to agent

## File Write Safety

- `write_file` requires the file to be read first
- Relay tracks file mtime from last `read_file` call
- If file was modified since last read, write fails
- Agent must re-read to get latest content before writing

## Development

```bash
# Worker (auto-reloads)
cd rebrow && pnpm dev

# Extension (rebuild after changes)
cd extension && pnpm build

# Local client (rebuild after changes)
cd local-client && pnpm build
```

## Testing Locally

1. Start worker: `cd rebrow && pnpm dev`
2. Configure extension: Room URL = `http://localhost:8787/room/test`, Passphrase = `test`
3. Connect a tab
4. Start local client: `cd local-client && node dist/cli.js http://localhost:8787/room/test test`
5. Test MCP: `curl -X POST http://localhost:8787/room/test/mcp-server -H "Authorization: Bearer test" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'`

## Guidelines

- Never use `console.log` in MCP sandbox code - use `console.error` for debugging
- Never call `browser.close()` in Playwright code - it's a relay, not owned browser
- Use UUIDs for room IDs in production
- Breaking changes to WS protocol must be avoided - extension updates aren't instant
- Local client has full filesystem access - sandboxing comes later

## CDP Documentation

```bash
curl -sL https://raw.githubusercontent.com/AltimateAI/anthropic-model-spec/master/pdl/domains/Target.pdl
curl -sL https://raw.githubusercontent.com/AltimateAI/anthropic-model-spec/master/pdl/domains/Browser.pdl
curl -sL https://raw.githubusercontent.com/AltimateAI/anthropic-model-spec/master/pdl/domains/Page.pdl
```
