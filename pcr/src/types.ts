// Import the class for type reference
import type { RebrowRelay } from './relay.js'
import type { Sandbox } from '@cloudflare/sandbox'

// Environment bindings
export interface Env {
  RELAY: DurableObjectNamespace<RebrowRelay>
  // Sandbox binding must be named 'Sandbox' for proxyToSandbox to work
  Sandbox: DurableObjectNamespace<Sandbox>
}

// CDP types (simplified from playwriter/src/cdp-types.ts)
export interface CDPCommand {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface CDPResponse {
  id: number
  result?: unknown
  error?: { message: string; code?: number }
  sessionId?: string
}

export interface CDPEvent {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

// Target info from CDP
export interface TargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  attached?: boolean
  browserContextId?: string
}

// Connected target tracking
export interface ConnectedTarget {
  sessionId: string
  targetId: string
  targetInfo: TargetInfo
}

// Messages from extension to relay
export interface ExtensionCommandMessage {
  id: number
  method: 'forwardCDPCommand'
  params: {
    method: string
    sessionId?: string
    params?: Record<string, unknown>
  }
}

export interface ExtensionResponseMessage {
  id: number
  result?: unknown
  error?: string
}

export interface ExtensionEventMessage {
  method: 'forwardCDPEvent'
  params: {
    method: string
    sessionId?: string
    params?: Record<string, unknown>
  }
}

export interface ExtensionLogMessage {
  method: 'log'
  params: {
    level: 'log' | 'debug' | 'info' | 'warn' | 'error'
    args: string[]
  }
}

export interface ExtensionPongMessage {
  method: 'pong'
}

export type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionEventMessage
  | ExtensionLogMessage
  | ExtensionPongMessage

// Messages from relay to extension
export interface ServerPingMessage {
  method: 'ping'
}

export interface ServerCommandMessage {
  id: number
  method: string
  params?: Record<string, unknown>
}

// WebSocket tags for hibernation
export type WebSocketTag = 'extension' | `mcp:${string}` | `local:${string}`

// Room state stored in DO
export interface RoomState {
  connectedTargets: Map<string, ConnectedTarget>
}

// ============== Local Client Types ==============

// Commands sent from relay to local client
export interface LocalCommand {
  id: number
  method: 'file.read' | 'file.write' | 'bash.execute'
  params: LocalReadParams | LocalWriteParams | LocalBashParams
}

export interface LocalReadParams {
  path: string
}

export interface LocalWriteParams {
  path: string
  content: string
  expectedMtime?: number // Used for optimistic concurrency - write fails if file was modified
}

export interface LocalBashParams {
  command: string
  workdir?: string
  timeout?: number
}

// Response from local client to relay
export interface LocalResponse {
  id: number
  result?: LocalReadResult | LocalWriteResult | LocalBashResult
  error?: string
}

export interface LocalReadResult {
  content: string
  mtime: number // Unix timestamp ms - used for write validation
}

export interface LocalWriteResult {
  success: true
  mtime: number // New mtime after write
}

export interface LocalBashResult {
  stdout: string
  stderr: string
  exitCode: number
}

// Messages from local client
export interface LocalPongMessage {
  method: 'pong'
}

export interface LocalLogMessage {
  method: 'log'
  params: {
    level: 'log' | 'debug' | 'info' | 'warn' | 'error'
    args: string[]
  }
}

export type LocalMessage = LocalResponse | LocalPongMessage | LocalLogMessage

// ============== Auth Types ==============

// Stored in DO for passphrase validation
export interface RoomAuth {
  passphraseHash: string // SHA-256 hash of passphrase
  createdAt: number
}
