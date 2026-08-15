/**
 * Two players, one room, one code — over two real sockets to a real server.
 *
 * This is the ticket's headline acceptance check and it is deliberately end to
 * end. One client opens a match and is told a six-character code; the other
 * types that code the way a person types it — lower case, with the hyphen a
 * chat client helpfully inserted — and lands in the same world. The server's
 * own tick scheduler advances it, both peers' commands are drained one per
 * sub-step from their own jitter buffers, and a round is played to a decision
 * and out the other side into the next one.
 *
 * ## Virtual time, real everything else
 *
 * The clock and the tick timer are this file's, so a two-second round costs CI
 * two seconds of *arithmetic* rather than two seconds of waiting — and the
 * scheduler being driven is the shipping one, folding the shipping accumulator
 * against a clock it cannot tell from `performance.now()`. Everything else is
 * real: `ws` on a real port, the origin check, the handshake, the framing, the
 * codec, the registry, the room.
 *
 * ## Why the round ends the way it does
 *
 * Neither player can reach the other in two seconds on a map whose spawns are
 * chosen to be far apart and mutually blind — that is the spawn system doing
 * its job (`sim/src/match/spawn.ts`). So the round is decided the other way the
 * rules allow: on the clock, by damage taken. One player rocket-jumps into the
 * floor and spends armour doing it (`armor_only` is the default self-damage
 * mode), the other stands still, and the one who spent nothing wins. That is a
 * *decided* round with a named winner rather than a draw, which is what makes
 * the score assertion mean something.
 */
import {
  BUTTON_ATTACK,
  DEFAULT_MATCH_RULES,
  MAX_PITCH_UNITS,
  MatchPhase,
  NULL_CMD,
  PROTOCOL_VERSION,
  TICK_RATE,
  Weapon,
  applyWireState,
  createMapState,
  encodeCmd,
  hashState,
  parseServerMessage,
  type GameState,
  type ServerMessage,
  type UserCmd,
} from '@gladiator/sim'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { manualClock, type ManualClock } from './clock.ts'
import { readConfig } from './config.ts'
import { SERVER_MAP, SERVER_MAP_HASH } from './map.ts'
import { ROOM_CODE_ALPHABET } from './roomCode.ts'
import { manualTimer } from './scheduler.ts'
import { startServer, type GladiatorServer } from './server.ts'

const ALLOWED_ORIGIN = 'http://localhost:5173'

/** The code the registry mints in this file. Fixed, so a test can name it. */
const DUEL_ROOM = 'H7K2Q9'

/**
 * A round short enough to watch and long enough to be a round.
 *
 * Two seconds of play and half a second of intermission. The rules are hashed
 * (`sim/src/match/match.ts`), so both peers are handed them at construction and
 * neither has to be told about them separately — which is the point of them
 * being in `GameState` at all.
 */
const QUICK_RULES = {
  ...DEFAULT_MATCH_RULES,
  roundTimeLimitTicks: 2 * TICK_RATE,
  intermissionTicks: Math.round(0.5 * TICK_RATE),
}

/** Milliseconds a client frame is worth. 60 Hz, as a browser gives you. */
const FRAME_MS = 16

let running: GladiatorServer | null = null

afterEach(async () => {
  await running?.close()
  running = null
})

/** A code source that always mints {@link DUEL_ROOM}. `roomCode.ts`. */
function fixedCode(code: string): () => number {
  let at = 0
  return () => {
    const symbol = code[at % code.length] ?? '0'
    at += 1
    return ROOM_CODE_ALPHABET.indexOf(symbol)
  }
}

/** Spin the event loop until `check` gives an answer, or give up loudly. */
async function waitFor<T>(check: () => T | null, what: string): Promise<T> {
  for (let attempt = 0; attempt < 500_000; attempt += 1) {
    const answer = check()
    if (answer !== null) return answer
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`gave up waiting for ${what}`)
}

/**
 * One headless player: a socket, everything it has been told, and a command
 * counter of its own.
 *
 * The tick labels are the player's own and start at one, which is the whole of
 * what `ServerSnapshot.ack` is in: how much of *this* peer's input the world
 * has executed, which is a different question from how far the world has been
 * advanced. Two players in one room have two of these counters and one world.
 */
type Player = {
  readonly socket: WebSocket
  readonly heard: ServerMessage[]
  /** The world this player last adopted, decoded from a snapshot. */
  readonly world: GameState
  send(cmds: readonly UserCmd[]): void
  /** Commands sent, which is also the last tick label used. */
  readonly sent: number
  welcome(): ServerMessage
  close(): void
}

function connect(port: number, room?: string): Player {
  const query = room === undefined ? '' : `?room=${encodeURIComponent(room)}`
  const socket = new WebSocket(`ws://127.0.0.1:${port}${query}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  })
  const heard: ServerMessage[] = []
  const world = createMapState(SERVER_MAP.source, 1)
  let sent = 0

  socket.on('message', (data) => {
    const parsed = parseServerMessage(String(data))
    if (parsed === null) throw new Error(`unparseable frame: ${String(data)}`)
    heard.push(parsed)
    if (parsed.t === 'ping') socket.send(JSON.stringify({ t: 'pong', id: parsed.id }))
    // Adopted rather than counted: a client that only counted snapshots would
    // pass this whole file while sending a state nobody could rebuild.
    if (parsed.t === 'snap' && !applyWireState(world, parsed.state)) {
      throw new Error('the server sent a snapshot this build cannot read')
    }
  })

  return {
    socket,
    heard,
    world,
    send(cmds) {
      const startTick = sent + 1
      sent += cmds.length
      socket.send(JSON.stringify({ t: 'cmds', startTick, cmds: cmds.map(encodeCmd) }))
    },
    get sent() {
      return sent
    },
    welcome() {
      const frame = heard.find((entry) => entry.t === 'welcome')
      if (frame === undefined) throw new Error('no welcome')
      return frame
    },
    close: () => socket.close(),
  }
}

async function start(): Promise<{ server: GladiatorServer; clock: ManualClock }> {
  const clock = manualClock()
  running = await startServer({
    config: { ...readConfig({}), port: 0, allowedOrigins: [ALLOWED_ORIGIN] },
    clock,
    timer: manualTimer(),
    random: fixedCode(DUEL_ROOM),
    rules: QUICK_RULES,
    log: () => undefined,
  })
  return { server: running, clock }
}

const HELLO = JSON.stringify({
  t: 'hello',
  protocol: PROTOCOL_VERSION,
  build: 'duel',
  mapHash: SERVER_MAP_HASH,
})

/** Standing still, looking where you were looking. */
const IDLE: UserCmd = { ...NULL_CMD, weapon: Weapon.RocketLauncher }

/**
 * Firing a rocket at your own feet.
 *
 * Pitch is in angle units and {@link MAX_PITCH_UNITS} is as far down as a view
 * may look. Both weapons are fully automatic, so the button is simply held and
 * the refire interval is the only thing between shots. In `armor_only` the
 * splash costs armour and never health, so a player can do this all round and
 * lose it on damage taken without ever being in danger of dying — which is
 * exactly the decided outcome this file wants.
 */
const ROCKET_AT_FEET: UserCmd = {
  ...NULL_CMD,
  pitch: MAX_PITCH_UNITS,
  buttons: BUTTON_ATTACK,
  weapon: Weapon.RocketLauncher,
}

describe('two headless clients, one room code', () => {
  it(
    'join by code, start a match, and play a round to a decision',
    { timeout: 120_000 },
    async () => {
      const { server, clock } = await start()

      // The host opens a match and is told the code to send their friend.
      const host = connect(server.port)
      await new Promise((resolve) => host.socket.once('open', resolve))
      host.socket.send(HELLO)
      const hostWelcome = await waitFor(
        () => host.heard.find((frame) => frame.t === 'welcome') ?? null,
        "the host's welcome",
      )
      if (hostWelcome.t !== 'welcome') throw new Error('unreachable')
      expect(hostWelcome.room).toBe(DUEL_ROOM)

      // The friend types it the way a person types it.
      const typed = `${hostWelcome.room.slice(0, 3)}-${hostWelcome.room.slice(3)}`.toLowerCase()
      const guest = connect(server.port, typed)
      await new Promise((resolve) => guest.socket.once('open', resolve))
      guest.socket.send(HELLO)
      const guestWelcome = await waitFor(
        () => guest.heard.find((frame) => frame.t === 'welcome') ?? null,
        "the guest's welcome",
      )
      if (guestWelcome.t !== 'welcome') throw new Error('unreachable')

      // One room, one world, two seats.
      expect(guestWelcome.room).toBe(hostWelcome.room)
      expect(guestWelcome.session).not.toBe(hostWelcome.session)
      expect(server.rooms.size).toBe(1)
      const room = server.rooms.get(DUEL_ROOM)?.room
      if (room === undefined) throw new Error('the registry lost the room')
      expect(room.peers.map((peer) => peer.slot)).toEqual([0, 1])

      // Nothing has started: the world is in warmup until the scheduler runs a
      // frame with both seats filled, which is the room's edge to take.
      expect(room.state.match.phase).toBe(MatchPhase.Warmup)

      /** One 60 Hz frame: both players send, then the host's clock moves. */
      const playFrame = async (hostCmd: UserCmd, guestCmd: UserCmd): Promise<void> => {
        // Two commands a frame, which is what 60 Hz buys at a 125 Hz tick rate
        // — and exactly what a 16 ms frame is worth on the far side, so the
        // buffers stay at their target depth and neither peer starves.
        host.send([hostCmd, hostCmd])
        guest.send([guestCmd, guestCmd])
        const wanted = host.sent
        await waitFor(
          () =>
            (room.peers[0]?.session.commands ?? 0) >= wanted &&
            (room.peers[1]?.session.commands ?? 0) >= wanted
              ? true
              : null,
          `${wanted} commands from both peers`,
        )
        clock.advance(FRAME_MS)
        expect(server.scheduler.frame().steps).toBe(2)
      }

      // The match starts on the first frame with both seats filled.
      await playFrame(IDLE, IDLE)
      expect(room.state.match.phase).toBe(MatchPhase.Live)
      expect(room.state.match.round).toBe(1)

      // Play the round out. The host burns armour on the floor; the guest does
      // nothing, which on the clock is the winning move.
      const roundFrames = Math.ceil(QUICK_RULES.roundTimeLimitTicks / 2) + 4
      for (let frame = 0; frame < roundFrames; frame += 1) {
        await playFrame(ROCKET_AT_FEET, IDLE)
        if (room.state.match.phase !== MatchPhase.Live) break
      }

      // A round, decided, with a winner — and the score to go with it.
      expect(room.state.match.phase).toBe(MatchPhase.Intermission)
      expect(room.state.match.lastRoundWinner).toBe(1)
      expect(room.state.match.wins).toEqual([0, 1])

      // The host really did spend armour on the floor, which is why they lost.
      const hostBody = room.state.entities.find((entity) => entity.slot === 0)
      const guestBody = room.state.entities.find((entity) => entity.slot === 1)
      expect(hostBody?.armor ?? 100).toBeLessThan(guestBody?.armor ?? 0)

      // And out the other side into round two, with both players stood up
      // again — which is the half of "a full round" that a round ending does
      // not by itself prove.
      const intermissionFrames = Math.ceil(QUICK_RULES.intermissionTicks / 2) + 4
      for (let frame = 0; frame < intermissionFrames; frame += 1) {
        await playFrame(IDLE, IDLE)
        if (room.state.match.round === 2) break
      }
      expect(room.state.match.phase).toBe(MatchPhase.Live)
      expect(room.state.match.round).toBe(2)

      // Both clients watched it happen, in the same world, from their own end
      // of the wire. The wait is not politeness: a frame's snapshots are on the
      // socket the instant it returns and arrive a moment later, so comparing
      // without it would be comparing the host against two clients that had not
      // been told yet.
      await waitFor(
        () => (host.world.tick === room.tick && guest.world.tick === room.tick ? true : null),
        'both clients to catch up',
      )

      // The snapshots each of them decoded are the host's world — not nearly
      // it — which is what reconciliation is built on.
      expect(hashState(host.world)).toBe(room.hash())
      expect(hashState(guest.world)).toBe(room.hash())
      expect(host.world.match.round).toBe(2)
      expect(guest.world.match.wins).toEqual([0, 1])

      // Each of them was acknowledged with *its own* tick labels, which is what
      // makes `ack` a per-peer number and not the world's tick.
      const ackOf = (player: Player): number => {
        const snaps = player.heard.flatMap((frame) => (frame.t === 'snap' ? [frame.ack] : []))
        return snaps[snaps.length - 1] ?? -1
      }
      expect(ackOf(host)).toBeGreaterThan(0)
      expect(ackOf(host)).toBeLessThanOrEqual(host.sent)
      expect(ackOf(guest)).toBeGreaterThan(0)

      // And neither peer starved the other: a tick never stalls waiting for a
      // socket, and with both of them sending on time it never had to fall back.
      expect(room.snapshot().starved).toBe(0)

      host.close()
      guest.close()
    },
  )

  it('refuses a third player, and says why rather than going quiet', async () => {
    const { server } = await start()
    const seated = []
    for (let index = 0; index < 2; index += 1) {
      const player = connect(server.port, index === 0 ? undefined : DUEL_ROOM)
      await new Promise((resolve) => player.socket.once('open', resolve))
      player.socket.send(HELLO)
      await waitFor(
        () => player.heard.find((frame) => frame.t === 'welcome') ?? null,
        'a welcome',
      )
      seated.push(player)
    }

    const third = connect(server.port, DUEL_ROOM)
    await new Promise((resolve) => third.socket.once('open', resolve))
    const code = await new Promise<number>((resolve) => third.socket.once('close', resolve))

    // A duel seats two. The third is told so and closed, rather than being left
    // holding an open socket that will never say anything.
    expect(code).toBe(4005)
    expect(third.heard[0]).toMatchObject({ t: 'fault', code: 'room-full' })
    expect(server.rooms.get(DUEL_ROOM)?.room.peers).toHaveLength(2)

    for (const player of seated) player.close()
  })
})
