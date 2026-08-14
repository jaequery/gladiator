import { quakeToEngine } from '@gladiator/sim'
import type { WebSocketServer } from 'ws'

import { DEFAULT_PORT } from './config.ts'

/**
 * Scaffold entry point. It exists so that `pnpm build` genuinely exercises the
 * server bundler against the source-only `@gladiator/sim` package, and so the
 * `.ts`-extension convention has somewhere to be demonstrated.
 *
 * The tick scheduler, WebSocket server and room registry are GLAD-FHKBN8.
 */
export type ServerHandle = {
  readonly port: number
  readonly wss: WebSocketServer
}

export function describeScaffold(): string {
  const forward = quakeToEngine([1, 0, 0])
  return `gladiator server scaffold — port ${DEFAULT_PORT}, quake forward -> [${forward.join(', ')}]`
}

if (process.env['GLADIATOR_SCAFFOLD_ECHO'] === '1') {
  console.log(describeScaffold())
}
