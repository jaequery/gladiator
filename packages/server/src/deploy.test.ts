/**
 * A deploy, in the middle of a duel — end to end, over real sockets.
 *
 * This is the ticket's headline claim and the one that cannot be argued from a
 * unit test: two players are a round into a match, the machine holding it gets
 * SIGTERM, and the match continues on **a different process** with the score
 * intact. Everything here is real except the clock: two `startServer`s on two
 * ephemeral ports, `ws` on both, the real handshake, the real registry, the
 * real drain, and a resume ticket that crosses from one process to the other
 * inside a client that never gets to choose what it says.
 *
 * The second server is not a metaphor for the next deploy. It is a second
 * process's worth of state — its own registry, its own rooms, its own
 * scheduler — sharing only the `RESUME_SECRET`, which is exactly what a Fly
 * blue/green cutover leaves two machines with.
 */
import {
  BUTTON_ATTACK,
  CloseReason,
  DEFAULT_MATCH_RULES,
  MAX_PITCH_UNITS,
  MatchPhase,
  NULL_CMD,
  PROTOCOL_VERSION,
  TICK_RATE,
  Weapon,
  encodeCmd,
  parseServerMessage,
  type ServerMessage,
  type UserCmd,
} from '@gladiator/sim'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { manualClock, type ManualClock } from './clock.ts'
import { readConfig } from './config.ts'
import { SERVER_MAP_HASH } from './map.ts'
import { ROOM_CODE_ALPHABET } from './roomCode.ts'
import { manualTimer } from './scheduler.ts'
import { startServer, type GladiatorServer } from './server.ts'
import { drainServer } from './shutdown.ts'

const ALLOWED_ORIGIN = 'http://localhost:5173'

/** The code both machines' registries mint here, so a test can name it. */
const ROOM = 'H7K2Q9'

/** Shared by every machine of the app, which is the whole point. `resume.ts`. */
const SECRET = 'a-shared-secret-that-both-machines-have'

/** A round short enough to play twice in a test. See `duel.test.ts`. */
const QUICK_RULES = {
  ...DEFAULT_MATCH_RULES,
  roundTimeLimitTicks: 2 * TICK_RATE,
  intermissionTicks: Math.round(0.5 * TICK_RATE),
}

const FRAME_MS = 16

const HELLO = JSON.stringify({
  t: 'hello',
  protocol: PROTOCOL_VERSION,
  build: 'deploy',
  mapHash: SERVER_MAP_HASH,
})

/** Standing still. */
const IDLE: UserCmd = { ...NULL_CMD, weapon: Weapon.RocketLauncher }

/** Firing at your own feet: armour spent, and a round lost on damage taken. */
const ROCKET_AT_FEET: UserCmd = {
  ...NULL_CMD,
  pitch: MAX_PITCH_UNITS,
  buttons: BUTTON_ATTACK,
  weapon: Weapon.RocketLauncher,
}

const machines: GladiatorServer[] = []

afterEach(async () => {
  for (const machine of machines.splice(0)) await machine.close()
})

function fixedCode(code: string): () => number {
  let at = 0
  return () => {
    const symbol = code[at % code.length] ?? '0'
    at += 1
    return ROOM_CODE_ALPHABET.indexOf(symbol)
  }
}

async function waitFor<T>(check: () => T | null, what: string): Promise<T> {
  for (let attempt = 0; attempt < 500_000; attempt += 1) {
    const answer = check()
    if (answer !== null) return answer
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`gave up waiting for ${what}`)
}

type Machine = { readonly server: GladiatorServer; readonly clock: ManualClock }

async function startMachine(over: { resumeSecret?: string } = {}): Promise<Machine> {
  const clock = manualClock()
  const server = await startServer({
    config: {
      ...readConfig({}),
      port: 0,
      allowedOrigins: [ALLOWED_ORIGIN],
      resumeSecret: over.resumeSecret ?? SECRET,
    },
    clock,
    timer: manualTimer(),
    random: fixedCode(ROOM),
    rules: QUICK_RULES,
    log: () => undefined,
  })
  machines.push(server)
  return { server, clock }
}

type Player = {
  readonly socket: WebSocket
  readonly heard: ServerMessage[]
  send(cmds: readonly UserCmd[]): void
  readonly sent: number
  /** The close code the server used, once it has closed. */
  readonly closedWith: number | null
  greet(): Promise<ServerMessage>
  close(): void
}

/** One headless player, dialling a port with an optional code and ticket. */
function connect(port: number, query: { room?: string; resume?: string } = {}): Player {
  const parameters = new URLSearchParams()
  if (query.room !== undefined) parameters.set('room', query.room)
  if (query.resume !== undefined) parameters.set('resume', query.resume)
  const search = parameters.toString()
  const socket = new WebSocket(`ws://127.0.0.1:${port}${search === '' ? '' : `?${search}`}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  })
  const heard: ServerMessage[] = []
  let sent = 0
  let closedWith: number | null = null

  socket.on('message', (data) => {
    const parsed = parseServerMessage(String(data))
    if (parsed === null) throw new Error(`unparseable frame: ${String(data)}`)
    heard.push(parsed)
    if (parsed.t === 'ping') socket.send(JSON.stringify({ t: 'pong', id: parsed.id }))
  })
  socket.on('close', (code: number) => {
    closedWith = code
  })

  return {
    socket,
    heard,
    send(cmds) {
      const startTick = sent + 1
      sent += cmds.length
      socket.send(JSON.stringify({ t: 'cmds', startTick, cmds: cmds.map(encodeCmd) }))
    },
    get sent() {
      return sent
    },
    get closedWith() {
      return closedWith
    },
    async greet() {
      await new Promise((resolve) => socket.once('open', resolve))
      socket.send(HELLO)
      return waitFor(() => heard.find((frame) => frame.t === 'welcome') ?? null, 'a welcome')
    },
    close: () => socket.close(),
  }
}

/** The drain frame this player was handed, or `null`. */
function drainOf(player: Player): { room: string; resume: string; retryAfterMs: number } | null {
  const frame = player.heard.find((entry) => entry.t === 'drain')
  return frame === undefined || frame.t !== 'drain' ? null : frame
}

/** The resume ticket this player was handed. Loud rather than `undefined`. */
function ticketOf(player: Player): string {
  const notice = drainOf(player)
  if (notice === null) throw new Error('this player was never told the host was deploying')
  return notice.resume
}

/** `GET /healthz`, as Fly's proxy asks it. */
async function health(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('a deploy in the middle of a duel', () => {
  it(
    'hands both players a ticket and resumes the match, at its score, on the next machine',
    { timeout: 120_000 },
    async () => {
      const first = await startMachine()

      const host = connect(first.server.port)
      const hostWelcome = await host.greet()
      if (hostWelcome.t !== 'welcome') throw new Error('unreachable')
      expect(hostWelcome.room).toBe(ROOM)

      const guest = connect(first.server.port, { room: ROOM })
      await guest.greet()

      const room = first.server.rooms.get(ROOM)?.room
      if (room === undefined) throw new Error('the registry lost the room')

      /** One 60 Hz frame on the first machine. */
      const playFrame = async (hostCmd: UserCmd, guestCmd: UserCmd): Promise<void> => {
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
        first.clock.advance(FRAME_MS)
        first.server.scheduler.frame()
      }

      // Play a round to a decision, so the score that has to survive the deploy
      // is a score somebody earned rather than a number in a fixture.
      await playFrame(IDLE, IDLE)
      expect(room.state.match.phase).toBe(MatchPhase.Live)
      const roundFrames = Math.ceil(QUICK_RULES.roundTimeLimitTicks / 2) + 4
      for (let frame = 0; frame < roundFrames; frame += 1) {
        await playFrame(ROCKET_AT_FEET, IDLE)
        if (room.state.match.phase !== MatchPhase.Live) break
      }
      expect(room.state.match.wins).toEqual([0, 1])

      // Into round two, so the match being interrupted is a match in progress.
      const intermissionFrames = Math.ceil(QUICK_RULES.intermissionTicks / 2) + 4
      for (let frame = 0; frame < intermissionFrames; frame += 1) {
        await playFrame(IDLE, IDLE)
        if (room.state.match.round === 2) break
      }
      expect(room.state.match.round).toBe(2)
      expect(await health(first.server.port)).toMatchObject({ status: 200, body: { ready: true } })

      // ---- the deploy ----
      const report = await drainServer({
        server: first.server,
        resume: first.server.resume,
        clock: first.clock,
        // The notice window and the poll are real time in production and a
        // formality here; the frames are already written by the time the drain
        // reaches them.
        sleep: () => new Promise((resolve) => setImmediate(resolve)),
      })
      expect(report).toMatchObject({ rooms: 1, told: 2, ticketed: 2, timedOut: false })

      // Both players were told where their match went, and both were closed
      // with 1001 — "come back" rather than "the wire broke".
      const hostDrain = drainOf(host)
      const guestDrain = drainOf(guest)
      expect(hostDrain?.room).toBe(ROOM)
      expect(guestDrain?.room).toBe(ROOM)
      expect(hostDrain?.resume).not.toBe('')
      // Two tickets, not one: a ticket names a seat, and two peers holding the
      // same one would come back into the same chair.
      expect(hostDrain?.resume).not.toBe(guestDrain?.resume)
      await waitFor(() => (host.closedWith !== null && guest.closedWith !== null ? true : null),
        'both sockets to close')
      expect(host.closedWith).toBe(CloseReason.GoingAway)
      expect(guest.closedWith).toBe(CloseReason.GoingAway)

      // ---- the next machine ----
      const second = await startMachine()
      expect(second.server.rooms.size).toBe(0)

      const hostAgain = connect(second.server.port, { room: ROOM, resume: ticketOf(host) })
      await hostAgain.greet()
      const guestAgain = connect(second.server.port, { room: ROOM, resume: ticketOf(guest) })
      await guestAgain.greet()

      const resumed = second.server.rooms.get(ROOM)?.room
      if (resumed === undefined) throw new Error('the second machine did not rebuild the room')

      // The same room, the same two seats, and — the whole point — the same
      // score. The match starts on the next frame with both seats filled.
      expect(resumed.peers.map((peer) => peer.slot).sort()).toEqual([0, 1])
      second.clock.advance(FRAME_MS)
      second.server.scheduler.frame()
      expect(resumed.state.match.phase).toBe(MatchPhase.Live)
      expect(resumed.state.match.wins).toEqual([0, 1])
      // Round two again: the round that was interrupted is replayed, not
      // skipped. One round has been decided, and this is the next one.
      expect(resumed.state.match.round).toBe(2)

      hostAgain.close()
      guestAgain.close()
    },
  )

  it('refuses new players while draining, and says how long to wait', async () => {
    const machine = await startMachine()
    const player = connect(machine.server.port)
    await player.greet()

    machine.server.beginDraining()

    // The health check is what takes this machine out of the proxy's rotation,
    // and it is the difference between "up" and "send me players".
    const checked = await health(machine.server.port)
    expect(checked.status).toBe(503)
    expect(checked.body).toMatchObject({ ready: false, draining: true, notReady: ['draining'] })

    // Liveness is a different question and still answers yes: the correct
    // response to *it* failing is to kill the process, and this process is
    // holding a duel.
    const alive = await fetch(`http://127.0.0.1:${machine.server.port}/livez`)
    expect(alive.status).toBe(200)

    // And the upgrade itself is refused, rather than accepted into a machine
    // that is about to go away.
    const refused = connect(machine.server.port)
    const error = await new Promise<Error>((resolve) => refused.socket.once('error', resolve))
    expect(error.message).toContain('503')

    // The player already in a match is untouched by any of it.
    expect(player.closedWith).toBeNull()
    expect(machine.server.rooms.size).toBe(1)
    player.close()
  })

  it('will not resume a room on a machine that does not share the secret', async () => {
    const first = await startMachine()
    const player = connect(first.server.port)
    await player.greet()
    await drainServer({
      server: first.server,
      resume: first.server.resume,
      clock: first.clock,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    })
    const ticket = ticketOf(player)
    expect(ticket).not.toBe('')

    // A machine with a different secret is, as far as a ticket is concerned, a
    // stranger — which is what stops a forged score from being one.
    const second = await startMachine({ resumeSecret: 'a-different-secret-entirely' })
    const rejoining = connect(second.server.port, { room: ROOM, resume: ticket })
    const closed = await new Promise<number>((resolve) => rejoining.socket.once('close', resolve))
    expect(closed).toBe(4006)
    expect(rejoining.heard[0]).toMatchObject({ t: 'fault', code: 'no-such-room' })
    expect(second.server.rooms.size).toBe(0)
  })

  it('says on /healthz whether this deploy can resume a match at all', async () => {
    const withSecret = await startMachine()
    expect((await health(withSecret.server.port)).body).toMatchObject({ canResume: true })

    const without = await startMachine({ resumeSecret: '' })
    expect((await health(without.server.port)).body).toMatchObject({ canResume: false })

    // No secret is not a pretend ticket: the drain frame still goes out, so a
    // client still learns this was a deploy rather than a crash, and the ticket
    // is empty rather than unverifiable.
    const player = connect(without.server.port)
    await player.greet()
    await drainServer({
      server: without.server,
      resume: without.server.resume,
      clock: without.clock,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    })
    expect(drainOf(player)).toMatchObject({ room: ROOM, resume: '' })
  })
})
