# Rebrow

Remote browser control via Cloudflare Workers. Let AI agents control your Chrome browser from anywhere.

## How it works

1. **Chrome Extension** connects to a Cloudflare Worker relay
2. **AI Agent** connects to the same relay via MCP
3. Agent can see the page (accessibility snapshots, screenshots) and interact (click, type, navigate)

```
Your Browser                    Cloudflare                      AI Agent
    |                               |                               |
    |  Extension connects to        |                               |
    |  wss://relay/room/xyz  -----> |                               |
    |                               | <----- Agent connects via MCP |
    |                               |        /room/xyz/mcp-server   |
    |  CDP commands/events <------> |  <---->  execute tool calls   |
    |                               |                               |
```

## Setup

### 1. Deploy the Worker

```bash
cd rebrow
pnpm install
pnpm deploy
```

Note the deployed URL (e.g., `https://rebrow.your-subdomain.workers.dev`).

### 2. Install the Extension

Load the extension in Chrome:

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/dist` folder

### 3. Connect a Tab

1. Click the Rebrow extension icon
2. Enter your relay URL with a room ID: `https://rebrow.your-subdomain.workers.dev/room/my-room`
3. Click **Save**
4. Click **Connect Tab** on any tab you want to control

### 4. Configure Your AI Agent

Add the MCP server to your agent config (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "rebrow": {
      "url": "https://rebrow.your-subdomain.workers.dev/room/my-room/mcp-server"
    }
  }
}
```

The room ID (`my-room`) acts as a shared secret - use a random UUID for security.

## What Can the Agent Do?

The agent has a single `execute` tool that runs Playwright code:

```javascript
// See what's on the page
console.log(await accessibilitySnapshot({ page }))

// Click an element
await page.locator('aria-ref=e13').click()

// Fill a form
await page.locator('aria-ref=e25').fill('hello@example.com')

// Navigate
await page.goto('https://example.com')

// Take a screenshot with labels
await screenshotWithAccessibilityLabels({ page })
```

## Use Cases

- **Accessibility assistance** - Help users with motor impairments control their browser via voice/chat
- **Remote automation** - Run browser tasks from anywhere
- **AI browser agents** - Let Claude, GPT, or local models browse the web

## Development

```bash
# Start the worker locally
cd rebrow
pnpm dev

# Build the extension
cd extension
pnpm build
```

For local development, the extension connects to `localhost:8787`.

## Architecture

- **`rebrow/`** - Cloudflare Worker with Durable Objects relay + Sandbox for Playwright execution
- **`extension/`** - Chrome extension that connects browser tabs to the relay

## License

MIT
