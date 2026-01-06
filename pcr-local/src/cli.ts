#!/usr/bin/env node

import { LocalClient } from './index.js'

const usage = `
Usage: pcr-local <relay-url> <passphrase>

Example:
  pcr-local https://pcr.example.com/room/my-room my-secret-passphrase

Environment variables:
  PCR_RELAY_URL    - Default relay URL
  PCR_PASSPHRASE   - Default passphrase

The local client connects to the Personal Compute Relay and exposes your
machine's filesystem and shell to cloud AI agents via the MCP protocol.
`

async function main() {
  const relayUrl = process.argv[2] || process.env.PCR_RELAY_URL
  const passphrase = process.argv[3] || process.env.PCR_PASSPHRASE

  if (!relayUrl || !passphrase) {
    console.error(usage)
    process.exit(1)
  }

  console.log('Personal Compute Relay - Local Client')
  console.log('=====================================')
  console.log(`Relay URL: ${relayUrl}`)
  console.log('')

  const client = new LocalClient({
    relayUrl,
    passphrase,
    onConnect: () => {
      console.log('Connected! Your machine is now available to cloud agents.')
      console.log('Press Ctrl+C to disconnect.')
    },
    onDisconnect: (reason) => {
      console.log(`Disconnected: ${reason}`)
    },
    onError: (error) => {
      console.error(`Error: ${error.message}`)
    },
    onLog: (level, message) => {
      const timestamp = new Date().toISOString().slice(11, 23)
      console.log(`[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}`)
    },
  })

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nDisconnecting...')
    client.disconnect()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    client.disconnect()
    process.exit(0)
  })

  try {
    await client.connect()
  } catch (error: unknown) {
    console.error(`Failed to connect: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

main()
