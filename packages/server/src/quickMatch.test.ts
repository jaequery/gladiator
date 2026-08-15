/**
 * Quick match, end to end: two strangers, two sockets, one duel.
 *
 * This is the ticket's headline acceptance check and it is deliberately not a
 * unit test. Two headless clients open `?queue=1` against a real server on a
 * real port, are paired into one room by the queue, and play a round to a
 * decision — the same shape `duel.test.ts` asserts for two friends and a room
 * code, which is the point: quick match is a different way of *choosing* a
 * room, and everything after that choice is the code path that already shipped.
 *
 * ## Virtual time, real everything else
 *
 * The clock and the tick timer belong to this file, so a two-second round costs
 * CI two seconds of arithmetic and a minute-long queue timeout costs none at
 * all. Everything else is real: `ws` over a port, the origin check, the
 * handshake, the framing, the registry, the room.
 *
 * ## Why the round ends the way it does
 *
 * The same reason `duel.test.ts` gives: the spawns are far apart and mutually
 * blind, so nobody can reach anybody in two seconds. One player rocket-jumps
 * into the floor and spends armour, the other stands still, and the round is
 * decided on the clock with a named winner.
 */
import {
  BUTTON_ATTACK,
  DEFAULT_MATCH_RULES,
  MAX_PITCH_UNITS,
  MatchPhase,
  NULL_CMD,
  PROTOCOL_VERSION,
  QueueState,
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
import { QUEUE_WAIT_TIMEOUT_MS } from './queue.ts'
import { manualTimer } from './scheduler.ts'
import { queueRequested, startServer, type GladiatorServer } from './server.ts'

const ALLOWED_ORIGIN = 'http://localhost:5173'

/** A round short enough to watch and long enough to be a round. */
const QUICK_RULES = {
  ...DEFAULT_MATCH_RULES,
  roundTimeLimitTicks: 2 * TICK_RATE,
  intermissionTicks: Math.round(0.5 * TICK_RATE),
}

/** Milliseconds a client frame is worth. 60 Hz, as a browser gives you. */
const FRAME_MS = 16

const HELLO = JSON.stringify({
  t: 'hello',
  protocol: PROTOCOL_VERSION,
  build: 'quick-match',
  mapHash: SERVER_MAP_HASH,
})

/** Standing still, looking where you were looking. */
const IDLE: UserCmd = { ...NULL_CMD, weapon: Weapon.RocketLauncher }

/** Firing a rocket at your own feet: armour spent, health untouched. */
const ROCKET_AT_FEET: UserCmd = {
  ...NULL_CMD,
  pitch: MAX_PITCH_UNITS,
  buttons: BUTTON_ATTACK,
  weapon: Weapon.RocketLauncher,
}

let running: GladiatorServer | null = null

afterEach(async () => {
  await running?.close()
  running = null
})

async function start(
  options: { queueTimeoutMs?: number } = {},
): Promise<{ server: GladiatorServer; clock: ManualClock }> {
  const clock = manualClock()
  running = await startServer({
    config: { ...readConfig({}), port: 0, allowedOrigins: [ALLOWED_ORIGIN] },
    clock,
    timer: manualTimer(),
    rules: QUICK_RULES,
    ...(options.queueTimeoutMs === undefined ? {} : { queueTimeoutMs: options.queueTimeoutMs }),
    log: () => undefined,
  })
  return { server: running, clock }
}

type Player = {
  readonly socket: WebSocket
  readonly heard: ServerMessage[]
  send(cmds: readonly UserCmd[]): void
  readonly sent: number
  /** Every queue frame this player has been sent, in order. */
  queueFrames(): ReadonlyArray<Extract<ServerMessage, { t: 'queue' }>>
  welcome(): Extract<ServerMessage, { t: 'welcome' }>
  close(): void
}

/** One headless player. `query` is the whole of what it asks the host for. */
function connect(port: number, query = ''): Player {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${query}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  })
  const heard: ServerMessage[] = []
  let sent = 0

  socket.on('message', (data) => {
    const parsed = parseServerMessage(String(data))
    if (parsed === null) throw new Error(`unparseable frame: ${String(data)}`)
    heard.push(parsed)
    if (parsed.t === 'ping') socket.send(JSON.stringify({ t: 'pong', id: parsed.id }))
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
    queueFrames: () => heard.flatMap((frame) => (frame.t === 'queue' ? [frame] : [])),
    welcome() {
      const frame = heard.find((entry) => entry.t === 'welcome')
      if (frame === undefined) throw new Error('no welcome')
      return frame
    },
    close: () => socket.close(),
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

/** Open a socket, say hello, and wait for the welcome. */
async function arrive(port: number, query: string): Promise<Player> {
  const player = connect(port, query)
  await new Promise((resolve) => player.socket.once('open', resolve))
  player.socket.send(HELLO)
  await waitFor(() => player.heard.find((frame) => frame.t === 'welcome') ?? null, 'a welcome')
  return player
}

describe('the queue parameter on the upgrade', () => {
  it('is any value at all, and is not a room code', () => {
    expect(queueRequested('/?queue=1')).toBe(true)
    expect(queueRequested('/?queue=true')).toBe(true)
    // A flag a menu sets: present is present. What it is *not* is a code, and a
    // request carrying both is answered as a code — `server.ts`.
    expect(queueRequested('/?queue')).toBe(true)
    expect(queueRequested('/')).toBe(false)
    expect(queueRequested(undefined)).toBe(false)
  })
})

describe('two strangers hitting find match', () => {
  it(
    'are paired into one room and play a round to a decision',
    { timeout: 120_000 },
    async () => {
      const { server, clock } = await start()

      // The first one arrives to an empty machine and is parked, and told so:
      // a room of their own, a code, and how long they may be kept.
      const first = await arrive(server.port, '?queue=1')
      const waiting = await waitFor(() => first.queueFrames()[0] ?? null, 'the waiting frame')
      expect(waiting).toEqual({
        t: 'queue',
        state: QueueState.Waiting,
        room: first.welcome().room,
        waitedMs: 0,
        timeoutMs: QUEUE_WAIT_TIMEOUT_MS,
      })
      expect(server.queue.size).toBe(1)

      // The second one arrives four seconds later and takes the free seat. The
      // frame in between is the machine going on running while somebody waits:
      // without it the four seconds would all land on the next frame at once,
      // and the scheduler would spend its stall clamp on them.
      clock.advance(4_000)
      server.scheduler.frame()
      const second = await arrive(server.port, '?queue=1')

      // One room, two seats, and both of them told the wait is over.
      expect(second.welcome().room).toBe(first.welcome().room)
      expect(server.rooms.size).toBe(1)
      expect(server.queue.size).toBe(0)
      expect(server.queue.stats()).toMatchObject({ parked: 1, paired: 1 })

      const matched = await waitFor(
        () => first.queueFrames().find((frame) => frame.state === QueueState.Matched) ?? null,
        "the waiting player's matched frame",
      )
      expect(matched.waitedMs).toBe(4_000)
      expect(matched.room).toBe(first.welcome().room)
      const arrivedTo = await waitFor(
        () => second.queueFrames()[0] ?? null,
        "the arriving player's frame",
      )
      // Zero, and honestly so: this one waited for nothing at all.
      expect(arrivedTo).toMatchObject({ state: QueueState.Matched, waitedMs: 0 })

      const room = server.rooms.get(first.welcome().room)?.room
      if (room === undefined) throw new Error('the registry lost the room')
      expect(room.peers.map((peer) => peer.slot)).toEqual([0, 1])
      expect(room.state.match.phase).toBe(MatchPhase.Warmup)

      // Whatever the world ran through while one player sat in it alone. A peer
      // with nothing in its buffer starves by definition, and a player waiting
      // for a stranger is exactly that — so the number worth asserting is what
      // the *duel* adds to it, which is none.
      const starvedWaiting = room.snapshot().starved

      /** One 60 Hz frame: both players send, then the host's clock moves. */
      const playFrame = async (firstCmd: UserCmd, secondCmd: UserCmd): Promise<void> => {
        first.send([firstCmd, firstCmd])
        second.send([secondCmd, secondCmd])
        const wanted = first.sent
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

      // The match starts on the first frame with both seats filled — the room's
      // own edge out of warmup, taken because the queue filled it.
      await playFrame(IDLE, IDLE)
      expect(room.state.match.phase).toBe(MatchPhase.Live)
      expect(room.state.match.round).toBe(1)

      const roundFrames = Math.ceil(QUICK_RULES.roundTimeLimitTicks / 2) + 4
      for (let frame = 0; frame < roundFrames; frame += 1) {
        await playFrame(ROCKET_AT_FEET, IDLE)
        if (room.state.match.phase !== MatchPhase.Live) break
      }

      // A round, played by two people who had never heard of each other, ended
      // with a winner and a score.
      expect(room.state.match.phase).toBe(MatchPhase.Intermission)
      expect(room.state.match.lastRoundWinner).toBe(1)
      expect(room.state.match.wins).toEqual([0, 1])

      // And out the other side into round two, both players stood up again.
      const intermissionFrames = Math.ceil(QUICK_RULES.intermissionTicks / 2) + 4
      for (let frame = 0; frame < intermissionFrames; frame += 1) {
        await playFrame(IDLE, IDLE)
        if (room.state.match.round === 2) break
      }
      expect(room.state.match.phase).toBe(MatchPhase.Live)
      expect(room.state.match.round).toBe(2)

      // Neither of them starved the other: the pairing changed which room they
      // are in and nothing about how the room is driven.
      expect(room.snapshot().starved).toBe(starvedWaiting)

      first.close()
      second.close()
    },
  )

  it('does not put a third one in the pair, but starts them a new wait', async () => {
    const { server } = await start()
    const first = await arrive(server.port, '?queue=1')
    const second = await arrive(server.port, '?queue=1')
    const third = await arrive(server.port, '?queue=1')

    expect(second.welcome().room).toBe(first.welcome().room)
    expect(third.welcome().room).not.toBe(first.welcome().room)
    expect(third.queueFrames()[0]).toMatchObject({ state: QueueState.Waiting })
    expect(server.rooms.size).toBe(2)
    expect(server.queue.size).toBe(1)

    first.close()
    second.close()
    third.close()
  })
})

describe('a player who queues and disconnects', () => {
  it('is taken out of the line and never paired', async () => {
    const { server, clock } = await start()
    const leaver = await arrive(server.port, '?queue=1')
    const abandoned = leaver.welcome().room
    expect(server.queue.size).toBe(1)

    leaver.close()
    await waitFor(
      () => (server.rooms.get(abandoned)?.room.peers.length === 0 ? true : null),
      'the socket to close',
    )

    // The sweep the tick scheduler runs is what notices — the same one the
    // registry's reaper rides on. Nothing tells the queue that a socket closed.
    clock.advance(FRAME_MS)
    server.scheduler.frame()
    expect(server.queue.size).toBe(0)

    // And the next arrival gets a room of their own rather than a duel against
    // somebody who left.
    const next = await arrive(server.port, '?queue=1')
    expect(next.welcome().room).not.toBe(abandoned)
    expect(next.queueFrames()[0]).toMatchObject({ state: QueueState.Waiting })
    expect(server.queue.stats()).toMatchObject({ paired: 0, dropped: 1 })

    next.close()
  })
})

describe('a wait that runs out', () => {
  it('says so, and hands back the code to send a friend', async () => {
    // Not a close and not a spinner: the socket, the room and the code all
    // survive, and the player is told that the *matching* is what ended.
    const { server, clock } = await start({ queueTimeoutMs: 5_000 })
    const player = await arrive(server.port, '?queue=1')
    const room = player.welcome().room

    clock.advance(FRAME_MS)
    server.scheduler.frame()
    expect(player.queueFrames()).toHaveLength(1)

    clock.advance(5_000)
    server.scheduler.frame()

    const timeout = await waitFor(
      () => player.queueFrames().find((frame) => frame.state === QueueState.Timeout) ?? null,
      'the timeout frame',
    )
    expect(timeout.room).toBe(room)
    expect(timeout.waitedMs).toBeGreaterThanOrEqual(5_000)
    expect(timeout.timeoutMs).toBe(0)
    expect(player.socket.readyState).toBe(WebSocket.OPEN)
    expect(server.queue.size).toBe(0)
    expect(server.rooms.get(room)).not.toBeNull()

    // Said once, however many frames go by afterwards.
    for (let frame = 0; frame < 10; frame += 1) {
      clock.advance(FRAME_MS)
      server.scheduler.frame()
    }
    expect(player.queueFrames().filter((frame) => frame.state === QueueState.Timeout)).toHaveLength(1)

    // And the code still works, which is what makes the sentence worth reading:
    // a friend sent those six characters lands in this match.
    const friend = await arrive(server.port, `?room=${room}`)
    expect(friend.welcome().room).toBe(room)
    expect(server.rooms.get(room)?.room.peers).toHaveLength(2)

    player.close()
    friend.close()
  })
})

describe('room codes are untouched', () => {
  it('still opens a room for a connection that names neither a code nor a queue', async () => {
    const { server } = await start()
    const host = await arrive(server.port, '')
    expect(host.welcome().room).toHaveLength(6)
    // No queue frame at all: this session never asked to be matched, and a
    // "looking for an opponent" panel over a room-code match would be a lie.
    expect(host.queueFrames()).toEqual([])
    expect(server.queue.size).toBe(0)

    const guest = await arrive(server.port, `?room=${host.welcome().room.toLowerCase()}`)
    expect(guest.welcome().room).toBe(host.welcome().room)
    expect(guest.queueFrames()).toEqual([])
    expect(server.rooms.size).toBe(1)

    host.close()
    guest.close()
  })

  it('answers a code with the code, even when the queue flag rides along', async () => {
    // Six characters somebody typed is a request for a *particular* match.
    // Quietly matching them with a stranger instead would be the worst
    // possible way to answer it.
    const { server } = await start()
    const host = await arrive(server.port, '?queue=1')
    const code = host.welcome().room

    const friend = await arrive(server.port, `?room=${code}&queue=1`)
    expect(friend.welcome().room).toBe(code)
    expect(friend.queueFrames()).toEqual([])
    expect(server.rooms.size).toBe(1)

    host.close()
    friend.close()
  })

  it('serves the line beside the rooms on /healthz', async () => {
    const { server } = await start()
    const player = await arrive(server.port, '?queue=1')

    const body = (await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json()) as {
      queue?: Record<string, number>
    }
    expect(body.queue).toMatchObject({ waiting: 1, parked: 1, paired: 0, timedOut: 0 })

    player.close()
  })
})
