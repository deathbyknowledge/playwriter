import { createMcpHandler } from 'agents/mcp'
import { proxyToSandbox } from '@cloudflare/sandbox'
import type { Env } from './types.js'
import { createRebrowMcpServer } from './mcp-server.js'

export { RebrowRelay } from './relay.js'
export { Sandbox } from '@cloudflare/sandbox'

/**
 * Rebrow - Remote Browser/Compute Relay
 *
 * URL structure:
 * - /room/:roomId/extension?passphrase=xxx - Extension WebSocket
 * - /room/:roomId/local?passphrase=xxx - Local client WebSocket
 * - /room/:roomId/mcp/:clientId?passphrase=xxx - Playwright CDP WebSocket
 * - /room/:roomId/mcp-server - MCP endpoint for agents (Bearer token or ?passphrase=xxx)
 * - / - Health check
 *
 * Authentication:
 * - First connection to a room sets the passphrase
 * - Subsequent connections must provide matching passphrase
 * - MCP server accepts passphrase via: Authorization: Bearer <passphrase> OR ?passphrase=xxx
 */

/**
 * Extract passphrase from request - checks Bearer token first, then query param
 */
function getPassphraseFromRequest(request: Request, url: URL): string | null {
  // Check Authorization header first (Bearer token)
  const authHeader = request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7) // Remove 'Bearer ' prefix
  }

  // Fall back to query parameter
  return url.searchParams.get('passphrase')
}
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
          hint: 'Use /room/:roomId/extension, /room/:roomId/local, /room/:roomId/mcp/:clientId, or /room/:roomId/mcp-server',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const roomId = pathParts[1]
    const subPath = '/' + pathParts.slice(2).join('/')

    // MCP Server endpoint (HTTP-based MCP protocol)
    if (subPath === '/mcp-server' || subPath.startsWith('/mcp-server/')) {
      // Get passphrase from Bearer token or query param
      const passphrase = getPassphraseFromRequest(request, url)

      if (!passphrase) {
        return new Response(
          JSON.stringify({
            error: 'Passphrase required',
            hint: 'Use Authorization: Bearer <passphrase> header or ?passphrase=xxx query param',
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      // Validate passphrase via DO
      const id = env.RELAY.idFromName(roomId)
      const stub = env.RELAY.get(id)
      const authCheckUrl = new URL(request.url)
      authCheckUrl.pathname = '/'
      authCheckUrl.searchParams.set('passphrase', passphrase)
      const authResponse = await stub.fetch(new Request(authCheckUrl.toString(), { method: 'HEAD' }))
      if (authResponse.status === 403) {
        return new Response(JSON.stringify({ error: 'Invalid passphrase' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const mcpServer = createRebrowMcpServer({ env, roomId, workerUrl: url.origin, passphrase })
      const handler = createMcpHandler(mcpServer, {
        route: '/mcp-server',
      })

      // Rewrite URL to match the MCP handler's expected route
      const mcpUrl = new URL(request.url)
      mcpUrl.pathname = subPath

      return handler(new Request(mcpUrl.toString(), request), env, ctx)
    }

    // WebSocket endpoints (extension, local, and playwright-core MCP clients)
    // Forward to the Durable Object relay
    const id = env.RELAY.idFromName(roomId)
    const stub = env.RELAY.get(id)

    // Forward the request to the DO, rewriting the path but keeping query params
    const doUrl = new URL(request.url)
    doUrl.pathname = subPath || '/'

    return stub.fetch(new Request(doUrl.toString(), request))
  },
}
