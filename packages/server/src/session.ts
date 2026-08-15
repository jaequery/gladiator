/**
 * One connected peer, and the rules for advancing the world it is playing in.
 *
 * Written as a pure state machine — `(session, frame) -> { session, replies }`
 * — with no socket anywhere in sight, because the interesting failure modes
 * (a command batch with a gap in it, a client one deploy behind, a hostile
 * frame) are all much easier to test than to reproduce over a network.
 *
 * The world it advances is handed in rather than constructed here
 * ({@link SessionSim}), and which slot a peer's commands land in is a field
 * rather than a constant. Both are what let `room.ts` be the thing that owns a
 * world and hand the same one to more than one peer (GLAD-FHKBN8), and what
 * keeps this module free of any particular map — which is what makes it
 * isomorphic, and therefore what makes the listen server possible.
 *
 * ## The advance rule
 *
 * **A command batch advances the world by exactly its own commands.** The
 * simulation is not driven by wall-clock here at all: no clock reading reaches
 * `tick()`, so one recorded input stream produces the same state hash whether
 * it arrived over a socket or across an in-process loopback. That equality is
 * what `net/parity.test.ts` asserts, and it is the property the whole
 * listen-server pattern rests on.
 *
 * The buffering policy that will eventually sit in front of this — how far
 * ahead a peer may run, what a tick does when its buffer is empty — is
 * GLAD-5995PA, and the tick scheduler that will call it is GLAD-FHKBN8.
 */
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type CollisionWorld,
  type GameState,
  type ServerMessage,
  type SpawnPlan,
  type UserCmd,
  decodeCmd,
  hashState,
  parseClientMessage,
  tick as simTick,
} from '@gladiator/sim'

/**
 * What the server tells a client about itself at the handshake.
 *
 * Two strings that both answer "are we the same deploy", from two angles.
 * `build` is which commit; `mapHash` is which world. Passed as one value
 * rather than two positional strings, because two adjacent strings of the same
 * type is a swap waiting to happen and the swap would not fail a typecheck.
 */
export type ServerIdentity = {
  readonly build: string
  /** `map/load.ts`: eight hex digits over the map's content. */
  readonly mapHash: string
}

/**
 * The world a session advances, and the level data beside it.
 *
 * The same object is shared by every peer in a room — one world, several
 * players — which is why `state` is a reference rather than something this
 * module creates.
 */
export type SessionSim = {
  /**
   * The room's world.
   *
   * `readonly` on the *reference* only: `tick()` advances a `GameState` in
   * place (see `AGENTS.md`), so the object a step returns is the same object it
   * was given, with new numbers in it. A caller that needs the state as it was
   * before calls `cloneGameState` itself.
   */
  readonly state: GameState
  readonly world: CollisionWorld
  /** Where a round may stand its players, or `null` for a world in warmup. */
  readonly plan: SpawnPlan | null
}

export type SessionState = {
  readonly id: string
  /** Which player slot this peer's commands land in. */
  readonly slot: number
  readonly sim: SessionSim
  /** The last tick this session has simulated. Always `sim.state.tick`. */
  readonly tick: number
  readonly greeted: boolean
  /** Set once the client has proven it is not the deploy we are: wrong
   *  protocol, or a different map. */
  readonly rejected: boolean
  /** Command batches whose `startTick` did not follow on from `tick`. */
  readonly gaps: number
  readonly commands: number
}

export type SessionStep = {
  readonly session: SessionState
  readonly replies: readonly ServerMessage[]
  /** Set when the session must be closed after the replies are flushed. */
  readonly close?: { readonly code: number; readonly reason: string }
}

/** Close code for a protocol version the server does not speak. */
export const CLOSE_VERSION_MISMATCH = 4001

/** Close code for a frame the server could not parse. */
export const CLOSE_BAD_FRAME = 4002

/** Close code for a client that sent commands before saying hello. */
export const CLOSE_NO_HELLO = 4003

/** Close code for a client holding a different map than the server. */
export const CLOSE_MAP_MISMATCH = 4004

/** Close code for a peer arriving at a room that has no seat for it. */
export const CLOSE_ROOM_FULL = 4005

export function createSession(id: string, sim: SessionSim, slot = 0): SessionState {
  return {
    id,
    slot,
    sim,
    tick: sim.state.tick,
    greeted: false,
    rejected: false,
    gaps: 0,
    commands: 0,
  }
}

/**
 * Apply one already-parsed frame.
 *
 * The reply to a command batch is a single hash, at the last tick applied —
 * not one per tick. At 125 Hz a hash per tick would be 125 frames a second in
 * the other direction to say "still fine", and the client is comparing against
 * its own history anyway, so one per batch finds a desync within a frame of it
 * happening at a fraction of the traffic.
 */
export function applyMessage(
  session: SessionState,
  message: ClientMessage,
  identity: ServerIdentity,
): SessionStep {
  if (message.t === 'hello') {
    if (message.protocol !== PROTOCOL_VERSION) {
      return {
        session: { ...session, rejected: true },
        replies: [
          {
            t: 'version_mismatch',
            serverProtocol: PROTOCOL_VERSION,
            clientProtocol: message.protocol,
            serverBuild: identity.build,
          },
        ],
        close: { code: CLOSE_VERSION_MISMATCH, reason: 'protocol version' },
      }
    }

    // The protocol check first, then the map: a client that cannot parse our
    // frames cannot read a map-mismatch frame either, and being told the wrong
    // thing is worse than being told nothing.
    //
    // Refusing rather than adopting the client's map is the whole point. The
    // server is authoritative, and a server that quietly played whichever
    // arena the client claimed would be a server that can be told where the
    // walls are.
    if (message.mapHash !== identity.mapHash) {
      return {
        session: { ...session, rejected: true },
        replies: [
          {
            t: 'map_mismatch',
            serverMapHash: identity.mapHash,
            clientMapHash: message.mapHash,
          },
        ],
        close: { code: CLOSE_MAP_MISMATCH, reason: 'map mismatch' },
      }
    }

    return {
      session: { ...session, greeted: true },
      replies: [
        {
          t: 'welcome',
          protocol: PROTOCOL_VERSION,
          build: identity.build,
          session: session.id,
          mapHash: identity.mapHash,
        },
      ],
    }
  }

  if (!session.greeted) {
    return {
      session,
      replies: [{ t: 'fault', code: 'no-hello', detail: 'send a hello frame first' }],
      close: { code: CLOSE_NO_HELLO, reason: 'no hello' },
    }
  }

  // A batch that does not start where we left off means frames were lost or
  // reordered. Counted rather than corrected: reconciliation is GLAD-6RT64L,
  // and quietly renumbering here would hide exactly the desync this ticket
  // exists to expose.
  const gapped = message.startTick !== session.tick + 1

  // One command per sub-step, into this peer's slot. The array is reused across
  // the batch: `tick()` allocates nothing in the steady state, and a server
  // running rooms at 125 Hz should not be the thing that makes garbage.
  const { state, world, plan } = session.sim
  const inputs: (UserCmd | null)[] = []
  for (const wire of message.cmds) {
    inputs[session.slot] = decodeCmd(wire)
    simTick(state, inputs, world, plan)
  }

  return {
    session: {
      ...session,
      tick: state.tick,
      gaps: session.gaps + (gapped ? 1 : 0),
      commands: session.commands + message.cmds.length,
    },
    replies: [{ t: 'hash', tick: state.tick, hash: hashState(state) }],
  }
}

/** Apply one raw frame from the wire. */
export function applyFrame(
  session: SessionState,
  raw: string,
  identity: ServerIdentity,
): SessionStep {
  const message: ClientMessage | null = parseClientMessage(raw)
  if (message === null) {
    return {
      session,
      replies: [{ t: 'fault', code: 'bad-frame', detail: 'could not parse that frame' }],
      close: { code: CLOSE_BAD_FRAME, reason: 'bad frame' },
    }
  }
  return applyMessage(session, message, identity)
}
