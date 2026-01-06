# Personal Compute Relay

Give cloud AI agents secure access to your personal compute resources - your browser and your local machine.

## What is it?

Personal Compute Relay bridges the gap between cloud-hosted AI agents and your local environment. Instead of running agents locally (which requires powerful hardware), you can run them in the cloud while they securely interact with:

- **Your Browser** - Control Chrome tabs, fill forms, navigate sites, take screenshots
- **Your Local Machine** - Read/write files, run bash commands, execute builds

```
┌─────────────────────┐         ┌──────────────────────┐         ┌─────────────────┐
│  Cloud AI Agent     │◄───────►│  Cloudflare Worker   │◄───────►│  Your Machine   │
│  (Claude, GPT, etc) │   MCP   │  (Relay)             │   WS    │                 │
│                     │         │                      │         │  - Browser tabs │
│                     │         │  - Auth              │         │  - Files        │
│                     │         │  - Route commands    │         │  - Shell        │
└─────────────────────┘         └──────────────────────┘         └─────────────────┘
```

## Quick Start

### 1. Deploy the Relay

```bash
cd pcr
pnpm install
pnpm deploy
```

Note your deployed URL (e.g., `https://pcr.your-subdomain.workers.dev`).

### 2. Connect Your Browser (Optional)

Build and install the Chrome extension:

```bash
cd extension
pnpm install && pnpm build
```

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/dist`
4. Click the extension icon
5. Enter Room URL: `https://pcr.your-subdomain.workers.dev/room/my-room`
6. Enter Passphrase: `your-secret-passphrase`
7. Click **Save**, then **Connect Tab**

### 3. Connect Your Local Machine (Optional)

```bash
cd pcr-local
pnpm install && pnpm build
node dist/cli.js https://pcr.your-subdomain.workers.dev/room/my-room your-secret-passphrase
```

### 4. Configure Your AI Agent

Add to your MCP client config (e.g., Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pcr": {
      "url": "https://pcr.your-subdomain.workers.dev/room/my-room/mcp-server",
      "headers": {
        "Authorization": "Bearer your-secret-passphrase"
      }
    }
  }
}
```

## Available Tools

### Browser Control (requires extension)

**`execute`** - Run Playwright code in your browser

```javascript
// See the page structure
console.log(await accessibilitySnapshot({ page }))

// Click elements
await page.locator('aria-ref=e13').click()

// Fill forms
await page.locator('aria-ref=e25').fill('hello@example.com')

// Navigate
await page.goto('https://example.com')

// Screenshot with labels
await screenshotWithAccessibilityLabels({ page })
```

### Local Machine (requires local-client)

**`read_file`** - Read files from your machine

```json
{ "path": "/Users/me/project/src/index.ts" }
```

**`write_file`** - Write files (must read first to prevent conflicts)

```json
{ "path": "/Users/me/project/src/index.ts", "content": "..." }
```

**`bash`** - Execute shell commands

```json
{ "command": "npm test", "workdir": "/Users/me/project" }
```

## Security

- **Passphrase authentication** - First connection sets the passphrase, subsequent must match
- **Room isolation** - Each room is completely isolated
- **No data storage** - Relay only passes through commands, stores nothing
- **You control access** - Only what you connect is accessible

## Use Cases

- **Remote development** - Code from anywhere with cloud AI assistance
- **Browser automation** - Let AI handle repetitive web tasks
- **Accessibility** - Voice/chat control of browser for motor-impaired users
- **AI agents** - Give Claude, GPT, or local models access to real compute

## Architecture

- **`pcr/`** - Cloudflare Worker + Durable Objects relay
- **`extension/`** - Chrome extension for browser control
- **`pcr-local/`** - Node.js CLI for local machine access

## Development

```bash
# Start the worker locally
cd pcr && pnpm dev

# Build the extension
cd extension && pnpm build

# Build local client
cd pcr-local && pnpm build

# Test locally
# Extension: Room URL = http://localhost:8787/room/test, Passphrase = test
# Local client: node dist/cli.js http://localhost:8787/room/test test
```

## License

MIT
