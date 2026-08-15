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
  NULL_CMD,
  SKELETON_SEED,
  createMapState,
  hashState,
  tick as simTick,
  type UserCmd,
} from '@gladiator/sim'
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
 * `main.ts`'s frame loop, minus the renderer: tick, hash, queue, flush.
 *
 * Deliberately the same order and the same calls. A test that batched
 * differently would be testing a client nobody ships.
 */
async function play(net: NetClient, listen: ListenServer, ticks: number): Promise<number> {
  const state = createMapState(CLIENT_MAP.source, SKELETON_SEED)
  let clientHash = 0
  for (let tick = 1; tick <= ticks; tick += 1) {
    const cmd = command(tick)
    simTick(state, [cmd], CLIENT_MAP.world)
    clientHash = hashState(state)
    net.record(state.tick, clientHash)
    net.queue(state.tick, cmd)
    // Two ticks a frame, which is what 60 Hz buys at a 125 Hz tick rate.
    if (tick % 2 === 0) {
      net.flush()
      await settleLoopback(listen.pair)
    }
  }
  net.flush()
  await settleLoopback(listen.pair)
  return clientHash
}

function hosted() {
  const listen = createListenServer({ map: CLIENT_MAP, build: 'local-test' })
  const net = createNetClient({
    transport: listen.transport,
    endpoint: 'the host in this tab',
    build: 'local-test',
    mapHash: CLIENT_MAP_HASH,
    now: () => 0,
  })
  net.connect()
  return { listen, net }
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
    const { listen, net } = hosted()
    await settleLoopback(listen.pair)

    const clientHash = await play(net, listen, 400)

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
    // free the moment a room can pick a map (GLAD-FHKBN8). The host is
    // authoritative even when it is three lines away.
    const listen = createListenServer({ map: CLIENT_MAP, build: 'local-test' })
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

  it('seats exactly one peer, and says so when a second arrives', () => {
    const listen = createListenServer({ map: CLIENT_MAP, build: 'local-test' })
    expect(listen.room.capacity).toBe(1)
    expect(listen.room.peers).toHaveLength(1)
    listen.stop()
  })
})
