import { createMcpHandler } from 'agents/mcp'
import { proxyToSandbox } from '@cloudflare/sandbox'
import type { Env } from './types.js'
import { createRebrowMcpServer } from './mcp-server.js'

export { RebrowRelay } from './relay.js'
export { Sandbox } from '@cloudflare/sandbox'

/**
 * Rebrow - Remote Browser Control
 *
 * URL structure:
 * - /room/:roomId/extension - Extension WebSocket
 * - /room/:roomId/mcp/:clientId - Playwright CDP WebSocket
 * - /room/:roomId/mcp-server - MCP endpoint for agents
 * - / - Health check
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Handle Sandbox preview URL routing first
    const proxyResponse = await proxyToSandbox(request, env)
    if (proxyResponse) {
      return proxyResponse
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('Rebrow Cloudflare Relay OK', { status: 200 })
    }

    // Parse room ID from path
    // /room/:roomId/...
    const pathParts = url.pathname.split('/').filter(Boolean)
    if (pathParts[0] !== 'room' || !pathParts[1]) {
      return new Response(
        JSON.stringify({
          error: 'Invalid path',
          hint: 'Use /room/:roomId/extension, /room/:roomId/mcp/:clientId, or /room/:roomId/mcp-server',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const roomId = pathParts[1]
    const subPath = '/' + pathParts.slice(2).join('/')

    // MCP Server endpoint (HTTP-based MCP protocol)
    if (subPath === '/mcp-server' || subPath.startsWith('/mcp-server/')) {
      const mcpServer = createRebrowMcpServer({ env, roomId, workerUrl: url.origin })
      const handler = createMcpHandler(mcpServer, {
        route: '/mcp-server',
      })

      // Rewrite URL to match the MCP handler's expected route
      const mcpUrl = new URL(request.url)
      mcpUrl.pathname = subPath

      return handler(new Request(mcpUrl.toString(), request), env, ctx)
    }

    // WebSocket endpoints (extension and playwright-core MCP clients)
    // Forward to the Durable Object relay
    const id = env.RELAY.idFromName(roomId)
    const stub = env.RELAY.get(id)

    // Forward the request to the DO, rewriting the path
    const doUrl = new URL(request.url)
    doUrl.pathname = subPath || '/'

    return stub.fetch(new Request(doUrl.toString(), request))
  },
}
