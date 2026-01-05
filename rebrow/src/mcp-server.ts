import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getSandbox } from '@cloudflare/sandbox'
import type { Env } from './types.js'

// Prompt for browser control - assistive use + developer tools
const EXECUTE_PROMPT = `
Control user's Chrome browser via Playwright code. You can help users accomplish tasks (filling forms, navigating sites) or assist developers with debugging and automation.

# BROWSER ASSISTANT

Be conversational - confirm what you're doing and ask for clarification when needed.

## understanding the page

**Start with accessibility snapshot** - shows interactive elements with refs:
\`\`\`js
console.log(await accessibilitySnapshot({ page }));
\`\`\`

Output example:
\`\`\`
- banner [ref=e3]:
    - link "Home" [ref=e5]
    - navigation [ref=e12]:
        - link "Sign In" [ref=e13]
- main [ref=e20]:
    - heading "Welcome" [ref=e21]
    - textbox "Email" [ref=e25]
    - button "Log In" [ref=e30]
\`\`\`

**When accessibility fails** (unlabeled elements, canvas, complex layouts), take a screenshot:
\`\`\`js
await screenshotWithAccessibilityLabels({ page });
\`\`\`
This overlays visual labels and includes the image in the response. Use for image-heavy pages, maps, or when you can't find what the user describes.

## interacting with elements

Click using ref (no quotes around value):
\`\`\`js
await page.locator('aria-ref=e13').click();
\`\`\`

Type in fields:
\`\`\`js
await page.locator('aria-ref=e25').fill('user@example.com');
\`\`\`

Navigate:
\`\`\`js
await page.goto('https://example.com');
\`\`\`

Search for specific elements:
\`\`\`js
console.log(await accessibilitySnapshot({ page, search: /sign in|login/i }));
\`\`\`

## always verify after actions

After clicking or submitting, check what happened:
\`\`\`js
await page.locator('aria-ref=e30').click();
await sleep(1000);
console.log('Now at:', page.url());
console.log(await accessibilitySnapshot({ page }).then(s => s.split('\\n').slice(0, 25).join('\\n')));
\`\`\`

## handling tricky websites

**iFrames** (embedded content, payment forms):
\`\`\`js
const frame = page.frameLocator('iframe').first();
await frame.locator('button').click();
\`\`\`

**Multiple matches** - be specific:
\`\`\`js
await page.locator('button').filter({ hasText: 'Submit' }).click();
await page.locator('button').first().click();
await page.locator('li').nth(2).click();  // 0-indexed
\`\`\`

**Popups/new tabs**:
\`\`\`js
const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('aria-ref=e15').click()]);
await popup.waitForLoadState();
console.log('Popup opened:', popup.url());
\`\`\`

**Dialogs** (alerts, confirms):
\`\`\`js
page.once('dialog', d => d.accept());
await page.locator('aria-ref=e10').click();
\`\`\`

**Scrolling**:
\`\`\`js
await page.mouse.wheel(0, 500);
await page.locator('aria-ref=e50').scrollIntoViewIfNeeded();
\`\`\`

**Waiting for content**:
\`\`\`js
await waitForPageLoad({ page });  // smart wait, ignores analytics
\`\`\`

## what you can help with

- Fill out forms, log into sites
- Navigate and find information
- Click through multi-step processes
- Read page content aloud (via snapshots)
- Handle cookie banners, popups, modals
- Download files, capture screenshots
- Anything the user would do manually

---

# DEVELOPER TOOLS

For debugging, testing, and automation tasks.

## context variables

- \`page\` - the browser tab the user activated
- \`context\` - browser context, \`context.pages()\` for all tabs
- \`state\` - persists between calls, store data here
- \`require\` - load Node.js modules
- \`sleep(ms)\` - wait helper

## selector best practices

For unknown websites, use \`accessibilitySnapshot()\` with \`aria-ref\`.

For development (with source access), prefer stable selectors:
1. \`[data-testid="submit"]\` - explicit test attributes
2. \`getByRole('button', { name: 'Save' })\` - semantic
3. \`getByText('Sign in')\`, \`getByLabel('Email')\` - user-facing
4. \`input[name="email"]\` - semantic HTML
5. Avoid: \`.btn-primary\`, \`#submit\` - fragile

## working with multiple pages

\`\`\`js
const pages = context.pages().filter(x => x.url().includes('localhost'));
state.targetPage = pages[0];

state.newPage = await context.newPage();
await state.newPage.goto('https://example.com');
\`\`\`

## page.evaluate

Run code in browser context (plain JS only):
\`\`\`js
const title = await page.evaluate(() => document.title);
const info = await page.evaluate(() => ({
    url: location.href,
    buttons: document.querySelectorAll('button').length,
}));
console.log(info);
\`\`\`

## network interception

Capture API calls for reverse-engineering:
\`\`\`js
state.requests = []; state.responses = [];
page.on('request', req => { if (req.url().includes('/api/')) state.requests.push({ url: req.url(), method: req.method(), headers: req.headers() }); });
page.on('response', async res => { if (res.url().includes('/api/')) { try { state.responses.push({ url: res.url(), status: res.status(), body: await res.json() }); } catch {} } });
\`\`\`

Analyze captured data:
\`\`\`js
console.log('Captured', state.responses.length, 'API calls');
state.responses.forEach(r => console.log(r.status, r.url.slice(0, 80)));
\`\`\`

Clean up: \`page.removeAllListeners('request'); page.removeAllListeners('response');\`

## console log capture

\`\`\`js
const logs = await getLatestLogs({ page, search: /error/i, count: 50 });
console.log(logs);
\`\`\`

## downloads

\`\`\`js
const [download] = await Promise.all([page.waitForEvent('download'), page.click('button.download')]);
await download.saveAs('/tmp/' + download.suggestedFilename());
\`\`\`

## file input

\`\`\`js
const fs = require('node:fs');
const content = fs.readFileSync('./data.txt', 'utf-8');
await page.locator('textarea').fill(content);
\`\`\`

## pinned elements

Users can right-click → "Copy Rebrow Element Reference" to pin elements:
\`\`\`js
const el = await page.evaluateHandle(() => globalThis.playwriterPinnedElem1);
await el.click();
\`\`\`

---

## rules (both modes)

- **Never close browser** - don't call \`browser.close()\` or \`context.close()\`
- **Multiple calls are fine** - break complex tasks into steps
- **Verify after actions** - check page state changed as expected
- **Ask for help** - captchas, unclear elements, ambiguous requests
`.trim()

/**
 * Generate the Node.js script that will run in the Sandbox container.
 * This script:
 * 1. Connects to the relay via WebSocket using playwright-core
 * 2. Executes the user's code
 * 3. Returns the result as JSON
 */
function generateExecutionScript({
  code,
  relayWsUrl,
  timeout,
}: {
  code: string
  relayWsUrl: string
  timeout: number
}): string {
  return `
const { chromium } = require('playwright-core');

// State persisted between calls (in this sandbox session)
const state = globalThis.__playwriterState || {};
globalThis.__playwriterState = state;

// Browser logs storage (persisted in state)
if (!state.__browserLogs) state.__browserLogs = new Map();
const browserLogs = state.__browserLogs;

// Screenshot collector for this execution
const screenshotCollector = [];

// Console log capture
const consoleLogs = [];
const originalConsole = { ...console };
console.log = (...args) => { consoleLogs.push({ method: 'log', args: args.map(String) }); };
console.info = (...args) => { consoleLogs.push({ method: 'info', args: args.map(String) }); };
console.warn = (...args) => { consoleLogs.push({ method: 'warn', args: args.map(String) }); };
console.error = (...args) => { consoleLogs.push({ method: 'error', args: args.map(String) }); };
console.debug = (...args) => { consoleLogs.push({ method: 'debug', args: args.map(String) }); };

// sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============== UTILITY FUNCTIONS ==============

// Helper function for accessibility snapshot
async function accessibilitySnapshot(options) {
  const { page, search, contextLines = 10, showDiffSinceLastCall = false } = options;
  if (page._snapshotForAI) {
    const snapshot = await page._snapshotForAI();
    const snapshotStr = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot, null, 2);
    
    if (!search) {
      return snapshotStr;
    }
    
    const lines = snapshotStr.split('\\n');
    const matches = [];
    const searchRegex = search instanceof RegExp ? search : new RegExp(search);
    
    for (let i = 0; i < lines.length && matches.length < 10; i++) {
      if (searchRegex.test(lines[i])) {
        matches.push({ line: lines[i], index: i });
      }
    }
    
    if (matches.length === 0) return 'No matches found';
    
    return matches.map(m => {
      const start = Math.max(0, m.index - contextLines);
      const end = Math.min(lines.length, m.index + contextLines + 1);
      return lines.slice(start, end).join('\\n');
    }).join('\\n\\n---\\n\\n');
  }
  throw new Error('accessibilitySnapshot is not available on this page');
}

// waitForPageLoad - smart load detection that ignores analytics/ads
const FILTERED_DOMAINS = [
  'doubleclick', 'googlesyndication', 'googleadservices', 'google-analytics',
  'googletagmanager', 'facebook.net', 'fbcdn.net', 'twitter.com', 'linkedin.com',
  'hotjar', 'mixpanel', 'segment.io', 'segment.com', 'newrelic', 'datadoghq',
  'sentry.io', 'fullstory', 'amplitude', 'intercom', 'crisp.chat', 'zdassets.com',
  'zendesk', 'tawk.to', 'hubspot', 'marketo', 'pardot', 'optimizely', 'crazyegg',
  'mouseflow', 'clarity.ms', 'bing.com/bat', 'ads.', 'analytics.', 'tracking.', 'pixel.'
];
const FILTERED_EXTENSIONS = ['.gif', '.ico', '.cur', '.woff', '.woff2', '.ttf', '.otf', '.eot'];

async function waitForPageLoad(options) {
  const { page, timeout = 30000, pollInterval = 100, minWait = 500 } = options;
  const startTime = Date.now();
  let lastReadyState = '';
  let lastPendingRequests = [];

  const checkPageReady = async () => {
    return await page.evaluate(({ filteredDomains, filteredExtensions }) => {
      const readyState = document.readyState;
      if (readyState !== 'complete') {
        return { ready: false, readyState, pendingRequests: ['document.readyState: ' + readyState] };
      }
      const resources = performance.getEntriesByType('resource');
      const now = performance.now();
      const pendingRequests = resources
        .filter(r => {
          if (r.responseEnd > 0) return false;
          const elapsed = now - r.startTime;
          const url = r.name.toLowerCase();
          if (url.startsWith('data:')) return false;
          if (filteredDomains.some(d => url.includes(d))) return false;
          if (elapsed > 10000) return false;
          if (elapsed > 3000 && filteredExtensions.some(ext => url.includes(ext))) return false;
          return true;
        })
        .map(r => r.name);
      return { ready: pendingRequests.length === 0, readyState, pendingRequests };
    }, { filteredDomains: FILTERED_DOMAINS, filteredExtensions: FILTERED_EXTENSIONS });
  };

  await sleep(minWait);

  while (Date.now() - startTime < timeout) {
    try {
      const { ready, readyState, pendingRequests } = await checkPageReady();
      lastReadyState = readyState;
      lastPendingRequests = pendingRequests;
      if (ready) {
        return { success: true, readyState, pendingRequests: [], waitTimeMs: Date.now() - startTime, timedOut: false };
      }
    } catch (e) {
      return { success: false, readyState: 'error', pendingRequests: ['page.evaluate failed'], waitTimeMs: Date.now() - startTime, timedOut: false };
    }
    await sleep(pollInterval);
  }

  return { success: false, readyState: lastReadyState, pendingRequests: lastPendingRequests.slice(0, 10), waitTimeMs: Date.now() - startTime, timedOut: true };
}

// getLatestLogs - retrieve captured browser console logs
async function getLatestLogs(options = {}) {
  const { page: filterPage, count, search } = options;
  let allLogs = [];

  if (filterPage) {
    const url = filterPage.url();
    const pageLogs = browserLogs.get(url) || [];
    allLogs = [...pageLogs];
  } else {
    for (const pageLogs of browserLogs.values()) {
      allLogs.push(...pageLogs);
    }
  }

  if (search) {
    allLogs = allLogs.filter(log => {
      if (typeof search === 'string') return log.includes(search);
      if (search instanceof RegExp) return search.test(log);
      return false;
    });
  }

  return count !== undefined ? allLogs.slice(-count) : allLogs;
}

// Setup console log capture for a page
function setupLogCapture(page) {
  const url = page.url();
  if (!browserLogs.has(url)) {
    browserLogs.set(url, []);
  }
  const logs = browserLogs.get(url);
  
  page.on('console', msg => {
    const text = '[' + msg.type() + '] ' + msg.text();
    logs.push(text);
    // Keep max 5000 logs per page
    if (logs.length > 5000) logs.shift();
  });
  
  // Clear logs on navigation
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      const newUrl = page.url();
      if (newUrl !== url) {
        browserLogs.delete(url);
        browserLogs.set(newUrl, []);
      }
    }
  });
}

// screenshotWithAccessibilityLabels - capture screenshot with Vimium-style labels
async function screenshotWithAccessibilityLabels(options) {
  const { page, interactiveOnly = true } = options;
  
  // Get accessibility snapshot first
  const snapshot = await accessibilitySnapshot({ page });
  
  // Parse refs from snapshot and show labels
  const labelCount = await page.evaluate(({ interactiveOnly }) => {
    const win = window;
    const doc = document;
    const containerId = '__playwriter_labels__';
    
    // Remove existing labels
    doc.getElementById(containerId)?.remove();
    
    // Create container for labels
    const container = doc.createElement('div');
    container.id = containerId;
    container.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483647;pointer-events:none;';
    
    // Find all elements with aria-ref attribute
    const elements = doc.querySelectorAll('[aria-ref]');
    let count = 0;
    
    const roleColors = {
      link: ['#FEF08A', '#FDE047', '#CA8A04'],
      button: ['#FED7AA', '#FDBA74', '#C2410C'],
      textbox: ['#FCA5A5', '#F87171', '#B91C1C'],
      checkbox: ['#F9A8D4', '#F472B6', '#BE185D'],
    };
    const defaultColors = ['#D1D5DB', '#9CA3AF', '#4B5563'];
    
    for (const element of elements) {
      const ref = element.getAttribute('aria-ref');
      if (!ref) continue;
      
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      
      const role = element.getAttribute('role') || element.tagName.toLowerCase();
      const [gradTop, gradBottom, border] = roleColors[role] || defaultColors;
      
      const label = doc.createElement('div');
      label.textContent = ref;
      label.style.cssText = 'position:absolute;font:bold 11px/1 monospace;padding:2px 4px;border-radius:2px;white-space:nowrap;' +
        'background:linear-gradient(to bottom,' + gradTop + ',' + gradBottom + ');' +
        'border:1px solid ' + border + ';color:#000;';
      label.style.left = (win.scrollX + rect.left) + 'px';
      label.style.top = (win.scrollY + Math.max(0, rect.top - 17)) + 'px';
      
      container.appendChild(label);
      count++;
    }
    
    doc.documentElement.appendChild(container);
    return count;
  }, { interactiveOnly });
  
  // Take screenshot
  const viewport = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })');
  const buffer = await page.screenshot({
    type: 'jpeg',
    quality: 80,
    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
  });
  
  // Hide labels
  await page.evaluate(() => {
    document.getElementById('__playwriter_labels__')?.remove();
  });
  
  // Add to collector
  screenshotCollector.push({
    base64: buffer.toString('base64'),
    mimeType: 'image/jpeg',
    snapshot,
    labelCount,
  });
}

async function main() {
  let browser;
  let result;
  
  try {
    // Connect to relay
    browser = await chromium.connectOverCDP('${relayWsUrl}');
    
    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    
    const pages = context.pages();
    if (pages.length === 0) {
      throw new Error('No browser tabs are connected. Please enable the Rebrow extension on at least one tab.');
    }
    const page = pages[0];
    
    // Setup log capture for all pages
    for (const p of pages) {
      setupLogCapture(p);
    }
    
    // Execute user code
    const asyncFn = new Function(
      'page', 'context', 'state', 'accessibilitySnapshot', 'console',
      'waitForPageLoad', 'getLatestLogs', 'screenshotWithAccessibilityLabels', 'sleep',
      \`return (async () => {
        ${code.replace(/`/g, '\\`')}
      })();\`
    );
    
    result = await Promise.race([
      asyncFn(page, context, state, accessibilitySnapshot, console,
              waitForPageLoad, getLatestLogs, screenshotWithAccessibilityLabels, sleep),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Execution timeout')), ${timeout}))
    ]);
    
  } catch (error) {
    // Output error as JSON
    const output = {
      success: false,
      consoleLogs,
      screenshots: screenshotCollector,
      error: error.message,
      stack: error.stack
    };
    originalConsole.log(JSON.stringify(output));
    setImmediate(() => process.exit(1));
  }
  
  // Output success result as JSON
  const output = {
    success: true,
    consoleLogs,
    screenshots: screenshotCollector,
    result: result !== undefined ? (typeof result === 'string' ? result : JSON.stringify(result)) : null
  };
  originalConsole.log(JSON.stringify(output));
  setImmediate(() => process.exit(0));
}

main().catch(err => {
  originalConsole.error('Unhandled error:', err);
  setImmediate(() => process.exit(1));
});
`
}

interface ScreenshotData {
  base64: string
  mimeType: string
  snapshot: string
  labelCount: number
}

interface ExecutionResult {
  success: boolean
  consoleLogs: Array<{ method: string; args: string[] }>
  screenshots?: ScreenshotData[]
  result?: string | null
  error?: string
  stack?: string
}

/**
 * Create the MCP server with the execute tool
 */
export function createRebrowMcpServer({
  env,
  roomId,
  workerUrl,
}: {
  env: Env
  roomId: string
  workerUrl: string
}): McpServer {
  const server = new McpServer({
    name: 'playwriter',
    version: '1.0.0',
  })

  // Track sandbox initialization state
  let sandboxInitialized = false

  server.tool(
    'execute',
    EXECUTE_PROMPT,
    {
      code: z
        .string()
        .describe(
          'js playwright code, has {page, state, context} in scope. Should be one line, using ; to execute multiple statements.',
        ),
      timeout: z.number().default(30000).describe('Timeout in milliseconds for code execution (default: 30000ms)'),
    },
    async ({ code, timeout }) => {
      try {
        // Get sandbox for this room
        const sandbox = getSandbox(env.Sandbox, `playwriter-${roomId}`)

        // Initialize sandbox if needed (install playwright-core)
        if (!sandboxInitialized) {
          console.log('[MCP] Initializing sandbox...')

          // Check if playwright-core is already installed
          const checkResult = await sandbox.exec('node -e "require(\'playwright-core\')" 2>&1 || echo "NOT_INSTALLED"')

          if (checkResult.stdout.includes('NOT_INSTALLED') || !checkResult.success) {
            console.log('[MCP] Installing playwright-core...')
            const installResult = await sandbox.exec('npm install playwright-core', { timeout: 120000 })
            if (!installResult.success) {
              throw new Error(`Failed to install playwright-core: ${installResult.stderr}`)
            }
            console.log('[MCP] playwright-core installed')
          }

          sandboxInitialized = true
        }

        // Build the relay WebSocket URL
        // The relay is on the same worker, so we use the room's mcp endpoint
        // Convert http(s):// to ws(s):// for WebSocket connection
        const wsProtocol = workerUrl.startsWith('https://') ? 'wss://' : 'ws://'
        const wsHost = workerUrl.replace(/^https?:\/\//, '')
        const relayWsUrl = `${wsProtocol}${wsHost}/room/${roomId}/mcp/sandbox-${Date.now()}`

        // Generate and write the execution script
        const script = generateExecutionScript({ code, relayWsUrl, timeout })
        await sandbox.writeFile('/workspace/execute.js', script)

        // Run the script
        const execResult = await sandbox.exec('node /workspace/execute.js', {
          timeout: timeout + 5000, // Give a bit more time for the wrapper
        })

        // Parse the output
        let output: ExecutionResult
        try {
          // Find the last line that looks like JSON
          const lines = execResult.stdout.trim().split('\n')
          const jsonLine = lines.reverse().find((l) => l.startsWith('{'))
          if (!jsonLine) {
            throw new Error('No JSON output found')
          }
          output = JSON.parse(jsonLine)
        } catch {
          // If we can't parse, treat the whole output as an error
          return {
            content: [
              {
                type: 'text',
                text: `Error parsing output:\nstdout: ${execResult.stdout}\nstderr: ${execResult.stderr}`,
              },
            ],
            isError: true,
          }
        }

        // Format the response
        let responseText = ''

        // Add console logs
        if (output.consoleLogs && output.consoleLogs.length > 0) {
          responseText += 'Console output:\n'
          for (const log of output.consoleLogs) {
            responseText += `[${log.method}] ${log.args.join(' ')}\n`
          }
          responseText += '\n'
        }

        if (output.success) {
          if (output.result) {
            responseText += `Return value:\n${output.result}`
          } else if (!output.consoleLogs || output.consoleLogs.length === 0) {
            responseText += 'Code executed successfully (no output)'
          }

          return {
            content: [{ type: 'text', text: responseText.trim() }],
          }
        } else {
          responseText += `Error executing code: ${output.error}\n${output.stack || ''}`
          return {
            content: [{ type: 'text', text: responseText.trim() }],
            isError: true,
          }
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text', text: `Error: ${errorMessage}` }],
          isError: true,
        }
      }
    },
  )

  // Reset tool to clear sandbox state
  server.tool(
    'reset',
    'Reset the browser connection and clear any stored state. Use when you get connection errors or want to start fresh.',
    {},
    async () => {
      try {
        const sandbox = getSandbox(env.Sandbox, `playwriter-${roomId}`)

        // Clear the state by running a script that resets globalThis.__playwriterState
        await sandbox.exec('node -e "globalThis.__playwriterState = {}"')
        sandboxInitialized = false

        return {
          content: [{ type: 'text', text: 'Connection reset. State cleared.' }],
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text', text: `Reset failed: ${errorMessage}` }],
          isError: true,
        }
      }
    },
  )

  return server
}
