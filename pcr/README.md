# Playwriter Cloudflare Relay

A fully cloud-native browser automation platform running on Cloudflare. This package includes:

1. **Durable Object Relay** - Routes CDP messages between extension and MCP clients via WebSocket
2. **MCP Server** - Remote MCP server that agents (Claude, etc.) connect to directly
3. **Sandbox Execution** - Runs Playwright code in isolated containers

## Architecture

```
                                    Cloudflare
                    ┌─────────────────────────────────────────┐
                    │                                         │
Extension ─────────►│  DO Relay  ◄────►  Sandbox Container   │◄───── Agent (Claude)
 (Chrome)    WSS    │  (CDP)            (playwright-core)     │  HTTP   (MCP client)
                    │                          │              │
                    │                    MCP Server           │
                    │                   (execute tool)        │
                    └─────────────────────────────────────────┘
```

**No local MCP server needed!** Agents connect directly to the Cloudflare MCP endpoint.

## Deployment

```bash
# Install dependencies
pnpm install

# Deploy to Cloudflare (requires Workers Paid plan for Sandbox)
pnpm deploy
```

Note: The Sandbox SDK requires a Workers Paid plan.

## URL Structure

Each "room" gets its own isolated environment:

- `POST /room/:roomId/mcp-server` - MCP server endpoint (for agents to connect)
- `GET /room/:roomId/extension` - WebSocket for Chrome extension
- `GET /room/:roomId/mcp/:clientId` - WebSocket for playwright-core connections
- `GET /room/:roomId/extension/status` - Check if extension is connected

## Usage

### 1. Deploy the Worker

```bash
cd cloudflare-relay
pnpm deploy
```

Note the deployed URL (e.g., `https://playwriter-relay.your-subdomain.workers.dev`).

### 2. Configure the Chrome Extension

1. Click the Playwriter extension icon in Chrome
2. Select **Cloud** mode
3. Enter your relay URL with a room ID:
   ```
   https://playwriter-relay.your-subdomain.workers.dev/room/my-secret-room
   ```
4. Click **Save**
5. Click **Connect Tab** to connect the current tab

### 3. Configure Your Agent

Connect your MCP client directly to the cloud endpoint. **No local `npx playwriter` needed!**

#### For Claude Desktop / Cursor / VS Code

Use a remote MCP configuration:

```json
{
  "mcpServers": {
    "playwriter": {
      "url": "https://playwriter-relay.your-subdomain.workers.dev/room/my-secret-room/mcp-server"
    }
  }
}
```

Or if your client requires a command (using `mcp-remote`):

```json
{
  "mcpServers": {
    "playwriter": {
      "command": "npx",
      "args": ["mcp-remote", "https://playwriter-relay.your-subdomain.workers.dev/room/my-secret-room/mcp-server"]
    }
  }
}
```

### Alternative: Local MCP with Cloud Relay

If you prefer running the MCP locally (for full Playwright API access), you can still use the relay for remote browser control:

```json
{
  "mcpServers": {
    "playwriter": {
      "command": "npx",
      "args": [
        "playwriter@latest",
        "--relay-url",
        "https://playwriter-relay.your-subdomain.workers.dev/room/my-secret-room"
      ]
    }
  }
}
```

## Local Development

```bash
# Run locally with wrangler
pnpm dev
```

This starts the worker at `http://localhost:8787`.

Note: Sandbox containers require deployment to Cloudflare - they don't run locally.

## How It Works

1. **Extension connects** - Chrome extension establishes WebSocket to the Durable Object relay
2. **Agent calls MCP** - Agent sends `execute` tool calls to the MCP server endpoint
3. **Sandbox executes** - A Sandbox container runs the Playwright code
4. **Playwright connects** - playwright-core in the sandbox connects to the relay via WebSocket
5. **CDP relayed** - CDP commands flow through the relay to the extension
6. **Extension executes** - Extension executes commands via chrome.debugger API
7. **Results return** - Results flow back through the chain to the agent

## Security Notes

- The **room ID acts as a shared secret** - anyone who knows it can connect
- For production, consider using randomly generated UUIDs as room IDs
- HTTPS/WSS is handled automatically by Cloudflare
- Each room gets isolated Sandbox containers

## Troubleshooting

### "Extension not connected" error

- Check that the extension is configured with the correct relay URL
- Verify the extension shows "Connected" status in the popup
- Make sure you clicked "Connect Tab" on the tab you want to control

### Sandbox initialization slow

- First request in a new room takes longer (installs playwright-core)
- Subsequent requests reuse the initialized sandbox

### Timeout errors

- Increase the `timeout` parameter in execute calls
- Complex operations may need 30-60 seconds
