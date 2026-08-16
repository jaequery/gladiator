/**
 * Two bots in a real match, and the measurements that decide whether the movement
 * works. GLAD-TSED8V.
 *
 * ## Why this is in `tools/` and not in `packages/bot`
 *
 * Because it has to build a `GameState`, and `eslint.config.js`'s
 * `GROUND_TRUTH_BANS` refuses that name anywhere in `packages/bot` outside
 * `perception/`. That is the fairness fence doing its job rather than getting in
 * the way: a harness is allowed to be omniscient — it is the thing checking on the
 * bot — and the place for an omniscient program is on the far side of the fence.
 * `packages/bot`'s own tests are about pieces (`movement/*.test.ts`) and take a
 * `WorldModel` and a `CollisionWorld`, neither of which is ground truth.
 *
 * ## The bots play through the real host path
 *
 * `startMatch` stands both players up, `tick()` advances the world, and each bot's
 * `UserCmd` goes into the slot a human's would. No shortcuts: if the movement
 * cannot get a body up a staircase with two axes and a jump button, that shows up
 * here as a bot that does not get up the staircase.
 *
 * ## What it measures, and why each number is measured here rather than asserted
 *   inside the bot
 *
 * Every check below is computed from the *world*, independently of the bot's own
 * bookkeeping. The stall clock is the clearest case: `stuck.ts` has an anchor and a
 * clock of its own, and asserting on those would be asking the detector whether it
 * thinks it is working. So this file keeps its own anchor, and the assertion is
 * about the body.
 *
 * The one thing it does read off the bot is {@link MoveState.hop} — which link the
 * bot believes it is on — because "never fell while the link was a `walk`" is a
 * statement about the *pairing* of a claim and an outcome, and there is nowhere
 * else the claim exists.
 */

import {
  DEFAULT_MATCH_RULES,
  EntityFlag,
  MatchPhase,
  NULL_CMD,
  PLAYER_MAXS,
  PLAYER_MINS,
  RUN_SPEED,
  TICK_RATE,
  buildSpawnPlan,
  createGameState,
  findPlayer,
  startMatch,
  tick,
} from '@gladiator/sim'
import type {
  CollisionWorld,
  EntityState,
  GameState,
  LoadedMap,
  MatchRules,
  SpawnPlan,
  UserCmd,
  Vec3,
} from '@gladiator/sim'
import {
  CIRCLE_JUMP_HOLD_TICKS,
  MAX_TURN_UNITS,
  RECOVERY_TICKS,
  STUCK_RADIUS,
  STUCK_TICKS,
  botCommand,
  createBot,
  onNavStuck,
} from '@gladiator/bot'
import { NAV_MAX_STEP, SHIPPED_SKILL } from '@gladiator/bot'
import type { Bot, BotSkill, LoadedNav, NavStuck } from '@gladiator/bot'

/** The two seats. */
export const SLOTS: readonly number[] = [0, 1]

export type BotArena = {
  readonly state: GameState
  readonly world: CollisionWorld
  readonly plan: SpawnPlan
  /** One entry per seat: a bot, or `null` for a seat driven from outside. */
  readonly bots: readonly (Bot | null)[]
  /** What a seat with no bot in it sends. */
  readonly scripted: ((slot: number, tick: number) => UserCmd) | null
  /** The last command each seat produced. */
  readonly commands: UserCmd[]
}

export type BotArenaOptions = {
  readonly map: LoadedMap
  readonly nav: LoadedNav
  /** Seeds the world's PRNG and, offset by the slot, each bot's own. */
  readonly seed: number
  readonly rules?: MatchRules
  /**
   * Which seats get a bot. Both, by default.
   *
   * One is what a *mutation* test needs. Two bots cannot be used to assert that a
   * perturbation is invisible, because the opponent's own model legitimately carries
   * its own health — perturb it and the opponent moves differently, the world differs,
   * and the bot under test differs for an entirely fair reason.
   * `perception/fairness.test.ts` seats one bot for exactly this reason.
   */
  readonly botSlots?: readonly number[]
  /** What a seat with no bot in it sends. Standing still, by default. */
  readonly scripted?: (slot: number, tick: number) => UserCmd
  /**
   * How good each seat is, indexed by slot. The shipped skill where absent.
   *
   * Two entries rather than one because the asymmetric rows of GLAD-6BIYFQ's
   * band table are a bot at one skill against a bot at another, and that is the
   * measurement that proves the difficulty axis is wired to something —
   * `packages/bot/src/tuning.ts`.
   */
  readonly skills?: readonly (BotSkill | undefined)[]
  /**
   * A spawn plan already built for this map, if there is one.
   *
   * `buildSpawnPlan` is `spawns² × 9` traces with the real player box and a
   * function of the map alone — `server/src/map.ts` builds it once at module
   * load for exactly that reason. A harness that plays five hundred matches on
   * one arena (`tools/bot-bands.ts`) would otherwise pay a level-design question
   * five hundred times for an answer that cannot change.
   */
  readonly plan?: SpawnPlan
}

/** Two bots, both seated, the match started, on the first sub-step of round one. */
export function createBotArena(options: BotArenaOptions): BotArena {
  const rules = options.rules ?? DEFAULT_MATCH_RULES
  const state = createGameState(options.seed, rules)
  const plan = options.plan ?? buildSpawnPlan(options.map.source, options.map.world)
  const terrain = { world: options.map.world, nav: options.nav }

  // `startMatch` places both bodies, creating them if this is their first round —
  // the same edge out of warmup the room takes when it fills (`match/round.ts`).
  startMatch(state, plan)

  const seated = options.botSlots ?? SLOTS
  return {
    state,
    world: options.map.world,
    plan,
    bots: SLOTS.map((slot) =>
      seated.includes(slot)
        ? createBot(
            slot,
            options.seed * 31 + slot,
            terrain,
            options.skills?.[slot] ?? SHIPPED_SKILL,
          )
        : null,
    ),
    scripted: options.scripted ?? null,
    commands: [NULL_CMD, NULL_CMD],
  }
}

/**
 * Both bots observe and act. The world does **not** advance.
 *
 * Split from {@link advanceBotArena} because of a phase trap that cost an
 * afternoon: a bot's `MoveState` is computed from the body's position *before* the
 * sub-step, so reading the two after `tick()` compares a decision against a
 * position it never saw. On a ramp that showed up as a 30-unit discrepancy and
 * looked exactly like the bot falling off a walk link. Watch between these two
 * calls and the pair is in phase.
 */
export function actBotArena(arena: BotArena): void {
  for (let i = 0; i < arena.bots.length; i += 1) {
    const bot = arena.bots[i]
    arena.commands[i] =
      bot === null || bot === undefined
        ? (arena.scripted?.(i, arena.state.tick) ?? NULL_CMD)
        : botCommand(bot, { state: arena.state, world: arena.world })
  }
}

/** Advance the world by the commands {@link actBotArena} produced. */
export function advanceBotArena(arena: BotArena): void {
  tick(arena.state, arena.commands, arena.world, arena.plan)
}

/** One sub-step: both bots act, then the world advances. */
export function stepBotArena(arena: BotArena): void {
  actBotArena(arena)
  advanceBotArena(arena)
}

/* --------------------------------------------------------------------------
 * What one seat did
 * ----------------------------------------------------------------------- */

/** Everything measured about one bot over one run. */
export type SlotReport = {
  slot: number
  /** Sub-steps the body's box was not wholly inside the world's AABB. */
  outsideAabb: number
  /** The worst distance outside it, in Quake units. */
  worstOutside: number
  /**
   * The worst a landing while on a `walk` link came down below the lower end of
   * that link, in Quake units. Over a step is a bot that fell off a walk.
   */
  worstWalkFall: number
  /** Landings on a `walk` link that came down more than a step low. */
  fellOnWalk: number
  /** Sub-steps with somewhere to go and no link to get there on. */
  offGraph: number
  /** The longest run of sub-steps inside {@link STUCK_RADIUS} while a path was live. */
  worstStall: number
  /** How many stalls got past {@link STUCK_TICKS} — recoveries the bot had to run. */
  stalls: number
  /** `NAV_STUCK` lines this seat produced. */
  reports: number
  /** The largest `|cmd.yaw|` change between consecutive sub-steps, in angle units. */
  maxYawDelta: number
  /** The largest `|cmd.pitch|` change between consecutive sub-steps, in angle units. */
  maxPitchDelta: number
  /** The largest `|cmd.pitch|`, in angle units. */
  maxPitch: number
  /** Sub-steps in which the ledge guard changed the direction. */
  vetoes: number
  /** Commands carrying the jump bit. */
  jumps: number
  /** Circle jumps taken — a take-off with the offset window armed. */
  circleJumps: number
  /** Circle jumps whose landing was measured. */
  landings: number
  /**
   * Landings that came down faster than a flat-out run, which is the mechanic having
   * worked.
   *
   * Counted rather than only bounded because the tail is real and small: about one hop
   * in a hundred clips geometry mid-flight and lands slow, and a claim about the
   * *slowest* landing over two hundred matches would be a claim about that one hop.
   */
  fastLandings: number
  /** The slowest a circle jump landed at, in qu/s. */
  slowestLanding: number
  /** The fastest a circle jump landed at, in qu/s. */
  fastestLanding: number
  /** Ground distance travelled, in Quake units. */
  distance: number
  /** The fastest the body went horizontally, in qu/s. */
  topSpeed: number
  /** How many sub-steps were spent on each link kind, and on none. */
  hops: Record<string, number>
}

function createSlotReport(slot: number): SlotReport {
  return {
    slot,
    outsideAabb: 0,
    worstOutside: 0,
    worstWalkFall: 0,
    fellOnWalk: 0,
    offGraph: 0,
    worstStall: 0,
    stalls: 0,
    reports: 0,
    maxYawDelta: 0,
    maxPitchDelta: 0,
    maxPitch: 0,
    vetoes: 0,
    jumps: 0,
    circleJumps: 0,
    landings: 0,
    fastLandings: 0,
    slowestLanding: Infinity,
    fastestLanding: 0,
    distance: 0,
    topSpeed: 0,
    hops: { walk: 0, jump: 0, drop: 0, teleport: 0, none: 0 },
  }
}

/** The state one seat's watcher carries between sub-steps. */
type Watcher = {
  readonly report: SlotReport
  last: UserCmd | null
  anchor: Vec3 | null
  anchorTick: number
  previous: Vec3 | null
  /** Whether the seat is mid-circle-jump, so its landing can be measured. */
  hopping: boolean
  /** Whether a rocket shoved the body during the current hop. See {@link watch}. */
  shoved: boolean
  /** Whether the body was on the ground last sub-step, for landing detection. */
  wasOnGround: boolean
  /**
   * The round the last observed command belonged to.
   *
   * A round boundary teleports both bodies and hands each of them a spawn yaw
   * (`match/spawn.ts`), and a client is expected to *adopt* that yaw rather than
   * turn to it — `AGENTS.md`, "The spawn system". So the step between the last
   * command of one round and the first of the next is not a turn and is not
   * measured. Before GLAD-HK3ATM nothing could end a round early, so this
   * boundary only ever fell where the match already restarted.
   */
  round: number
}

/** How far outside the world's AABB the player box at `origin` reaches. */
function outsideBy(world: CollisionWorld, origin: Vec3): number {
  let worst = 0
  for (let axis = 0; axis < 3; axis += 1) {
    const low = (world.mins[axis] ?? 0) - (origin[axis] ?? 0) - (PLAYER_MINS[axis] ?? 0)
    const high = (origin[axis] ?? 0) + (PLAYER_MAXS[axis] ?? 0) - (world.maxs[axis] ?? 0)
    worst = Math.max(worst, low, high)
  }
  return worst
}

/** The shortest way round between two angle-unit values, always non-negative. */
function angleDelta(a: number, b: number): number {
  let delta = (a - b) % 65536
  if (delta > 32768) delta -= 65536
  if (delta <= -32768) delta += 65536
  return Math.abs(delta)
}

function watch(arena: BotArena, watcher: Watcher, slot: number): void {
  const report = watcher.report
  const bot = arena.bots[slot]
  const body = findPlayer(arena.state, slot)
  if (bot === null || bot === undefined || body === null) return

  const round = arena.state.match.round
  if (round !== watcher.round) {
    watcher.round = round
    watcher.last = null
    watcher.anchor = null
    watcher.previous = null
  }

  const cmd = arena.commands[slot]
  if (cmd !== undefined) {
    if (watcher.last !== null) {
      report.maxYawDelta = Math.max(report.maxYawDelta, angleDelta(cmd.yaw, watcher.last.yaw))
      report.maxPitchDelta = Math.max(
        report.maxPitchDelta,
        Math.abs(cmd.pitch - watcher.last.pitch),
      )
    }
    report.maxPitch = Math.max(report.maxPitch, Math.abs(cmd.pitch))
    if ((cmd.buttons & 1) !== 0) report.jumps += 1
    watcher.last = cmd
  }

  const move = bot.movement
  report.hops[move.hop ?? 'none'] = (report.hops[move.hop ?? 'none'] ?? 0) + 1
  if (move.vetoed) report.vetoes += 1
  if (move.hasTarget && move.hop === null) report.offGraph += 1

  const outside = outsideBy(arena.world, body.origin)
  if (outside > 0) {
    report.outsideAabb += 1
    report.worstOutside = Math.max(report.worstOutside, outside)
  }

  // Guard 2, measured where it is unambiguous: **a landing**.
  //
  // The tempting version — "the body is below both ends of the link right now" —
  // reads a ramp as a 16-unit fall, because a bot half way up one is legitimately
  // below the node at the top of it. A landing has no such ambiguity: a `walk` link
  // is walkable ground the whole way (`nav/schema.ts`), so coming down on to
  // something more than a step below its lower end means the bot left the link.
  const onGround = (body.flags & EntityFlag.OnGround) !== 0
  if (onGround && !watcher.wasOnGround && move.hop === 'walk') {
    const fall = Math.min(move.from[2], move.target[2]) - body.origin[2]
    report.worstWalkFall = Math.max(report.worstWalkFall, fall)
    if (fall > NAV_MAX_STEP) report.fellOnWalk += 1
  }
  watcher.wasOnGround = onGround

  const speed = Math.sqrt(
    body.velocity[0] * body.velocity[0] + body.velocity[1] * body.velocity[1],
  )
  report.topSpeed = Math.max(report.topSpeed, speed)

  // A take-off with the offset window fully armed is a circle jump, and the number
  // worth having is what it left the bot travelling at when it touched down —
  // `movement/circleJump.ts` was tuned to a measurement and this is the same one,
  // taken over a real match instead of over one hop down an empty lane.
  if (move.offsetTicks === CIRCLE_JUMP_HOLD_TICKS && !watcher.hopping) {
    watcher.hopping = true
    watcher.shoved = false
    report.circleJumps += 1
  } else if (watcher.hopping && onGround) {
    // A hop a rocket landed on is not a measurement of the circle jump: 500 qu/s
    // of splash knockback (`damage.ts`) dwarfs the 369 the mechanic is worth, and
    // counting it would turn a claim about the offset window into a claim about
    // who got shot mid-air. The hop is still counted as taken.
    if (!watcher.shoved) {
      report.landings += 1
      if (speed > RUN_SPEED) report.fastLandings += 1
      report.slowestLanding = Math.min(report.slowestLanding, speed)
      report.fastestLanding = Math.max(report.fastestLanding, speed)
    }
    watcher.hopping = false
    watcher.shoved = false
  } else if (watcher.hopping && body.knockbackTicks > 0) {
    watcher.shoved = true
  }

  if (watcher.previous !== null) {
    const dx = body.origin[0] - watcher.previous[0]
    const dy = body.origin[1] - watcher.previous[1]
    report.distance += Math.sqrt(dx * dx + dy * dy)
  }
  watcher.previous = [body.origin[0], body.origin[1], body.origin[2]]

  trackStall(watcher, move.hasTarget, body, arena.state.tick)
}

/**
 * The harness's own stall clock — deliberately not the bot's.
 *
 * The acceptance check is "no bot remains within 32 u of its position for more
 * than 3 s while a path is active, and if recovery triggers it resolves within
 * 1.5 s". Both halves are one number: the longest stall must be at most
 * {@link STUCK_TICKS} + {@link RECOVERY_TICKS}. Measuring it from the body means
 * the assertion holds whether or not `stuck.ts` noticed.
 */
function trackStall(watcher: Watcher, active: boolean, body: EntityState, tick: number): void {
  if (!active) {
    watcher.anchor = null
    return
  }
  if (watcher.anchor === null) {
    watcher.anchor = [body.origin[0], body.origin[1], body.origin[2]]
    watcher.anchorTick = tick
    return
  }
  const dx = body.origin[0] - watcher.anchor[0]
  const dy = body.origin[1] - watcher.anchor[1]
  const dz = body.origin[2] - watcher.anchor[2]
  const stalled = tick - watcher.anchorTick
  if (dx * dx + dy * dy + dz * dz > STUCK_RADIUS * STUCK_RADIUS) {
    if (stalled > STUCK_TICKS) watcher.report.stalls += 1
    watcher.report.worstStall = Math.max(watcher.report.worstStall, stalled)
    watcher.anchor = [body.origin[0], body.origin[1], body.origin[2]]
    watcher.anchorTick = tick
    return
  }
  watcher.report.worstStall = Math.max(watcher.report.worstStall, stalled)
}

/* --------------------------------------------------------------------------
 * Running it
 * ----------------------------------------------------------------------- */

export type SoakOptions = BotArenaOptions & {
  /** How many matches. */
  readonly matches: number
  /** How long each one runs for, in seconds of simulated time. */
  readonly seconds: number
  /** Called once per match with the match index, for a progress line. */
  readonly onMatch?: (index: number, report: SoakReport) => void
}

export type SoakReport = {
  matches: number
  ticks: number
  /** One per seat, aggregated over every match. */
  readonly slots: SlotReport[]
  /** Every `NAV_STUCK` line the run produced, in order. */
  readonly stuck: NavStuck[]
}

/** The worst of two reports, field by field. Aggregating across matches. */
function foldReport(into: SlotReport, from: SlotReport): void {
  into.outsideAabb += from.outsideAabb
  into.worstOutside = Math.max(into.worstOutside, from.worstOutside)
  into.worstWalkFall = Math.max(into.worstWalkFall, from.worstWalkFall)
  into.fellOnWalk += from.fellOnWalk
  into.offGraph += from.offGraph
  into.worstStall = Math.max(into.worstStall, from.worstStall)
  into.stalls += from.stalls
  into.reports += from.reports
  into.maxYawDelta = Math.max(into.maxYawDelta, from.maxYawDelta)
  into.maxPitchDelta = Math.max(into.maxPitchDelta, from.maxPitchDelta)
  into.maxPitch = Math.max(into.maxPitch, from.maxPitch)
  into.vetoes += from.vetoes
  into.jumps += from.jumps
  into.circleJumps += from.circleJumps
  into.landings += from.landings
  into.fastLandings += from.fastLandings
  into.slowestLanding = Math.min(into.slowestLanding, from.slowestLanding)
  into.fastestLanding = Math.max(into.fastestLanding, from.fastestLanding)
  into.distance += from.distance
  into.topSpeed = Math.max(into.topSpeed, from.topSpeed)
  for (const kind of Object.keys(from.hops)) {
    into.hops[kind] = (into.hops[kind] ?? 0) + (from.hops[kind] ?? 0)
  }
}

/**
 * Run one match of `ticks` sub-steps and report on both seats.
 *
 * A match that decides itself before the clock runs out is restarted from a fresh
 * state, so the whole budget is spent on a live match rather than on an
 * intermission. Since GLAD-HK3ATM the bots shoot, so rounds now end on a death
 * rather than only on the time limit — which is why {@link Watcher} has a round
 * number in it and why a hop that took a rocket is not counted as a landing.
 */
export type BotMatchOptions = BotArenaOptions & {
  readonly ticks: number
  /**
   * Called before the bots observe, with the sub-step index.
   *
   * Where a mutation test perturbs ground truth. It has to happen *before* the
   * observation or the perturbation lands a sub-step late and the two runs differ by
   * one command for the wrong reason — `perception/fixture.ts` makes the same point.
   */
  readonly before?: (arena: BotArena, step: number) => void
  /** Called after the commands are produced and before the world advances. */
  readonly observe?: (arena: BotArena, step: number) => void
}

export function runBotMatch(options: BotMatchOptions): {
  readonly slots: SlotReport[]
  readonly stuck: NavStuck[]
  readonly arena: BotArena
} {
  const stuck: NavStuck[] = []
  onNavStuck((event) => stuck.push(event))

  let arena = createBotArena(options)
  const watchers: Watcher[] = SLOTS.map((slot) => ({
    report: createSlotReport(slot),
    last: null,
    anchor: null,
    anchorTick: 0,
    previous: null,
    hopping: false,
    shoved: false,
    wasOnGround: true,
    round: -1,
  }))

  try {
    for (let step = 0; step < options.ticks; step += 1) {
      options.before?.(arena, step)
      actBotArena(arena)
      for (const slot of SLOTS) {
        const watcher = watchers[slot]
        if (watcher !== undefined) watch(arena, watcher, slot)
      }
      options.observe?.(arena, step)
      advanceBotArena(arena)
      if (arena.state.match.phase === MatchPhase.Over) {
        arena = createBotArena({ ...options, seed: options.seed + step + 1 })
        for (const watcher of watchers) {
          watcher.anchor = null
          watcher.previous = null
          watcher.last = null
          watcher.round = -1
        }
      }
    }
  } finally {
    onNavStuck(null)
  }

  for (const event of stuck) {
    const watcher = watchers[event.slot]
    if (watcher !== undefined) watcher.report.reports += 1
  }

  return { slots: watchers.map((w) => w.report), stuck, arena }
}

/** Run `matches` of them and fold the reports together. */
export function soakBots(options: SoakOptions): SoakReport {
  const ticks = Math.round(options.seconds * TICK_RATE)
  const soak: SoakReport = {
    matches: 0,
    ticks: 0,
    slots: SLOTS.map((slot) => createSlotReport(slot)),
    stuck: [],
  }

  for (let match = 0; match < options.matches; match += 1) {
    const one = runBotMatch({ ...options, seed: options.seed + match * 1009, ticks })
    for (const slot of SLOTS) {
      const into = soak.slots[slot]
      const from = one.slots[slot]
      if (into !== undefined && from !== undefined) foldReport(into, from)
    }
    soak.stuck.push(...one.stuck)
    soak.matches += 1
    soak.ticks += ticks
    options.onMatch?.(match, soak)
  }

  return soak
}

/* --------------------------------------------------------------------------
 * The verdict
 * ----------------------------------------------------------------------- */

/** One failed claim. */
export type SoakFailure = {
  readonly check: string
  readonly detail: string
}

/**
 * The acceptance checks, as predicates over a report.
 *
 * Written here rather than in the test so that `pnpm bot:soak` and
 * `maps/arena1.bot.test.ts` cannot disagree about what passing means — the CLI
 * runs two hundred matches and the test runs a handful, and the only difference
 * between them should be the sample size.
 */
export function soakFailures(soak: SoakReport): SoakFailure[] {
  const failures: SoakFailure[] = []
  const stallCap = STUCK_TICKS + RECOVERY_TICKS
  // The turn rate is a per-sub-step clamp, and the check allows 5% over it for the
  // rounding the clamp does on the way to whole angle units.
  const turnCap = Math.floor(MAX_TURN_UNITS * 1.05)
  // 89 degrees, which is what `MAX_PITCH_UNITS` is (`usercmd.ts`).
  const pitchCap = 16202

  for (const slot of soak.slots) {
    const seat = `slot ${slot.slot}`
    if (slot.outsideAabb > 0) {
      failures.push({
        check: 'stays inside the map AABB',
        detail: `${seat} was outside it on ${slot.outsideAabb} sub-steps, by up to ${slot.worstOutside.toFixed(1)} units.`,
      })
    }
    if (slot.fellOnWalk > 0) {
      failures.push({
        check: 'never falls while the link is a walk',
        detail: `${seat} landed more than a step below the lower end of a walk link ${slot.fellOnWalk} time(s), by up to ${slot.worstWalkFall.toFixed(1)} units.`,
      })
    }
    if (slot.worstStall > stallCap) {
      failures.push({
        check: 'stuck recovery resolves in time',
        detail: `${seat} went ${slot.worstStall} sub-steps without covering ${STUCK_RADIUS} units while a path was live; the budget is ${stallCap} (${STUCK_TICKS} to notice plus ${RECOVERY_TICKS} to recover).`,
      })
    }
    if (slot.maxYawDelta > turnCap) {
      failures.push({
        check: 'the view never turns faster than the turn rate',
        detail: `${seat} turned ${slot.maxYawDelta} angle units in one sub-step; the cap is ${turnCap}.`,
      })
    }
    if (slot.maxPitchDelta > turnCap) {
      failures.push({
        check: 'the view never turns faster than the turn rate',
        detail: `${seat} pitched ${slot.maxPitchDelta} angle units in one sub-step; the cap is ${turnCap}.`,
      })
    }
    if (slot.maxPitch > pitchCap) {
      failures.push({
        check: 'pitch stays within +/-89 degrees',
        detail: `${seat} sent a pitch of ${slot.maxPitch} angle units; the band is +/-${pitchCap}.`,
      })
    }
  }

  return failures
}

/** A one-line-per-seat summary, for the CLI and for a failing test's output. */
export function formatSoak(soak: SoakReport): string {
  const lines = [
    `${soak.matches} matches, ${soak.ticks} sub-steps (${(soak.ticks / TICK_RATE / 60).toFixed(1)} minutes of simulated duel)`,
  ]
  for (const slot of soak.slots) {
    const hops = Object.entries(slot.hops)
      .map(([kind, count]) => `${kind} ${((count / soak.ticks) * 100).toFixed(1)}%`)
      .join(', ')
    lines.push(
      `slot ${slot.slot}: travelled ${(slot.distance / 1000).toFixed(1)}k units, top speed ${slot.topSpeed.toFixed(0)} ups, ${slot.jumps} jumps, ${slot.vetoes} ledge vetoes`,
      `        ${slot.circleJumps} circle jumps, ${slot.fastLandings}/${slot.landings} landing over ${RUN_SPEED} ups, range ${Number.isFinite(slot.slowestLanding) ? slot.slowestLanding.toFixed(0) : '-'} to ${slot.fastestLanding.toFixed(0)}`,
      `        links: ${hops}`,
      `        worst stall ${slot.worstStall} sub-steps (${slot.stalls} recoveries, ${slot.reports} NAV_STUCK), off-graph ${slot.offGraph} sub-steps`,
      `        outside the AABB ${slot.outsideAabb}, fell on a walk ${slot.fellOnWalk} (worst landing ${slot.worstWalkFall.toFixed(1)} u low)`,
      `        max turn ${slot.maxYawDelta} yaw / ${slot.maxPitchDelta} pitch units per sub-step, max pitch ${slot.maxPitch}`,
    )
  }
  return lines.join('\n')
}
