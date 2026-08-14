import { quakeToEngine } from '@gladiator/sim'
import type { Vec3 } from '@gladiator/sim'

/**
 * Placeholder so the package has a resolvable entry point and the workspace
 * link is exercised by `pnpm typecheck`. The bot itself lands in GLAD-V7CMHR
 * (perception), GLAD-TSED8V (movement) and GLAD-HK3ATM (combat).
 */
export function debugAxisMap(q: Vec3): Vec3 {
  return quakeToEngine(q)
}
