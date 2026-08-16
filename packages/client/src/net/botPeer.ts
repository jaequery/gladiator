/**
 * The bot, seated in the listen server's second seat.
 *
 * This is what `listenServer.ts` left a hole for: "the bot joins this room as a
 * second peer over a loopback of its own, which is why `Room` takes a capacity
 * rather than assuming one." It does exactly that. There is no bot branch
 * inside `Room`, no third kind of seat, and no code path that exists only in
 * single-player — the host cannot tell this peer from the one on the other end
 * of a socket, because the only thing it ever sees from either is a `hello` and
 * a stream of `cmds` frames.
 *
 * That is the whole reason it is built this way rather than as a callback the
 * room invokes per sub-step. A local hook would be a second way for input to
 * reach the simulation, and the second way is always the one that drifts: it
 * would skip the input queue, skip the frame guard, skip the admission rules,
 * and single-player would stop being the multiplayer code path the moment
 * anything in `session.ts` changed.
 *
 * ## What the bot is allowed to know
 *
 * It reads the host's `GameState` directly rather than the snapshots the wire
 * carries, and that is not a cheat — it is where the fairness boundary actually
 * lives. `botCommand` runs the perception layer first, and *that* is what
 * decides what the bot knows: field of view, line of sight, hearing, and a
 * decaying memory, with everything else discarded (`AGENTS.md`, **The bot's
 * perception, and the fairness boundary**). Feeding it a snapshot instead would
 * narrow the input to that filter without narrowing the filter, which buys no
 * fairness and costs the interpolation delay twice. `tools/bot-arena.ts` hands
 * the bot the same true state for the same reason, and it is the harness the
 * bot's difficulty was actually tuned against (GLAD-6BIYFQ).
 *
 * ## Tick labels are this peer's own, counted from one
 *
 * A command's tick label is "the peer's, not the world's" (`room.ts`, `join`) —
 * the admission window opens at zero and a batch must follow on from the last
 * one, or the session counts a gap. So this peer counts its own commands from
 * one and never looks at `room.tick`. Nothing has to be reconciled: the queue
 * executes its head whatever it is labelled, which is what a jitter buffer is
 * for.
 *
 * ## Why exactly `steps` commands per beat
 *
 * The room consumes one command per sub-step. Emitting exactly the number it is
 * about to run means the queue neither starves — which would repeat the last
 * command and hold the bot's feet down — nor grows past
 * `MAX_BUFFERED_COMMANDS`, and it keeps this peer inside `COMMAND_BUDGET`,
 * which is the same 125 Hz. The depth is primed with
 * {@link JITTER_BUFFER_TICKS} commands at the start so the very first advance
 * has something to execute.
 *
 * ## The frame of latency, which is left in on purpose
 *
 * A loopback delivers on a microtask, so commands generated during a beat land
 * *after* that beat's `advance` and are executed by the next one. The bot
 * therefore acts on a world roughly one frame plus the jitter buffer old — call
 * it 30 ms. It could have been removed by handing the room a callback, and it
 * is left in because a human peer pays it too, because it makes the bot
 * fractionally slower rather than fractionally faster, and because removing it
 * would have cost the property this whole module exists to keep.
 */
import {
  PROTOCOL_VERSION,
  encodeCmd,
  parseServerMessage,
  type LoadedMap,
  type UserCmd,
} from '@gladiator/sim'
import {
  SHIPPED_SKILL,
  type Bot,
  type BotSkill,
  type LoadedNav,
  botCommand,
  createBot,
} from '@gladiator/bot'
import { JITTER_BUFFER_TICKS } from '@gladiator/server/inputQueue'
import { createLoopbackPair, type LoopbackPair } from '@gladiator/server/net/loopbackTransport'
import type { Room } from '@gladiator/server/room'

export type BotPeerOptions = {
  /** The host to sit down at. Its second seat must be free. */
  readonly room: Room
  /** The map the room is authoritative over — the world the bot traces against. */
  readonly map: LoadedMap
  /** The graph it walks on, baked against that same map. `client/src/nav.ts`. */
  readonly nav: LoadedNav
  /** The build string, for the handshake. Must match the host's. */
  readonly build: string
  /** The bot's seeded stream. The same seed plays the same bot. */
  readonly seed?: number
  /** How good it is. The shipped difficulty unless a harness says otherwise. */
  readonly skill?: BotSkill
}

export type BotPeer = {
  /** The slot it was seated in, or {@link NO_BOT_SLOT} if the room refused it. */
  readonly slot: number
  /** The bot itself, for the diagnostics panel and for tests. */
  readonly bot: Bot
  /**
   * This peer's own pipe.
   *
   * Exposed for the one thing that needs it: a test has to drain *both*
   * loopbacks before it may assert, and `settleLoopback` returns as soon as the
   * pair it was handed is idle — which says nothing about this one.
   */
  readonly pair: LoopbackPair
  /** Commands this peer has offered the host. Diagnostics. */
  readonly offered: number
  /**
   * Decide, and send, the commands for the `steps` sub-steps the host is about
   * to run. Call immediately **before** `room.advance(steps)`.
   *
   * Before rather than after, because a bot's movement state is computed from
   * the body's position as it stands *now*; reading the two either side of a
   * `tick()` compares a decision against a position it never saw. That cost
   * `tools/bot-arena.ts` an afternoon and is why `actBotArena` is a separate
   * call from `advanceBotArena`.
   */
  beat(steps: number): void
  stop(): void
}

/** The slot of a bot the room would not seat. */
export const NO_BOT_SLOT = -1

/** The seed a bot plays under when nobody says. */
export const DEFAULT_BOT_SEED = 20260814

/**
 * Sit a bot down in `room` and hand back the handle that drives it.
 *
 * The room seats it synchronously, so {@link BotPeer.slot} is readable the
 * moment this returns; the `welcome` that confirms it arrives on a microtask
 * and is only ever read to notice a refusal.
 */
export function createBotPeer(options: BotPeerOptions): BotPeer {
  const pair: LoopbackPair = createLoopbackPair()
  const peer = options.room.join(pair.server)
  const slot = peer.slot

  const bot = createBot(
    slot < 0 ? 1 : slot,
    options.seed ?? DEFAULT_BOT_SEED,
    { world: options.map.world, nav: options.nav },
    options.skill ?? SHIPPED_SKILL,
  )

  /** The label of the last command offered. The peer's own space, from zero. */
  let lastTick = 0
  let offered = 0
  let refused = false
  let closed = false

  pair.client.setHandlers({
    onMessage: (raw) => {
      if (typeof raw !== 'string') return
      const parsed = parseServerMessage(raw)
      if (parsed === null) return
      // Pongs keep the round trip honest and cost nothing; a fault or a
      // mismatch means this peer is not playing, and the flag stops it
      // pointlessly pushing commands at a socket that has stopped listening.
      if (parsed.t === 'ping') {
        pair.client.send(JSON.stringify({ t: 'pong', id: parsed.id }))
        return
      }
      if (parsed.t === 'fault' || parsed.t === 'version_mismatch' || parsed.t === 'map_mismatch') {
        refused = true
      }
    },
    onClose: () => {
      closed = true
    },
  })

  // The same three fields a browser sends, and they are checked just as hard:
  // this peer is bundled with the host it is talking to, so a mismatch here
  // would mean the *build* is inconsistent with itself rather than that two
  // deploys drifted apart — which is worth finding out in a tab.
  pair.client.send(
    JSON.stringify({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      build: options.build,
      mapHash: options.map.hash,
    }),
  )

  const send = (cmds: readonly UserCmd[]): void => {
    if (cmds.length === 0) return
    const startTick = lastTick + 1
    lastTick += cmds.length
    offered += cmds.length
    pair.client.send(
      JSON.stringify({ t: 'cmds', startTick, cmds: cmds.map(encodeCmd) }),
    )
  }

  // Primed so the host's first advance has something to execute rather than
  // falling straight through to the missing-command fallback.
  const prime = (): void => {
    const opening: UserCmd[] = []
    for (let i = 0; i < JITTER_BUFFER_TICKS; i += 1) {
      opening.push(botCommand(bot, { state: options.room.state, world: options.map.world }))
    }
    send(opening)
  }

  if (slot >= 0) prime()

  return {
    slot,
    bot,
    pair,
    get offered() {
      return offered
    },

    beat(steps: number): void {
      if (slot < 0 || refused || closed || steps <= 0) return
      const batch: UserCmd[] = []
      for (let i = 0; i < steps; i += 1) {
        // Every command in a frame is decided from the same world, because the
        // world does not move until `advance` runs. That is the honest shape of
        // it: a human peer's frame is a single sample of the mouse too.
        batch.push(botCommand(bot, { state: options.room.state, world: options.map.world }))
      }
      send(batch)
    },

    stop: () => {
      closed = true
      pair.close()
    },
  }
}
