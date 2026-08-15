/**
 * The input buffer policy: what the server does when a command arrives late,
 * out of order, twice, too fast, or never.
 *
 * This is the single largest determinant of how the game feels under a real
 * network, and every answer is wrong in a different way, so all of them are
 * written down here with the reasoning rather than discovered by whoever
 * changes it next. The summary lives in `AGENTS.md` under **The input buffer
 * policy**; this file is the executable copy.
 *
 * ## One queue per peer, drained one command per server tick
 *
 * The server ticks at a fixed 125 Hz on its own clock (the scheduler is
 * GLAD-FHKBN8). Each tick it takes exactly one command per player and hands it
 * to `tick()`. The queue in front of that is a jitter buffer: it holds
 * {@link JITTER_BUFFER_TICKS} commands on purpose, so that the *next* tick has
 * something to execute even when the packet carrying it is 16 ms late.
 *
 * Deeper is not better. Every buffered command is a tick of latency the player
 * paid for and cannot get back, so the buffer is kept shallow and the depth is
 * corrected continuously rather than allowed to wander.
 *
 * ## The tick label is for admission, not for scheduling
 *
 * A command carries the tick the client predicted it into. That number decides
 * whether the command is *accepted* — duplicates and commands whose moment has
 * passed are refused by it — and the order the queue holds them in. It does not
 * decide which server tick executes them: the head of the queue executes next,
 * whatever it is labelled. That is what a jitter buffer is for. Trying to
 * execute command T at server tick T exactly would mean stalling whenever it
 * was late, and a stall on one peer's socket is a hitch in the *other* peer's
 * game — the one failure this policy will not accept.
 *
 * ## The four ways a command goes wrong
 *
 * - **Duplicate** — a tick already in the buffer. Dropped. The transport
 *   promises exactly-once (`sim/src/transport.ts`), so a second copy is a
 *   client bug or a harness; executing it would be a free extra tick of
 *   movement, which is the speedhack this file also exists to prevent.
 * - **Out of order** — a tick below one already buffered, but not yet executed.
 *   **Kept**, inserted in tick order. It is still the player's intent for a
 *   moment that has not happened yet, and dropping it would insert a fallback
 *   command in its place for no reason.
 * - **Late** — a tick at or below the last one executed. Dropped. Applying it
 *   would mean rewinding the world for *input*, and the world is only ever
 *   rewound for *hits* (lag compensation, GLAD-5QGO11). One is a shared
 *   authority the other player also lives in; the other is a private opinion.
 * - **Missing** — nothing in the buffer when the tick comes. The fallback,
 *   below. Never a stall.
 *
 * ## The missing-command fallback: repeat the last one, minus the trigger
 *
 * The three candidates and what each costs:
 *
 * - *Stall the tick* — refused outright. The world is shared, so one peer's
 *   packet loss would hitch the other peer's game, and the round would be
 *   decided by whose ISP was worse.
 * - *Insert an empty command* — zeroes `forwardMove` and `sideMove`, which are
 *   exactly the two numbers air control reads. A player mid strafe-jump stops
 *   accelerating and drops out of the hop. One lost packet, and the movement
 *   the whole game is built around visibly breaks.
 * - *Repeat the last command* — the player keeps holding what they were
 *   holding. Angles are absolute in a `UserCmd`, so a repeat holds the aim
 *   still rather than continuing to turn; only the movement axes and the
 *   buttons carry over, which is precisely the intent that was continuous.
 *
 * So: **repeat the last command, with {@link BUTTON_ATTACK} cleared, for at
 * most {@link MAX_REPEAT_TICKS} consecutive ticks; after that a command that
 * holds the angles and the weapon and zeroes everything else.**
 *
 * Two things in that sentence are the whole decision:
 *
 * **The trigger is cleared** because firing is an *edge* and movement is a
 * *state*. Repeating "still holding forward" reproduces an intent the player
 * genuinely still has; repeating "still holding fire" invents rockets they
 * never asked for, and both weapons are fully automatic, so it would keep
 * inventing one every refire interval until the packets came back. A round lost
 * to a rocket nobody fired is not a round anybody accepts.
 *
 * **The repeat is bounded** because the open question in this ticket's plan is
 * real: repeat-last means a disconnected player keeps running. At half a second
 * the body stops, so a player whose connection died mid-strafe comes to rest on
 * the ledge instead of sprinting off it, and the connection lifecycle
 * (GLAD-DVDV6P) inherits a body that has stopped rather than one still moving.
 * That is this ticket's half of the disconnect policy; *when* a silent peer is
 * declared gone is that ticket's half, and 500 ms is deliberately far shorter
 * than any timeout it could reasonably choose, so the two cannot disagree.
 *
 * ## Drift: two commands consumed in one tick, never two applied
 *
 * A client whose clock runs fast delivers more than one command per server
 * tick, and the buffer grows. Left alone it would grow without bound and every
 * command in it would be added latency. So when the buffer is deeper than
 * {@link JITTER_BUFFER_TICKS} after a take, the take **consumes two commands
 * and applies one**, merged: the newer command's angles and axes, with the
 * buttons of both OR'd together.
 *
 * Consumed, not applied. Applying both would advance that player through two
 * ticks of movement in one tick of the world, which is the speedhack. Merging
 * rather than discarding is what keeps a jump or a shot in the dropped command
 * from being lost — a button press survives, at worst 8 ms early.
 *
 * ## The rate limit is the actual anti-speedhack
 *
 * Bounding the buffer caps how far *ahead* a client can get. It does not by
 * itself cap how much of the world's time a client can consume, because the
 * drift correction above will happily keep consuming two per tick. The cap is
 * therefore explicit and in the only unit that matters: **commands per
 * wall-clock second**, measured on the server's clock, {@link COMMAND_BUDGET}
 * of them with a {@link COMMAND_BURST} allowance for a batch that arrived in a
 * clump. A client sending 500 Hz of input has 375 of every 500 commands refused
 * at the door and moves at exactly the speed everyone else does.
 *
 * The burst is what makes an honest client at 30 fps indistinguishable from a
 * cheat: it sends four commands per frame in one batch, and a bucket with no
 * burst allowance would refuse three of them.
 *
 * ## No clock in here
 *
 * `nowMs` is an argument, as it is everywhere on the authoritative side. This
 * module runs inside a browser tab as part of the listen server, and
 * `room.isomorphic.test.ts` fails the build on a `Date.now()` that appears
 * anywhere reachable from `room.ts`.
 */
import { BUTTON_ATTACK, TICK_RATE, type UserCmd } from '@gladiator/sim'

import { createTokenBucket } from './rateLimit.ts'

/**
 * How many commands the buffer holds on purpose, in ticks.
 *
 * Two, which is 16 ms — one tick of slack for a packet that arrives a frame
 * late, and one for the tick it was going to be executed on anyway. It is also
 * the number the client adds to its own lead (`client/net/clockSync.ts`), so
 * the two ends are aiming at the same depth rather than at two numbers that
 * happen to be close.
 *
 * Bigger buffers hide more jitter and cost every player the latency all the
 * time. This is a duel; the trade goes the other way.
 */
export const JITTER_BUFFER_TICKS = 2

/**
 * The hard ceiling on buffered commands.
 *
 * 32 is 256 ms of input — well past anything the drift correction should ever
 * let build up, so hitting it means a client is running away rather than merely
 * jittering. The ceiling exists so that a hostile client cannot make the server
 * hold an unbounded array by simply sending faster than it is drained; the
 * drift correction is what keeps an honest one nowhere near it.
 */
export const MAX_BUFFERED_COMMANDS = 32

/**
 * How long the missing-command fallback repeats before giving up, in ticks.
 *
 * 62 ticks is 496 ms. See the header: long enough to cover any loss burst worth
 * papering over, short enough that a disconnected player comes to rest instead
 * of running off the map.
 */
export const MAX_REPEAT_TICKS = 62

/**
 * Commands a peer may have executed per wall-clock second.
 *
 * Exactly the tick rate, because that is exactly how many the world has room
 * for. Not a tuned number: a client that needs more than one command per tick
 * is a client asking for more than one tick.
 */
export const COMMAND_BUDGET = TICK_RATE

/**
 * How far the rate limit lets a client run ahead of its own budget.
 *
 * 32 commands, the same 256 ms as {@link MAX_BUFFERED_COMMANDS}. A client at
 * 30 fps produces four commands per frame and sends them in one batch, and a
 * browser that misses a frame sends eight; refusing those would be refusing
 * honest input. Anything past a quarter of a second of it is not a frame rate,
 * it is a clock running fast.
 */
export const COMMAND_BURST = 32

/** What happened to a command offered to the queue. */
export const CommandFate = {
  /** Accepted, and holding a place in tick order. */
  Queued: 'queued',
  /** A tick already in the buffer. See the header. */
  Duplicate: 'duplicate',
  /** A tick whose moment has already been executed. */
  Late: 'late',
  /** The buffer is at {@link MAX_BUFFERED_COMMANDS}. */
  Overflow: 'overflow',
  /** Over {@link COMMAND_BUDGET} commands per second. */
  RateLimited: 'rate-limited',
} as const

export type CommandFate = (typeof CommandFate)[keyof typeof CommandFate]

/** Where the command a tick executed came from. */
export const CommandFill = {
  /** One buffered command, executed as sent. The steady state. */
  Fresh: 'fresh',
  /** Two consumed and merged, because the buffer was too deep. */
  Merged: 'merged',
  /** Nothing buffered: the last command again, without the trigger. */
  Repeat: 'repeat',
  /** Nothing buffered for {@link MAX_REPEAT_TICKS}: angles held, the rest zero. */
  Idle: 'idle',
  /** Nothing buffered and nothing ever received. `null`, and the kernel's own
   *  default applies. */
  Empty: 'empty',
} as const

export type CommandFill = (typeof CommandFill)[keyof typeof CommandFill]

export type TakenCommand = {
  /** The command for this tick, or `null` when the peer has never sent one. */
  readonly cmd: UserCmd | null
  readonly fill: CommandFill
  /** Buffered commands this take removed: 0, 1 or 2. Never more. */
  readonly consumed: number
}

export type InputQueueStats = {
  readonly accepted: number
  readonly duplicate: number
  readonly late: number
  readonly overflow: number
  readonly rateLimited: number
  /** Commands executed, one per {@link InputQueue.take}. */
  readonly executed: number
  /** Takes that consumed two commands. Drift being corrected. */
  readonly merged: number
  /** Takes that found nothing buffered — the fallback, in either form. */
  readonly starved: number
  /** Commands that arrived below a tick already buffered and were kept. */
  readonly reordered: number
}

export type InputQueue = {
  /**
   * Offer a command for `tick`, received at `nowMs` on the server's clock.
   *
   * The tick is the one the client predicted the command into. Returns what
   * became of it; the caller never has to ask a second question.
   */
  offer(tick: number, cmd: UserCmd, nowMs: number): CommandFate
  /** Take the command for the next server tick. Never stalls, never throws. */
  take(): TakenCommand
  /** Buffered and not yet executed. */
  readonly depth: number
  /** The tick label of the last command executed, or the start tick. */
  readonly executedTick: number
  /** Consecutive takes that have found nothing buffered. */
  readonly starving: number
  readonly stats: InputQueueStats
}

export type InputQueueOptions = {
  /** Commands at or below this tick are late on arrival. Defaults to 0. */
  readonly startTick?: number
  readonly target?: number
  readonly capacity?: number
  readonly maxRepeatTicks?: number
  /** Commands per wall-clock second. Zero turns the limit off. */
  readonly budgetPerSecond?: number
  readonly burst?: number
}

type Buffered = {
  readonly tick: number
  readonly cmd: UserCmd
}

/**
 * Fold two commands into one.
 *
 * The newer command's angles, axes and weapon — a state value is superseded by
 * the next one, so keeping the older would be keeping a stale opinion about
 * where the player is looking. The buttons of both, because a button is an
 * *edge*: a jump or a shot in the older command is a thing the player asked
 * for, and merging it forward costs at most 8 ms of earliness where dropping it
 * costs the whole press.
 */
export function mergeCommands(older: UserCmd, newer: UserCmd): UserCmd {
  return { ...newer, buttons: older.buttons | newer.buttons }
}

/**
 * The command a repeat sends: the last one, with the trigger released.
 *
 * Jump is deliberately left alone. `PM_CheckJump` latches on a held button and
 * only unlatches when it is released (`pmove/index.ts`), so a repeated hold can
 * never manufacture a second jump — it can only preserve the state the player
 * was in, which is the point.
 */
export function repeatCommand(last: UserCmd): UserCmd {
  return last.buttons === 0 ? last : { ...last, buttons: last.buttons & ~BUTTON_ATTACK }
}

/**
 * The command a peer gets once the repeat has run out: still looking where they
 * were looking, holding what they were holding, and doing nothing.
 *
 * The angles are kept rather than zeroed because the kernel writes a steered
 * player's angles from its command, and a zeroed yaw would snap the body to due
 * north — a thing the other player would watch happen.
 */
export function idleCommand(last: UserCmd): UserCmd {
  return { ...last, forwardMove: 0, sideMove: 0, buttons: 0 }
}

export function createInputQueue(options: InputQueueOptions = {}): InputQueue {
  const target = options.target ?? JITTER_BUFFER_TICKS
  const capacity = options.capacity ?? MAX_BUFFERED_COMMANDS
  const maxRepeatTicks = options.maxRepeatTicks ?? MAX_REPEAT_TICKS
  const budgetPerSecond = options.budgetPerSecond ?? COMMAND_BUDGET
  const burst = options.burst ?? COMMAND_BURST

  const buffer: Buffered[] = []
  let executedTick = options.startTick ?? 0
  let last: UserCmd | null = null
  let starving = 0

  // The token bucket. Full to begin with, and its clock starts at the first
  // command rather than at construction: a room may sit empty for a minute
  // before anybody joins, and a peer should not arrive to a bucket that has
  // been notionally refilling since the process booted. `rateLimit.ts` holds
  // that arithmetic, because it is also what bounds frames, bytes and
  // connections and four copies of it would be four opinions about a clock that
  // went backwards.
  const bucket = createTokenBucket({ ratePerSecond: budgetPerSecond, burst })

  const stats = {
    accepted: 0,
    duplicate: 0,
    late: 0,
    overflow: 0,
    rateLimited: 0,
    executed: 0,
    merged: 0,
    starved: 0,
    reordered: 0,
  }

  return {
    offer(tick: number, cmd: UserCmd, nowMs: number): CommandFate {
      if (tick <= executedTick) {
        stats.late += 1
        return CommandFate.Late
      }
      // Scanned rather than hashed: the buffer is bounded at 32 entries and
      // this runs once per received command, so a Map would be more allocation
      // than arithmetic. Walked from the back because the common case — a
      // command that follows the last one — matches on the first comparison.
      let at = buffer.length
      while (at > 0) {
        const held = buffer[at - 1]
        if (held === undefined) break
        if (held.tick === tick) {
          stats.duplicate += 1
          return CommandFate.Duplicate
        }
        if (held.tick < tick) break
        at -= 1
      }

      // Refused *before* the rate limit is charged for it. A client that is
      // running away should not also be able to spend its neighbour's budget,
      // and a bucket drained by commands that were never queued would punish
      // the peer twice for one mistake.
      if (buffer.length >= capacity) {
        stats.overflow += 1
        return CommandFate.Overflow
      }
      if (!bucket.spend(1, nowMs)) {
        stats.rateLimited += 1
        return CommandFate.RateLimited
      }

      if (at < buffer.length) stats.reordered += 1
      buffer.splice(at, 0, { tick, cmd })
      stats.accepted += 1
      return CommandFate.Queued
    },

    take(): TakenCommand {
      const head = buffer.shift()
      if (head === undefined) {
        stats.starved += 1
        starving += 1
        if (last === null) return { cmd: null, fill: CommandFill.Empty, consumed: 0 }
        const fill = starving > maxRepeatTicks ? CommandFill.Idle : CommandFill.Repeat
        const cmd = fill === CommandFill.Idle ? idleCommand(last) : repeatCommand(last)
        // The fallback becomes the new `last`, so a repeat that has decayed to
        // idle stays idle rather than springing back to a half-second-old
        // sprint the moment the trigger is cleared again.
        last = cmd
        return { cmd, fill, consumed: 0 }
      }

      starving = 0
      stats.executed += 1
      executedTick = head.tick

      // Deeper than the target *after* taking the head means the client is
      // ahead of us and the extra depth is pure latency. One more is consumed
      // and merged in, which walks the buffer back down a tick per tick.
      if (buffer.length > target) {
        const next = buffer.shift()
        if (next !== undefined) {
          executedTick = next.tick
          stats.merged += 1
          const cmd = mergeCommands(head.cmd, next.cmd)
          last = cmd
          return { cmd, fill: CommandFill.Merged, consumed: 2 }
        }
      }

      last = head.cmd
      return { cmd: head.cmd, fill: CommandFill.Fresh, consumed: 1 }
    },

    get depth() {
      return buffer.length
    },

    get executedTick() {
      return executedTick
    },

    get starving() {
      return starving
    },

    get stats(): InputQueueStats {
      return { ...stats }
    },
  }
}
