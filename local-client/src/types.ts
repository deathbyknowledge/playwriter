// Commands received from relay
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
  expectedMtime?: number
}

export interface LocalBashParams {
  command: string
  workdir?: string
  timeout?: number
}

// Responses sent to relay
export interface LocalResponse {
  id: number
  result?: LocalReadResult | LocalWriteResult | LocalBashResult
  error?: string
}

export interface LocalReadResult {
  content: string
  mtime: number
}

export interface LocalWriteResult {
  success: true
  mtime: number
}

export interface LocalBashResult {
  stdout: string
  stderr: string
  exitCode: number
}

// Messages from relay
export interface PingMessage {
  method: 'ping'
}

export type RelayMessage = LocalCommand | PingMessage
