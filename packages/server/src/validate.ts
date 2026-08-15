/**
 * The frame door: what a connection is allowed to send, before anything reads
 * it.
 *
 * This endpoint is on the public internet and anyone can open a socket to it.
 * The origin check at upgrade (`origin.ts`) stops a *browser* on somebody
 * else's page; it stops nothing else, because an `Origin` header is a string a
 * non-browser writes for itself. So the real defence is that the server is
 * authoritative and distrusts everything it is handed, and this file is the
 * first half of that: a bound on the traffic, before `JSON.parse` sees it.
 *
 * The second half is the *contents* of a command, and it lives in
 * `sim/src/usercmd.ts`'s `sanitizeUserCmd` — deliberately inside the
 * simulation package, next to the constants that define what a legal value is,
 * because a clamp that lived out here would be a second opinion about
 * `MAX_PITCH_UNITS` to keep in step. Everything on the wire reaches the sim
 * through `decodeCmd`, and `decodeCmd` cannot return anything illegal.
 *
 * ## Three caps, because there are three ways to be expensive
 *
 * | Cap | Number | What it stops |
 * | --- | ------ | ------------- |
 * | one frame's size | {@link MAX_FRAME_BYTES} | a 500 MB frame allocated in one read |
 * | frames per second | {@link FRAME_BUDGET_PER_SECOND} | a parse loop nobody is playing behind |
 * | bytes per second | {@link BYTE_BUDGET_PER_SECOND} | many legal-sized frames, which pass the other two |
 *
 * The size cap is enforced twice on purpose. `ws`'s `maxPayload` refuses an
 * oversized frame before the bytes are ever assembled, which is the version that
 * matters on Fly; this one catches the same mistake arriving over a loopback,
 * where there is no socket to hold the line. Two checks of one number, not two
 * numbers: both read `config.maxPayloadBytes`.
 *
 * ## It throttles, and only then disconnects
 *
 * A frame over the rate is **dropped, silently**. Not answered: replying to a
 * flood with one fault per frame is answering a flood with a flood, in our own
 * direction and at our own expense. And not closed on either, because a client
 * that briefly overshoots is far more likely to be a browser on a 240 Hz display
 * than an attacker, and killing a duel over a hiccough is a worse bug than the
 * one this file exists to prevent.
 *
 * A client that keeps at it is a different thing. Past
 * {@link MAX_REFUSED_FRAMES} refusals the connection is told why and closed,
 * because at that point it is not overshooting — it is not listening.
 *
 * ## A binary frame is refused rather than guessed at
 *
 * The protocol is JSON text. Bytes are either a client speaking something else
 * or a client speaking the *next* protocol, and both are better answered with a
 * sentence than with a decoder that has to be total against hostile input.
 * When the wire does go binary, this is the one line that changes.
 *
 * ## No clock in here
 *
 * `nowMs` is an argument. This module is reached from `room.ts`, which runs
 * inside a browser tab as part of the listen server, and
 * `room.isomorphic.test.ts` fails the build on a `Date.now()` reachable from it.
 */
import { messageSize, type ServerFault, type TransportMessage } from '@gladiator/sim'

import { createTokenBucket } from './rateLimit.ts'
import { CLOSE_BAD_FRAME } from './session.ts'

/**
 * The biggest frame this server will read, in bytes.
 *
 * Sixteen kilobytes, and the number comes from arithmetic rather than from a
 * round figure. The largest legal frame is a full command batch:
 * `MAX_CMDS_PER_BATCH` is 256 and a `WireCmd` is six integers, which is 28
 * characters at its widest — 7,468 bytes with the envelope, and
 * `validate.test.ts` computes that rather than quoting it. Sixteen kilobytes is
 * a little over twice that, which is headroom for a protocol that grows a field
 * without being headroom for anything else.
 *
 * A typical frame is nothing like this: one command is ~25 bytes and a client
 * sends one to four of them per rendered frame.
 */
export const MAX_FRAME_BYTES = 16 * 1024

/**
 * Frames a connection may send per wall-clock second.
 *
 * Three hundred, and the budget is set by the fastest *honest* client rather
 * than by what feels generous. A client flushes its outbox once per rendered
 * frame (`client/net/client.ts`), so a 240 Hz display sends 240 command frames a
 * second, and clock sync adds five pongs. 245 is the ceiling a real player can
 * reach; 300 is that with room for a browser that renders a little fast.
 *
 * This is deliberately **not** the command rate limit. That one is 125
 * commands per second (`inputQueue.ts`) and it exists to stop a client
 * consuming more of the world's time than everyone else — the speedhack. This
 * one is about the *pipe*: a client sending 10,000 empty frames a second passes
 * the command limit trivially, because none of its frames contain a command the
 * world would execute, and would still spend a core on `JSON.parse`.
 */
export const FRAME_BUDGET_PER_SECOND = 300

/**
 * How far ahead of its own frame budget a connection may run.
 *
 * Sixty frames, a fifth of a second at the budget. A browser that misses a
 * paint and then catches up, or a batch of pongs that arrived in one TCP
 * segment, is a clump of frames delivered together; refusing those would be
 * refusing honest traffic for being punctual in the wrong pattern.
 */
export const FRAME_BURST = 60

/**
 * Bytes a connection may send per wall-clock second.
 *
 * A hundred and twenty-eight kilobytes. The frame limit alone does not bound
 * bandwidth: 300 frames a second at the 16 kB cap is 4.8 MB/s per connection and
 * every one of those frames is individually legal. An honest client at 240 Hz
 * sends about 36 kB/s, so this is three and a half times the worst real player
 * and thirty-seven times under what the frame cap alone would allow.
 */
export const BYTE_BUDGET_PER_SECOND = 128 * 1024

/**
 * How far ahead of its own byte budget a connection may run.
 *
 * Twice {@link MAX_FRAME_BYTES}, and that relationship is the point rather than
 * the number: a burst allowance smaller than one maximal frame would refuse a
 * legal frame for arriving first, which is a limit that fails on exactly the
 * input it was sized for.
 */
export const BYTE_BURST = 2 * MAX_FRAME_BYTES

/**
 * How many refused frames a connection gets before it is closed.
 *
 * A hundred. An honest client is never refused at all — it is a hundred frames
 * a second under budget — so this is not a threshold anybody reaches by
 * accident. It is the point at which "briefly overshot" stops being a credible
 * account of what is happening.
 */
export const MAX_REFUSED_FRAMES = 100

/**
 * Close code for a connection that would not stop.
 *
 * Its own code rather than a reused {@link CLOSE_BAD_FRAME}, because the two are
 * different sentences to whoever is reading: one says "I could not understand
 * that" and the other says "I understood it and there was too much of it".
 * 4007; the connection lifecycle's codes (GLAD-DVDV6P) start above it.
 */
export const CLOSE_FLOODING = 4007

/** What the door made of a frame. */
export const FrameFate = {
  /** Read it. */
  Accept: 'accept',
  /** Bytes, where the protocol is text. */
  Binary: 'binary',
  /** Past {@link MAX_FRAME_BYTES}. */
  Oversize: 'oversize',
  /** Past {@link FRAME_BUDGET_PER_SECOND}. Dropped, not answered. */
  TooFast: 'too-fast',
  /** Past {@link BYTE_BUDGET_PER_SECOND}. Dropped, not answered. */
  TooLoud: 'too-loud',
} as const

export type FrameFate = (typeof FrameFate)[keyof typeof FrameFate]

export type FrameVerdict = {
  readonly fate: FrameFate
  /** The frame to parse, when there is one. `null` on every refusal. */
  readonly text: string | null
  /** What to tell the peer, or `null` for a refusal that is dropped in silence. */
  readonly fault: ServerFault | null
  /** Set when the connection must be closed once the fault has been flushed. */
  readonly close: { readonly code: number; readonly reason: string } | null
}

export type FrameGuardStats = {
  readonly accepted: number
  readonly binary: number
  readonly oversize: number
  readonly tooFast: number
  readonly tooLoud: number
  /** Every refusal, of any kind. What {@link MAX_REFUSED_FRAMES} counts. */
  readonly refused: number
}

export type FrameGuard = {
  /**
   * Judge one frame, received at `nowMs` on the server's clock.
   *
   * Charges the rate limits, so it is called exactly once per frame and its
   * answer is the only one there is.
   */
  admit(message: TransportMessage, nowMs: number): FrameVerdict
  readonly stats: FrameGuardStats
}

export type FrameGuardOptions = {
  /** Defaults to {@link MAX_FRAME_BYTES}. */
  readonly maxFrameBytes?: number
  /** Frames per second. Zero turns the limit off. */
  readonly framesPerSecond?: number
  readonly frameBurst?: number
  /** Bytes per second. Zero turns the limit off. */
  readonly bytesPerSecond?: number
  readonly byteBurst?: number
  readonly maxRefused?: number
}

export function createFrameGuard(options: FrameGuardOptions = {}): FrameGuard {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES
  const maxRefused = options.maxRefused ?? MAX_REFUSED_FRAMES
  const framesPerSecond = options.framesPerSecond ?? FRAME_BUDGET_PER_SECOND
  const bytesPerSecond = options.bytesPerSecond ?? BYTE_BUDGET_PER_SECOND

  const frames = createTokenBucket({
    ratePerSecond: framesPerSecond,
    burst: options.frameBurst ?? FRAME_BURST,
  })
  const bytes = createTokenBucket({
    ratePerSecond: bytesPerSecond,
    burst: options.byteBurst ?? BYTE_BURST,
  })

  const stats = { accepted: 0, binary: 0, oversize: 0, tooFast: 0, tooLoud: 0, refused: 0 }

  /**
   * A refusal, and the decision about whether it is this connection's last.
   *
   * `fault` is `null` for the throttled kinds: see the header for why a flood is
   * answered with silence until it is answered with a close.
   */
  const refuse = (fate: FrameFate, fault: ServerFault | null, closeCode: number): FrameVerdict => {
    stats.refused += 1
    if (fault !== null) {
      return { fate, text: null, fault, close: { code: closeCode, reason: fate } }
    }
    if (stats.refused < maxRefused) return { fate, text: null, fault: null, close: null }
    return {
      fate,
      text: null,
      fault: {
        t: 'fault',
        code: 'flooding',
        detail: `over ${framesPerSecond} frames or ${bytesPerSecond} bytes a second, ${stats.refused} times`,
      },
      close: { code: CLOSE_FLOODING, reason: 'flooding' },
    }
  }

  return {
    admit(message: TransportMessage, nowMs: number): FrameVerdict {
      // `messageSize` counts UTF-16 code units for a string, which is a lower
      // bound on the bytes a multi-byte character costs. That is the right
      // direction to be wrong in for a *rate* limit, and the exact byte cap is
      // `ws`'s `maxPayload` on the socket, which counts the frame as it arrives.
      const size = messageSize(message)

      if (typeof message !== 'string') {
        stats.binary += 1
        return refuse(
          FrameFate.Binary,
          { t: 'fault', code: 'binary', detail: 'this protocol is JSON text' },
          CLOSE_BAD_FRAME,
        )
      }

      if (size > maxFrameBytes) {
        stats.oversize += 1
        return refuse(
          FrameFate.Oversize,
          { t: 'fault', code: 'oversize', detail: `frames are capped at ${maxFrameBytes} bytes` },
          CLOSE_BAD_FRAME,
        )
      }

      // Frames first, then bytes, and both are charged before either can refuse
      // — a frame that is over one limit is over the pipe's budget either way,
      // and skipping the second charge would let a client alternate between
      // huge-and-slow and tiny-and-fast to stay under both counters.
      const underFrameRate = frames.spend(1, nowMs)
      const underByteRate = bytes.spend(size, nowMs)

      if (!underFrameRate) {
        stats.tooFast += 1
        return refuse(FrameFate.TooFast, null, CLOSE_FLOODING)
      }
      if (!underByteRate) {
        stats.tooLoud += 1
        return refuse(FrameFate.TooLoud, null, CLOSE_FLOODING)
      }

      stats.accepted += 1
      return { fate: FrameFate.Accept, text: message, fault: null, close: null }
    },

    get stats(): FrameGuardStats {
      return { ...stats }
    },
  }
}
