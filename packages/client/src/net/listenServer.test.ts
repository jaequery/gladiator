/**
 * Single-player, end to end, through the multiplayer code path.
 *
 * The client here is the same `createNetClient` a duel on Fly uses, driven the
 * same way `main.ts` drives it: simulate a tick, record the hash, queue the
 * command, flush. The only difference is which `Transport` it was handed. If
 * these hashes ever stop agreeing, either the host in this tab is not the host
 * on the server or the loopback is not carrying what a socket would — and both
 * are the failure this whole ticket exists to make impossible.
 */
import {
  MatchPhase,
  NULL_CMD,
  SKELETON_SEED,
  createMapState,
  hashState,
  tick as simTick,
  type UserCmd,
} from '@gladiator/sim'
import { manualClock, type ManualClock } from '@gladiator/server/clock'
import { settleLoopback } from '@gladiator/server/net/loopbackTransport'
import { describe, expect, it } from 'vitest'

import { CLIENT_MAP, CLIENT_MAP_HASH } from '../map.ts'
import { createNetClient, type NetClient } from './client.ts'
import { createListenServer, type ListenServer } from './listenServer.ts'

/** A movement script with a turn in it, so the run exercises more than one axis. */
function command(tick: number): UserCmd {
  return {
    ...NULL_CMD,
    forwardMove: 1,
    sideMove: tick % 60 < 30 ? 1 : -1,
    yaw: (tick * 53) % 65536,
    buttons: tick % 40 === 0 ? 1 : 0,
  }
}

/**
 * `main.ts`'s frame loop, minus the renderer: beat the host, tick, hash, queue,
 * flush.
 *
 * Deliberately the same order and the same calls. A test that batched
 * differently would be testing a client nobody ships. The beat is the half that
 * makes this tab a *host*: a `Room` holds no timer, so the animation frame is
 * what turns wall-clock into sub-steps and runs them (GLAD-FHKBN8).
 */
async function play(
  net: NetClient,
  listen: ListenServer,
  clock: ManualClock,
  ticks: number,
): Promise<number> {
  const state = createMapState(CLIENT_MAP.source, SKELETON_SEED)
  let clientHash = 0
  let nowMs = 0
  // The frame loop's first frame, which is worth no simulated time: there is no
  // previous one to measure against. Priming it here is what a tab does by
  // simply having run a frame before the player pressed anything, and skipping
  // it would leave the host a frame behind for the whole run — which the jitter
  // buffer would then spend the run merging back down.
  listen.beat(nowMs)
  for (let tick = 1; tick <= ticks; tick += 1) {
    const cmd = command(tick)
    simTick(state, [cmd], CLIENT_MAP.world)
    clientHash = hashState(state)
    net.record(state.tick, clientHash)
    net.queue(state.tick, cmd)
    // Two ticks a frame, which is what 60 Hz buys at a 125 Hz tick rate. The
    // commands go out first and the host's frame runs after them, so every
    // sub-step has the command it was predicted with — which is the condition a
    // client with a correct lead reaches and this one reaches by construction.
    if (tick % 2 === 0) {
      net.flush()
      await settleLoopback(listen.pair)
      nowMs += 16
      clock.set(nowMs)
      listen.beat(nowMs)
      await settleLoopback(listen.pair)
    }
  }
  net.flush()
  await settleLoopback(listen.pair)
  return clientHash
}

function hosted(clock = manualClock()) {
  const listen = createListenServer({ map: CLIENT_MAP, build: 'local-test', clock })
  const net = createNetClient({
    transport: listen.transport,
    endpoint: 'the host in this tab',
    build: 'local-test',
    mapHash: CLIENT_MAP_HASH,
    now: () => 0,
  })
  net.connect()
  return { listen, net, clock }
}

describe('the listen server', () => {
  it('welcomes the local client over the loopback', async () => {
    const { listen, net } = hosted()
    await settleLoopback(listen.pair)

    const snapshot = net.snapshot()
    expect(snapshot.status).toBe('live')
    expect(snapshot.serverMapHash).toBe(CLIENT_MAP_HASH)
    expect(snapshot.message).toContain('build local-test')
    listen.stop()
  })

  it('agrees with the host in this tab at every hash it compares', async () => {
    const { listen, net, clock } = hosted()
    await settleLoopback(listen.pair)

    const clientHash = await play(net, listen, clock, 400)

    const snapshot = net.snapshot()
    expect(snapshot.compared).toBeGreaterThan(150)
    expect(snapshot.mismatched).toBe(0)
    expect(snapshot.dropped).toBe(0)
    expect(snapshot.agree).toBe(true)
    // And the host really simulated it, rather than echoing what it was told.
    expect(listen.room.tick).toBe(400)
    expect(listen.room.hash()).toBe(clientHash)
    listen.stop()
  })

  it('refuses the local client if the two are somehow on different arenas', async () => {
    // Impossible from one bundle today, and exactly the check that stops being
    // free the moment a room can pick a map. The host is authoritative even
    // when it is three lines away.
    const listen = createListenServer({
      map: CLIENT_MAP,
      build: 'local-test',
      clock: manualClock(),
    })
    const net = createNetClient({
      transport: listen.transport,
      endpoint: 'the host in this tab',
      build: 'local-test',
      mapHash: CLIENT_MAP_HASH,
      mapHashOverride: '00000000',
    })
    net.connect()
    await settleLoopback(listen.pair)

    expect(net.snapshot().status).toBe('map-mismatch')
    expect(net.snapshot().message).toContain('reload')
    listen.stop()
  })

  it('advances the world on the frame loop, and only when time has passed', async () => {
    // The beat is the host's frame: it folds the wall-clock since the last one
    // into whole 8 ms sub-steps and runs them. `stepsFor` is the same
    // accumulator the Node scheduler uses, so a tab and a Fly machine turn a
    // frame into sub-steps by one rule rather than two that happen to agree.
    const { listen } = hosted()
    await settleLoopback(listen.pair)

    // The first beat is worth nothing: there is no previous frame to measure
    // against, and measuring against zero would be every millisecond since the
    // tab was opened.
    expect(listen.beat(1000)).toBe(0)
    expect(listen.room.tick).toBe(0)

    expect(listen.beat(1016)).toBe(2)
    expect(listen.beat(1032)).toBe(2)
    // Seven milliseconds buys nothing and is carried; the next frame gets it.
    expect(listen.beat(1039)).toBe(0)
    expect(listen.beat(1048)).toBe(2)
    expect(listen.room.tick).toBe(6)
    listen.stop()
  })

  it('runs clock sync over the loopback, on the frame loop as its beat', async () => {
    // A `Room` holds no timer, in a tab least of all. Without a beat the whole
    // clock-sync conversation would be dead code in single-player — and it is
    // exactly the code path a duel on Fly runs, so dead here means untested
    // there too.
    const { listen, net, clock } = hosted()
    await settleLoopback(listen.pair)
    expect(net.snapshot().pings).toBe(0)

    listen.beat(clock.advance(16))
    await settleLoopback(listen.pair)

    expect(net.snapshot().pings).toBe(1)
    // The client answered with a pong, and the host measured the trip against
    // its own clock — which over a loopback is a fraction of a millisecond.
    const rttMs = listen.room.peers[0]?.rttMs ?? -1
    expect(rttMs).toBeGreaterThanOrEqual(0)
    expect(rttMs).toBeLessThan(50)
    // And the clock-sync half of the beat advanced nothing on its own: the
    // first beat has no previous frame to measure against, so it is worth no
    // sub-steps.
    expect(listen.room.tick).toBe(0)
    listen.stop()
  })

  it('seats the player and keeps the other seat for the bot', () => {
    // Two seats, exactly as on Fly — one host, not a server and an offline mode
    // that resemble each other. The bot takes the second one over a loopback of
    // its own (GLAD-V7CMHR), and until it exists the world sits in warmup,
    // which is what a world with no match started in it has always been.
    const listen = createListenServer({ map: CLIENT_MAP, build: 'local-test' })
    expect(listen.room.capacity).toBe(2)
    expect(listen.room.peers).toHaveLength(1)
    expect(listen.room.state.match.phase).toBe(MatchPhase.Warmup)
    listen.stop()
  })

  it('names the room it is hosting, so the HUD reads the same field either way', () => {
    // A tab has no registry to be unique within, so the code is a constant —
    // but it is in the welcome, in the same field a code from Fly arrives in,
    // which is what keeps the menu flow (GLAD-NPCTU8) from needing a branch.
    const listen = createListenServer({ map: CLIENT_MAP, build: 'local-test' })
    expect(listen.room.identity.room).toBe('LOCAL1')
    listen.stop()
  })
})
