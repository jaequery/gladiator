/**
 * Demos on disk. The Node edge around `sim/src/demo.ts`.
 *
 * The split is the same one `net/wsTransport.ts` makes and for the same reason:
 * the host that produces a demo runs in a browser tab as well as on Fly, so it
 * produces a *value* and this file — which nothing on that side of the line may
 * import — is what turns the value into a file.
 *
 * ## Why a server writes demos at all
 *
 * "I got yanked backwards" is unactionable. The same sentence with a room code
 * beside it, and a file on disk holding the exact command stream that room
 * executed, is a bug you can re-run until you have seen it. Capture is off
 * unless `GLADIATOR_DEMO_DIR` is set, because a machine holding two hundred
 * rooms should not be holding two hundred growing arrays and writing two hundred
 * files unless somebody asked it to.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { decodeDemo, encodeDemo, type Demo } from '@gladiator/sim'

/**
 * A file name for a demo: when, then which room.
 *
 * Time first so an `ls` is in order, and a room code after it because room
 * codes are unique among *live* rooms and recycle freely once a room is gone —
 * a name that was only the code would overwrite last week's recording of a
 * different match.
 *
 * The colons and the dot in an ISO timestamp are replaced: both are legal on
 * every filesystem this runs on and neither survives being pasted into a shell
 * without quoting, and a debugging artifact that needs quoting is one people
 * stop using.
 */
export function demoFileName(demo: Demo, atMs: number): string {
  const stamp = new Date(atMs).toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${demo.header.room}.demo.json`
}

/**
 * Write a demo into `dir`, creating the directory if it is not there.
 *
 * Returns the path written. Synchronous on purpose: the one caller is a room
 * being closed, and a promise there would be a promise nothing awaits during a
 * SIGTERM drain.
 */
export function writeDemoFile(dir: string, demo: Demo, atMs: number): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, demoFileName(demo, atMs))
  writeFileSync(path, encodeDemo(demo), 'utf8')
  return path
}

/** Read a demo back. Throws with a sentence for anything that is not one. */
export function readDemoFile(path: string): Demo {
  return decodeDemo(readFileSync(path, 'utf8'))
}
