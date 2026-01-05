# Rebrow - Remote Browser Control

This codebase contains:

- **rebrow/** - Cloudflare Worker that relays CDP (Chrome DevTools Protocol) between the extension and AI agents
- **extension/** - Chrome extension that connects browser tabs to the relay

## Architecture

- User installs extension in Chrome
- Extension connects to Cloudflare Worker at `wss://worker/room/:roomId/extension`
- AI agent connects to MCP endpoint at `https://worker/room/:roomId/mcp-server`
- Worker runs Playwright code in a Sandbox container to control the browser
- Tabs are identified by sessionId or targetId (CDP concepts) or tabId (chrome debugger concept)

## Development

### Extension

```bash
cd extension && pnpm build
```

Load `extension/dist` in Chrome via `chrome://extensions` (developer mode).

### Worker

```bash
cd rebrow && pnpm dev
```

Starts local worker at `localhost:8787`.

### Testing

Configure extension with `http://localhost:8787/room/test` and connect a tab.

## Key Files

- `rebrow/src/relay.ts` - Durable Object that relays CDP between extension and Playwright
- `rebrow/src/mcp-server.ts` - MCP server with `execute` tool that runs Playwright code
- `rebrow/src/index.ts` - Worker entry point, routes to DO or MCP
- `extension/src/background.ts` - Service worker, handles CDP via chrome.debugger API
- `extension/src/popup.ts` - Settings popup for configuring relay URL

## CDP Flow

1. Agent calls `execute` tool with Playwright code
2. Worker spawns Sandbox container with playwright-core
3. Sandbox connects to relay via WebSocket (`/room/:roomId/mcp/:clientId`)
4. Playwright sends CDP commands through relay to extension
5. Extension forwards to chrome.debugger API
6. Responses flow back through relay to Playwright
7. Result returned to agent

## CDP Docs

```bash
curl -sL https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Target.pdl
curl -sL https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Browser.pdl
curl -sL https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl
curl -sL https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Emulation.pdl
```

## Guidelines

- Never use `console.log` in MCP code - use `console.error` for debugging
- Room ID acts as shared secret - recommend using UUIDs
- Never call `browser.close()` in Playwright code - it's a relay, not owned browser
- Breaking changes to WS protocol must be avoided - extension updates are not instant
