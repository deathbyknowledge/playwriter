import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import type {
  LocalCommand,
  LocalResponse,
  LocalReadParams,
  LocalWriteParams,
  LocalBashParams,
  LocalReadResult,
  LocalWriteResult,
  LocalBashResult,
  RelayMessage,
} from './types.js'

export interface LocalClientOptions {
  relayUrl: string // e.g., "https://relay.example.com/room/my-room"
  passphrase: string
  clientId?: string
  onConnect?: () => void
  onDisconnect?: (reason: string) => void
  onError?: (error: Error) => void
  onLog?: (level: string, message: string) => void
}

export class LocalClient {
  private ws: WebSocket | null = null
  private options: LocalClientOptions
  private reconnectTimeout: NodeJS.Timeout | null = null
  private shouldReconnect = true
  private pingInterval: NodeJS.Timeout | null = null
  private pongReceived = true

  constructor(options: LocalClientOptions) {
    this.options = options
  }

  private startPingInterval() {
    this.stopPingInterval()
    this.pongReceived = true

    // Send WebSocket-level ping every 30 seconds
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return
      }

      // Check if we received a pong since last ping
      if (!this.pongReceived) {
        this.log('warn', 'No pong received, connection appears dead')
        this.ws.terminate() // Force close, will trigger reconnect
        return
      }

      this.pongReceived = false
      this.ws.ping()
    }, 30000)
  }

  private stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private log(level: string, message: string) {
    if (this.options.onLog) {
      this.options.onLog(level, message)
    } else {
      const timestamp = new Date().toISOString()
      console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`)
    }
  }

  async connect(): Promise<void> {
    if (this.ws) {
      this.log('warn', 'Already connected')
      return
    }

    const clientId = this.options.clientId || 'default'

    // Build WebSocket URL
    let wsUrl = this.options.relayUrl
    if (wsUrl.startsWith('https://')) {
      wsUrl = 'wss://' + wsUrl.slice(8)
    } else if (wsUrl.startsWith('http://')) {
      wsUrl = 'ws://' + wsUrl.slice(7)
    } else if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      wsUrl = 'wss://' + wsUrl
    }

    // Append /local path and client ID
    wsUrl = wsUrl.replace(/\/$/, '')
    wsUrl += `/local/${clientId}?passphrase=${encodeURIComponent(this.options.passphrase)}`

    this.log('info', `Connecting to ${wsUrl.replace(/passphrase=[^&]+/, 'passphrase=***')}`)

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl)

      this.ws.on('open', () => {
        this.log('info', 'Connected to relay')
        this.startPingInterval()
        this.options.onConnect?.()
        resolve()
      })

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString())
      })

      this.ws.on('pong', () => {
        this.pongReceived = true
      })

      this.ws.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || 'unknown'
        this.log('warn', `Disconnected: code=${code} reason=${reasonStr}`)
        this.stopPingInterval()
        this.ws = null
        this.options.onDisconnect?.(reasonStr)

        if (this.shouldReconnect) {
          this.scheduleReconnect()
        }
      })

      this.ws.on('error', (error) => {
        this.log('error', `WebSocket error: ${error.message}`)
        this.options.onError?.(error)
        reject(error)
      })
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) {
      return
    }

    this.log('info', 'Reconnecting in 3 seconds...')
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.connect().catch((err) => {
        this.log('error', `Reconnect failed: ${err.message}`)
      })
    }, 3000)
  }

  disconnect() {
    this.shouldReconnect = false
    this.stopPingInterval()
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }
  }

  private send(message: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  private async handleMessage(data: string) {
    let message: RelayMessage
    try {
      message = JSON.parse(data)
    } catch {
      this.log('error', 'Invalid JSON message received')
      return
    }

    // Handle ping
    if ('method' in message && message.method === 'ping') {
      this.send({ method: 'pong' })
      return
    }

    // Handle commands
    if ('id' in message && 'method' in message) {
      const command = message as LocalCommand
      await this.handleCommand(command)
    }
  }

  private async handleCommand(command: LocalCommand) {
    const response: LocalResponse = { id: command.id }

    try {
      switch (command.method) {
        case 'file.read':
          response.result = await this.handleFileRead(command.params as LocalReadParams)
          break
        case 'file.write':
          response.result = await this.handleFileWrite(command.params as LocalWriteParams)
          break
        case 'bash.execute':
          response.result = await this.handleBashExecute(command.params as LocalBashParams)
          break
        default:
          response.error = `Unknown method: ${command.method}`
      }
    } catch (error: unknown) {
      response.error = error instanceof Error ? error.message : String(error)
    }

    this.send(response)
  }

  private async handleFileRead(params: LocalReadParams): Promise<LocalReadResult> {
    const absolutePath = path.resolve(params.path)
    this.log('debug', `Reading file: ${absolutePath}`)

    const stat = await fs.promises.stat(absolutePath)
    const content = await fs.promises.readFile(absolutePath, 'utf-8')

    return {
      content,
      mtime: stat.mtimeMs,
    }
  }

  private async handleFileWrite(params: LocalWriteParams): Promise<LocalWriteResult> {
    const absolutePath = path.resolve(params.path)
    this.log('debug', `Writing file: ${absolutePath}`)

    // Check if file exists and validate mtime
    if (params.expectedMtime !== undefined) {
      try {
        const stat = await fs.promises.stat(absolutePath)
        if (Math.abs(stat.mtimeMs - params.expectedMtime) > 1) {
          // Allow 1ms tolerance
          throw new Error(
            `File has been modified since last read. Expected mtime ${params.expectedMtime}, got ${stat.mtimeMs}. Please read the file again to get the latest content.`,
          )
        }
      } catch (error: unknown) {
        // If file doesn't exist, that's fine for a new file
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }

    // Ensure directory exists
    const dir = path.dirname(absolutePath)
    await fs.promises.mkdir(dir, { recursive: true })

    // Write file
    await fs.promises.writeFile(absolutePath, params.content, 'utf-8')

    // Get new mtime
    const stat = await fs.promises.stat(absolutePath)

    return {
      success: true,
      mtime: stat.mtimeMs,
    }
  }

  private async handleBashExecute(params: LocalBashParams): Promise<LocalBashResult> {
    const workdir = params.workdir || process.env.HOME || '/'
    const timeout = params.timeout || 30000

    this.log('debug', `Executing: ${params.command} in ${workdir}`)

    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', params.command], {
        cwd: workdir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let killed = false

      const timeoutId = setTimeout(() => {
        killed = true
        child.kill('SIGKILL')
      }, timeout)

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        clearTimeout(timeoutId)

        if (killed) {
          resolve({
            stdout,
            stderr: stderr + `\n[Process killed after ${timeout}ms timeout]`,
            exitCode: 124, // Standard timeout exit code
          })
        } else {
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 1,
          })
        }
      })

      child.on('error', (error) => {
        clearTimeout(timeoutId)
        resolve({
          stdout: '',
          stderr: error.message,
          exitCode: 1,
        })
      })
    })
  }
}
