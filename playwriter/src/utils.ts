export function getCdpUrl({ port = 19988, host = '127.0.0.1' }: { port?: number; host?: string } = {}) {
  const id = `${Math.random().toString(36).substring(2, 15)}_${Date.now()}`
  return `ws://${host}:${port}/cdp/${id}`
}
