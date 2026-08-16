/**
 * Single-player is a duel — the epic's acceptance check, executed.
 *
 * `listenServer.test.ts` proves the host in this tab is the host on Fly. This
 * proves there is somebody in the other chair: that the bot takes the second
 * seat through the same handshake a stranger would, that it moves, that it aims
 * and fires **both** weapons, and that it can put damage on a human who is not
 * fighting back.
 *
 * The human here stands still and does nothing. That is deliberate and it is
 * the strongest form of the assertion: every shot that lands, every unit of
 * distance covered and every weapon switch in this test is the bot's own doing,
 * so none of it can be an artifact of a script that happened to walk into a
 * rocket.
 */
import {
  EntityKind,
  NULL_CMD,
  SKELETON_SEED,
  Weapon,
  createMapState,
  findPlayer,
  hashState,
  tick as simTick,
  type GameState,
} from '@gladiator/sim'
import { manualClock } from '@gladiator/server/clock'
import { settleLoopback } from '@gladiator/server/net/loopbackTransport'
import { describe, expect, it } from 'vitest'

import { CLIENT_MAP, CLIENT_MAP_HASH } from '../map.ts'
import { CLIENT_NAV } from '../nav.ts'
import { createBotPeer, type BotPeer } from './botPeer.ts'
import { createNetClient } from './client.ts'
import { createListenServer } from './listenServer.ts'

/** The slot `main.ts` steers. The bot must not take it. */
const HUMAN_SLOT = 0

/** Sub-steps to play. 6000 is 48 seconds — several rounds of a duel. */
const TICKS = 6000

/**
 * A whole match, played with the human standing still.
 *
 * The frame loop is `listenServer.test.ts`'s, for the same reason it is written
 * out there: a test that batched differently would be testing a client nobody
 * ships. Both loopbacks are drained before anything is read, because the bot's
 * commands cross a pipe of their own.
 */
async function duel(): Promise<{
  readonly host: GameState
  readonly peer: BotPeer
  readonly moved: number
  readonly weapons: ReadonlySet<number>
  readonly fired: number
  readonly humanLow: number
}> {
  const clock = manualClock()
  let seated: BotPeer | null = null
  const listen = createListenServer({
    map: CLIENT_MAP,
    build: 'bot-peer-test',
    clock,
    opponent: (room) => {
      seated = createBotPeer({ room, map: CLIENT_MAP, nav: CLIENT_NAV, build: 'bot-peer-test' })
      return seated
    },
  })
  const peer = seated as BotPeer | null
  if (peer === null) throw new Error('the opponent factory was never called')

  const net = createNetClient({
    transport: listen.transport,
    endpoint: 'the host in this tab',
    build: 'bot-peer-test',
    mapHash: CLIENT_MAP_HASH,
    now: () => 0,
  })
  net.connect()
  await settleLoopback(listen.pair)

  const state = createMapState(CLIENT_MAP.source, SKELETON_SEED)
  let nowMs = 0
  listen.beat(nowMs)

  // What the bot did, sampled from the host's own world rather than from a
  // snapshot — this is the authoritative answer to "did it play".
  const weapons = new Set<number>()
  let moved = 0
  let fired = 0
  let humanLow = Number.POSITIVE_INFINITY
  let lastBotOrigin: readonly [number, number, number] | null = null
  let lastFireSeen = -1

  const settle = async (): Promise<void> => {
    await settleLoopback(listen.pair)
    await settleLoopback(peer.pair)
  }

  for (let t = 1; t <= TICKS; t += 1) {
    // The human: present, predicted, and completely passive.
    simTick(state, [NULL_CMD], CLIENT_MAP.world)
    net.record(state.tick, hashState(state))
    net.queue(state.tick, NULL_CMD)

    if (t % 2 === 0) {
      net.flush()
      await settle()
      nowMs += 16
      clock.set(nowMs)
      listen.beat(nowMs)
      await settle()

      const world = listen.room.state
      const bot = findPlayer(world, peer.slot)
      if (bot !== null) {
        weapons.add(bot.weapon)
        if (bot.lastFireTick > lastFireSeen) {
          lastFireSeen = bot.lastFireTick
          fired += 1
        }
        const here: readonly [number, number, number] = [
          bot.origin[0],
          bot.origin[1],
          bot.origin[2],
        ]
        if (lastBotOrigin !== null) {
          const dx = here[0] - lastBotOrigin[0]
          const dy = here[1] - lastBotOrigin[1]
          const dz = here[2] - lastBotOrigin[2]
          moved += Math.sqrt(dx * dx + dy * dy + dz * dz)
        }
        lastBotOrigin = here
      }
      const human = findPlayer(world, HUMAN_SLOT)
      // The low-water mark rather than the final reading: a round ends by
      // respawning both bodies at full health, so the damage the bot did is
      // only visible while the round it did it in is still running.
      if (human !== null) humanLow = Math.min(humanLow, human.health + human.armor)
    }
  }

  listen.stop()
  return { host: listen.room.state, peer, moved, weapons, fired, humanLow }
}

describe('the bot in the second seat', () => {
  it('joins as a peer, plays a duel, and uses both weapons', async () => {
    const { host, peer, moved, weapons, fired, humanLow } = await duel()

    // Seated, and not in the seat `main.ts` steers.
    expect(peer.slot).toBeGreaterThanOrEqual(0)
    expect(peer.slot).not.toBe(HUMAN_SLOT)

    // The host accepted its commands: a peer that was refused, or one whose
    // labels were all rejected as late, offers commands and lands none.
    expect(peer.offered).toBeGreaterThan(TICKS / 2)

    // Two bodies in the world, which is what makes it a duel rather than a
    // player alone in a room.
    const players = host.entities.filter((entity) => entity.kind === EntityKind.Player)
    expect(players).toHaveLength(2)

    // It moved. 48 seconds of a bot that never left its spawn would be a nav
    // graph that failed to load, and it would still have passed every
    // assertion above.
    expect(moved).toBeGreaterThan(1000)

    // It aimed and pulled the trigger, repeatedly.
    expect(fired).toBeGreaterThan(5)

    // Both weapons, which is the acceptance check in as many words. The rocket
    // launcher is what it spawns holding; the railgun it has to choose.
    expect(weapons.has(Weapon.RocketLauncher)).toBe(true)
    expect(weapons.has(Weapon.Railgun)).toBe(true)

    // And it hit something. The human never moved and never fired, so every
    // point of this came off the bot's aim.
    expect(humanLow).toBeLessThan(200)
  })
})
