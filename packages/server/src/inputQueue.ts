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
 * So: **repeat the last command, with one-shot attack and dash bits cleared,
 * for at most {@link MAX_REPEAT_TICKS} consecutive ticks; after that a command that
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
 * command in it would be added latency. So when the buffer has been deeper than
 * {@link JITTER_BUFFER_TICKS} for {@link DRIFT_WINDOW_TICKS} takes running, the
 * take **consumes two commands and applies one**, merged: the newer command's
 * angles and axes, with the buttons of both OR'd together.
 *
 * Consumed, not applied. Applying both would advance that player through two
 * ticks of movement in one tick of the world, which is the speedhack. Merging
 * rather than discarding is what keeps a jump or a shot in the dropped command
 * from being lost — a button press survives, at worst 8 ms early.
 *
 * **"Has been", not "is".** Depth on its own does not mean a fast clock. A
 * browser ships a whole frame's worth of commands at once — two at 60 fps, four
 * at 30 — so depth sawtooths by a frame on a link with no jitter whatsoever.
 * Draining on the peak of that sawtooth empties the jitter buffer into the gap
 * it exists to cover, and the next gap starves: measured at 33% of sub-steps
 * merged and 36% starved over a localhost socket, against a client that was
 * supplying 0.98 commands per tick. The window is what separates the two
 * signals, and {@link DRIFT_WINDOW_TICKS} argues its length.
 *
 * ## The rate limit is the actual anti-speedhack
 *
 * Bounding the buffer caps how far *ahead* a client can get. It does not by
 * itself cap how much of the world's time a client can consume, because the
 * drift correction above will happily keep consuming two per tick. The cap is
 * therefore explicit and in the only unit that matters: **commands per
 * wall-clock second**, measured on the server's clock, {@link COMMAND_BUDGET}
 * of them with a {@link COMMAND_BURST} allowance for a batch that arrived in a
 * clump. A client sending 500 Hz of input has the overwhelming majority of them
 * refused at the door and moves at exactly the speed everyone else does.
 *
 * The budget is the tick rate plus the slew an honest client is *asked* to run
 * at, not the tick rate flat — {@link COMMAND_BUDGET} argues why a budget with
 * no room for the protocol's own correction starves the host it was protecting.
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
import {
  BUTTON_ATTACK,
  BUTTON_DASH_MASK,
  MAX_COMMAND_SLEW,
  TICK_RATE,
  type UserCmd,
} from '@gladiator/sim'

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
 * How long the buffer has to stay deeper than the target before a take starts
 * draining it, in ticks.
 *
 * Eight ticks is 64 ms. The number exists because depth is *two* signals wearing
 * one hat, and only one of them is worth acting on:
 *
 * - **Drift** — a client whose clock runs fast. Depth climbs and stays climbed.
 *   That extra depth is pure latency and draining it is the point.
 * - **Jitter** — every honest client, all the time. A browser samples input and
 *   ships commands once per *rendered frame*, and a frame is longer than a
 *   tick: a 60 fps client hands over two commands every 16 ms, a 30 fps client
 *   four every 33 ms. Depth therefore sawtooths by a whole frame's worth,
 *   by construction, on a link with no jitter at all.
 *
 * Reacting to the peak of that sawtooth was a self-inflicted wound. The drain
 * fired on every clump, walked the buffer back to the target immediately, and
 * so guaranteed that the gap *between* clumps found nothing there — the buffer
 * was emptied by the correction and then starved by the very jitter it exists
 * to cover. Measured on the browser smoke test before this window existed: 33%
 * of sub-steps merged, 36% starved, and only 31% executed one fresh command as
 * sent, on a localhost socket with the client supplying 0.98 commands per tick.
 *
 * So the trigger is the *trough*, not the peak: the buffer must have stayed
 * above target across a whole window. A clump touches the target on its way
 * down every frame and never qualifies; a fast clock never touches it and
 * qualifies within 64 ms — which is well inside the fifth of a second the
 * client's own slew takes to close a drift of the same size.
 *
 * The window has to outlast one frame's worth of commands, which is what sets
 * the floor: eight ticks is 64 ms, four frames at 60 fps and two at 30, so a
 * clump's trough lands inside the window whatever the frame rate. It is not
 * longer than that because every tick of it is a tick of standing latency a
 * drifting client keeps, and the client's own slew closes a drift of this size
 * in about the same time.
 */
export const DRIFT_WINDOW_TICKS = 8

/**
 * Commands a peer may offer per wall-clock second.
 *
 * The tick rate plus the slew the protocol asks a client to run at
 * ({@link MAX_COMMAND_SLEW}), rounded up. Not a tuned number, and the headroom
 * is not slack — it is the *whole* of the correction `client/net/clockSync.ts`
 * is built to make.
 *
 * It used to be exactly the tick rate, on the reasoning that one command per
 * tick is all the world has room for. That is true of what a tick *executes*
 * and false of what a second *carries*: a client that is behind its lead closes
 * the gap by running its command clock up to 12.5% fast, which is 141 commands
 * in the second it spends catching up. A budget of exactly 125 refused the
 * overshoot, so the lead never closed, so the client stayed behind — and the
 * host spent that second on the missing-command fallback for input the door had
 * just turned away.
 *
 * This is not the speedhack ceiling and never was. What a peer *executes* is
 * one command per sub-step, whatever it sends: {@link InputQueue.take} applies
 * exactly one, and the doubling-up below consumes two and applies one on
 * purpose. A client at 500 Hz still moves at exactly the speed everyone else
 * does — `inputQueue.test.ts` measures it in units travelled.
 */
export const COMMAND_BUDGET = Math.ceil(TICK_RATE * (1 + MAX_COMMAND_SLEW))

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
  /**
   * Consecutive takes that have left the buffer deeper than the target.
   *
   * The drift signal itself, exposed so that a queue draining a clump and a
   * queue draining a fast clock can be told apart from outside — the counter
   * sits at zero for the first and climbs for the second.
   */
  readonly overTarget: number
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
  /** Ticks the buffer must stay over target before a take drains it. */
  readonly driftWindowTicks?: number
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
  const repeatedButtons = last.buttons & ~(BUTTON_ATTACK | BUTTON_DASH_MASK)
  return repeatedButtons === last.buttons ? last : { ...last, buttons: repeatedButtons }
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
  const driftWindowTicks = options.driftWindowTicks ?? DRIFT_WINDOW_TICKS
  const budgetPerSecond = options.budgetPerSecond ?? COMMAND_BUDGET
  const burst = options.burst ?? COMMAND_BURST

  const buffer: Buffered[] = []
  let executedTick = options.startTick ?? 0
  let last: UserCmd | null = null
  let starving = 0
  /**
   * Consecutive takes that have left the buffer over target — how long the
   * surplus has *lasted*, which is what tells drift from a clump.
   */
  let overTarget = 0

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
        // A buffer that has run dry has no standing surplus by definition, so
        // whatever depth it had built up stops counting towards one.
        overTarget = 0
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

      // Deeper than the target *after* taking the head, and it has been for a
      // whole window: the client is genuinely ahead of us and the extra depth
      // is pure latency. One more is consumed and merged in, which walks the
      // buffer back down a tick per tick.
      //
      // The window is the whole of the decision. Depth alone cannot tell a fast
      // clock from a browser handing over a frame's worth of commands at once,
      // and draining on the second reading empties the jitter buffer into the
      // gap it exists to cover. See {@link DRIFT_WINDOW_TICKS}.
      overTarget = buffer.length > target ? overTarget + 1 : 0
      if (overTarget > driftWindowTicks) {
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
      return { ...stats, overTarget }
    },
  }
}
