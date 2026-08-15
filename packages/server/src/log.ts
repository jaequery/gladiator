/**
 * The server log: one JSON object per event, one line each.
 *
 * A log line is read twice — once by a person tailing `fly logs` at three in the
 * morning, and once by a query trying to answer "which rooms saw a peer time out
 * in the last hour". Prose serves the first badly and the second not at all, so
 * every line here is an object and the sentence a human reads is assembled from
 * it rather than the other way round.
 *
 * ## `room` and `tick` are on every line, including the ones that have neither
 *
 * Every entry carries both keys. When the event is not about a room they are
 * `null`, and that is deliberate rather than sloppy: a consumer that can always
 * project `.room` and `.tick` never has to branch on whether a field exists, and
 * a missing key and a null one look identical in a filter and mean very
 * different things. The two together are the whole index — a bug report is
 * "room 7QK4M2, about a minute in", and those are exactly the two coordinates
 * that turns into.
 *
 * The tick is read *at write time*, from the room's live world, which is why a
 * scoped logger takes a function rather than a number. A line stamped with the
 * tick the room was on when the logger was made would be a line stamped with
 * zero.
 *
 * ## It is isomorphic, because `room.ts` imports it
 *
 * No `console`, no `Date.now`, no `process`. The sink is injected and so is the
 * clock — `index.ts` passes `console.log` and `Date.now`, a test passes an array
 * and a counter, and a listen server in a browser tab passes nothing at all and
 * gets a logger that writes nowhere. `room.isomorphic.test.ts` enforces this.
 */

/** What may appear as a field value. Anything else is a bug at the call site. */
export type LogValue = string | number | boolean | null

export type LogFields = Readonly<Record<string, LogValue | undefined>>

/**
 * Write one event.
 *
 * `event` is a dotted, lower-snake name — `room.match_start`, `registry.reaped`
 * — because a name with a room code in it is a name nothing can group by.
 * Anything that varies goes in `fields`.
 */
export type Log = (event: string, fields?: LogFields) => void

/** Where a line goes. `console.log` on Fly; an array in a test. */
export type LogSink = (line: string) => void

export type LoggerOptions = {
  readonly write: LogSink
  /**
   * Epoch milliseconds, injected.
   *
   * Not `Date.now` read in here: this module is on the isomorphic side of the
   * line, and a clock a caller passes is a clock a test can pin.
   */
  readonly time?: () => number
  /** Fields on every line this logger writes — the build, the machine. */
  readonly context?: LogFields
}

/** A logger that discards. What a listen server in a browser tab gets. */
export const NO_LOG: Log = () => undefined

/**
 * The fields every entry carries, in the order they are written.
 *
 * Order matters for exactly one reader: the person watching a terminal, for
 * whom `{"time":…,"level":…,"event":…,"room":…,"tick":…` is legible at a glance
 * and the same five fields in hash order are not.
 */
function entryOf(
  timeMs: number | null,
  event: string,
  fields: LogFields | undefined,
): Record<string, LogValue> {
  const level = fields?.['level']
  const entry: Record<string, LogValue> = {
    time: timeMs === null ? null : new Date(timeMs).toISOString(),
    level: typeof level === 'string' ? level : 'info',
    event,
    room: null,
    tick: null,
  }
  if (fields !== undefined) {
    for (const key of Object.keys(fields)) {
      if (key === 'level') continue
      const value = fields[key]
      if (value !== undefined) entry[key] = value
    }
  }
  return entry
}

export function createLogger(options: LoggerOptions): Log {
  const { write } = options
  const time = options.time
  const context = options.context

  return (event, fields) => {
    write(JSON.stringify(entryOf(time === undefined ? null : time(), event, { ...context, ...fields })))
  }
}

/**
 * A logger that stamps `room` and `tick` on to everything it writes.
 *
 * Handed to a `Room` and to the registry, so no call site has to remember —
 * "include the room" is the sort of rule that holds for exactly as long as
 * nobody is in a hurry.
 */
export function scopeToRoom(log: Log, room: string, tick: () => number): Log {
  return (event, fields) => {
    log(event, { room, tick: tick(), ...fields })
  }
}

/**
 * Collect lines and parse them back. For tests, and for `tools/`.
 *
 * A test that asserted on the string would be a test that breaks when a field
 * is added; one that parses is a test about the *shape*, which is the property
 * this file exists to hold.
 */
export function createLogCollector(): {
  readonly log: Log
  readonly lines: readonly string[]
  entries(): readonly Record<string, LogValue>[]
} {
  const lines: string[] = []
  const log = createLogger({ write: (line) => lines.push(line), time: () => 0 })
  return {
    log,
    get lines() {
      return lines
    },
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, LogValue>),
  }
}
