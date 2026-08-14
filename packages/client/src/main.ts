import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { QUAKE_TO_ENGINE, determinant3, quakeToEngine } from '@gladiator/sim'

/**
 * Scaffold entry point. It exists to prove three things at build time, not to
 * be a game:
 *
 *   1. `@gladiator/sim` resolves from here as source, through its `exports` map
 *   2. Babylon resolves from here (and, by construction, nowhere near the sim)
 *   3. the two agree about which way is up
 *
 * The walking skeleton — pointer lock, a box on a plane — is GLAD-5W28TP.
 */
const forward = quakeToEngine([1, 0, 0])
const engineForward = new Vector3(forward[0], forward[1], forward[2])

const app = document.querySelector('#app')
if (app) {
  app.textContent =
    `gladiator scaffold — det(QUAKE_TO_ENGINE) = ${determinant3(QUAKE_TO_ENGINE)}, ` +
    `quake forward = ${engineForward.toString()}`
}
