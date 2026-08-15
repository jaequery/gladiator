/**
 * The effects: what a shot looks like after it has already happened.
 *
 * This is `audio/cues.ts`'s twin for eyes, and it is built the same way and for
 * the same reason. The tempting shortcut is to spawn an explosion where one is
 * *caused* — in the input handler when the fire button goes down, in the weapon
 * code when a rocket is created. Every one of those is a guess about a
 * simulation that is authoritative somewhere else, and each is wrong in its own
 * way under packet loss: the shot you drew was rejected by the server, the
 * rocket you drew flying was destroyed two snapshots ago.
 *
 * So the input is what the renderer is already drawing — the rockets in flight
 * and the players' netstates — and the output is a list of {@link FxEvent}s.
 *
 * ## It is a fold, because an effect is made of *edges*
 *
 * "A rocket detonated" is not a field anybody sends. It is a rocket id that was
 * in the last frame's list and is not in this one's, which is a fact about a
 * *change* — so {@link advanceFx} carries the previous observation forward, and
 * a frame that sees a rocket for the first time produces nothing at all. That
 * is what stops a client joining mid-flight from detonating every rocket
 * already in the air.
 *
 * The one thing a fold cannot supply is *where a shot landed*, because the
 * simulation does not send it: a railgun is hitscan and leaves no entity
 * behind. The trace comes in as a function, so this file needs to know nothing
 * about which map is loaded — and what a beam is drawn against is the
 * simulation's own `traceRay`, the very code the shot was resolved with, rather
 * than a second opinion about where a wall is.
 *
 * ## Nothing here can be read back
 *
 * `FxEvent` values are plain data in the Quake frame; the pool below converts
 * once, at emit, and lives in the engine frame afterwards. No effect ever
 * writes to `GameState`, and no simulation value is ever derived from one.
 *
 * ## The clock is the simulation's
 *
 * Every particle ages against `tick + alpha`, exactly like `animState.ts` and
 * `viewmodel.ts`, and never against a wall clock. Two clients drawing the same
 * tick at 60 Hz and at 240 Hz therefore draw the same explosion, and a frame
 * that arrives late does not fast-forward the smoke.
 *
 * That is also why the particles are ours rather than Babylon's
 * `ParticleSystem`: that one ages itself from the engine's frame delta, which
 * would be a second clock in the one part of this program that is allowed none
 * (`docs/renderer.md` §1). What is here instead is three meshes of
 * camera-facing quads whose vertices are rewritten each frame — one draw call
 * per blend mode, no instancing extension, and not a single allocation after
 * construction.
 */
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import type { Scene } from '@babylonjs/core/scene'
import {
  NEVER_FIRED,
  PLAYER_VIEW_HEIGHT,
  type Vec3,
  Weapon,
  angleUnitsToRadians,
  quakeToEngine,
} from '@gladiator/sim'

import type { PlayerNetState } from './animState.ts'
import { viewForwardQuake } from './view.ts'

/* --------------------------------------------------------------------------
 * The events
 * ----------------------------------------------------------------------- */

/** A rocket the renderer is drawing. Quake frame, already interpolated. */
export type RocketView = {
  readonly id: number
  readonly origin: Vec3
}

export type FxEvent =
  /** A shot left a barrel. Quake frame. */
  | { readonly kind: 'muzzle'; readonly origin: Vec3; readonly weapon: Weapon }
  /** A rocket stopped existing. */
  | { readonly kind: 'explosion'; readonly origin: Vec3 }
  /** A railgun shot, from the muzzle to whatever stopped it. */
  | { readonly kind: 'rail'; readonly from: Vec3; readonly to: Vec3 }
  /** Something hit a surface and left a mark on it. */
  | {
      readonly kind: 'mark'
      readonly origin: Vec3
      readonly normal: Vec3
      readonly radius: number
    }

/** Where a trace stopped, and what it stopped against. */
export type FxTraceHit = {
  readonly point: Vec3
  /** Outward unit normal of the surface, or all zeroes when nothing was hit. */
  readonly normal: Vec3
  readonly hit: boolean
}

/** Radius of the scorch a rocket leaves, in Quake units. */
export const BLAST_MARK_RADIUS = 22

/** And of the burn a railgun leaves. A slug punches; a rocket blackens. */
export const RAIL_MARK_RADIUS = 7

/**
 * How far a rail beam is traced, in Quake units.
 *
 * 8192, the far plane. A railgun has no range in Quake and it has none here;
 * this is only the length of the ray that has to reach the far wall.
 */
export const RAIL_RANGE = 8192

/**
 * How far past its last seen position a detonating rocket is traced, in Quake
 * units.
 *
 * 96. Far enough to find the wall a rocket a frame short of it flew into, short
 * enough that one detonating in mid-air over a pit does not scorch the floor
 * below.
 */
export const BLAST_SEARCH = 96

/** What the fold is given each frame. */
export type FxObservation = {
  readonly self: PlayerNetState | null
  readonly others: readonly PlayerNetState[]
  readonly rockets: readonly RocketView[]
  /** The simulation's own hitscan. See the header for why it is a parameter. */
  readonly trace: (from: Vec3, to: Vec3) => FxTraceHit
}

/** Where a rocket was, and which way it was going. */
export type RocketTrack = {
  readonly origin: Vec3
  /** How far it moved since the frame before. Zero on the frame it appeared. */
  readonly delta: Vec3
}

/** What the fold remembers between frames. */
export type FxMemory = {
  readonly rockets: ReadonlyMap<number, RocketTrack>
  /** `lastFireTick` per player id, so the same shot is drawn once. */
  readonly fired: ReadonlyMap<number, number>
}

export const INITIAL_FX: FxMemory = { rockets: new Map(), fired: new Map() }

export type FxFold = {
  readonly memory: FxMemory
  readonly events: readonly FxEvent[]
}

/** The muzzle: a shot leaves at the eye, not at the feet. Same rule as `cues.ts`. */
function muzzleOf(net: PlayerNetState): Vec3 {
  return [net.origin[0], net.origin[1], net.origin[2] + PLAYER_VIEW_HEIGHT]
}

/**
 * Fold one frame of what the renderer can see into the effects it should start.
 *
 * Pure and total: given the same memory and observation it produces the same
 * events, so it is tested without a GPU (`fx.test.ts`).
 */
export function advanceFx(memory: FxMemory, observation: FxObservation): FxFold {
  const events: FxEvent[] = []
  const rockets = new Map<number, RocketTrack>()
  const fired = new Map<number, number>()

  for (const rocket of observation.rockets) {
    const previous = memory.rockets.get(rocket.id)
    const origin: Vec3 = [rocket.origin[0], rocket.origin[1], rocket.origin[2]]
    const delta: Vec3 =
      previous === undefined
        ? [0, 0, 0]
        : [
            origin[0] - previous.origin[0],
            origin[1] - previous.origin[1],
            origin[2] - previous.origin[2],
          ]
    rockets.set(rocket.id, { origin, delta })
  }

  // --- a rocket that was here and is not ------------------------------------
  // The only signal there is that one detonated: `GameState` removes a rocket
  // on the tick it explodes and sends nothing else, so its absence *is* the
  // event.
  for (const [id, track] of memory.rockets) {
    if (rockets.has(id)) continue
    events.push({ kind: 'explosion', origin: track.origin })

    // Where it scorched something. Traced along the way it was already going,
    // because a rocket detonates a frame *before* the wall it hit — assuming
    // straight down instead would put every wall hit's mark on the floor.
    const [dx, dy, dz] = track.delta
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (length <= 0) continue
    const ahead: Vec3 = [
      track.origin[0] + (dx / length) * BLAST_SEARCH,
      track.origin[1] + (dy / length) * BLAST_SEARCH,
      track.origin[2] + (dz / length) * BLAST_SEARCH,
    ]
    const hit = observation.trace(track.origin, ahead)
    if (hit.hit) {
      events.push({
        kind: 'mark',
        origin: hit.point,
        normal: hit.normal,
        radius: BLAST_MARK_RADIUS,
      })
    }
  }

  // --- somebody fired ------------------------------------------------------
  for (const net of observation.self === null ? observation.others : [observation.self, ...observation.others]) {
    fired.set(net.id, net.lastFireTick)
    const previous = memory.fired.get(net.id)
    // A player seen for the first time emits nothing: every rule here is an
    // edge, and an edge against a memory of nothing fires spuriously.
    if (previous === undefined) continue
    if (net.lastFireTick === previous || net.lastFireTick === NEVER_FIRED) continue

    const muzzle = muzzleOf(net)
    events.push({ kind: 'muzzle', origin: muzzle, weapon: net.weapon })
    if (net.weapon !== Weapon.Railgun) continue

    const forward = viewForwardQuake(
      angleUnitsToRadians(net.angles[1]),
      angleUnitsToRadians(net.angles[0]),
    )
    const far: Vec3 = [
      muzzle[0] + forward[0] * RAIL_RANGE,
      muzzle[1] + forward[1] * RAIL_RANGE,
      muzzle[2] + forward[2] * RAIL_RANGE,
    ]
    const hit = observation.trace(muzzle, far)
    events.push({ kind: 'rail', from: muzzle, to: hit.point })
    if (hit.hit) {
      events.push({
        kind: 'mark',
        origin: hit.point,
        normal: hit.normal,
        radius: RAIL_MARK_RADIUS,
      })
    }
  }

  return { memory: { rockets, fired }, events }
}

/* --------------------------------------------------------------------------
 * The numbers
 *
 * Lifetimes are in **ticks**, because the clock is the simulation's. 125 ticks
 * is one second.
 * ----------------------------------------------------------------------- */

/** How long a puff of rocket exhaust lasts, and how far apart puffs are laid. */
const TRAIL_LIFE = 90
const TRAIL_STRIDE = 26

/** The blast: a core flash, a fan of sparks, and smoke that outlives both. */
const BLAST_SPARKS = 22
const BLAST_SMOKE = 14
const BLAST_FLASH_LIFE = 16
const BLAST_SPARK_LIFE = 55
const BLAST_SMOKE_LIFE = 110

/** How long a rail beam stays on screen. A third of a second. */
const RAIL_LIFE = 42

/** How long a scorch survives before its slot may be reused. Twelve seconds. */
const MARK_LIFE = 1500

/** How far off the surface a mark sits, in Quake units. Enough to beat depth. */
const MARK_LIFT = 0.6

/** Half-width of a rail beam, in Quake units. */
const RAIL_WIDTH = 1.6

/** One tick, as a fraction of a second — every speed below is per second. */
const PER_TICK = 1 / 125

/**
 * Pool sizes. Fixed, allocated once, never grown.
 *
 * A duel is two players with two weapons, and these are comfortably more than
 * that can produce. Fixed is the point: it is what makes the whole system
 * allocate nothing per frame, and per-frame allocation shows up as exactly the
 * hitches `frameStats.ts` exists to catch. When a pool is full the **oldest**
 * slot is taken, so what gets dropped is the effect already fading rather than
 * the one that just happened.
 */
const MAX_PARTICLES = 320
const MAX_BEAMS = 12
const MAX_MARKS = 48

/* --------------------------------------------------------------------------
 * The pool
 * ----------------------------------------------------------------------- */

/**
 * One particle, in the engine frame.
 *
 * Flat fields rather than vectors: this is read every frame for every live
 * particle, and a `Vector3` per field would be three allocations per emit —
 * see {@link MAX_PARTICLES}.
 */
type Particle = {
  live: boolean
  x: number
  y: number
  z: number
  /** Engine-frame velocity, per tick. */
  vx: number
  vy: number
  vz: number
  /** Engine-frame acceleration per tick squared. Gravity is negative `y`. */
  ay: number
  /** Velocity retained per tick: 1 is none, 0.93 is thick smoke. */
  drag: number
  birth: number
  life: number
  size0: number
  size1: number
  r0: number
  g0: number
  b0: number
  a0: number
  r1: number
  g1: number
  b1: number
  a1: number
  /** Which mesh draws it: additive flame, or alpha-blended smoke. */
  additive: boolean
}

type Beam = {
  live: boolean
  birth: number
  /** Engine frame. */
  readonly from: Float32Array
  readonly to: Float32Array
}

type Mark = {
  live: boolean
  birth: number
  /** Engine frame: four corners, computed at emit — a mark never moves. */
  readonly corners: Float32Array
}

export type FxCounts = {
  readonly particles: number
  readonly beams: number
  readonly marks: number
}

export type FxSystem = {
  /**
   * Start whatever these events look like, and advance everything already
   * running to `tick + alpha`.
   *
   * `cameraPosition` is read, not written. A beam is a flat quad that has to be
   * rolled about its own axis to face the eye, which is the only thing in this
   * renderer that legitimately depends on where the camera is; it is passed in
   * rather than read back off the camera for the same reason the frame interval
   * is — one source, written once a frame.
   */
  update(
    events: readonly FxEvent[],
    rockets: readonly RocketView[],
    tick: number,
    alpha: number,
    cameraPosition: Vec3,
  ): void
  /** Live particles, beams and marks — for the HUD and the smoke test. */
  readonly counts: FxCounts
  dispose(): void
}

/**
 * A soft round dot.
 *
 * Radial, with a hard-ish core and a long tail, because the same sprite has to
 * read as a spark when it is additive and small and as smoke when it is
 * alpha-blended and large. White, so the per-particle colour decides everything.
 */
function createPuffTexture(scene: Scene): DynamicTexture {
  const size = 64
  const texture = new DynamicTexture('fx:puff', { width: size, height: size }, scene, true)
  const context = texture.getContext() as unknown as CanvasRenderingContext2D
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.72)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  texture.update(false)
  texture.wrapU = Texture.CLAMP_ADDRESSMODE
  texture.wrapV = Texture.CLAMP_ADDRESSMODE
  texture.hasAlpha = true
  return texture
}

/**
 * A scorch: opaque at the middle, gone at the rim, with a soft shoulder.
 *
 * Only the alpha carries the shape; the colour is written per mark. That is
 * what lets one texture be a rocket's black blast and a railgun's small bright
 * burn without a second file.
 */
function createScorchTexture(scene: Scene): DynamicTexture {
  const size = 64
  const texture = new DynamicTexture('fx:scorch', { width: size, height: size }, scene, true)
  const context = texture.getContext() as unknown as CanvasRenderingContext2D
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.68)')
  gradient.addColorStop(0.82, 'rgba(255,255,255,0.18)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  texture.update(false)
  texture.wrapU = Texture.CLAMP_ADDRESSMODE
  texture.wrapV = Texture.CLAMP_ADDRESSMODE
  texture.hasAlpha = true
  return texture
}

/**
 * A mesh of camera-facing quads whose vertices are rewritten each frame.
 *
 * One draw call for every quad of a kind, no instancing extension, no per-frame
 * allocation: the buffers are made once and `updateVerticesData` hands the same
 * `Float32Array` back to the GPU. Everything is written in world space, so the
 * mesh itself never moves and its world matrix is frozen.
 */
type QuadMesh = {
  readonly mesh: Mesh
  readonly positions: Float32Array
  readonly colors: Float32Array
  readonly capacity: number
  /** Blank every quad from `used` onwards, so a stale one is not drawn. */
  hide(used: number): void
  flush(): void
  dispose(): void
}

function createQuadMesh(scene: Scene, name: string, quads: number, material: StandardMaterial): QuadMesh {
  const positions = new Float32Array(quads * 4 * 3)
  const colors = new Float32Array(quads * 4 * 4)
  const uvs = new Float32Array(quads * 4 * 2)
  const indices = new Uint32Array(quads * 6)

  for (let q = 0; q < quads; q += 1) {
    const v = q * 4
    uvs.set([0, 0, 1, 0, 1, 1, 0, 1], v * 2)
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6)
  }

  const mesh = new Mesh(name, scene)
  const data = new VertexData()
  data.positions = positions
  data.colors = colors
  data.uvs = uvs
  data.indices = indices
  data.applyToMesh(mesh, true)
  mesh.material = material
  mesh.isPickable = false
  mesh.hasVertexAlpha = true
  // World space already, so there is no transform to recompute — and no useful
  // frustum culling either, since a bounding box over a buffer that changes
  // every frame would have to be recomputed every frame to be true.
  mesh.freezeWorldMatrix()
  mesh.alwaysSelectAsActiveMesh = true

  return {
    mesh,
    positions,
    colors,
    capacity: quads,
    hide(used) {
      // Zero the alpha rather than move the geometry: a degenerate triangle is
      // still a triangle the rasteriser sets up, and a fully transparent one is
      // rejected by the blend before it costs anything.
      if (used < quads) colors.fill(0, used * 16, colors.length)
    },
    flush() {
      mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false)
      mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false)
    },
    dispose() {
      mesh.dispose()
    },
  }
}

/**
 * An unlit sprite material.
 *
 * Nothing in this file is lit. Every colour here is authored — a muzzle flash
 * is not a surface that light falls on, it *is* the light — so the whole light
 * loop is switched off and the colour rides in `emissiveColor` times the vertex
 * colour, exactly as the arena's albedo does (`materials.ts`).
 */
function createSpriteMaterial(scene: Scene, name: string, texture: Texture): StandardMaterial {
  const material = new StandardMaterial(name, scene)
  material.diffuseTexture = texture
  material.useAlphaFromDiffuseTexture = true
  material.emissiveColor = new Color3(1, 1, 1)
  material.diffuseColor = new Color3(0, 0, 0)
  material.specularColor = new Color3(0, 0, 0)
  material.disableLighting = true
  material.backFaceCulling = false
  // An effect never writes depth. Two overlapping puffs would otherwise each
  // punch a hole in the other, and the hole would move with the camera.
  material.disableDepthWrite = true
  return material
}

/**
 * Build the effects.
 *
 * Everything is allocated here, at load, behind the loading screen: three
 * meshes, three materials, two textures and the pools. After this the system
 * allocates nothing at all.
 */
export function createFx(scene: Scene, camera: Camera): FxSystem {
  const puff = createPuffTexture(scene)
  const scorch = createScorchTexture(scene)

  const smokeMaterial = createSpriteMaterial(scene, 'fx:smoke', puff)
  const flameMaterial = createSpriteMaterial(scene, 'fx:flame', puff)
  // A flame adds light; it does not hide what is behind it.
  flameMaterial.alphaMode = 1 // ALPHA_ADD
  const markMaterial = createSpriteMaterial(scene, 'fx:mark', scorch)
  // A mark is *on* a wall, so it must not fight the wall for the same depth.
  markMaterial.zOffset = -4

  const smoke = createQuadMesh(scene, 'fx:smoke', MAX_PARTICLES, smokeMaterial)
  const flame = createQuadMesh(scene, 'fx:flame', MAX_PARTICLES + MAX_BEAMS, flameMaterial)
  const marks = createQuadMesh(scene, 'fx:marks', MAX_MARKS, markMaterial)

  const particles: Particle[] = []
  const blank = (): Particle => ({
    live: false,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    ay: 0,
    drag: 1,
    birth: 0,
    life: 1,
    size0: 1,
    size1: 1,
    r0: 1,
    g0: 1,
    b0: 1,
    a0: 1,
    r1: 1,
    g1: 1,
    b1: 1,
    a1: 0,
    additive: false,
  })
  for (let i = 0; i < MAX_PARTICLES; i += 1) particles.push(blank())
  let nextParticle = 0

  const beams: Beam[] = []
  for (let i = 0; i < MAX_BEAMS; i += 1) {
    beams.push({ live: false, birth: 0, from: new Float32Array(3), to: new Float32Array(3) })
  }
  let nextBeam = 0

  const markPool: Mark[] = []
  for (let i = 0; i < MAX_MARKS; i += 1) {
    markPool.push({ live: false, birth: 0, corners: new Float32Array(12) })
  }
  let nextMark = 0

  /** Where each rocket last dropped a puff, so a trail is paced by distance. */
  const trailAt = new Map<number, Vec3>()

  /**
   * Take the next slot, live or not.
   *
   * Round-robin rather than first-free: the pool is a ring, so a full pool
   * evicts the *oldest* particle — the one nearest the end of its life, and the
   * one least likely to be noticed going.
   */
  const claim = (): Particle => {
    const particle = particles[nextParticle] as Particle
    nextParticle = (nextParticle + 1) % particles.length
    particle.live = true
    return particle
  }

  /** A puff of rocket exhaust. */
  const emitTrail = (at: Vec3, now: number): void => {
    const [x, y, z] = quakeToEngine(at)
    const p = claim()
    p.x = x
    p.y = y
    p.z = z
    p.vx = 0
    p.vy = 6 * PER_TICK
    p.vz = 0
    p.ay = 0
    p.drag = 0.97
    p.birth = now
    p.life = TRAIL_LIFE
    p.size0 = 6
    p.size1 = 26
    p.r0 = 1
    p.g0 = 0.72
    p.b0 = 0.38
    p.a0 = 0.8
    p.r1 = 0.36
    p.g1 = 0.36
    p.b1 = 0.4
    p.a1 = 0
    p.additive = false
  }

  /**
   * The blast: a core flash, a fan of sparks, and smoke that outlives both.
   *
   * The directions are a fixed golden-angle fan hashed by index, not random.
   * The simulation owns the only PRNG in this program and the renderer has no
   * business drawing from it (`AGENTS.md`), and over 130 milliseconds a fixed
   * fan is indistinguishable from noise.
   */
  const emitExplosion = (at: Vec3, now: number): void => {
    const [x, y, z] = quakeToEngine(at)

    const flash = claim()
    flash.x = x
    flash.y = y
    flash.z = z
    flash.vx = 0
    flash.vy = 0
    flash.vz = 0
    flash.ay = 0
    flash.drag = 1
    flash.birth = now
    flash.life = BLAST_FLASH_LIFE
    flash.size0 = 34
    flash.size1 = 190
    flash.r0 = 1
    flash.g0 = 0.93
    flash.b0 = 0.7
    flash.a0 = 1
    flash.r1 = 1
    flash.g1 = 0.45
    flash.b1 = 0.12
    flash.a1 = 0
    flash.additive = true

    for (let i = 0; i < BLAST_SPARKS; i += 1) {
      const angle = i * 2.39996
      const spread = 0.35 + ((i * 7919) % 1000) / 1540
      const speed = 340 + ((i * 104729) % 1000) * 0.42
      const p = claim()
      p.x = x
      p.y = y
      p.z = z
      p.vx = Math.cos(angle) * spread * speed * PER_TICK
      p.vy = (0.55 + ((i * 15485863) % 1000) / 1600) * speed * PER_TICK
      p.vz = Math.sin(angle) * spread * speed * PER_TICK
      p.ay = -800 * PER_TICK * PER_TICK
      p.drag = 0.93
      p.birth = now
      p.life = BLAST_SPARK_LIFE
      p.size0 = 9
      p.size1 = 2
      p.r0 = 1
      p.g0 = 0.86
      p.b0 = 0.5
      p.a0 = 1
      p.r1 = 1
      p.g1 = 0.3
      p.b1 = 0.08
      p.a1 = 0
      p.additive = true
    }

    for (let i = 0; i < BLAST_SMOKE; i += 1) {
      const angle = i * 2.39996
      const speed = 60 + ((i * 39916801) % 1000) * 0.09
      const p = claim()
      p.x = x
      p.y = y
      p.z = z
      p.vx = Math.cos(angle) * speed * PER_TICK
      p.vy = (40 + ((i * 6151) % 100)) * PER_TICK
      p.vz = Math.sin(angle) * speed * PER_TICK
      p.ay = 0
      p.drag = 0.95
      p.birth = now
      p.life = BLAST_SMOKE_LIFE
      p.size0 = 26
      p.size1 = 96
      p.r0 = 0.5
      p.g0 = 0.44
      p.b0 = 0.4
      p.a0 = 0.65
      p.r1 = 0.24
      p.g1 = 0.24
      p.b1 = 0.26
      p.a1 = 0
      p.additive = false
    }
  }

  const emitMuzzle = (at: Vec3, weapon: Weapon, now: number): void => {
    const [x, y, z] = quakeToEngine(at)
    const rocket = weapon === Weapon.RocketLauncher
    const p = claim()
    p.x = x
    p.y = y
    p.z = z
    p.vx = 0
    p.vy = 0
    p.vz = 0
    p.ay = 0
    p.drag = 1
    p.birth = now
    p.life = 9
    p.size0 = rocket ? 22 : 16
    p.size1 = rocket ? 46 : 8
    p.r0 = rocket ? 1 : 0.6
    p.g0 = 0.85
    p.b0 = rocket ? 0.5 : 1
    p.a0 = 0.9
    p.r1 = rocket ? 1 : 0.4
    p.g1 = 0.4
    p.b1 = rocket ? 0.15 : 1
    p.a1 = 0
    p.additive = true
  }

  const emitBeam = (from: Vec3, to: Vec3, now: number): void => {
    const beam = beams[nextBeam] as Beam
    nextBeam = (nextBeam + 1) % beams.length
    beam.from.set(quakeToEngine(from))
    beam.to.set(quakeToEngine(to))
    beam.birth = now
    beam.live = true
  }

  /**
   * A mark, as four corners lying in the plane it was left on.
   *
   * No decal projection and no clipping against the geometry, because there is
   * nothing to project on to: every surface in this world is cut from a brush
   * plane (`map/geometry.ts`), so a quad in that plane *is* the decal. It is
   * computed once, here, and never touched again.
   */
  const emitMark = (at: Vec3, normal: Vec3, radius: number, now: number): void => {
    const mark = markPool[nextMark] as Mark
    nextMark = (nextMark + 1) % markPool.length

    const [nx, ny, nz] = quakeToEngine(normal)
    const [px, py, pz] = quakeToEngine(at)
    // Same 1/sqrt(3) tangent rule as everywhere else in this repository.
    const seed: Vec3 =
      Math.abs(nx) < 0.57735 ? [1, 0, 0] : Math.abs(ny) < 0.57735 ? [0, 1, 0] : [0, 0, 1]
    const along = seed[0] * nx + seed[1] * ny + seed[2] * nz
    let tx = seed[0] - nx * along
    let ty = seed[1] - ny * along
    let tz = seed[2] - nz * along
    const length = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1
    tx /= length
    ty /= length
    tz /= length
    const bx = ny * tz - nz * ty
    const by = nz * tx - nx * tz
    const bz = nx * ty - ny * tx

    const ox = px + nx * MARK_LIFT
    const oy = py + ny * MARK_LIFT
    const oz = pz + nz * MARK_LIFT
    let slot = 0
    for (const [s, t] of CORNERS) {
      mark.corners[slot] = ox + (tx * s + bx * t) * radius
      mark.corners[slot + 1] = oy + (ty * s + by * t) * radius
      mark.corners[slot + 2] = oz + (tz * s + bz * t) * radius
      slot += 3
    }
    mark.birth = now
    mark.live = true
  }

  const counts = { particles: 0, beams: 0, marks: 0 }

  return {
    get counts() {
      return counts
    },

    update(events, live, tick, alpha, cameraPosition) {
      const now = tick + alpha

      for (const event of events) {
        if (event.kind === 'explosion') emitExplosion(event.origin, now)
        else if (event.kind === 'muzzle') emitMuzzle(event.origin, event.weapon, now)
        else if (event.kind === 'rail') emitBeam(event.from, event.to, now)
        else emitMark(event.origin, event.normal, event.radius, now)
      }

      // --- trails, paced by distance rather than by time --------------------
      // The same rule footsteps use (`audio/cues.ts`): a rocket crossing the
      // arena leaves the same trail at 60 Hz and at 240 Hz, and one that is
      // barely moving does not pile smoke up on the spot.
      for (const rocket of live) {
        const last = trailAt.get(rocket.id)
        if (last !== undefined) {
          const dx = rocket.origin[0] - last[0]
          const dy = rocket.origin[1] - last[1]
          const dz = rocket.origin[2] - last[2]
          if (dx * dx + dy * dy + dz * dz < TRAIL_STRIDE * TRAIL_STRIDE) continue
        }
        trailAt.set(rocket.id, [rocket.origin[0], rocket.origin[1], rocket.origin[2]])
        emitTrail(rocket.origin, now)
      }
      if (trailAt.size > live.length) {
        const present = new Set(live.map((rocket) => rocket.id))
        for (const id of [...trailAt.keys()]) if (!present.has(id)) trailAt.delete(id)
      }

      // --- the camera basis, for the billboards -----------------------------
      // Read off the camera's world matrix rather than re-derived from the
      // pose. The camera has already been written this frame (`applyPose`), and
      // two derivations of one basis is exactly the drift §1 warns about.
      const view = camera.getWorldMatrix().m
      const rx = view[0] as number
      const ry = view[1] as number
      const rz = view[2] as number
      const ux = view[4] as number
      const uy = view[5] as number
      const uz = view[6] as number

      let smokeUsed = 0
      let flameUsed = 0
      counts.particles = 0

      for (const particle of particles) {
        if (!particle.live) continue
        const age = (now - particle.birth) / particle.life
        if (age >= 1 || age < 0) {
          particle.live = false
          continue
        }

        const target = particle.additive ? flame : smoke
        const index = particle.additive ? flameUsed : smokeUsed
        if (index >= target.capacity) continue
        if (particle.additive) flameUsed += 1
        else smokeUsed += 1
        counts.particles += 1

        // Constant acceleration with the per-tick drag folded into an average
        // factor. Exact enough for smoke, and it costs no per-frame state.
        const t = (now - particle.birth) * (0.5 + 0.5 * particle.drag)
        const px = particle.x + particle.vx * t
        const py = particle.y + particle.vy * t + 0.5 * particle.ay * t * t
        const pz = particle.z + particle.vz * t
        const half = (particle.size0 + (particle.size1 - particle.size0) * age) * 0.5

        const at = index * 12
        let slot = 0
        for (const [s, u] of CORNERS) {
          target.positions[at + slot] = px + (rx * s + ux * u) * half
          target.positions[at + slot + 1] = py + (ry * s + uy * u) * half
          target.positions[at + slot + 2] = pz + (rz * s + uz * u) * half
          slot += 3
        }

        const r = particle.r0 + (particle.r1 - particle.r0) * age
        const g = particle.g0 + (particle.g1 - particle.g0) * age
        const b = particle.b0 + (particle.b1 - particle.b0) * age
        const a = (particle.a0 + (particle.a1 - particle.a0) * age) * (1 - age)
        paint(target.colors, index, r, g, b, a)
      }

      // --- the rail beams ---------------------------------------------------
      // A flat quad along the shot, rolled about its own axis until it faces
      // the eye. Not a cylinder: a beam is a bright line, and a tube of
      // triangles is a dozen times the vertices for a silhouette nobody sees.
      counts.beams = 0
      for (const beam of beams) {
        if (!beam.live) continue
        const age = (now - beam.birth) / RAIL_LIFE
        if (age >= 1 || age < 0) {
          beam.live = false
          continue
        }
        if (flameUsed >= flame.capacity) continue
        counts.beams += 1

        const ax = beam.from[0] as number
        const ay = beam.from[1] as number
        const az = beam.from[2] as number
        const bx = beam.to[0] as number
        const by = beam.to[1] as number
        const bz = beam.to[2] as number
        const dx = bx - ax
        const dy = by - ay
        const dz = bz - az
        // `axis x eye` is the direction that widens the quad towards the
        // viewer. It degenerates when you look straight down the beam, which is
        // exactly when the beam is a point and nobody can tell.
        const ex = cameraPosition[0] - (ax + bx) * 0.5
        const ey = cameraPosition[1] - (ay + by) * 0.5
        const ez = cameraPosition[2] - (az + bz) * 0.5
        let wx = dy * ez - dz * ey
        let wy = dz * ex - dx * ez
        let wz = dx * ey - dy * ex
        const wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1
        wx = (wx / wl) * RAIL_WIDTH
        wy = (wy / wl) * RAIL_WIDTH
        wz = (wz / wl) * RAIL_WIDTH

        const index = flameUsed
        flameUsed += 1
        const at = index * 12
        flame.positions[at] = ax - wx
        flame.positions[at + 1] = ay - wy
        flame.positions[at + 2] = az - wz
        flame.positions[at + 3] = bx - wx
        flame.positions[at + 4] = by - wy
        flame.positions[at + 5] = bz - wz
        flame.positions[at + 6] = bx + wx
        flame.positions[at + 7] = by + wy
        flame.positions[at + 8] = bz + wz
        flame.positions[at + 9] = ax + wx
        flame.positions[at + 10] = ay + wy
        flame.positions[at + 11] = az + wz
        paint(flame.colors, index, 0.55, 0.8, 1, (1 - age) * (1 - age))
      }

      // --- the marks --------------------------------------------------------
      let markUsed = 0
      counts.marks = 0
      for (const mark of markPool) {
        if (!mark.live) continue
        const age = (now - mark.birth) / MARK_LIFE
        if (age >= 1 || age < 0) {
          mark.live = false
          continue
        }
        counts.marks += 1
        const index = markUsed
        markUsed += 1
        marks.positions.set(mark.corners, index * 12)
        // Held at full strength and faded off over the last quarter of its
        // life, so a scorch does not visibly dim while a player is looking at
        // the wall it is on.
        paint(marks.colors, index, 0.05, 0.04, 0.04, Math.min(1, (1 - age) * 4))
      }

      smoke.hide(smokeUsed)
      flame.hide(flameUsed)
      marks.hide(markUsed)
      smoke.flush()
      flame.flush()
      marks.flush()
    },

    dispose() {
      smoke.dispose()
      flame.dispose()
      marks.dispose()
      smokeMaterial.dispose()
      flameMaterial.dispose()
      markMaterial.dispose()
      puff.dispose()
      scorch.dispose()
    },
  }
}

/** A quad's corners, counter-clockwise, in the order the index buffer expects. */
const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

/** Write one colour across a quad's four vertices. */
function paint(
  colors: Float32Array,
  index: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const at = index * 16
  for (let corner = 0; corner < 4; corner += 1) {
    colors[at + corner * 4] = r
    colors[at + corner * 4 + 1] = g
    colors[at + corner * 4 + 2] = b
    colors[at + corner * 4 + 3] = a
  }
}
