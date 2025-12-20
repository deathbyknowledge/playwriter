import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function getCdpUrl({ port = 19988, host = '127.0.0.1' }: { port?: number; host?: string } = {}) {
  const id = `${Math.random().toString(36).substring(2, 15)}_${Date.now()}`
  return `ws://${host}:${port}/cdp/${id}`
}

function getLogFilePath(): string {
  if (process.env.PLAYWRITER_LOG_PATH) {
    return process.env.PLAYWRITER_LOG_PATH
  }
  const logsDir = path.join(os.tmpdir(), 'playwriter')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(logsDir, `relay-server-${timestamp}.log`)
}

export const LOG_FILE_PATH = getLogFilePath()
