import { DurableObject } from 'cloudflare:workers'
import type {
  Env,
  CDPCommand,
  CDPResponse,
  CDPEvent,
  ConnectedTarget,
  TargetInfo,
  ExtensionMessage,
  ExtensionEventMessage,
  WebSocketTag,
  LocalCommand,
  LocalMessage,
  LocalResponse,
  RoomAuth,
} from './types.js'

// Simple hash function for passphrase (SHA-256)
async function hashPassphrase(passphrase: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(passphrase)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * RebrowRelay is a Durable Object that acts as a WebSocket relay between:
 * - Chrome extension (sends CDP events, receives CDP commands)
 * - MCP clients (sends CDP commands, receives CDP events/responses)
 *
 * Uses WebSocket hibernation for cost efficiency - the DO only wakes up when
 * messages are sent, not while connections are idle.
 */
export class RebrowRelay extends DurableObject<Env> {
  // Track connected targets (pages) from the extension
  private connectedTargets = new Map<string, ConnectedTarget>()

  // Pending requests waiting for extension response
  private pendingRequests = new Map<
    number,
    {
      resolve: (result: unknown) => void
      reject: (error: Error) => void
      mcpClientId: string
    }
  >()

  // Pending requests waiting for local client response
  private pendingLocalRequests = new Map<
    number,
    {
      resolve: (result: unknown) => void
      reject: (error: Error) => void
    }
  >()

  // Track file read timestamps for write validation
  // Map of filepath -> last read timestamp (mtime from local client)
  private fileReadTimestamps = new Map<string, number>()

  // Message ID counter for requests to extension
  private messageId = 0

  // Message ID counter for requests to local client
  private localMessageId = 0

  // Ping interval handle
  private pingInterval: ReturnType<typeof setInterval> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  // ============== Passphrase Auth ==============

  /**
   * Validate passphrase - first connection sets it, subsequent must match
   */
  async validatePassphrase(passphrase: string): Promise<boolean> {
    const stored = await this.ctx.storage.get<RoomAuth>('auth')

    if (!stored) {
      // First connection - set the passphrase
      const hash = await hashPassphrase(passphrase)
      await this.ctx.storage.put<RoomAuth>('auth', {
        passphraseHash: hash,
        createdAt: Date.now(),
      })
      console.log('[Relay] Passphrase set for room')
      return true
    }

    // Validate against stored hash
    const hash = await hashPassphrase(passphrase)
    return hash === stored.passphraseHash
  }

  /**
   * Handle incoming HTTP requests - upgrade to WebSocket
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const passphrase = url.searchParams.get('passphrase')

    // Health check endpoint - also used for passphrase validation
    if (url.pathname === '/' || url.pathname === '/health') {
      // If passphrase is provided, validate it
      if (passphrase) {
        const isValid = await this.validatePassphrase(passphrase)
        if (!isValid) {
          return new Response('Invalid passphrase', { status: 403 })
        }
      }
      return new Response('OK', { status: 200 })
    }

    // Extension status endpoint
    if (url.pathname === '/extension/status') {
      const extensionWs = this.getExtensionWebSocket()
      return Response.json({ connected: extensionWs !== null })
    }

    // Local client status endpoint
    if (url.pathname === '/local/status') {
      const localWs = this.getLocalWebSocket()
      return Response.json({ connected: localWs !== null })
    }

    // All other endpoints require passphrase in query param
    if (!passphrase) {
      return new Response('Passphrase required', { status: 401 })
    }

    const isValid = await this.validatePassphrase(passphrase)
    if (!isValid) {
      return new Response('Invalid passphrase', { status: 403 })
    }

    // WebSocket upgrade for extension
    if (url.pathname === '/extension') {
      return this.handleExtensionUpgrade(request)
    }

    // WebSocket upgrade for local client
    // Format: /local or /local/:clientId
    if (url.pathname === '/local' || url.pathname.startsWith('/local/')) {
      const clientId = url.pathname.split('/')[2] || 'default'
      return this.handleLocalUpgrade(request, clientId)
    }

    // WebSocket upgrade for MCP clients
    // Format: /mcp or /mcp/:clientId
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      const clientId = url.pathname.split('/')[2] || 'default'
      return this.handleMcpUpgrade(request, clientId)
    }

    return new Response('Not Found', { status: 404 })
  }

  /**
   * Handle WebSocket upgrade for extension
   */
  private handleExtensionUpgrade(request: Request): Response {
    // Check if extension is already connected - reject new connection
    const existingWs = this.getExtensionWebSocket()
    if (existingWs) {
      console.log('[Relay] Rejecting duplicate extension connection')
      return new Response('Extension already connected', { status: 409 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept with hibernation and tag
    this.ctx.acceptWebSocket(server, ['extension'] as WebSocketTag[])

    // Start ping interval to keep extension alive
    this.startPingInterval()

    console.log('[Relay] Extension connected')

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Handle WebSocket upgrade for MCP client
   */
  private handleMcpUpgrade(request: Request, clientId: string): Response {
    // Check if this client ID is already connected
    const existingWs = this.getMcpWebSocket(clientId)
    if (existingWs) {
      console.log(`[Relay] Rejecting duplicate MCP client: ${clientId}`)
      return new Response('Client ID already connected', { status: 409 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept with hibernation and tag
    this.ctx.acceptWebSocket(server, [`mcp:${clientId}`] as WebSocketTag[])

    console.log(`[Relay] MCP client connected: ${clientId}`)

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Handle WebSocket upgrade for local client
   */
  private handleLocalUpgrade(request: Request, clientId: string): Response {
    // Check if a local client is already connected (only one allowed)
    const existingWs = this.getLocalWebSocket()
    if (existingWs) {
      console.log(`[Relay] Rejecting duplicate local client: ${clientId}`)
      return new Response('Local client already connected', { status: 409 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept with hibernation and tag
    this.ctx.acceptWebSocket(server, [`local:${clientId}`] as WebSocketTag[])

    // Start ping interval to keep local client alive
    this.startPingInterval()

    console.log(`[Relay] Local client connected: ${clientId}`)

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Called when a WebSocket message is received (hibernation API)
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws)
    const messageStr = typeof message === 'string' ? message : new TextDecoder().decode(message)

    let data: unknown
    try {
      data = JSON.parse(messageStr)
    } catch {
      console.error('[Relay] Invalid JSON message')
      return
    }

    if (tags.includes('extension')) {
      await this.handleExtensionMessage(ws, data as ExtensionMessage)
    } else {
      // Check for local client tag
      const localTag = tags.find((t) => t.startsWith('local:'))
      if (localTag) {
        await this.handleLocalMessage(ws, data as LocalMessage)
        return
      }

      // Find MCP client ID from tag
      const mcpTag = tags.find((t) => t.startsWith('mcp:'))
      if (mcpTag) {
        const clientId = mcpTag.slice(4)
        await this.handleMcpMessage(ws, clientId, data as CDPCommand)
      }
    }
  }

  /**
   * Called when a WebSocket is closed (hibernation API)
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const tags = this.ctx.getTags(ws)

    if (tags.includes('extension')) {
      console.log(`[Relay] Extension disconnected: code=${code} reason=${reason}`)
      this.cleanupExtensionState()

      // Notify all MCP clients that extension disconnected
      for (const mcpWs of this.getMcpWebSockets()) {
        mcpWs.close(1000, 'Extension disconnected')
      }
    }

    // Check for local client
    const localTag = tags.find((t) => t.startsWith('local:'))
    if (localTag) {
      const clientId = localTag.slice(6)
      console.log(`[Relay] Local client disconnected: ${clientId} code=${code} reason=${reason}`)
      this.cleanupLocalState()
    }

    const mcpTag = tags.find((t) => t.startsWith('mcp:'))
    if (mcpTag) {
      const clientId = mcpTag.slice(4)
      console.log(`[Relay] MCP client disconnected: ${clientId}`)
    }

    // Stop ping if no extension or local client connected
    if (!this.getExtensionWebSocket() && !this.getLocalWebSocket()) {
      this.stopPingInterval()
    }
  }

  /**
   * Called when a WebSocket error occurs (hibernation API)
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[Relay] WebSocket error:', error)
  }

  /**
   * Handle message from extension
   */
  private async handleExtensionMessage(ws: WebSocket, message: ExtensionMessage): Promise<void> {
    // Response to a command we sent
    if ('id' in message && message.id !== undefined && !('method' in message && message.method)) {
      const pending = this.pendingRequests.get(message.id)
      if (pending) {
        this.pendingRequests.delete(message.id)
        if ('error' in message && message.error) {
          pending.reject(new Error(message.error))
        } else {
          pending.resolve(message.result)
        }
      }
      return
    }

    // Pong response - keep-alive
    if ('method' in message && message.method === 'pong') {
      return
    }

    // Log message from extension
    if ('method' in message && message.method === 'log') {
      const { level, args } = message.params
      console.log(`[Extension] [${level.toUpperCase()}]`, ...args)
      return
    }

    // CDP event from extension
    if ('method' in message && message.method === 'forwardCDPEvent') {
      const eventMessage = message as ExtensionEventMessage
      const { method, params, sessionId } = eventMessage.params

      // Handle target lifecycle events
      if (method === 'Target.attachedToTarget' && params) {
        const targetParams = params as {
          sessionId: string
          targetInfo: TargetInfo
          waitingForDebugger: boolean
        }
        this.connectedTargets.set(targetParams.sessionId, {
          sessionId: targetParams.sessionId,
          targetId: targetParams.targetInfo.targetId,
          targetInfo: targetParams.targetInfo,
        })
        console.log(`[Relay] Target attached: ${targetParams.sessionId}`)
      } else if (method === 'Target.detachedFromTarget' && params) {
        const detachParams = params as { sessionId: string }
        this.connectedTargets.delete(detachParams.sessionId)
        console.log(`[Relay] Target detached: ${detachParams.sessionId}`)
      } else if (method === 'Target.targetInfoChanged' && params) {
        const infoParams = params as { targetInfo: TargetInfo }
        for (const target of this.connectedTargets.values()) {
          if (target.targetId === infoParams.targetInfo.targetId) {
            target.targetInfo = infoParams.targetInfo
            break
          }
        }
      } else if (method === 'Page.frameNavigated' && sessionId && params) {
        const frameParams = params as { frame: { url: string; name?: string; parentId?: string } }
        if (!frameParams.frame.parentId) {
          const target = this.connectedTargets.get(sessionId)
          if (target) {
            target.targetInfo = {
              ...target.targetInfo,
              url: frameParams.frame.url,
              title: frameParams.frame.name || target.targetInfo.title,
            }
          }
        }
      }

      // Forward event to all MCP clients
      const cdpEvent: CDPEvent = { method, params, sessionId }
      this.broadcastToMcpClients(cdpEvent)
    }
  }

  /**
   * Handle message from local client
   */
  private async handleLocalMessage(ws: WebSocket, message: LocalMessage): Promise<void> {
    // Response to a command we sent
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const response = message as LocalResponse
      const pending = this.pendingLocalRequests.get(response.id)
      if (pending) {
        this.pendingLocalRequests.delete(response.id)
        if (response.error) {
          pending.reject(new Error(response.error))
        } else {
          pending.resolve(response.result)
        }
      }
      return
    }

    // Pong response - keep-alive
    if ('method' in message && message.method === 'pong') {
      return
    }

    // Log message from local client
    if ('method' in message && message.method === 'log') {
      const { level, args } = message.params
      console.log(`[Local] [${level.toUpperCase()}]`, ...args)
      return
    }
  }

  /**
   * Handle message from MCP client
   */
  private async handleMcpMessage(ws: WebSocket, clientId: string, command: CDPCommand): Promise<void> {
    const { id, method, params, sessionId } = command

    const extensionWs = this.getExtensionWebSocket()
    if (!extensionWs) {
      const errorResponse: CDPResponse = {
        id,
        sessionId,
        error: { message: 'Extension not connected' },
      }
      ws.send(JSON.stringify(errorResponse))
      return
    }

    try {
      const result = await this.routeCdpCommand({ method, params, sessionId, clientId })

      // Send attachedToTarget events after setAutoAttach
      if (method === 'Target.setAutoAttach' && !sessionId) {
        for (const target of this.connectedTargets.values()) {
          const attachedPayload: CDPEvent = {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: target.sessionId,
              targetInfo: { ...target.targetInfo, attached: true },
              waitingForDebugger: false,
            },
          }
          ws.send(JSON.stringify(attachedPayload))
        }
      }

      // Send targetCreated events after setDiscoverTargets
      if (method === 'Target.setDiscoverTargets' && (params as { discover?: boolean })?.discover) {
        for (const target of this.connectedTargets.values()) {
          const targetCreatedPayload: CDPEvent = {
            method: 'Target.targetCreated',
            params: {
              targetInfo: { ...target.targetInfo, attached: true },
            },
          }
          ws.send(JSON.stringify(targetCreatedPayload))
        }
      }

      // Send attachedToTarget after attachToTarget
      if (method === 'Target.attachToTarget' && result && (result as { sessionId?: string }).sessionId) {
        const targetId = (params as { targetId?: string })?.targetId
        const target = Array.from(this.connectedTargets.values()).find((t) => t.targetId === targetId)
        if (target) {
          const attachedPayload: CDPEvent = {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: (result as { sessionId: string }).sessionId,
              targetInfo: { ...target.targetInfo, attached: true },
              waitingForDebugger: false,
            },
          }
          ws.send(JSON.stringify(attachedPayload))
        }
      }

      const response: CDPResponse = { id, sessionId, result }
      ws.send(JSON.stringify(response))
    } catch (e) {
      console.error('[Relay] Error handling CDP command:', method, e)
      const errorResponse: CDPResponse = {
        id,
        sessionId,
        error: { message: (e as Error).message },
      }
      ws.send(JSON.stringify(errorResponse))
    }
  }

  /**
   * Route CDP command - some are handled locally, others forwarded to extension
   */
  private async routeCdpCommand({
    method,
    params,
    sessionId,
    clientId,
  }: {
    method: string
    params?: Record<string, unknown>
    sessionId?: string
    clientId: string
  }): Promise<unknown> {
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Cloudflare-Relay',
          revision: '1.0.0',
          userAgent: 'Playwriter-Cloudflare-Relay/1.0.0',
          jsVersion: 'V8',
        }
      }

      case 'Browser.setDownloadBehavior': {
        return {}
      }

      case 'Target.setAutoAttach': {
        if (sessionId) {
          break
        }
        return {}
      }

      case 'Target.setDiscoverTargets': {
        return {}
      }

      case 'Target.attachToTarget': {
        const targetId = (params as { targetId?: string })?.targetId
        if (!targetId) {
          throw new Error('targetId is required for Target.attachToTarget')
        }
        for (const target of this.connectedTargets.values()) {
          if (target.targetId === targetId) {
            return { sessionId: target.sessionId }
          }
        }
        throw new Error(`Target ${targetId} not found in connected targets`)
      }

      case 'Target.getTargetInfo': {
        const targetId = (params as { targetId?: string })?.targetId
        if (targetId) {
          for (const target of this.connectedTargets.values()) {
            if (target.targetId === targetId) {
              return { targetInfo: target.targetInfo }
            }
          }
        }
        if (sessionId) {
          const target = this.connectedTargets.get(sessionId)
          if (target) {
            return { targetInfo: target.targetInfo }
          }
        }
        const firstTarget = Array.from(this.connectedTargets.values())[0]
        return { targetInfo: firstTarget?.targetInfo }
      }

      case 'Target.getTargets': {
        return {
          targetInfos: Array.from(this.connectedTargets.values()).map((t) => ({
            ...t.targetInfo,
            attached: true,
          })),
        }
      }

      case 'Target.detachFromTarget': {
        // Handle detach for child sessions (iframes, workers) locally
        // These are sessions that Playwright attached to via Target.setAutoAttach on a page session
        const detachSessionId = (params as { sessionId?: string })?.sessionId
        if (detachSessionId) {
          // Check if this is a child session (not a main tab session)
          const isMainTabSession = this.connectedTargets.has(detachSessionId)
          if (!isMainTabSession) {
            // Child session - just acknowledge the detach, extension tracks these internally
            console.log(`[Relay] Detaching child session: ${detachSessionId}`)
            return {}
          }
        }
        // For main tab sessions, forward to extension
        break
      }
    }

    // Forward to extension
    return await this.sendToExtension({ method, params, sessionId, clientId })
  }

  /**
   * Send a command to the extension and wait for response
   */
  private async sendToExtension({
    method,
    params,
    sessionId,
    clientId,
    timeout = 30000,
  }: {
    method: string
    params?: Record<string, unknown>
    sessionId?: string
    clientId: string
    timeout?: number
  }): Promise<unknown> {
    const extensionWs = this.getExtensionWebSocket()
    if (!extensionWs) {
      throw new Error('Extension not connected')
    }

    const id = ++this.messageId
    const message = {
      id,
      method: 'forwardCDPCommand',
      params: { method, params, sessionId },
    }

    extensionWs.send(JSON.stringify(message))

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Extension request timeout after ${timeout}ms: ${method}`))
      }, timeout)

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeoutId)
          reject(error)
        },
        mcpClientId: clientId,
      })
    })
  }

  /**
   * Broadcast a CDP event to all connected MCP clients
   */
  private broadcastToMcpClients(event: CDPEvent): void {
    const message = JSON.stringify(event)
    for (const ws of this.getMcpWebSockets()) {
      ws.send(message)
    }
  }

  /**
   * Get the extension WebSocket (if connected)
   */
  private getExtensionWebSocket(): WebSocket | null {
    const websockets = this.ctx.getWebSockets('extension' as WebSocketTag)
    return websockets[0] || null
  }

  /**
   * Get a specific MCP client WebSocket
   */
  private getMcpWebSocket(clientId: string): WebSocket | null {
    const websockets = this.ctx.getWebSockets(`mcp:${clientId}` as WebSocketTag)
    return websockets[0] || null
  }

  /**
   * Get all MCP client WebSockets
   */
  private getMcpWebSockets(): WebSocket[] {
    // Get all websockets and filter to MCP ones
    const allWs = this.ctx.getWebSockets()
    return allWs.filter((ws) => {
      const tags = this.ctx.getTags(ws)
      return tags.some((t) => t.startsWith('mcp:'))
    })
  }

  /**
   * Get the local client WebSocket (if connected)
   */
  private getLocalWebSocket(): WebSocket | null {
    const allWs = this.ctx.getWebSockets()
    for (const ws of allWs) {
      const tags = this.ctx.getTags(ws)
      if (tags.some((t) => t.startsWith('local:'))) {
        return ws
      }
    }
    return null
  }

  /**
   * Clean up state when extension disconnects
   */
  private cleanupExtensionState(): void {
    this.connectedTargets.clear()
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('Extension connection closed'))
    }
    this.pendingRequests.clear()
  }

  /**
   * Clean up state when local client disconnects
   */
  private cleanupLocalState(): void {
    this.fileReadTimestamps.clear()
    for (const pending of this.pendingLocalRequests.values()) {
      pending.reject(new Error('Local client connection closed'))
    }
    this.pendingLocalRequests.clear()
  }

  /**
   * Start ping interval to keep extension/local WebSocket alive
   */
  private startPingInterval(): void {
    this.stopPingInterval()
    this.pingInterval = setInterval(() => {
      const extensionWs = this.getExtensionWebSocket()
      if (extensionWs) {
        extensionWs.send(JSON.stringify({ method: 'ping' }))
      }
      const localWs = this.getLocalWebSocket()
      if (localWs) {
        localWs.send(JSON.stringify({ method: 'ping' }))
      }
    }, 5000)
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  // ============== Local Client Command Interface ==============

  /**
   * Send a command to the local client and wait for response
   */
  async sendToLocalClient(command: Omit<LocalCommand, 'id'>, timeout = 30000): Promise<unknown> {
    const localWs = this.getLocalWebSocket()
    if (!localWs) {
      throw new Error('Local client not connected')
    }

    const id = ++this.localMessageId
    const message: LocalCommand = { id, ...command } as LocalCommand

    localWs.send(JSON.stringify(message))

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingLocalRequests.delete(id)
        reject(new Error(`Local client request timeout after ${timeout}ms: ${command.method}`))
      }, timeout)

      this.pendingLocalRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeoutId)
          reject(error)
        },
      })
    })
  }

  /**
   * Read a file via local client - tracks mtime for write validation
   */
  async readFile(path: string): Promise<{ content: string; mtime: number }> {
    const result = (await this.sendToLocalClient({
      method: 'file.read',
      params: { path },
    })) as { content: string; mtime: number }

    // Track the mtime for write validation
    this.fileReadTimestamps.set(path, result.mtime)

    return result
  }

  /**
   * Write a file via local client - validates mtime hasn't changed since read
   */
  async writeFile(path: string, content: string): Promise<{ success: true; mtime: number }> {
    const lastReadMtime = this.fileReadTimestamps.get(path)

    // If we've never read this file, that's an error
    if (lastReadMtime === undefined) {
      throw new Error(
        `Cannot write to ${path}: file has not been read yet. Read the file first to ensure you have the latest content.`,
      )
    }

    const result = (await this.sendToLocalClient({
      method: 'file.write',
      params: { path, content, expectedMtime: lastReadMtime },
    })) as { success: true; mtime: number }

    // Update our tracked mtime to the new value
    this.fileReadTimestamps.set(path, result.mtime)

    return result
  }

  /**
   * Execute a bash command via local client
   */
  async executeBash(
    command: string,
    options?: { workdir?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = (await this.sendToLocalClient(
      {
        method: 'bash.execute',
        params: { command, workdir: options?.workdir, timeout: options?.timeout },
      },
      options?.timeout ? options.timeout + 5000 : 30000,
    )) as { stdout: string; stderr: string; exitCode: number }

    return result
  }
}
