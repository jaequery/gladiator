/** Static client files served by the same Node edge that upgrades WebSockets. */
import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ktx2': 'image/ktx2',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
}

/**
 * Serve one Vite output, returning whether this request belonged to it.
 *
 * Only files that exist below `root` are answered. The URL is decoded before
 * resolving and the resolved path is checked again, so encoded `..` segments
 * cannot turn the public directory into a filesystem browser.
 */
export function serveClient(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false

  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://gladiator.invalid').pathname)
  } catch {
    return false
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const absoluteRoot = resolve(root)
  const file = resolve(absoluteRoot, relative)
  if (file !== absoluteRoot && !file.startsWith(`${absoluteRoot}${sep}`)) return false

  let size: number
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return false
    size = stat.size
  } catch {
    return false
  }

  const cache = relative === 'index.html'
    ? 'no-cache'
    : relative.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600'
  response.writeHead(200, {
    'cache-control': cache,
    'content-length': size,
    'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
  })
  if (request.method === 'HEAD') response.end()
  else createReadStream(file).pipe(response)
  return true
}
