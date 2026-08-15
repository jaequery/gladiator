/**
 * Every way a connection can start, end, or come back — one test each.
 *
 * The ticket this file belongs to (GLAD-DVDV6P) exists because these
 * transitions are usually not *decided* anywhere: a socket closes, a peer is
 * spliced out of an array, and what that means for the match is whatever the
 * rest of the code happens to do next. So there is a test per transition and
 * each one asserts the documented outcome rather than the current behaviour.
 *
 * Three layers, because the transitions live at three levels:
 *
 * - **the seat machine** — `lifecycle.ts` on its own, no world and no sockets;
 * - **a room** — the machine wired to a `GameState` and two loopbacks, which is
 *   where "the body stays and stays killable" and "the score survives" are
 *   observable at all;
 * - **the registry** — the empty-room reaper, and the one inequality it owes
 *   the grace window.
 */
import {
  BUTTON_ATTACK,
  CloseReason,
  EntityFlag,
  MAX_PITCH_UNITS,
  MatchPhase,
  NO_SLOT,
  NO_WINNER,
  NULL_CMD,
  PROTOCOL_VERSION,
  TICK_RATE,
  Weapon,
  findPlayer,
  matchRules,
  parseServerMessage,
  type ServerMessage,
  type UserCmd,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { manualClock, type ManualClock } from './clock.ts'
import {
  Admission,
  RECONNECT_GRACE_MS,
  SeatPhase,
  createLifecycle,
  mintSeatToken,
} from './lifecycle.ts'
import { MAX_REPEAT_TICKS } from './inputQueue.ts'
import { SERVER_MAP, SERVER_MAP_HASH, SERVER_PLAN } from './map.ts'
import { createLoopbackPair, settleLoopback, type LoopbackPair } from './net/loopbackTransport.ts'
import { createRoom, DEFAULT_IDLE_TIMEOUT_MS, type Room } from './room.ts'
import { EMPTY_ROOM_TTL_MS, createRoomRegistry } from './rooms.ts'
import { CLOSE_MATCH_ENDED, CLOSE_REPLACED, CLOSE_ROOM_FULL } from './session.ts'

/* --------------------------------------------------------------------------
 * The seat machine, on its own
 * ----------------------------------------------------------------------- */

/** A draw that produces a different token each call, without a CSPRNG. */
function countingDraw(): () => number {
  let at = 0x1000
  return () => {
    at += 1
    return at
  }
}

describe('the seat machine', () => {
  it('seats the first arrival and mints them a key', () => {
    const life = createLifecycle({ random: countingDraw() })
    const first = life.arrive('a', null, 0)

    expect(first.verdict).toBe(Admission.Seated)
    expect(first.slot).toBe(0)
    expect(first.token).not.toBeNull()
    expect(life.live).toBe(1)
    expect(life.seats[0]?.phase).toBe(SeatPhase.Live)
  })

  it('seats the second arrival opposite the first', () => {
    const life = createLifecycle({ random: countingDraw() })
    life.arrive('a', null, 0)
    const second = life.arrive('b', null, 0)

    expect(second.verdict).toBe(Admission.Seated)
    expect(second.slot).toBe(1)
    // Two seats, two keys. A shared one would let either player take the other's
    // side back after a drop.
    expect(second.token).not.toBe(life.seats[0]?.token)
  })

  it('refuses a third arrival rather than seating it nowhere', () => {
    const life = createLifecycle({ random: countingDraw() })
    life.arrive('a', null, 0)
    life.arrive('b', null, 0)
    const third = life.arrive('c', null, 0)

    expect(third.verdict).toBe(Admission.Full)
    expect(third.slot).toBe(NO_SLOT)
    expect(third.token).toBeNull()
  })

  it('hands a seat to the newer socket when both hold the same key', () => {
    // The double-tab case, and the one the naive answer gets wrong. Refusing
    // the newcomer locks a player out of their own seat behind a socket that is
    // dead in every sense except that the kernel has not noticed yet.
    const life = createLifecycle({ random: countingDraw() })
    const first = life.arrive('a', null, 0)
    const again = life.arrive('a-second-tab', first.token, 0)

    expect(again.verdict).toBe(Admission.Replaced)
    expect(again.slot).toBe(first.slot)
    expect(again.token).toBe(first.token)
    expect(again.evicted).toBe('a')
    expect(life.live).toBe(1)
  })

  it('holds a seat for a peer that left mid-match, and gives it back', () => {
    const clock = manualClock()
    const life = createLifecycle({ random: countingDraw() })
    const first = life.arrive('a', null, clock.nowMs())
    life.arrive('b', null, clock.nowMs())

    life.depart('a', clock.nowMs(), true)
    expect(life.seats[0]?.phase).toBe(SeatPhase.Vacant)
    expect(life.held).toBe(1)
    expect(life.graceLeftMs(0, clock.nowMs())).toBe(RECONNECT_GRACE_MS)

    clock.advance(RECONNECT_GRACE_MS - 1)
    expect(life.expire(clock.nowMs())).toEqual([])
    const back = life.arrive('a-again', first.token, clock.nowMs())

    expect(back.verdict).toBe(Admission.Resumed)
    expect(back.slot).toBe(first.slot)
    expect(back.token).toBe(first.token)
    expect(life.live).toBe(2)
  })

  it('reopens a seat vacated with no match to come back to', () => {
    // Warmup. There is no score to protect, and holding the seat would refuse
    // the next player who could have started the match.
    const life = createLifecycle({ random: countingDraw() })
    const first = life.arrive('a', null, 0)
    life.depart('a', 0, false)

    expect(life.seats[0]?.phase).toBe(SeatPhase.Open)
    expect(life.arrive('c', null, 0).verdict).toBe(Admission.Seated)
    // And the key that seat used to have opens nothing: with the room full
    // again, its holder is just another third player.
    life.arrive('d', null, 0)
    expect(life.arrive('a-again', first.token, 0).verdict).toBe(Admission.Full)
  })

  it('forfeits a seat whose window ran out, and refuses its key afterwards', () => {
    const clock = manualClock()
    const life = createLifecycle({ random: countingDraw() })
    const first = life.arrive('a', null, clock.nowMs())
    life.arrive('b', null, clock.nowMs())
    life.depart('a', clock.nowMs(), true)

    clock.advance(RECONNECT_GRACE_MS)
    expect(life.expire(clock.nowMs())).toEqual([0])
    expect(life.seats[0]?.phase).toBe(SeatPhase.Forfeit)

    const late = life.arrive('a-again', first.token, clock.nowMs())
    expect(late.verdict).toBe(Admission.Ended)
    expect(late.slot).toBe(NO_SLOT)
  })

  it('answers a key whose window has closed but which nothing has swept', () => {
    // The verdict must not depend on whether the sweep ran first this frame.
    const clock = manualClock()
    const life = createLifecycle({ random: countingDraw() })
    const first = life.arrive('a', null, clock.nowMs())
    life.arrive('b', null, clock.nowMs())
    life.depart('a', clock.nowMs(), true)

    clock.advance(RECONNECT_GRACE_MS + 1)
    expect(life.arrive('a-again', first.token, clock.nowMs()).verdict).toBe(Admission.Ended)
  })

  it('lets a key back in after the match ended, and turns a stranger away', () => {
    // `ended` refuses *new* seats. The player whose opponent's window ran out
    // while they were themselves reconnecting is owed the sight of the match
    // they just won by forfeit.
    const life = createLifecycle({ random: countingDraw() })
    const first = life.arrive('a', null, 0)
    const second = life.arrive('b', null, 0)
    life.depart('a', 0, true)
    life.depart('b', 0, true)
    life.expire(RECONNECT_GRACE_MS)
    life.end()

    expect(life.arrive('stranger', null, RECONNECT_GRACE_MS).verdict).toBe(Admission.Ended)
    expect(life.arrive('a-again', first.token, RECONNECT_GRACE_MS).verdict).toBe(Admission.Ended)
    expect(second.token).not.toBe(first.token)
  })

  it('treats a key from a room that no longer exists as no key at all', () => {
    const life = createLifecycle({ random: countingDraw() })
    const stale = life.arrive('stranger', mintSeatToken(countingDraw()), 0)
    // Not an error: a stale token in somebody's tab must not turn a free seat
    // into a room they cannot join.
    expect(stale.verdict).toBe(Admission.Seated)
  })

  it("ignores a displaced peer's own close, so it cannot vacate the seat it lost", () => {
    const life = createLifecycle({ random: countingDraw() })
    const first = life.arrive('a', null, 0)
    life.arrive('a-second-tab', first.token, 0)

    // The old socket's close arrives a moment after the new one took the seat.
    expect(life.depart('a', 0, true).slot).toBe(NO_SLOT)
    expect(life.seats[0]?.phase).toBe(SeatPhase.Live)
    expect(life.seats[0]?.peerId).toBe('a-second-tab')
  })

  it('mints keys nobody is going to guess', () => {
    const draw = countingDraw()
    const seen = new Set<string>()
    for (let i = 0; i < 64; i += 1) seen.add(mintSeatToken(draw))
    expect(seen.size).toBe(64)
    expect([...seen][0]).toMatch(/^[0-9a-f]{32}$/)
  })
})

/* --------------------------------------------------------------------------
 * The numbers that have to agree with each other
 * ----------------------------------------------------------------------- */

describe('the three timeouts, in the order they fire', () => {
  it('lets a body come to rest long before its seat expires', () => {
    // The two halves of the disconnect policy live in two files. The repeat-last
    // fallback is bounded at half a second (`inputQueue.ts`) precisely so that a
    // player whose connection died mid strafe-jump is standing still for almost
    // all of the window their seat is held for — rather than sprinting off a
    // ledge for thirty seconds.
    const repeatMs = (MAX_REPEAT_TICKS * 1000) / TICK_RATE
    expect(repeatMs).toBeLessThan(RECONNECT_GRACE_MS / 10)
  })

  it('notices a half-open socket before the seat it holds could expire', () => {
    // A socket that closes properly vacates its seat immediately; one that just
    // stops answering costs the idle timeout first. Keeping that shorter than
    // the grace window is what bounds the worst case at 40 seconds rather than
    // at 90.
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeLessThan(RECONNECT_GRACE_MS)
  })

  it('keeps a room alive for longer than the seats inside it', () => {
    // A match both of whose players dropped is a room with no peers in it.
    // Reaping that before their windows closed would turn a reconnect that was
    // still in time into "no such room".
    expect(EMPTY_ROOM_TTL_MS).toBeGreaterThanOrEqual(RECONNECT_GRACE_MS)
  })
})

/* --------------------------------------------------------------------------
 * A room, one transition at a time
 * ----------------------------------------------------------------------- */

/** A round short enough to drive, and an intermission short enough to wait out. */
const QUICK_RULES = matchRules({
  roundTimeLimitTicks: 4 * TICK_RATE,
  intermissionTicks: Math.round(0.5 * TICK_RATE),
})

const IDLE: UserCmd = { ...NULL_CMD, weapon: Weapon.RocketLauncher }

/** Firing at your own feet: the cheapest way to make a body take damage. */
const ROCKET_AT_FEET: UserCmd = {
  ...NULL_CMD,
  pitch: MAX_PITCH_UNITS,
  buttons: BUTTON_ATTACK,
  weapon: Weapon.RocketLauncher,
}

const HELLO = JSON.stringify({
  t: 'hello',
  protocol: PROTOCOL_VERSION,
  build: 'test',
  mapHash: SERVER_MAP_HASH,
})

type Client = {
  readonly pair: LoopbackPair
  readonly heard: ServerMessage[]
  readonly closes: Array<[number, string]>
  /** The seat key the welcome carried. */
  token(): string
  /** The last lifecycle frame this client was sent, if any. */
  life(): Extract<ServerMessage, { t: 'life' }> | null
  send(cmds: readonly UserCmd[]): void
}

function hosted(options: { clock?: ManualClock } = {}) {
  const clock = options.clock ?? manualClock()
  const room: Room = createRoom({
    map: SERVER_MAP,
    plan: SERVER_PLAN,
    clock,
    build: 'test-build',
    id: 'H7K2Q9',
    rules: QUICK_RULES,
    peerId: (index) => `peer-${index}`,
    seatRandom: countingDraw(),
  })
  return { clock, room }
}

/** Open a pipe into `room`, say hello, and settle. */
async function connect(room: Room, token: string | null = null): Promise<Client> {
  const pair: LoopbackPair = createLoopbackPair()
  const heard: ServerMessage[] = []
  const closes: Array<[number, string]> = []
  let sent = 0
  pair.client.setHandlers({
    onMessage: (message) => {
      const parsed = parseServerMessage(String(message))
      if (parsed !== null) heard.push(parsed)
    },
    onClose: (code, reason) => closes.push([code, reason]),
  })
  room.join(pair.server, { token })
  pair.client.send(HELLO)
  await settleLoopback(pair)

  return {
    pair,
    heard,
    closes,
    token() {
      const welcome = heard.find((frame) => frame.t === 'welcome')
      if (welcome === undefined || welcome.t !== 'welcome') throw new Error('no welcome')
      return welcome.token
    },
    life() {
      const frames = heard.flatMap((frame) => (frame.t === 'life' ? [frame] : []))
      return frames[frames.length - 1] ?? null
    },
    send(cmds) {
      const startTick = sent + 1
      sent += cmds.length
      pair.client.send(
        JSON.stringify({
          t: 'cmds',
          startTick,
          cmds: cmds.map((cmd) => [
            cmd.forwardMove,
            cmd.sideMove,
            cmd.yaw,
            cmd.pitch,
            cmd.buttons,
            cmd.weapon,
          ]),
        }),
      )
    },
  }
}

/**
 * Move the clock forward while `client` keeps talking, as a real one does.
 *
 * A connected client sends sixty commands a second, so its socket is never idle;
 * a test that jumped the clock thirty seconds with nobody sending would have the
 * *survivor* time out too, and would be asserting on a room with two dead peers
 * in it. Sweeping every few seconds is also what the scheduler does, so this is
 * the shape of real time passing rather than a shortcut around it.
 */
async function idleAlong(
  room: Room,
  clock: ManualClock,
  client: Client,
  ms: number,
): Promise<void> {
  const step = DEFAULT_IDLE_TIMEOUT_MS / 2
  let left = ms
  while (left > 0) {
    const chunk = left < step ? left : step
    clock.advance(chunk)
    left -= chunk
    client.send([IDLE])
    await settleLoopback(client.pair)
    room.sweep(clock.nowMs())
  }
}

/** A two-player room with the match under way, and both ends of the wire. */
async function duelling(clock: ManualClock = manualClock()) {
  const { room } = hosted({ clock })
  const host = await connect(room)
  const guest = await connect(room)
  room.advance(1)
  await settleLoopback(host.pair)
  await settleLoopback(guest.pair)
  expect(room.state.match.phase).toBe(MatchPhase.Live)
  return { clock, room, host, guest }
}

describe('a room, one transition at a time', () => {
  it('starts the match when the second player arrives, and tells the first', async () => {
    const { room } = hosted()
    const host = await connect(room)
    expect(room.seats.map((seat) => seat.phase)).toEqual([SeatPhase.Live, SeatPhase.Open])
    expect(room.state.match.phase).toBe(MatchPhase.Warmup)

    const guest = await connect(room)
    await settleLoopback(host.pair)
    expect(host.life()?.event).toBe('opponent-joined')
    // And the newcomer is not told about themselves.
    expect(guest.life()).toBeNull()

    room.advance(1)
    expect(room.state.match.phase).toBe(MatchPhase.Live)
    expect(room.state.match.round).toBe(1)
  })

  it('refuses a third player with a sentence rather than silence', async () => {
    const { room } = hosted()
    await connect(room)
    await connect(room)
    const third = await connect(room)

    expect(third.heard[0]).toMatchObject({ t: 'fault', code: 'room-full' })
    expect(third.closes[0]?.[0]).toBe(CLOSE_ROOM_FULL)
    expect(room.peers).toHaveLength(2)
  })

  it('keeps simulating a disconnected body, and tells the opponent with a countdown', async () => {
    const { clock, room, host, guest } = await duelling()

    // Put the host's body in the air, so that "the world kept simulating it" is
    // a claim with something to measure: a body that is standing on the floor
    // looks the same whether or not gravity ran.
    host.send(Array.from({ length: 8 }, () => ROCKET_AT_FEET))
    await settleLoopback(host.pair)
    room.advance(8)
    const launched = findPlayer(room.state, 0)
    expect(launched?.velocity[2] ?? 0).toBeGreaterThan(0)
    const launchedAt = launched?.origin.slice() ?? [0, 0, 0]

    host.pair.close()
    await settleLoopback(host.pair)
    await settleLoopback(guest.pair)

    // The seat is held rather than freed, and the opponent is told immediately.
    expect(room.seats[0]?.phase).toBe(SeatPhase.Vacant)
    expect(room.peers).toHaveLength(1)
    expect(guest.life()?.event).toBe('opponent-left')
    expect(guest.life()?.graceMs).toBe(RECONNECT_GRACE_MS)
    expect(guest.life()?.detail).toContain('30s')

    // The round did not pause: the world advanced, and the body it was steering
    // kept being simulated with no input at all — it flew, landed, and came to
    // rest. Standing still and killable is the whole disconnect policy, and the
    // alternative (removing the body) would make pulling a cable the cheapest
    // way to deny an opponent a frag they had already earned.
    const before = room.tick
    room.advance(2 * TICK_RATE)
    expect(room.tick).toBe(before + 2 * TICK_RATE)
    expect(room.state.match.phase).toBe(MatchPhase.Live)

    const settled = findPlayer(room.state, 0)
    expect(settled).not.toBeNull()
    expect(settled?.origin).not.toEqual(launchedAt)
    expect((settled?.flags ?? 0) & EntityFlag.OnGround).not.toBe(0)
    const speed = Math.sqrt(
      (settled?.velocity[0] ?? 0) * (settled?.velocity[0] ?? 0) +
        (settled?.velocity[1] ?? 0) * (settled?.velocity[1] ?? 0),
    )
    expect(speed).toBeLessThan(1)
    // Still in the world, still alive, still something a rocket can reach.
    expect(settled?.health).toBeGreaterThan(0)

    clock.advance(1)
    expect(room.snapshot().held).toBe(1)
  })

  it('holds the seat through an intermission too', async () => {
    const { room, host, guest } = await duelling()

    // Decide the round the only way two players who cannot see each other can:
    // on the clock, by damage taken. The host spends armour on the floor.
    const frames = Math.ceil(QUICK_RULES.roundTimeLimitTicks / 2) + 4
    for (let frame = 0; frame < frames; frame += 1) {
      host.send([ROCKET_AT_FEET, ROCKET_AT_FEET])
      guest.send([IDLE, IDLE])
      await settleLoopback(host.pair)
      await settleLoopback(guest.pair)
      room.advance(2)
      if (room.state.match.phase !== MatchPhase.Live) break
    }
    expect(room.state.match.phase).toBe(MatchPhase.Intermission)
    expect(room.state.match.wins).toEqual([0, 1])

    host.pair.close()
    await settleLoopback(host.pair)
    expect(room.seats[0]?.phase).toBe(SeatPhase.Vacant)
    // A match between rounds is still a match: the seat is held on exactly the
    // same terms, and the score it is being held over is untouched.
    expect(room.state.match.wins).toEqual([0, 1])
  })

  it('gives the seat and the score back to a reconnect inside the window', async () => {
    const { clock, room, host, guest } = await duelling()

    // Put a round on the board first, so "the score survived" has something to
    // survive.
    room.state.match.wins[0] = 1
    room.state.match.wins[1] = 2
    const token = host.token()
    const tickAtDrop = room.tick

    host.pair.close()
    await settleLoopback(host.pair)
    await idleAlong(room, clock, guest, RECONNECT_GRACE_MS - 1_000)
    room.advance(TICK_RATE)

    const back = await connect(room, token)
    expect(back.heard.find((frame) => frame.t === 'welcome')).toBeDefined()
    expect(back.token()).toBe(token)
    expect(room.seats[0]?.phase).toBe(SeatPhase.Live)
    expect(room.peers.map((peer) => peer.slot).sort()).toEqual([0, 1])

    // The match is the one they left: same round, same score, still live, and
    // the world carried on while they were away.
    expect(room.state.match.phase).toBe(MatchPhase.Live)
    expect(room.state.match.wins).toEqual([1, 2])
    expect(room.tick).toBeGreaterThan(tickAtDrop)

    // And the other player is told the countdown is over.
    await settleLoopback(guest.pair)
    expect(guest.life()?.event).toBe('opponent-back')
  })

  it('awards the match when the window closes, and says so', async () => {
    const { clock, room, host, guest } = await duelling()
    const token = host.token()

    host.pair.close()
    await settleLoopback(host.pair)
    await idleAlong(room, clock, guest, RECONNECT_GRACE_MS)
    await settleLoopback(guest.pair)

    // The round in progress is awarded, and the match with it. The score reads
    // as the rounds that were played, and the winner is the player who stayed.
    expect(room.state.match.phase).toBe(MatchPhase.Over)
    expect(room.state.match.winner).toBe(1)
    expect(room.state.match.wins).toEqual([0, 1])
    expect(guest.life()?.event).toBe('forfeit')
    expect(guest.life()?.detail).toContain('forfeit')
    expect(room.snapshot().ended).toBe(true)

    // And the seat's key is now a key to nothing — a clean sentence, not a hang
    // and not a ghost peer.
    const late = await connect(room, token)
    expect(late.heard[0]).toMatchObject({ t: 'fault', code: 'match-ended' })
    expect(late.closes[0]?.[0]).toBe(CLOSE_MATCH_ENDED)
    expect(room.peers).toHaveLength(1)
    expect(room.seats.some((seat) => seat.peerId === 'peer-3')).toBe(false)
  })

  it('abandons a match both of whose players stopped answering', async () => {
    const { clock, room, host, guest } = await duelling()

    host.pair.close()
    guest.pair.close()
    await settleLoopback(host.pair)
    await settleLoopback(guest.pair)
    expect(room.peers).toHaveLength(0)
    expect(room.seats.every((seat) => seat.phase === SeatPhase.Vacant)).toBe(true)

    // With nobody watching, the world stands still — the same rule as a room
    // nobody has joined — while the windows keep running on wall-clock.
    const parked = room.tick
    room.advance(TICK_RATE)
    expect(room.tick).toBe(parked)

    clock.advance(RECONNECT_GRACE_MS)
    room.sweep(clock.nowMs())

    // Nobody to award it to, so nobody gets it.
    expect(room.state.match.phase).toBe(MatchPhase.Over)
    expect(room.state.match.winner).toBe(NO_WINNER)
    expect(room.snapshot().ended).toBe(true)
  })

  it('lets one of two vanished players come back and find they won', async () => {
    // The ordering that makes `ended` mean "no new seats" rather than "no seats":
    // the survivor's window had not run out when their opponent's did.
    const clock = manualClock()
    const { room, host, guest } = await duelling(clock)
    const guestToken = guest.token()

    host.pair.close()
    await settleLoopback(host.pair)
    clock.advance(RECONNECT_GRACE_MS - 5_000)
    guest.pair.close()
    await settleLoopback(guest.pair)

    clock.advance(5_000)
    room.sweep(clock.nowMs())
    expect(room.state.match.winner).toBe(1)

    const back = await connect(room, guestToken)
    expect(back.heard.find((frame) => frame.t === 'welcome')).toBeDefined()
    expect(back.token()).toBe(guestToken)
    expect(room.state.match.phase).toBe(MatchPhase.Over)
  })

  it('hands the seat to a second tab and closes the first', async () => {
    const { room, host } = await duelling()
    const token = host.token()

    const second = await connect(room, token)
    await settleLoopback(host.pair)

    expect(second.heard.find((frame) => frame.t === 'welcome')).toBeDefined()
    expect(host.heard.some((frame) => frame.t === 'fault' && frame.code === 'replaced')).toBe(true)
    expect(host.closes[0]?.[0]).toBe(CLOSE_REPLACED)
    // One seat, one peer in it — never two peers steering one slot.
    expect(room.peers.filter((peer) => peer.slot === 0)).toHaveLength(1)
    expect(room.peers).toHaveLength(2)
  })

  it('says nothing about opponents when the room itself is being closed', async () => {
    // A room going away is not two players leaving. Closing it peer by peer
    // would have the first close read as a *departure*: the other player would
    // be told their opponent dropped and shown a forfeit countdown, a moment
    // before their own socket closed too — and on a deploy that countdown is
    // over a room that is being demolished (GLAD-G41FQ9's `shutdown.ts` closes
    // through here for exactly this reason).
    const { room, host, guest } = await duelling()
    const before = { host: host.life(), guest: guest.life() }

    room.close(CloseReason.GoingAway, 'server shutting down')
    await settleLoopback(host.pair)
    await settleLoopback(guest.pair)

    expect(host.life()).toEqual(before.host)
    expect(guest.life()).toEqual(before.guest)
    expect(host.closes[0]?.[0]).toBe(CloseReason.GoingAway)
    expect(guest.closes[0]?.[0]).toBe(CloseReason.GoingAway)
    // And no seat was vacated, so nothing is counting down towards a forfeit
    // in a room that no longer exists.
    expect(room.snapshot().held).toBe(0)
    expect(room.seats.every((seat) => seat.phase === SeatPhase.Live)).toBe(true)
  })

  it('vacates the seat of a socket that went quiet without closing', async () => {
    const clock = manualClock()
    const { room, host, guest } = await duelling(clock)

    // No close event at all — the half-open case, which is what the idle
    // timeout is for. It runs *before* the grace window rather than beside it,
    // which is what bounds the worst case at 40 seconds rather than 90.
    clock.advance(DEFAULT_IDLE_TIMEOUT_MS)
    guest.send([IDLE])
    await settleLoopback(guest.pair)
    room.sweep(clock.nowMs())
    await settleLoopback(host.pair)

    expect(room.seats[0]?.phase).toBe(SeatPhase.Vacant)
    expect(room.state.match.phase).toBe(MatchPhase.Live)

    await idleAlong(room, clock, guest, RECONNECT_GRACE_MS)
    expect(room.state.match.phase).toBe(MatchPhase.Over)
    expect(room.state.match.winner).toBe(1)
  })
})

/* --------------------------------------------------------------------------
 * The registry
 * ----------------------------------------------------------------------- */

describe('room garbage collection', () => {
  it('reaps a room nobody is in, and only once its TTL has passed', () => {
    const clock = manualClock()
    const registry = createRoomRegistry({
      clock,
      create: (code) =>
        createRoom({
          map: SERVER_MAP,
          plan: SERVER_PLAN,
          clock,
          build: 'test',
          id: code,
        }),
    })

    const opened = registry.create()
    expect(opened).not.toBeNull()
    const code = opened?.code ?? ''
    expect(registry.get(code)).not.toBeNull()

    // Empty from the instant it exists, but not yet expired.
    clock.advance(EMPTY_ROOM_TTL_MS - 1)
    registry.sweep(clock.nowMs())
    expect(registry.size).toBe(1)
    expect(registry.get(code)).not.toBeNull()

    clock.advance(1)
    registry.sweep(clock.nowMs())

    // Gone from the registry, and the code it held is back in the space.
    expect(registry.size).toBe(0)
    expect(registry.codes()).toEqual([])
    expect(registry.get(code)).toBeNull()
    expect(registry.stats()).toMatchObject({ rooms: 0, reaped: 1, created: 1 })
  })

  it('keeps a room whose only player is inside their reconnect window', () => {
    // The inequality asserted above, as behaviour: a room with no peers is not
    // necessarily a room with no *seats*, and reaping one out from under a
    // reconnect is the failure this ordering exists to prevent.
    const clock = manualClock()
    const registry = createRoomRegistry({
      clock,
      create: (code) =>
        createRoom({ map: SERVER_MAP, plan: SERVER_PLAN, clock, build: 'test', id: code }),
    })
    const opened = registry.create()
    const room = opened?.room
    if (room === undefined) throw new Error('no room')

    const pair = createLoopbackPair()
    room.join(pair.server)
    pair.close()

    clock.advance(RECONNECT_GRACE_MS)
    registry.sweep(clock.nowMs())
    expect(registry.size).toBe(1)
  })
})
